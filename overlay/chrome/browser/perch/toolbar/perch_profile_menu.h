// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_TOOLBAR_PERCH_PROFILE_MENU_H_
#define CHROME_BROWSER_PERCH_TOOLBAR_PERCH_PROFILE_MENU_H_

#include <memory>
#include <vector>

#include "base/files/file_path.h"
#include "base/memory/raw_ptr.h"
#include "ui/menus/simple_menu_model.h"

class BrowserWindowInterface;

namespace views {
class View;
}

namespace perch {

// The menu behind the toolbar's profile button (spec 5.3): the profiles,
// then Bookmarks, Downloads, Extensions, History and Developers, then
// Settings, New Tab and Incognito Window. It replaces Chromium's profile
// bubble.
class PerchProfileMenuModel : public ui::SimpleMenuModel,
                              public ui::SimpleMenuModel::Delegate {
 public:
  explicit PerchProfileMenuModel(BrowserWindowInterface* browser);
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

  raw_ptr<BrowserWindowInterface> browser_;
  // The profile each profile row switches to, by row.
  std::vector<base::FilePath> profiles_;
  std::unique_ptr<ui::SimpleMenuModel> developers_;
};

// Opens the menu below `anchor`, the profile button.
void ShowPerchProfileMenu(BrowserWindowInterface* browser, views::View* anchor);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_TOOLBAR_PERCH_PROFILE_MENU_H_
