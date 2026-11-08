// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_CREDENTIAL_FILL_H_
#define CHROME_BROWSER_PERCH_AGENT_CREDENTIAL_FILL_H_

#include "base/functional/callback_forward.h"
#include "chrome/browser/perch/agent/perch_domain_data.h"

namespace perch {

// Saved logins and cards for the agent (plan 3b task 7). Listings carry ids,
// usernames, the card network and last four digits, for the approval card;
// fills put the values into the page from the browser and reply with an
// outcome only, so no value reaches perchd or the model.
//
//   listLogins {targetId} -> {logins: [{loginId, username, origin}]}
//   fillLogin  {targetId, loginId} -> {result, fields}
//   listCards  {targetId} -> {cards: [{cardId, network, lastFour, expiry}]}
//   fillCard   {targetId, cardId} -> {result, fields}
// result is filled, no-form, needs-user or failed. fields is empty: filled
// inputs carry a data-perch-filled attribute instead.
void ListLogins(const base::DictValue& params,
                base::OnceCallback<void(DataResult)> reply);
void FillLogin(const base::DictValue& params,
               base::OnceCallback<void(DataResult)> reply);
DataResult ListCards(const base::DictValue& params);
void FillCard(const base::DictValue& params,
              base::OnceCallback<void(DataResult)> reply);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_CREDENTIAL_FILL_H_
