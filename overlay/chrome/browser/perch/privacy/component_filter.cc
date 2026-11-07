// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/privacy/component_filter.h"

#include "base/command_line.h"

namespace perch {

bool RegisterGoogleComponents() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch(
      "perch-google-components");
}

}  // namespace perch
