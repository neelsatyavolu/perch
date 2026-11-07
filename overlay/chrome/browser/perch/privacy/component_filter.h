// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PRIVACY_COMPONENT_FILTER_H_
#define CHROME_BROWSER_PERCH_PRIVACY_COMPONENT_FILTER_H_

namespace perch {

// Whether to register the Google components Perch leaves out (spec 5.1):
// optimization hints, privacy sandbox and trust token data, origin trials,
// safety tips, commerce and AI data, and the like. Perch keeps only CRLSet,
// certificate data, Widevine, the certificate error assistant, file type
// policies, hyphenation, Screen AI and on-device translation, which
// registration.cc registers unconditionally. False unless
// --perch-google-components is given, for comparing behaviour.
bool RegisterGoogleComponents();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PRIVACY_COMPONENT_FILTER_H_
