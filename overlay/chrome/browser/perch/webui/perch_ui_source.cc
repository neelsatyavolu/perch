// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_ui_source.h"

#include <string>
#include <utility>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/string_escape.h"
#include "base/memory/ref_counted_memory.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "content/public/browser/web_ui_data_source.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"

namespace perch {

namespace {

// Paths in ui/dist are plain: letters, digits, dots, dashes, underscores and
// slashes, never "..".
bool IsSafePath(std::string_view path) {
  if (path.empty() || path.front() == '/' ||
      path.find("..") != std::string_view::npos) {
    return false;
  }
  for (char c : path) {
    if (!base::IsAsciiAlphaNumeric(c) && c != '.' && c != '-' && c != '_' &&
        c != '/') {
      return false;
    }
  }
  return true;
}

std::string PathOnly(const std::string& path) {
  return path.substr(0, path.find_first_of("?#"));
}

// window.perchApp for the page (docs/design/webui-hosting.md). The token lives
// only in this script and the page's memory, never in an address.
std::string ConfigScript(bool side_panel) {
  const PerchdLauncher& launcher = PerchdLauncher::Get();
  std::string script = base::StringPrintf(
      "window.perchApp = Object.freeze({api: %s, token: %s, "
      "windowId: new URLSearchParams(location.search).get('window') || "
      "'main', theme: 'system', accent: 'blue'});\n",
      base::GetQuotedJSONString(launcher.ApiOrigin()).c_str(),
      base::GetQuotedJSONString(launcher.token()).c_str());
  if (side_panel) {
    // The panel view closes the panel on this same-document navigation
    // (perch_side_panel_controller.cc), and opens window.open in a tab.
    script +=
        "(() => { let n = 0; window.perchHost = Object.freeze({"
        "close() { location.replace('#perch-close-' + (++n)); },"
        "openTab(url) { window.open(url, '_blank', 'noopener'); }}); })();\n";
  }
  return script;
}

scoped_refptr<base::RefCountedMemory> ReadPage(base::FilePath file) {
  std::string data;
  if (!base::ReadFileToString(file, &data)) {
    return nullptr;
  }
  return base::MakeRefCounted<base::RefCountedString>(std::move(data));
}

bool ShouldHandle(const std::string& path) {
  return true;
}

void HandleRequest(const std::string& default_page,
                   bool side_panel,
                   const std::string& raw_path,
                   content::WebUIDataSource::GotDataCallback callback) {
  std::string path = PathOnly(raw_path);
  if (path.empty()) {
    path = default_page;
  }
  if (path == "config.js") {
    std::move(callback).Run(
        base::MakeRefCounted<base::RefCountedString>(ConfigScript(side_panel)));
    return;
  }
  if (!IsSafePath(path)) {
    std::move(callback).Run(nullptr);
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ReadPage, PerchdLauncher::Get().UiDir().Append(path)),
      std::move(callback));
}

}  // namespace

void ServePerchPages(content::WebUIDataSource* source,
                     std::string_view default_page,
                     bool side_panel) {
  PerchdLauncher::Get().MaybeStart();
  source->SetRequestFilter(
      base::BindRepeating(&ShouldHandle),
      base::BindRepeating(&HandleRequest, std::string(default_page),
                          side_panel));
  const std::string api = PerchdLauncher::Get().ApiOrigin();
  const std::string socket =
      api.empty() ? std::string()
                  : "ws" + api.substr(std::string_view("http").size());
  using Directive = network::mojom::CSPDirectiveName;
  source->OverrideContentSecurityPolicy(Directive::DefaultSrc,
                                        "default-src 'self';");
  source->OverrideContentSecurityPolicy(Directive::ScriptSrc,
                                        "script-src 'self';");
  source->OverrideContentSecurityPolicy(
      Directive::ConnectSrc,
      api.empty() ? "connect-src 'none';"
                  : base::StringPrintf("connect-src %s %s;", api.c_str(),
                                       socket.c_str()));
  source->OverrideContentSecurityPolicy(Directive::StyleSrc,
                                        "style-src 'self' 'unsafe-inline';");
  // Artifacts come from perchd's separate artifact origin on loopback.
  source->OverrideContentSecurityPolicy(
      Directive::ImgSrc, "img-src 'self' data: blob: http://127.0.0.1:*;");
  source->OverrideContentSecurityPolicy(Directive::FontSrc,
                                        "font-src 'self' data:;");
  source->OverrideContentSecurityPolicy(Directive::FrameSrc,
                                        "frame-src http://127.0.0.1:*;");
  source->DisableTrustedTypesCSP();
}

}  // namespace perch
