// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/settings/site_data.h"

#include <algorithm>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "chrome/browser/browsing_data/chrome_browsing_data_model_delegate.h"
#include "chrome/browser/profiles/profile.h"
#include "components/browsing_data/content/browsing_data_model.h"

namespace perch {

namespace {

constexpr size_t kMaxSites = 500;

struct Totals {
  uint64_t bytes = 0;
  uint64_t cookies = 0;
};

}  // namespace

void ListSiteData(Profile* profile,
                  base::OnceCallback<void(base::ListValue)> reply) {
  BrowsingDataModel::BuildFromDisk(
      profile, ChromeBrowsingDataModelDelegate::CreateForProfile(profile),
      base::BindOnce(
          [](base::OnceCallback<void(base::ListValue)> reply,
             std::unique_ptr<BrowsingDataModel> model) {
            std::map<std::string, Totals> sites;
            for (const auto& entry : *model) {
              const std::string host =
                  BrowsingDataModel::GetHost(*entry.data_owner);
              if (host.empty()) {
                continue;
              }
              Totals& totals = sites[host];
              totals.bytes += entry.data_details->storage_size;
              totals.cookies += entry.data_details->cookie_count;
            }
            std::vector<std::pair<std::string, Totals>> sorted(sites.begin(),
                                                               sites.end());
            std::ranges::sort(sorted, [](const auto& a, const auto& b) {
              return a.second.bytes > b.second.bytes;
            });
            base::ListValue list;
            for (const auto& [host, totals] : sorted) {
              if (list.size() >= kMaxSites) {
                break;
              }
              list.Append(base::DictValue()
                              .Set("host", host)
                              .Set("bytes", static_cast<double>(totals.bytes))
                              .Set("cookies", static_cast<int>(totals.cookies)));
            }
            std::move(reply).Run(std::move(list));
          },
          std::move(reply)));
}

}  // namespace perch
