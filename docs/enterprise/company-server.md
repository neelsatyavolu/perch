# Running a company sync server

A company can run its own copy of Perch's sync server. It is the same Cloudflare Worker that serves Perch's hosted sync, set to company mode: people sign in through your identity provider with OpenID Connect, email and passkey sign-in are turned off, and admins can list and remove devices.

## What the server can and cannot see

The company server holds ciphertext only, exactly as Perch's hosted server does. Perch encrypts bookmarks, history, tabs, settings, memory, skills, chats and artifacts on the Mac before they leave it, with a sync key the server never receives. The server stores that ciphertext with its size, timestamps and device ids.

Admins cannot read synced data. The admin tools show each device's name, kind (browser or command line), when it was added and last seen, whether it was removed, and the email of the account it belongs to. Nothing else.

## Before you start

You need:

- A Cloudflare account with Workers, D1, R2 and Durable Objects, and a hostname on a zone in that account, such as `perch-sync.example.com`.
- Admin access to your identity provider, to register an app.
- A clone of the Perch repository and [Bun](https://bun.sh).

## 1. Register Perch with your identity provider

Create a web app (confidential client) that uses the authorization code flow with a client secret. Perch always sends a PKCE challenge (S256), so you can require PKCE if your provider offers that.

Register this redirect URI, with your hostname:

```
https://perch-sync.example.com/v1/auth/oidc/callback
```

Note the issuer URL, the client id and the client secret. To give some people admin tools, have the provider put a `groups` claim in the ID token and pick the group whose members are admins. Provider steps are below.

Only people the provider lets into this app can sign in, so limit the app to the people who should use Perch.

## 2. Configure the Worker

In `server/wrangler.jsonc`:

1. Change the hostnames in `routes` to yours. The same Worker serves the API and the relay (`/v1/relay`), so one hostname is enough.
2. Set `API_ORIGIN` to `https://perch-sync.example.com`. It must be the origin of the redirect URI you registered.
3. Set `RP_NAME` to the name Perch should show for this server, such as `Acme Perch`. `RP_ID` and `PASSKEY_ORIGINS` are not used in company mode but must still be set; your hostname is fine.
4. Uncomment the company settings under `vars` and fill them in:

| Setting | Value |
|---|---|
| `AUTH_MODE` | `company` |
| `OIDC_ISSUER` | The issuer URL, exactly as your provider's discovery document gives it (the `issuer` field of `<issuer>/.well-known/openid-configuration`). It must be https. |
| `OIDC_CLIENT_ID` | The client id. |
| `OIDC_ADMIN_GROUP` | The value of the `groups` claim that marks an admin. Leave it out to have no admins. |

The client secret is never a var. You add it as a Worker secret in the next step.

Any `AUTH_MODE` value other than `public` or `company` makes the server refuse every request, so a typo cannot leave email sign-up open.

## 3. Deploy

From the `server` folder, signed in to Cloudflare with `bunx wrangler login`:

```sh
cd server
bun install
bunx wrangler d1 create perch            # put the printed database_id in wrangler.jsonc
bunx wrangler r2 bucket create perch-sync
bunx wrangler d1 migrations apply perch --remote
bunx wrangler secret put OIDC_CLIENT_SECRET
bunx wrangler deploy
```

`wrangler secret put` asks for the value; paste the client secret there, not on the command line, so it stays out of your shell history.

To check the server, open `https://perch-sync.example.com/v1/server`. It should answer `{"auth":["oidc"],"name":"Acme Perch"}`.

For later releases, run `bunx wrangler d1 migrations apply perch --remote` when there are new migrations, then `bunx wrangler deploy`.

## 4. Point Perch at the server

Set `SyncServerURL` in the configuration profile for `co.xanom.perch` (see [deploying.md](deploying.md)):

```xml
<key>SyncServerURL</key>
<string>https://perch-sync.example.com</string>
```

Perch asks the server which sign-in it offers and shows sign-in through your company. The person signs in like this:

1. Perch opens a sign-in page in a tab and shows a two-digit number.
2. The page asks for that number. A wrong number cancels the sign-in. This stops someone from sending a sign-in link to a colleague and getting the colleague's account on their own device.
3. The page sends them to your identity provider. When they finish there, the page says "Perch is signed in. You can close this tab." and Perch picks up the session.

The page sets one short-lived cookie, which ties the provider's answer to the browser that typed the number.

## Provider setup

### Okta

1. In the Admin Console, go to Applications > Applications > Create App Integration, choose OIDC - OpenID Connect and Web Application.
2. Add the redirect URI as a sign-in redirect URI. Keep Authorization Code as the grant type and Client secret as the client authentication.
3. Under Assignments, assign the groups that should use Perch.
4. Turn on the groups claim. Where depends on which authorization server you use:
   - Org authorization server (issuer `https://<your-okta-domain>`): on the app's Sign On tab, edit OpenID Connect ID Token and set Groups claim type to Filter, the claim name to `groups`, and a filter that matches your admin group, such as Equals `perch-admins`. Perch asks for the `groups` scope because this server lists it.
   - Custom authorization server (issuer such as `https://<your-okta-domain>/oauth2/default`): go to Security > API > Authorization Servers, open the server, and on Claims add a claim named `groups`, included in the ID token always, value type Groups, with a filter for your admin group. Set it to be included in any scope, since Perch asks for `groups` only when the server lists that scope.
5. Set `OIDC_ADMIN_GROUP` to the group's name, such as `perch-admins`.

### Microsoft Entra ID

1. In the Entra admin center, go to App registrations > New registration. Add the redirect URI with the Web platform.
2. Under Certificates & secrets, add a client secret. Entra secrets expire, so note the date and replace it with `wrangler secret put OIDC_CLIENT_SECRET` before then.
3. Set `OIDC_ISSUER` to `https://login.microsoftonline.com/<tenant-id>/v2.0`, with your directory (tenant) id. Do not use `common` or `organizations`; their issuer does not match the tokens. `OIDC_CLIENT_ID` is the Application (client) ID.
4. Under Token configuration, choose Add groups claim. Pick Groups assigned to the application (or Security groups), and under ID choose Group ID.
5. Set `OIDC_ADMIN_GROUP` to the admin group's Object ID, a GUID such as `5f6d…`. Entra puts group object ids in the claim, not names, for groups created in the cloud.
6. To limit who can sign in, open the app under Enterprise applications, set Assignment required to Yes in Properties, and assign users or groups.

Two things to know:

- If a person belongs to more than 200 groups, Entra leaves the `groups` claim out of the ID token. Perch then treats them as not an admin. Choosing Groups assigned to the application in step 4 avoids this. Assigning groups to an app needs Microsoft Entra ID P1 or P2.
- Entra includes `email` only for people with a mailbox address. Add `email` as an optional claim under Token configuration if you want it; otherwise Perch shows the user principal name. The email is for display only.

Perch does not ask Entra for a `groups` scope, because Entra does not list it; the claim comes from the token configuration above.

### Google Workspace

1. In the Google Cloud console, open a project owned by your Workspace organization.
2. Under APIs & Services > OAuth consent screen, set the user type to Internal. This limits sign-in to accounts in your Workspace. With External, any Google account could sign in and get an account on your server.
3. Under Credentials, create an OAuth client ID of type Web application and add the redirect URI under Authorized redirect URIs.
4. Set `OIDC_ISSUER` to `https://accounts.google.com` and `OIDC_CLIENT_ID` to the client id.

Google's ID tokens do not include group membership, and Google has no setting to add it. People can sign in and sync, but with Google as the provider nobody is an admin. If you need admins, sign Perch in through a provider that puts groups in the ID token: Okta or Microsoft Entra ID if your company also uses one, or a broker that reads Google group membership through the Admin SDK Directory API and adds a `groups` claim. Then use that provider's issuer, client id and secret instead.

## Admin tools

An admin is someone whose ID token, checked at sign-in, has `OIDC_ADMIN_GROUP` in its `groups` claim. Admin rights belong to that one session, on a Perch browser, for 12 hours. After that the person signs in through the company again to use them; their sync keeps working either way. A command-line device never gets admin tools, and a device added by pairing does not inherit them.

The admin routes are:

- `GET /v1/admin/devices` lists every device on the server with its account email, name, kind, dates and whether it was removed.
- `DELETE /v1/admin/devices/<id>` removes a device: its sessions and its copy of the sync key are deleted, and its relay connection is closed at once.

When someone leaves, remove them at your identity provider and remove their devices here. Removing them at the provider stops new sign-ins, but a device that is already signed in keeps its session until an admin removes the device.

## Other notes

- The account is tied to the provider's issuer and subject (`iss` and `sub`), not to the email. Someone whose email changes at the provider keeps the same account.
- Pairing a new device from a signed-in one works as on the hosted server.
- Deleting an account from Perch needs a code sent by email. To allow that, set up email as in `server/README.md` (`RESEND_API_KEY` and `MAIL_FROM`). Without it, an admin removes the person's devices instead.
- The server keeps its own logs free of personal data: route, status and timing only. Failed sign-ins are logged with a reason code, such as `bad_nonce`, and nothing about the person.
