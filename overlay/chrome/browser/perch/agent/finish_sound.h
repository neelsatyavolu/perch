// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_FINISH_SOUND_H_
#define CHROME_BROWSER_PERCH_AGENT_FINISH_SOUND_H_

#include <cstdint>
#include <vector>

namespace perch {

// A short, soft chime when a chat's task finishes, played once by the browser
// (not by each open chat page).
void PlayFinishSound();

// The chime as a 16-bit mono WAV file, for PlayFinishSound and tests.
std::vector<uint8_t> FinishSoundWav();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_FINISH_SOUND_H_
