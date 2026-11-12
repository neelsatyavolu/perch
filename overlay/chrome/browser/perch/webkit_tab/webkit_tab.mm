// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webkit_tab/webkit_tab.h"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <algorithm>
#include <string>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/hash/sha1.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/perch/webkit_tab/webkit_tab_rules.h"
#include "chrome/browser/perch/webkit_tab/webkit_tab_state.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/favicon_status.h"
#include "content/public/browser/invalidate_type.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/page.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/page_transition_types.h"
#include "ui/gfx/image/image.h"
#include "url/gurl.h"

namespace {

// Netflix serves WebKit only to browsers that say they are Safari, as every
// WebKit browser on the Mac does. Use the installed Safari's version.
NSString* SafariApplicationName() {
  NSBundle* safari =
      [NSBundle bundleWithPath:@"/System/Volumes/Preboot/Cryptexes/App/System/"
                               @"Applications/Safari.app"]
          ?: [NSBundle bundleWithPath:@"/Applications/Safari.app"];
  NSString* version =
      [safari objectForInfoDictionaryKey:@"CFBundleShortVersionString"]
          ?: @"18.0";
  return [NSString stringWithFormat:@"Version/%@ Safari/605.1.15", version];
}

// One persistent WebKit store per Perch profile, so profiles keep separate
// Netflix sign-ins. Incognito tabs get a store that is never written to disk.
WKWebsiteDataStore* DataStoreFor(content::WebContents* web_contents) {
  Profile* profile =
      Profile::FromBrowserContext(web_contents->GetBrowserContext());
  if (profile->IsOffTheRecord()) {
    return [WKWebsiteDataStore nonPersistentDataStore];
  }
  std::string key = "perch-webkit-tab:" + profile->GetPath().BaseName().value();
  base::SHA1Digest digest = base::SHA1Hash(base::as_byte_span(key));
  uuid_t bytes;
  std::copy_n(digest.begin(), sizeof(bytes), bytes);
  bytes[6] = (bytes[6] & 0x0F) | 0x50;  // A name-based (version 5) UUID.
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  NSUUID* identifier = [[NSUUID alloc] initWithUUIDBytes:bytes];
  if (@available(macOS 14, *)) {
    return [WKWebsiteDataStore dataStoreForIdentifier:identifier];
  }
  return [WKWebsiteDataStore defaultDataStore];
}

// Finds the page's icon: the last <link rel=icon>, else /favicon.ico.
NSString* const kFindIconScript =
    @"(() => { const l = [...document.querySelectorAll('link[rel~=\"icon\"]')]"
    @".pop(); return new URL(l ? l.getAttribute('href') : '/favicon.ico', "
    @"location.href).href; })()";

}  // namespace

// Forwards WebKit's callbacks to the C++ WebKitTab. Owned by WebKitTab::Cocoa,
// which clears `owner` before WebKitTab goes away.
@interface PerchWebKitTabBridge
    : NSObject <WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, assign) perch::WebKitTab* owner;
@end

@implementation PerchWebKitTabBridge

@synthesize owner = _owner;

- (void)observeValueForKeyPath:(NSString*)keyPath
                      ofObject:(id)object
                        change:(NSDictionary*)change
                       context:(void*)context {
  WKWebView* webView = object;
  if (!_owner) {
    return;
  }
  if ([keyPath isEqualToString:@"title"]) {
    _owner->OnTitleChanged(base::SysNSStringToUTF16(webView.title ?: @""));
  } else if ([keyPath isEqualToString:@"URL"] && webView.URL) {
    _owner->OnURLChanged(GURL(base::SysNSStringToUTF8(webView.URL.absoluteString)));
  } else {
    // loading or hasOnlySecureContent.
    _owner->OnPageStateChanged(
        webView.loading,
        webView.hasOnlySecureContent && [webView.URL.scheme isEqual:@"https"]);
  }
}

- (void)webView:(WKWebView*)webView
    decidePolicyForNavigationAction:(WKNavigationAction*)action
                    decisionHandler:
                        (void (^)(WKNavigationActionPolicy))decisionHandler {
  GURL url(base::SysNSStringToUTF8(action.request.URL.absoluteString));
  bool top_level = action.targetFrame.isMainFrame;
  bool web = url.SchemeIsHTTPOrHTTPS();
  if (_owner && top_level && web && !perch::UsesWebKit(url)) {
    // Leaving Netflix: the rest of the web is Chromium's.
    decisionHandler(WKNavigationActionPolicyCancel);
    _owner->OpenInChromium(url, WindowOpenDisposition::kCurrentTab);
    return;
  }
  decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView*)webView
    didFinishNavigation:(WKNavigation*)navigation {
  __weak PerchWebKitTabBridge* weakSelf = self;
  [webView evaluateJavaScript:kFindIconScript
            completionHandler:^(id result, NSError* error) {
              NSURL* iconURL = [result isKindOfClass:[NSString class]]
                                   ? [NSURL URLWithString:result]
                                   : nil;
              if (iconURL) {
                [weakSelf loadIcon:iconURL];
              }
            }];
}

- (void)loadIcon:(NSURL*)iconURL {
  __weak PerchWebKitTabBridge* weakSelf = self;
  NSURLSessionDataTask* task = [NSURLSession.sharedSession
        dataTaskWithURL:iconURL
      completionHandler:^(NSData* data, NSURLResponse* response,
                          NSError* error) {
        NSImage* source = data ? [[NSImage alloc] initWithData:data] : nil;
        if (!source) {
          return;
        }
        // An .ico holds several sizes; draw one tab-sized icon (16 pt, with
        // a 2x bitmap) instead of handing Chromium the largest.
        NSImage* image = [NSImage
             imageWithSize:NSMakeSize(16, 16)
                   flipped:NO
            drawingHandler:^BOOL(NSRect rect) {
              [source drawInRect:rect];
              return YES;
            }];
        dispatch_async(dispatch_get_main_queue(), ^{
          PerchWebKitTabBridge* strongSelf = weakSelf;
          if (strongSelf && strongSelf.owner) {
            strongSelf.owner->OnFaviconLoaded(
                GURL(base::SysNSStringToUTF8(iconURL.absoluteString)),
                gfx::Image(image));
          }
        });
      }];
  [task resume];
}

// target=_blank and window.open become Perch tabs (Netflix ones come back to
// WebKit through the navigation throttle).
- (WKWebView*)webView:(WKWebView*)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration*)configuration
               forNavigationAction:(WKNavigationAction*)action
                    windowFeatures:(WKWindowFeatures*)windowFeatures {
  GURL url(base::SysNSStringToUTF8(action.request.URL.absoluteString));
  if (_owner && url.is_valid()) {
    _owner->OpenInChromium(url, WindowOpenDisposition::kNewForegroundTab);
  }
  return nil;
}

@end

namespace perch {

struct WebKitTab::Cocoa {
  WKWebView* __strong web_view;
  PerchWebKitTabBridge* __strong bridge;

  ~Cocoa() {
    bridge.owner = nullptr;
    [web_view removeObserver:bridge forKeyPath:@"title"];
    [web_view removeObserver:bridge forKeyPath:@"URL"];
    [web_view removeObserver:bridge forKeyPath:@"loading"];
    [web_view removeObserver:bridge forKeyPath:@"hasOnlySecureContent"];
    web_view.navigationDelegate = nil;
    web_view.UIDelegate = nil;
    [web_view stopLoading];
    [web_view removeFromSuperview];
  }
};

WebKitTab::WebKitTab(content::WebContents* web_contents)
    : content::WebContentsUserData<WebKitTab>(*web_contents),
      content::WebContentsObserver(web_contents),
      cocoa_(std::make_unique<Cocoa>()) {
  WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
  config.websiteDataStore = DataStoreFor(web_contents);
  config.applicationNameForUserAgent = SafariApplicationName();
  config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
  config.preferences.elementFullscreenEnabled = YES;
  config.preferences.fraudulentWebsiteWarningEnabled = NO;  // Perch's own.

  cocoa_->bridge = [[PerchWebKitTabBridge alloc] init];
  cocoa_->bridge.owner = this;
  WKWebView* web_view = [[WKWebView alloc] initWithFrame:NSZeroRect
                                           configuration:config];
  web_view.navigationDelegate = cocoa_->bridge;
  web_view.UIDelegate = cocoa_->bridge;
  web_view.allowsBackForwardNavigationGestures = YES;
  web_view.allowsMagnification = YES;
  web_view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  // Perch's own background while the page loads, not WebKit's white.
  web_view.underPageBackgroundColor = NSColor.windowBackgroundColor;
  [web_view addObserver:cocoa_->bridge
             forKeyPath:@"title"
                options:NSKeyValueObservingOptionNew
                context:nullptr];
  for (NSString* key in @[ @"URL", @"loading", @"hasOnlySecureContent" ]) {
    [web_view addObserver:cocoa_->bridge
               forKeyPath:key
                  options:NSKeyValueObservingOptionNew
                  context:nullptr];
  }
  web_contents->SetUserData(&kWebKitTabStateKey,
                            std::make_unique<WebKitTabState>());
  cocoa_->web_view = web_view;
}

// The tab state is left alone here: when the WebContents is being destroyed
// (closing the tab, quitting) web_contents() is already null and the
// WebContents frees the state itself. DetachSoon removes it otherwise.
WebKitTab::~WebKitTab() = default;

void WebKitTab::Load(const GURL& url) {
  active_ = true;
  url_ = url;
  NSURL* ns_url = [NSURL URLWithString:base::SysUTF8ToNSString(url.spec())];
  if (ns_url) {
    [cocoa_->web_view loadRequest:[NSURLRequest requestWithURL:ns_url]];
  }
  Attach();
}

void WebKitTab::Reload(bool bypass_cache) {
  active_ = true;
  if (bypass_cache) {
    [cocoa_->web_view reloadFromOrigin];
  } else {
    [cocoa_->web_view reload];
  }
  Attach();
}

void WebKitTab::OnTitleChanged(const std::u16string& title) {
  title_ = title;
  SyncEntry();
}

void WebKitTab::OnURLChanged(const GURL& url) {
  if (!url.is_valid()) {
    return;
  }
  url_ = url;
  SyncEntry();
}

void WebKitTab::OnPageStateChanged(bool loading, bool secure) {
  auto* state = static_cast<WebKitTabState*>(
      web_contents()->GetUserData(&kWebKitTabStateKey));
  if (!state || (state->loading == loading && state->secure == secure)) {
    return;
  }
  bool security_changed = state->secure != secure;
  state->loading = loading;
  state->secure = secure;
  web_contents()->NotifyNavigationStateChanged(
      static_cast<content::InvalidateTypes>(content::INVALIDATE_TYPE_LOAD |
                                            content::INVALIDATE_TYPE_TAB));
  if (security_changed) {
    web_contents()->DidChangeVisibleSecurityState();
  }
}

void WebKitTab::OnFaviconLoaded(const GURL& icon_url, const gfx::Image& image) {
  content::NavigationEntry* entry =
      web_contents()->GetController().GetLastCommittedEntry();
  if (!entry || image.IsEmpty()) {
    return;
  }
  content::FaviconStatus& favicon = entry->GetFavicon();
  favicon.valid = true;
  favicon.url = icon_url;
  favicon.image = image;
  web_contents()->NotifyNavigationStateChanged(content::INVALIDATE_TYPE_TAB);
}

void WebKitTab::OpenInChromium(const GURL& url,
                               WindowOpenDisposition disposition) {
  content::OpenURLParams params(url, content::Referrer(), disposition,
                                ui::PAGE_TRANSITION_LINK,
                                /*is_renderer_initiated=*/false);
  // Posted: this can replace the placeholder, which destroys this object.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> contents,
             content::OpenURLParams params) {
            if (contents) {
              contents->OpenURL(params, /*navigation_handle_callback=*/{});
            }
          },
          web_contents()->GetWeakPtr(), std::move(params)));
}

void WebKitTab::PrimaryPageChanged(content::Page& page) {
  const GURL& committed =
      page.GetMainDocument().GetLastCommittedURL();
  content::NavigationEntry* entry =
      web_contents()->GetController().GetLastCommittedEntry();
  bool ours = page.GetMainDocument().IsErrorDocument() && entry &&
              UsesWebKit(entry->GetURL());
  if (!ours && !UsesWebKit(committed)) {
    DetachSoon();
    return;
  }
  Attach();
  SyncEntry();
}

void WebKitTab::WebContentsDestroyed() {
  // From here web_contents() is null: stop WebKit calling back into this tab.
  cocoa_->bridge.owner = nullptr;
  [cocoa_->web_view stopLoading];
  [cocoa_->web_view removeFromSuperview];
}

void WebKitTab::RenderFrameHostChanged(content::RenderFrameHost* old_host,
                                       content::RenderFrameHost* new_host) {
  // A new renderer view can be stacked above the WKWebView; lift it again.
  if (new_host && new_host->IsInPrimaryMainFrame()) {
    Attach();
  }
}

void WebKitTab::OnWebContentsFocused(
    content::RenderWidgetHost* render_widget_host) {
  // Chromium focuses the placeholder when the tab is selected; the keyboard
  // belongs to the WebKit page.
  WKWebView* web_view = cocoa_->web_view;
  if (web_view.window && web_view.window.firstResponder != web_view) {
    [web_view.window makeFirstResponder:web_view];
  }
}

void WebKitTab::Attach() {
  NSView* host = web_contents()->GetNativeView().GetNativeNSView();
  WKWebView* web_view = cocoa_->web_view;
  if (!host) {
    return;
  }
  if (web_view.superview != host || host.subviews.lastObject != web_view) {
    [host addSubview:web_view positioned:NSWindowAbove relativeTo:nil];
  }
  web_view.frame = host.bounds;
}

void WebKitTab::SyncEntry() {
  content::NavigationEntry* entry =
      web_contents()->GetController().GetLastCommittedEntry();
  if (!entry || !UsesWebKit(entry->GetURL())) {
    return;
  }
  int changed = 0;
  if (!title_.empty() && entry->GetTitle() != title_) {
    entry->SetTitle(title_);
    changed |= content::INVALIDATE_TYPE_TITLE;
  }
  if (url_.is_valid() && entry->GetVirtualURL() != url_) {
    entry->SetVirtualURL(url_);
    changed |= content::INVALIDATE_TYPE_URL;
  }
  if (changed) {
    web_contents()->NotifyNavigationStateChanged(
        static_cast<content::InvalidateTypes>(changed));
  }
}

void WebKitTab::DetachSoon() {
  active_ = false;
  [cocoa_->web_view removeFromSuperview];
  [cocoa_->web_view stopLoading];
  // Posted: WebContentsObserver callbacks can't delete their observer. A
  // Netflix load in between (Load) keeps the object.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<WebKitTab> tab) {
                       if (tab && !tab->active_ && tab->web_contents()) {
                         content::WebContents* contents = tab->web_contents();
                         contents->RemoveUserData(&kWebKitTabStateKey);
                         contents->NotifyNavigationStateChanged(
                             content::INVALIDATE_TYPE_TAB);
                         contents->RemoveUserData(UserDataKey());
                       }
                     },
                     weak_factory_.GetWeakPtr()));
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(WebKitTab);

}  // namespace perch
