// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_update_policy.h"

#import <Foundation/Foundation.h>

#include "base/apple/foundation_util.h"
#include "base/apple/scoped_cftyperef.h"
#include "base/strings/sys_string_conversions.h"
#include "base/version.h"

namespace perch {

namespace {

// The forced value of `key` in co.xanom.perch, or nil.
id Forced(CFStringRef key) {
  CFStringRef domain = CFSTR("co.xanom.perch");
  if (!CFPreferencesAppValueIsForced(key, domain)) {
    return nil;
  }
  base::apple::ScopedCFTypeRef<CFPropertyListRef> value(
      CFPreferencesCopyAppValue(key, domain));
  return (__bridge_transfer id)value.release();
}

}  // namespace

UpdatePolicy ReadUpdatePolicy() {
  UpdatePolicy policy;
  if (NSNumber* on = base::apple::ObjCCast<NSNumber>(
          Forced(CFSTR("AutoUpdateEnabled")))) {
    policy.auto_update = on.boolValue;
  }
  if (NSString* channel =
          base::apple::ObjCCast<NSString>(Forced(CFSTR("UpdateChannel")))) {
    if ([channel isEqualToString:@"stable"] ||
        [channel isEqualToString:@"beta"]) {
      policy.channel = base::SysNSStringToUTF8(channel);
    }
  }
  if (NSNumber* days =
          base::apple::ObjCCast<NSNumber>(Forced(CFSTR("UpdateDelayDays")))) {
    if (days.intValue >= 0 && days.intValue <= 30) {
      policy.delay_days = days.intValue;
    }
  }
  if (NSString* minimum =
          base::apple::ObjCCast<NSString>(Forced(CFSTR("MinimumVersion")))) {
    const std::string value = base::SysNSStringToUTF8(minimum);
    if (base::Version(value).IsValid()) {
      policy.minimum_version = value;
    }
  }
  return policy;
}

bool ShouldOffer(const UpdatePolicy& policy,
                 base::Time published,
                 const std::string& channel,
                 base::Time now) {
  if (!channel.empty() && channel != "stable" && channel != policy.channel) {
    return false;
  }
  return policy.delay_days == 0 ||
         now - published >= base::Days(policy.delay_days);
}

bool BelowMinimumVersion(const UpdatePolicy& policy,
                         const std::string& running) {
  if (!policy.minimum_version) {
    return false;
  }
  const base::Version have(running);
  const base::Version need(*policy.minimum_version);
  return have.IsValid() && need.IsValid() && have < need;
}

}  // namespace perch
