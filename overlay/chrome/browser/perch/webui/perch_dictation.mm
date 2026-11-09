// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_dictation.h"

#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>

#include <utility>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/sequenced_task_runner.h"

namespace perch {

struct PerchDictation::State {
  SFSpeechRecognizer* __strong recognizer = nil;
  SFSpeechAudioBufferRecognitionRequest* __strong request = nil;
  SFSpeechRecognitionTask* __strong task = nil;
  AVAudioEngine* __strong engine = nil;
  bool listening = false;
  // Between Start and macOS answering the permission requests.
  bool starting = false;
  // Bumped by each Start, so a cancelled start's late answer is ignored.
  int generation = 0;
  StartedCallback pending_started;
  TextCallback on_text;
  base::WeakPtrFactory<State> weak_factory{this};

  void StopListening() {
    if (engine) {
      [engine stop];
      [engine.inputNode removeTapOnBus:0];
    }
    [request endAudio];
    listening = false;
  }

  // Runs on the UI thread once macOS has answered the authorization request.
  void Begin(StartedCallback started,
             SFSpeechRecognizerAuthorizationStatus status,
             bool microphone) {
    // Guard against a previous session left running.
    [task cancel];
    task = nil;
    if (listening) {
      StopListening();
    }
    if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
      std::move(started).Run(
          "Speech recognition is off for Perch in System Settings › Privacy");
      return;
    }
    // Without microphone access the audio engine still runs, on silence.
    if (!microphone) {
      std::move(started).Run(
          "The microphone is off for Perch in System Settings › Privacy");
      return;
    }
    recognizer = [[SFSpeechRecognizer alloc] initWithLocale:NSLocale.currentLocale];
    if (!recognizer || !recognizer.supportsOnDeviceRecognition) {
      std::move(started).Run(
          "This Mac can't recognize speech in your language without a server, "
          "so dictation is off");
      return;
    }
    request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    request.requiresOnDeviceRecognition = YES;
    request.shouldReportPartialResults = YES;
    engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* input = engine.inputNode;
    SFSpeechAudioBufferRecognitionRequest* feed = request;
    [input installTapOnBus:0
                bufferSize:1024
                    format:[input outputFormatForBus:0]
                     block:^(AVAudioPCMBuffer* buffer, AVAudioTime* when) {
                       [feed appendAudioPCMBuffer:buffer];
                     }];
    [engine prepare];
    NSError* error = nil;
    if (![engine startAndReturnError:&error]) {
      [input removeTapOnBus:0];
      std::move(started).Run("Perch can't use the microphone");
      return;
    }
    listening = true;
    scoped_refptr<base::SequencedTaskRunner> runner =
        base::SequencedTaskRunner::GetCurrentDefault();
    base::WeakPtr<State> self = weak_factory.GetWeakPtr();
    task = [recognizer
        recognitionTaskWithRequest:request
                     resultHandler:^(SFSpeechRecognitionResult* result,
                                     NSError* task_error) {
                       const std::string text =
                           result ? base::SysNSStringToUTF8(
                                        result.bestTranscription.formattedString)
                                  : std::string();
                       const bool final = !result || result.isFinal || task_error;
                       runner->PostTask(
                           FROM_HERE,
                           base::BindOnce(
                               [](base::WeakPtr<State> self, std::string text,
                                  bool final) {
                                 if (!self) {
                                   return;
                                 }
                                 if (self->on_text) {
                                   self->on_text.Run(text, final);
                                 }
                                 if (final) {
                                   self->StopListening();
                                 }
                               },
                               self, text, final));
                     }];
    std::move(started).Run(std::nullopt);
  }
};

PerchDictation::PerchDictation() : state_(std::make_unique<State>()) {}

PerchDictation::~PerchDictation() {
  Stop();
  [state_->task cancel];
}

void PerchDictation::Start(TextCallback on_text, StartedCallback started) {
  if (state_->listening || state_->starting) {
    std::move(started).Run("Dictation is already listening");
    return;
  }
  state_->on_text = std::move(on_text);
  state_->starting = true;
  state_->pending_started = std::move(started);
  const int generation = ++state_->generation;
  scoped_refptr<base::SequencedTaskRunner> runner =
      base::SequencedTaskRunner::GetCurrentDefault();
  base::WeakPtr<State> self = state_->weak_factory.GetWeakPtr();
  // Speech recognition first, then the microphone; each asks once.
  [SFSpeechRecognizer requestAuthorization:^(
                          SFSpeechRecognizerAuthorizationStatus status) {
    [AVCaptureDevice
        requestAccessForMediaType:AVMediaTypeAudio
                completionHandler:^(BOOL granted) {
                  runner->PostTask(
                      FROM_HERE,
                      base::BindOnce(
                          [](base::WeakPtr<State> self, int generation,
                             SFSpeechRecognizerAuthorizationStatus status,
                             bool microphone) {
                            // Stopped (or restarted) while macOS asked.
                            if (!self || !self->starting ||
                                self->generation != generation) {
                              return;
                            }
                            self->starting = false;
                            self->Begin(std::move(self->pending_started),
                                        status, microphone);
                          },
                          self, generation, status, granted == YES));
                }];
  }];
}

void PerchDictation::Stop() {
  if (state_->starting) {
    state_->starting = false;
    if (state_->pending_started) {
      std::move(state_->pending_started).Run("Dictation was cancelled");
    }
  }
  if (state_->listening) {
    state_->StopListening();
  }
}

}  // namespace perch
