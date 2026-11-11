// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/finish_sound.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <cmath>
#include <numbers>

#include "base/logging.h"
#include "base/no_destructor.h"

namespace perch {

namespace {

constexpr int kRate = 44100;

struct Note {
  double hz;
  double at;      // seconds
  double length;  // seconds
  double gain;
};

// Two notes a fifth apart, the second a beat later: the welcome page's soft
// sines (ui-pages/src/pages/welcome/sound.ts), short enough not to intrude.
constexpr Note kNotes[] = {
    {659.25, 0.0, 0.55, 0.16},
    {987.77, 0.09, 0.75, 0.12},
};

void PutLE(std::vector<uint8_t>& out, uint32_t value, int bytes) {
  for (int i = 0; i < bytes; ++i) {
    out.push_back(static_cast<uint8_t>((value >> (8 * i)) & 0xFF));
  }
}

}  // namespace

std::vector<uint8_t> FinishSoundWav() {
  double end = 0;
  for (const Note& note : kNotes) {
    end = std::max(end, note.at + note.length);
  }
  const int frames = static_cast<int>(end * kRate) + 1;
  std::vector<double> mix(frames, 0.0);
  for (const Note& note : kNotes) {
    const int start = static_cast<int>(note.at * kRate);
    const int count = static_cast<int>(note.length * kRate);
    const double attack = 0.012 * kRate;
    for (int i = 0; i < count && start + i < frames; ++i) {
      // A quick fade in, then an exponential fall: nothing clicks.
      const double t = static_cast<double>(i) / kRate;
      const double envelope =
          std::min(1.0, i / attack) * std::exp(-5.5 * t / note.length);
      mix[start + i] +=
          note.gain * envelope * std::sin(2 * std::numbers::pi * note.hz * t);
    }
  }
  std::vector<uint8_t> wav;
  const uint32_t data_bytes = static_cast<uint32_t>(frames) * 2;
  wav.insert(wav.end(), {'R', 'I', 'F', 'F'});
  PutLE(wav, 36 + data_bytes, 4);
  wav.insert(wav.end(), {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
  PutLE(wav, 16, 4);
  PutLE(wav, 1, 2);  // PCM
  PutLE(wav, 1, 2);  // mono
  PutLE(wav, kRate, 4);
  PutLE(wav, kRate * 2, 4);
  PutLE(wav, 2, 2);
  PutLE(wav, 16, 2);
  wav.insert(wav.end(), {'d', 'a', 't', 'a'});
  PutLE(wav, data_bytes, 4);
  for (double sample : mix) {
    const int16_t value = static_cast<int16_t>(
        std::lround(std::clamp(sample, -1.0, 1.0) * 32767));
    PutLE(wav, static_cast<uint16_t>(value), 2);
  }
  return wav;
}

void PlayFinishSound() {
  VLOG(1) << "Perch: finish chime";
  static base::NoDestructor<NSSound*> sound([] {
    const std::vector<uint8_t> wav = FinishSoundWav();
    NSData* data = [NSData dataWithBytes:wav.data() length:wav.size()];
    return [[NSSound alloc] initWithData:data];
  }());
  NSSound* chime = *sound;
  if (!chime) {
    return;
  }
  [chime stop];
  [chime play];
}

}  // namespace perch
