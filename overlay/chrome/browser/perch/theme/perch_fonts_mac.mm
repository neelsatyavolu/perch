// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/theme/perch_fonts_mac.h"

#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>
#import <Foundation/Foundation.h>

#include "base/apple/bundle_locations.h"
#include "base/apple/foundation_util.h"
#include "base/no_destructor.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/path_service.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/gfx/font_list.h"

namespace perch {

namespace {

bool g_mono = false;

base::FilePath FontsDir() {
  base::FilePath bundled = base::apple::FrameworkBundlePath()
                               .Append("Resources")
                               .Append("perch_fonts");
  if (base::DirectoryExists(bundled)) {
    return bundled;
  }
  // Development: out/<config>/Perch.app/Contents/MacOS/Perch, beside which
  // perch-build stage-extensions puts perch_fonts.
  base::FilePath exe;
  if (!base::PathService::Get(base::DIR_EXE, &exe)) {
    return base::FilePath();
  }
  return exe.DirName().DirName().DirName().Append("perch_fonts");
}

}  // namespace

void RegisterPerchFonts() {
  const base::FilePath dir = FontsDir();
  if (dir.empty() || !base::DirectoryExists(dir)) {
    return;
  }
  bool sans = false;
  base::FileEnumerator files(dir, /*recursive=*/false,
                             base::FileEnumerator::FILES,
                             FILE_PATH_LITERAL("*.ttf"));
  for (base::FilePath path = files.Next(); !path.empty();
       path = files.Next()) {
    NSURL* url = base::apple::FilePathToNSURL(path);
    if (!CTFontManagerRegisterFontsForURL(
            (__bridge CFURLRef)url, kCTFontManagerScopeProcess, nullptr)) {
      continue;
    }
    const std::string name = path.BaseName().value();
    if (name.starts_with("GeistMono-")) {
      g_mono = true;
    } else if (name.starts_with("Geist-")) {
      sans = true;
    }
  }
  if (sans) {
    gfx::FontList::SetDefaultFontDescription("Geist, 13px");
    if (ui::ResourceBundle::HasSharedInstance()) {
      ui::ResourceBundle::GetSharedInstance().ReloadFonts();
    }
  }
}

bool HasPerchMonoFont() {
  return g_mono;
}

void SetPerchDockIconForTheme(const std::string& theme) {
  const std::string want =
      theme == "sakura" || theme == "yozakura" ? theme : std::string();
  static base::NoDestructor<std::string> shown;
  if (want == *shown) {
    return;
  }
  *shown = want;
  NSImage* image = nil;
  if (!want.empty()) {
    const base::FilePath png = base::apple::FrameworkBundlePath()
                                   .Append("Resources")
                                   .Append("perch_pages")
                                   .Append("app-icons")
                                   .Append("app-" + want + ".png");
    image = [[NSImage alloc]
        initWithContentsOfFile:base::apple::FilePathToNSString(png)];
  }
  // Nil puts back the app's own icon.
  NSApp.applicationIconImage = image;
}

}  // namespace perch
