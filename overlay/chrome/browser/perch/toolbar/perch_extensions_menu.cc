// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/toolbar/perch_extensions_menu.h"

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/extensions/extensions_container.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/toolbar/toolbar_action_view_model.h"
#include "chrome/browser/ui/toolbar/toolbar_actions_model.h"
#include "content/public/browser/page_navigator.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest_handlers/options_page_info.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/geometry/size.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"

namespace perch {

namespace {

enum ExtensionCommand { kOpen = 1, kPin, kOptions };

// One extension's submenu: Open, Pin to Toolbar, Options.
class ExtensionSubmenu : public ui::SimpleMenuModel,
                         public ui::SimpleMenuModel::Delegate {
 public:
  ExtensionSubmenu(BrowserWindowInterface* browser, std::string id)
      : ui::SimpleMenuModel(this), browser_(browser), id_(std::move(id)) {
    AddItem(kOpen, u"Open");
    AddCheckItem(kPin, u"Pin to Toolbar");
    if (OptionsUrl().is_valid()) {
      AddItem(kOptions, u"Options");
    }
  }

  bool IsCommandIdChecked(int command_id) const override {
    ToolbarActionsModel* model =
        ToolbarActionsModel::Get(browser_->GetProfile());
    return command_id == kPin && model && model->IsActionPinned(id_);
  }

  void ExecuteCommand(int command_id, int event_flags) override {
    switch (command_id) {
      case kOpen:
        if (ExtensionsContainer* container =
                ExtensionsContainer::From(*browser_)) {
          if (ToolbarActionViewModel* action =
                  container->GetActionForId(id_)) {
            action->ExecuteUserAction(
                ToolbarActionViewModel::InvocationSource::kMenuEntry);
          }
        }
        return;
      case kPin:
        if (ToolbarActionsModel* model =
                ToolbarActionsModel::Get(browser_->GetProfile())) {
          model->SetActionVisibility(id_, !model->IsActionPinned(id_));
        }
        return;
      case kOptions:
        browser_->OpenURL(
            content::OpenURLParams(OptionsUrl(), content::Referrer(),
                                   WindowOpenDisposition::kNewForegroundTab,
                                   ui::PAGE_TRANSITION_AUTO_TOPLEVEL, false),
            {});
        return;
    }
  }

 private:
  GURL OptionsUrl() const {
    const extensions::Extension* extension =
        extensions::ExtensionRegistry::Get(browser_->GetProfile())
            ->enabled_extensions()
            .GetByID(id_);
    return extension ? extensions::OptionsPageInfo::GetOptionsPage(extension)
                     : GURL();
  }

  raw_ptr<BrowserWindowInterface> browser_;
  const std::string id_;
};

class ExtensionsMenu : public ui::SimpleMenuModel,
                       public ui::SimpleMenuModel::Delegate {
 public:
  explicit ExtensionsMenu(BrowserWindowInterface* browser)
      : ui::SimpleMenuModel(this), browser_(browser) {
    AddItem(IDC_MANAGE_EXTENSIONS, u"Manage Extensions");
    AddItem(IDC_FIND_EXTENSIONS, u"Chrome Web Store");

    ToolbarActionsModel* model =
        ToolbarActionsModel::Get(browser->GetProfile());
    ExtensionsContainer* container = ExtensionsContainer::From(*browser);
    if (!model || !container || model->action_ids().empty()) {
      return;
    }
    struct Row {
      std::string id;
      std::u16string name;
      ui::ImageModel icon;
    };
    std::vector<Row> rows;
    content::WebContents* page =
        browser->GetTabStripModel()->GetActiveWebContents();
    for (const std::string& id : model->action_ids()) {
      ToolbarActionViewModel* action = container->GetActionForId(id);
      if (!action) {
        continue;
      }
      rows.push_back({id, action->GetActionName(),
                      action->GetIcon(page, gfx::Size(16, 16))});
    }
    std::ranges::sort(rows, [](const Row& a, const Row& b) {
      return a.name < b.name;
    });
    AddSeparator(ui::NORMAL_SEPARATOR);
    AddTitle(u"Installed extensions");
    int command = kFirstExtension;
    for (Row& row : rows) {
      submenus_.push_back(std::make_unique<ExtensionSubmenu>(browser, row.id));
      AddSubMenuWithIcon(command++, row.name, submenus_.back().get(),
                         row.icon);
    }
  }

  void ExecuteCommand(int command_id, int event_flags) override {
    chrome::ExecuteCommand(browser_, command_id);
  }

 private:
  static constexpr int kFirstExtension = 1000;

  raw_ptr<BrowserWindowInterface> browser_;
  std::vector<std::unique_ptr<ExtensionSubmenu>> submenus_;
};

struct OpenMenu {
  std::unique_ptr<ExtensionsMenu> model;
  std::unique_ptr<views::MenuRunner> runner;
};

OpenMenu& Current() {
  static base::NoDestructor<OpenMenu> open;
  return *open;
}

}  // namespace

bool ShowPerchExtensionsMenu(BrowserWindowInterface* browser,
                             views::View* anchor) {
  OpenMenu& open = Current();
  if (open.runner && open.runner->IsRunning()) {
    open.runner->Cancel();
  }
  open.runner.reset();
  open.model = std::make_unique<ExtensionsMenu>(browser);
  open.runner = std::make_unique<views::MenuRunner>(
      open.model.get(), views::MenuRunner::HAS_MNEMONICS);
  open.runner->RunMenuAt(anchor->GetWidget(), nullptr,
                         anchor->GetAnchorBoundsInScreen(),
                         views::MenuAnchorPosition::kTopRight,
                         ui::mojom::MenuSourceType::kNone);
  return true;
}

}  // namespace perch
