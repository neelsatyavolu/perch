// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/restore_flow.h"

#include <utility>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "chrome/browser/perch/keys/backup.h"
#include "chrome/browser/perch/keys/key_broker.h"

namespace perch {

namespace {

bool g_busy = false;

// Every file step runs here, one after another, and finishes even when the
// browser is quitting, so a folder is never left half moved.
scoped_refptr<base::SequencedTaskRunner> FileRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

struct Prepared {
  std::optional<std::string> error;
  std::optional<base::FilePath> staging;
};

// Checks the key and the backup without changing anything.
Prepared Prepare(const RestoreRequest& request) {
  Prepared out;
  const std::optional<bool> matches =
      CheckRootKey(request.profile_dir, request.key);
  if (!request.backup) {
    // The key alone must be the one the data on this Mac was made with.
    if (matches == false) {
      out.error = "wrong-key";
    }
    return out;
  }
  base::expected<base::FilePath, BackupError> staged =
      UnpackBackup(request.profile_dir, request.key, *request.backup);
  if (!staged.has_value()) {
    out.error = staged.error() == BackupError::kWrongKey    ? "wrong-key"
                : staged.error() == BackupError::kBadBackup ? "bad-backup"
                                                            : "failed";
    return out;
  }
  // Data made with another key goes only when the person said so.
  if (matches == false && !request.replace_data) {
    base::DeletePathRecursively(*staged);
    out.error = "replaces-data";
    return out;
  }
  out.staging = *staged;
  return out;
}

class Restore {
 public:
  Restore(RestoreRequest request,
          base::OnceCallback<void(std::optional<std::string>)> done)
      : request_(std::move(request)), done_(std::move(done)) {}

  // The checks only read, so perchd keeps running until something changes.
  void Start() {
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&Prepare, request_),
        base::BindOnce(&Restore::OnPrepared, base::Unretained(this)));
  }

 private:
  void OnPrepared(Prepared prepared) {
    if (prepared.error) {
      Finish(prepared.error);
      return;
    }
    staging_ = prepared.staging;
    PerchdLauncher::Get().Pause(
        base::BindOnce(&Restore::OnPaused, base::Unretained(this)));
  }

  void OnPaused() {
    old_key_ = KeyBroker::Get().RootKeyFor(request_.profile_dir);
    KeyBroker::Get().ImportRootKey(
        request_.profile_dir, request_.key,
        base::BindOnce(&Restore::OnImported, base::Unretained(this)));
  }

  void OnImported(std::optional<std::string> error) {
    if (error) {
      DropStaging();
      Finish(error);
      return;
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](RestoreRequest request,
               std::optional<base::FilePath> staging) {
              if (staging && !SwapInRestored(request.profile_dir, *staging)) {
                return false;
              }
              EnsureRootCheck(request.profile_dir, request.key);
              return true;
            },
            request_, staging_),
        base::BindOnce(&Restore::OnSwapped, base::Unretained(this)));
  }

  void OnSwapped(bool ok) {
    if (ok) {
      Finish(std::nullopt);
      return;
    }
    // The files stayed as they were, so the key they need goes back too.
    if (!old_key_) {
      Finish("failed");
      return;
    }
    KeyBroker::Get().ImportRootKey(
        request_.profile_dir, std::move(*old_key_),
        base::BindOnce(
            [](Restore* self, std::optional<std::string>) {
              self->Finish("failed");
            },
            base::Unretained(this)));
  }

  void DropStaging() {
    if (staging_) {
      FileRunner()->PostTask(
          FROM_HERE,
          base::BindOnce(base::IgnoreResult(&base::DeletePathRecursively),
                         *staging_));
    }
  }

  void Finish(std::optional<std::string> result) {
    g_busy = false;
    PerchdLauncher::Get().Resume();
    std::move(done_).Run(std::move(result));
    delete this;
  }

  RestoreRequest request_;
  base::OnceCallback<void(std::optional<std::string>)> done_;
  std::optional<base::FilePath> staging_;
  std::optional<std::vector<uint8_t>> old_key_;
};

}  // namespace

void RunRestore(RestoreRequest request,
                base::OnceCallback<void(std::optional<std::string>)> done) {
  if (g_busy) {
    std::move(done).Run("busy");
    return;
  }
  if (!KeyBroker::Get().HelperAvailable()) {
    std::move(done).Run("unavailable");
    return;
  }
  g_busy = true;
  (new Restore(std::move(request), std::move(done)))->Start();
}

void RunExport(base::FilePath profile_dir,
               std::vector<uint8_t> key,
               base::FilePath dest,
               base::OnceCallback<void(std::optional<std::string>)> done) {
  if (g_busy) {
    std::move(done).Run("busy");
    return;
  }
  g_busy = true;
  // perchd stops so its databases are whole in the copy.
  PerchdLauncher::Get().Pause(base::BindOnce(
      [](base::FilePath profile_dir, std::vector<uint8_t> key,
         base::FilePath dest,
         base::OnceCallback<void(std::optional<std::string>)> done) {
        FileRunner()->PostTaskAndReplyWithResult(
            FROM_HERE,
            base::BindOnce(&WriteBackup, profile_dir, std::move(key), dest),
            base::BindOnce(
                [](base::OnceCallback<void(std::optional<std::string>)> done,
                   bool ok) {
                  g_busy = false;
                  PerchdLauncher::Get().Resume();
                  std::move(done).Run(ok ? std::nullopt
                                         : std::optional<std::string>("failed"));
                },
                std::move(done)));
      },
      std::move(profile_dir), std::move(key), std::move(dest),
      std::move(done)));
}

}  // namespace perch
