// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_DICTATION_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_DICTATION_H_

#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"

namespace perch {

// Dictation for the chat composer (plan 3b task 13), with macOS speech
// recognition held to on-device recognition: audio never leaves the Mac. A
// language without an on-device model says so instead of using a server.
class PerchDictation {
 public:
  // Words so far; `final` once speech ends.
  using TextCallback = base::RepeatingCallback<void(std::string text, bool final)>;
  // Null when listening started, else a sentence for the page.
  using StartedCallback =
      base::OnceCallback<void(std::optional<std::string> error)>;

  PerchDictation();
  PerchDictation(const PerchDictation&) = delete;
  PerchDictation& operator=(const PerchDictation&) = delete;
  ~PerchDictation();

  void Start(TextCallback on_text, StartedCallback started);
  void Stop();

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_DICTATION_H_
