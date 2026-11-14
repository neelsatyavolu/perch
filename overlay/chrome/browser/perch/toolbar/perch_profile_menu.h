// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_TOOLBAR_PERCH_PROFILE_MENU_H_
#define CHROME_BROWSER_PERCH_TOOLBAR_PERCH_PROFILE_MENU_H_

#include <memory>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/memory/raw_ptr.h"
#include "ui/menus/simple_menu_model.h"

class BrowserWindowInterface;

namespace gfx {
struct VectorIcon;
}

namespace ui {
class ImageModel;
class MenuModel;
}

namespace views {
class MenuRunner;
class View;
}

namespace perch {

// Perch's two toolbar menus, in place of Chromium's profile bubble and app
// menu: the profile button lists the profiles (spec 5.3); the menu button at
// the end of the toolbar has new tabs and windows, zoom, find and print,
// History, Downloads, Bookmarks, Extensions, More Tools, Settings and About.
class PerchProfileMenuModel : public ui::SimpleMenuModel,
                              public ui::SimpleMenuModel::Delegate {
 public:
  enum class Kind { kProfile, kApp };

  PerchProfileMenuModel(BrowserWindowInterface* browser, Kind kind);
  PerchProfileMenuModel(const PerchProfileMenuModel&) = delete;
  PerchProfileMenuModel& operator=(const PerchProfileMenuModel&) = delete;
  ~PerchProfileMenuModel() override;

  // ui::SimpleMenuModel::Delegate:
  bool IsCommandIdChecked(int command_id) const override;
  bool IsCommandIdEnabled(int command_id) const override;
  bool GetAcceleratorForCommandId(int command_id,
                                  ui::Accelerator* accelerator) const override;
  void ExecuteCommand(int command_id, int event_flags) override;

 private:
  void Build();
  void BuildProfiles();
  void BuildApp();
  void AddRecentDownloads();

  raw_ptr<BrowserWindowInterface> browser_;
  const Kind kind_;
  // The profile each profile row switches to, by row.
  std::vector<base::FilePath> profiles_;
  // Recent finished downloads, by row of the Downloads submenu.
  std::vector<std::string> downloads_;
  std::unique_ptr<ui::SimpleMenuModel> bookmarks_;
  std::unique_ptr<ui::SimpleMenuModel> downloads_menu_;
  std::unique_ptr<ui::SimpleMenuModel> extensions_;
  std::unique_ptr<ui::MenuModel> history_;
  std::unique_ptr<ui::SimpleMenuModel> developers_;
};

// A line icon for a toolbar menu item, in the menu's icon colour.
ui::ImageModel Icon(const gfx::VectorIcon& icon);

// A profile's picture as Perch shows it, round, `size` DIPs across: the one
// uploaded in Settings › Profile, or else Chromium's.
ui::ImageModel ProfilePicture(const base::FilePath& profile_path, int size);

// Runs `model` as a frosted Perch menu just below `anchor`, keeping the
// runner in `runner`. Every Perch toolbar menu opens this way.
void RunToolbarMenu(ui::MenuModel* model,
                    std::unique_ptr<views::MenuRunner>& runner,
                    views::View* anchor);

// Open the menus below `anchor`: the profile button, or the menu button.
void ShowPerchProfileMenu(BrowserWindowInterface* browser, views::View* anchor);
// True once it is open (Chromium's menu then stays closed).
bool ShowPerchAppMenu(BrowserWindowInterface* browser, views::View* anchor);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_TOOLBAR_PERCH_PROFILE_MENU_H_
