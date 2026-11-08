// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_built_in_policy.h"

#import <Foundation/Foundation.h>

#include "base/apple/foundation_util.h"
#include "base/apple/scoped_cftyperef.h"
#include "base/strings/sys_string_conversions.h"

namespace perch {

std::optional<bool> ForcedBuiltIn(std::string_view key) {
  CFStringRef domain = CFSTR("co.xanom.perch");
  CFStringRef name = CFSTR("BuiltInExtensions");
  if (!CFPreferencesAppValueIsForced(name, domain)) {
    return std::nullopt;
  }
  base::apple::ScopedCFTypeRef<CFPropertyListRef> value(
      CFPreferencesCopyAppValue(name, domain));
  NSDictionary* dict = base::apple::ObjCCast<NSDictionary>(
      (__bridge id)value.get());
  NSNumber* forced = base::apple::ObjCCast<NSNumber>(
      dict[base::SysUTF8ToNSString(std::string(key))]);
  if (!forced) {
    return std::nullopt;
  }
  return forced.boolValue;
}

}  // namespace perch
