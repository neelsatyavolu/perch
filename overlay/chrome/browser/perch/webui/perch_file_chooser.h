// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_FILE_CHOOSER_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_FILE_CHOOSER_H_

#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback_forward.h"
#include "base/values.h"

class Profile;

namespace content {
class WebContents;
}

namespace perch {

// Hands paths the person picked to perchd (POST /api/files), which keeps them
// and answers [{id, name, size}]; pages only ever hold the ids. Null on error.
void StorePickedFiles(Profile* profile,
                      std::vector<base::FilePath> paths,
                      base::OnceCallback<void(std::optional<base::ListValue>)> reply);

// Shows the open panel for one file, limited to `extensions` when not empty,
// then stores the pick in perchd. Replies {id, name}, or null when cancelled.
void ChooseOneFile(content::WebContents* contents,
                   const std::vector<std::string>& extensions,
                   base::OnceCallback<void(std::optional<base::Value>)> reply);

// The save or open panel for a path the browser itself reads or writes (a
// backup), never one a page sees. Replies nullopt when cancelled.
void ChooseSavePath(content::WebContents* contents,
                    const base::FilePath& suggested_name,
                    const std::string& extension,
                    base::OnceCallback<void(std::optional<base::FilePath>)> reply);
void ChooseOpenPath(content::WebContents* contents,
                    const std::string& extension,
                    base::OnceCallback<void(std::optional<base::FilePath>)> reply);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_FILE_CHOOSER_H_
