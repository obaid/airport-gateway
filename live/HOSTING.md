# Host Airport for multiple owners

A hosted Airport installation serves multiple users from one Node process. Each account has its own SQLite database. Owners sign in on one hostname and their agents connect to a second hostname. Keep the repository's `live/` and `dist/` directories together. The service reads its UI assets and offline toolkit directory from both.

If you run a modified version, give everyone who interacts with it remotely a prominent way to download its corresponding source at no charge. For example, link to the exact release you deployed from the console and the agent setup guide. Keep operator secrets and customer data outside the source archive. [AGPL section 13](../LICENSE)

## Deploy on Render

You need a fork of this repository, a Render account, a domain where you can create two DNS records and a [Composio project API key](https://platform.composio.dev/). The steps below use Airport's email-code sign-in and a Cloudflare email relay. For self-service signup, Cloudflare requires its Workers Paid plan to send codes to arbitrary recipients. For a private test it also supports preverified destination addresses. The web hosts can use DNS-only records with native Airport sign-in. [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)

1. Choose two hostnames you control, such as `app.example.com` for people and `mcp.example.com` for agents. For email sign-in, onboard a sending subdomain and deploy the [sign-in relay](#send-sign-in-codes) first. Keep its URL and relay secret. For a team already using Cloudflare Access, you can [use its identity provider](#use-cloudflare-access-instead) in place of email.
2. Generate a **separate tenant secret** with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. Save it in your secrets manager. The same value is required after every restart and restore.
3. In Render choose **New → Blueprint**, grant its Git integration access to your fork, select the branch and use [render.yaml](../render.yaml) from the root. The Blueprint runs one paid Node service with a 1 GB persistent disk mounted at `/var/data/airport`. Review your selected plan and disk charges before applying. For a manual service, leave **Root Directory** blank, use `npm ci --prefix live` as the build command, `node live/hosted.mjs` as the start command, and `/healthz` as the health check. Use the same runtime, environment and disk as the Blueprint. [Blueprint setup](https://render.com/docs/infrastructure-as-code) · [Render disks](https://render.com/docs/disks)
4. Fill in the Blueprint prompts using the table below. The Blueprint sets `AIRPORT_SIGNUP_MODE=open` for self-service registration. Choose `invite` in your fork if only invited users should register. Apply the Blueprint and wait for Render to mark the deployment live.
5. In the service's **Settings → Custom Domains**, add both hostnames. At your authoritative DNS provider, create CNAME records for `app` and `mcp` pointing at the same Render-assigned hostname, such as `your-service.onrender.com`. With Cloudflare DNS, use **DNS only** until Render verifies both domains and issues both certificates. If you later enable proxying, use **Full (strict)** TLS with the verified origin. Leave the agent host available to bearer-authenticated clients. [Custom domains](https://render.com/docs/custom-domains) · [Cloudflare DNS with Render](https://render.com/docs/configure-cloudflare-dns)
6. Open the custom owner hostname, verify your email, choose a display name and finish signup. On an invitation-only installation, [bootstrap the first administrator](#customer-accounts) following email verification. Follow [Configure app sign-in](#configure-app-sign-in-once) and [Verify a deployment](#verify-a-deployment) before inviting anyone. For local state you want to bring with you, use the [migration guide](MIGRATION.md).

| Blueprint prompt | Value on your installation |
| --- | --- |
| `AIRPORT_OWNER_ORIGIN` | `https://app.example.com`, root of the browser console |
| `AIRPORT_AGENT_BASE` | `https://mcp.example.com`, optionally followed by a stable path such as `/v1` |
| `AIRPORT_AUTH_MODE` | `email` for the relay instructions below |
| `AIRPORT_EMAIL_RELAY_URL` | Full HTTPS Worker URL ending in `/sign-in` |
| `AIRPORT_EMAIL_RELAY_SECRET` | Same value as the Worker's `RELAY_SECRET` |
| `AIRPORT_TENANT_SECRET` | Stable tenant secret generated in step 2 |
| `COMPOSIO_API_KEY` | Operator's Composio project API key. Every user authorizes their own accounts. |

## Network and identity

1. Choose stable URLs. For example, publish the owner console at `https://app.example.com` and the agent gateway at `https://mcp.example.com/v1`. The owner UI needs the root of its own origin. The agent base can include a path prefix.
2. For the native sign-in page, set `AIRPORT_AUTH_MODE=email` and choose one of the mail transports below. Both verify the same eight-digit code, which expires after ten minutes and allows five guesses. A successful sign-in creates a revocable 14-day session in a Secure, HttpOnly, host-only cookie. Sign-out revokes the server-side session.
3. Route both hosts to the Node listener, preserving the original Host and path. On the agent host, publish the configured prefix followed by `/gateway/`. An agent request requires a workspace bearer credential. Apply edge rate limits to enrollment and pairing routes.
4. Terminate TLS at the proxy and keep the Node listener private. By default it binds to `127.0.0.1:8080`. A private container may set `HOST=0.0.0.0` and configure its ingress to reach that port. Preserve `Authorization` on agent requests. Configure proxy logs to omit query strings, authorization headers, invitation bodies and OAuth callback parameters.

### Send sign-in codes

1. In Cloudflare, open **Email Service → Email Sending** and onboard a dedicated subdomain such as `auth.example.com`. Complete its DNS verification and wait until sending is enabled. Use an address on that subdomain, such as `signin@auth.example.com`. The domain used for sending needs Cloudflare DNS. [Start sending email](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [Sending subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/)
2. From the gateway repository root, prepare the Worker config.

   ```sh
   cd workers/sign-in-email
   cp wrangler.example.jsonc wrangler.jsonc
   ```

3. Edit your local `wrangler.jsonc`. Set `name` to the Worker you want to deploy. Set **both** `vars.AIRPORT_EMAIL_FROM` and the `EMAIL` binding's `allowed_sender_addresses` to your verified lowercase sender. The secret stays outside the config file.
4. Generate the relay secret with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"` and save the resulting 43-character string in a secrets manager. Run the following from the Worker directory. Paste that string when Wrangler prompts for `RELAY_SECRET`.

   ```sh
   npx wrangler@4 login
   npx wrangler@4 deploy
   npx wrangler@4 secret put RELAY_SECRET
   ```

5. Copy the HTTPS Worker URL printed by Wrangler, append `/sign-in` and use it for Render's `AIRPORT_EMAIL_RELAY_URL`. Enter the same relay secret in Render's `AIRPORT_EMAIL_RELAY_SECRET`. The Worker accepts a signed POST from Airport and sends a fixed sign-in template. Finish the test by receiving a code from your hosted console.

If upgrading an existing relay, use its current Worker name, verified sender and relay secret when preparing the local config. Set the sender in both places before your first redeployment.

**Direct email API alternative.** You can send through the Cloudflare REST API without a Worker. Before creating the Blueprint, replace its two relay environment entries with `AIRPORT_EMAIL_FROM`, `AIRPORT_EMAIL_ACCOUNT_ID` and `AIRPORT_EMAIL_API_TOKEN`, each using `sync: false`. On an existing service remove both relay entries completely and set the three direct-delivery values together. Set the sender to your verified address, use the account ID of the sending domain, and scope the token to email sending on that account. [Cloudflare Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)

### Use Cloudflare Access instead

For a private deployment with an existing identity provider, replace the Blueprint's two relay entries with `CF_ACCESS_ISSUER` and `CF_ACCESS_AUD`. Set `AIRPORT_AUTH_MODE=access`. In Cloudflare Zero Trust, add a self-hosted Access application for the **owner** hostname, with an allow policy for your intended users. Proxy that hostname through Cloudflare after Render has verified its certificate. Use your team origin (such as `https://your-team.cloudflareaccess.com`) for the issuer and the application’s audience tag for the audience. Access forwards `Cf-Access-Jwt-Assertion`. Airport verifies its signature, issuer, audience, expiration and human identity. Keep the agent hostname outside this browser sign-in policy so agents can authenticate with their Airport bearer. [Cloudflare Access setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

### Moving a Cloudflare Access installation to email sign-in

1. Keep a consistent backup of the registry and tenant databases. Preserve the tenant secret, Composio project, disk, hostnames and existing bootstrap administrator pair. The account registry maps each customer’s previously verified address to the original tenant. For deployments predating the account registry, have each legacy owner open Airport through Access first so Airport can record that mapping. For the operator’s own legacy workspace, the explicitly configured verified address and tenant key also support enrollment.
2. Deploy the new server with the current Access configuration. Configure and verify your sending domain and relay. Set the mail credentials and `AIRPORT_AUTH_MODE=email` together, leaving the existing edge policy in place for the first native sign-in. The origin now requires its own session and ignores Access assertions.
3. Sign in through Airport with the owner’s previously verified email and check the original account key, role, workspaces and an existing agent URL. Use a signed-out browser to confirm that `/api/account` and `/api/state` are protected. Remove the old Access applications for the console hostname and any path-specific exceptions. Visit the console again in a fresh browser and confirm it goes straight to Airport sign-in.

## Runtime and persistent storage

### Customer accounts

Set `AIRPORT_SIGNUP_MODE=open` for self-service registration. New customers verify their email and choose a display name to create their account. Each account gets independent Personal and Work workspaces and the member role. Use `AIRPORT_SIGNUP_MODE=invite` for invitations bound to particular verified addresses.

To create the first administrator, verify your own email on the owner hostname. In that signed-in browser, visit `/api/account` and copy `identity.accountKey`. This is available after identity verification, including on an invitation-only installation. In the Render service environment, set `AIRPORT_BOOTSTRAP_OWNER_EMAIL` to the verified address and `AIRPORT_BOOTSTRAP_OWNER_TENANT` to its exact 64-character tenant key. Redeploy and reopen the console with the same identity. The **Admin** navigation item should appear. Include the account registry (`accounts.sqlite3`), authentication data (`authentication.sqlite3`) and the tenant databases in consistent backups, with the stable tenant secret stored separately.

The configured owner can open **Admin** at `/admin` to see registered users, workspaces, active connections, and active agent credentials. The integration ranking counts active connections. Agent and tool rankings count successful calls to connected apps in the past 30 days, using retained activity that identifies the caller as an agent. Each refresh reads aggregate counts from the platform’s own databases.

### Public beta

The public service includes 1,000 successful agent actions per account from November 22 through December 21, 2026 (Pacific). The allowance is shared by all workspaces and agents. The signed-in account menu links to `/billing`, which shows usage by workspace. Reaching the allowance pauses further agent actions that would call an app. Discovery, managing permissions and reviewing Activity stay available. While free access continues after the launch period, the allowance renews in 30-day windows. Paid service requires a separate opt-in.

The hosted entry point enables the public beta on `https://app.airport.so`. Set `AIRPORT_PUBLIC_BETA=1` to exercise the same limits on a staging host. Other hosts default to their existing unrestricted configuration.

The administrator's beta report keeps the original launch dates for analysis. Activation measures new accounts that made a successful agent request within 24 hours, among signups with a full day of observation. Week-two retention measures people who used an agent in their first week and used it again in their second, among signups with two complete weeks of observation. Accounts that never connect an app are included in the activation denominator.

The customer allowance counts successful agent actions. When reviewing operating costs, use the provider-attempt count to help reconcile Composio project usage and its billing dashboard. Owner tests and dispatched failures can incur costs. Setup verification, separately priced tools and service fees can also affect the invoice. Enforcing a dollar budget for the shared Composio project requires its own spending controls.

### Run with your own process manager

The Blueprint pins Node.js 24. The package requires Node.js 22.16 or later with built-in `node:sqlite` support. From the repository root, install the locked dependency and run the isolated tests.

```sh
cd live
npm ci
npm test
```

For a browser check of sign-in, code verification, explicit signup and logout, run `npx playwright-core install chromium` and `npm run test:browser` from `live/`. Alternatively set `AIRPORT_TEST_CHROMIUM` to the path of an installed Chrome or Chromium executable. This test uses OpenSSL for a temporary local HTTPS certificate and an in-memory test mailbox.

Create a private persistent directory owned by the Airport service account, such as `/var/lib/airport`, with mode `0700`. Store secrets separately from the repository and database volume. Generate the stable tenant key once. This example writes an environment file directly into an existing private secrets directory and refuses to replace a file.

```sh
node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  import { writeFileSync } from "node:fs";
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(process.argv[1], "AIRPORT_TENANT_SECRET="+secret+"\n", {mode:0o600,flag:"wx"});
' /private/airport-secrets/tenant.env
```

Configure the process environment through your service manager or secrets manager.

| Variable | Value |
| --- | --- |
| `AIRPORT_OWNER_ORIGIN` | Dedicated HTTPS console origin, e.g. `https://app.example.com`. |
| `AIRPORT_AGENT_BASE` | Canonical HTTPS gateway base, e.g. `https://mcp.example.com/v1`. Airport appends `/gateway/<tenant>`. |
| `AIRPORT_AUTH_MODE` | `email` for native sign-in or `access` for an Access-protected console. |
| `AIRPORT_EMAIL_RELAY_URL`, `AIRPORT_EMAIL_RELAY_SECRET` | Native sign-in using the Worker relay. |
| `AIRPORT_EMAIL_FROM`, `AIRPORT_EMAIL_ACCOUNT_ID`, `AIRPORT_EMAIL_API_TOKEN` | Native sign-in using direct Cloudflare delivery. |
| `CF_ACCESS_ISSUER` | Access mode only. Exact team origin, e.g. `https://your-team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | Access mode only. Audience tag of the owner Access application. |
| `AIRPORT_HOSTED_DATA_DIR` | Absolute durable volume path, e.g. `/var/lib/airport`. |
| `AIRPORT_TENANT_SECRET` | Stable base64url secret with at least 32 random bytes. |
| `COMPOSIO_API_KEY` | Airport's private Composio project API key, provisioned once by the platform operator. |
| `AIRPORT_AUTH_CONFIGS_JSON` | Optional toolkit-to-project-config map such as `{"gmail":"ac_yourGmailConfig","custom_crm":"ac_yourCRMConfig"}`. |
| `AIRPORT_COMPOSIO_VERIFIER_PATH` | Optional project verification callback path, e.g. `/oauth/verify`. See below. |
| `HOST`, `PORT` | Optional private listener address and port. |

With the required values injected, start the service from `live/` using `npm start`. If the service manager injects everything except the tenant secret generated above, launch `node --env-file=/private/airport-secrets/tenant.env hosted.mjs`. Configure the supervisor to restart the process after a crash or machine reboot.

Each owner gets a database under `AIRPORT_HOSTED_DATA_DIR/tenants/`. Existing registered customers keep their namespace when switching from Access to the same verified email. New native accounts derive their namespace from the tenant secret and canonical verified email. Access-mode tenants derive theirs from the secret, issuer and immutable subject. Back up the stable tenant secret and configuration privately. Keep a single active writer process per disk. Render briefly stops a disk-backed service during redeployment. [Persistent disk behavior](https://render.com/docs/disks)

### Back up and restore

1. Back up the **whole** mounted directory, including `accounts.sqlite3`, `authentication.sqlite3` when using email, `tenants/*.sqlite3` and any SQLite journal or WAL files. Use a consistent disk snapshot, or stop the writer before making a filesystem copy. Treat backups as customer data.
2. Store a separate recovery copy of the tenant secret, the Composio project configuration, identity/mail settings and the two canonical URLs. Composio keeps its connected accounts in the upstream project. Restoring a database while switching projects breaks their association.
3. Restore a consistent backup into the same mount path with only one active Airport process. Reinject the matching settings. Confirm that a known user sees the expected workspaces and existing agent credentials before reopening traffic. Test recovery on an isolated copy before replacing a live disk. [Render snapshots and restores](https://render.com/docs/disks#disk-snapshots)

## Configure app sign-in once

1. Use a Composio project dedicated to Airport. Provide project permissions for listing toolkit/tool metadata, creating sessions and Connect Links, verifying connected accounts and executing approved tools. Pinned config lookup also needs permission to read the selected auth config. End users choose an app in Airport and complete that provider's sign-in or credential form. Airport supplies the project key server-side. [Composio auth configurations](https://docs.composio.dev/reference/api-reference/auth-configs)
2. Gmail supports managed OAuth. With the toolkit's default, Airport starts a session and requests a Connect Link without listing auth configs. Composio can reuse an existing project config before falling back to managed auth. Pin a config in `AIRPORT_AUTH_CONFIGS_JSON` when a deployment requires a specific OAuth app or specific scopes. An auth config can serve many users. Each connection obtains its own Composio owner ID and connected account. The operator config map also accepts custom toolkit slugs containing underscores. [Session config selection](https://docs.composio.dev/docs/configuring-sessions) · [Gmail OAuth setup and scopes](https://docs.composio.dev/toolkits/gmail)
3. For an auth-required toolkit without a managed configuration, enable its auth config in the project and map its ID on the server before offering sign-in. The hosted service requires an explicit mapping for that case. Owners see a setup message if the app is unavailable. Credentialless apps can activate directly when the provider explicitly marks them as such. Tools still start blocked per connection.
4. Review requested scopes at the provider consent screen. Gmail's default config can request full mailbox access. Operators who need the dedicated inbox counter can configure the narrower Gmail metadata scope, subject to Google app approval and Workspace policies. The scope needed by each general catalog tool depends on the operation. [Gmail toolkit scope details](https://docs.composio.dev/toolkits/gmail) · [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

### Verify the returning account owner

For hosted production OAuth, configure `AIRPORT_COMPOSIO_VERIFIER_PATH=/oauth/verify`, then set the Composio project's verification URL to the same public owner URL, for example `https://app.example.com/oauth/verify`. The callback requires the same owner session as the console. This project-wide setting affects every provider-redirect OAuth flow in the project. Start test connections from Airport. [Composio callback identity verification](https://docs.composio.dev/reference/api-reference/connected-accounts)

Composio returns a ten-minute, single-use `session_uri`. Start one app sign-in at a time per signed-in Airport owner. Airport finds the server-held owner and account for the pending connection, redeems the session, checks the returned account ID and toolkit, then verifies the upstream account before activating it. The dedicated Gmail path also checks the expected mailbox address. If multiple sign-ins are pending, cancel the other pending connections in Airport and retry the intended flow. The same operator may instead leave verification off in a separate development project. In that mode `/oauth/done` returns to the UI and Airport checks the stored account through Composio. [Complete a deferred connection](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth)

## Verify a deployment

First check routing from outside the hosting network. These examples expect email sign-in. Replace both hostnames with your own.

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/api/state
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/api/state
```

Expect `204`, `204`, `401`, `404` in that order. Health checks verify tenant directory access. Sign-in delivery and the actual Composio connection need the separate checks below. [Render health checks](https://render.com/docs/health-checks)

1. Open the owner hostname in a fresh browser session. Complete Airport sign-in, create a workspace and connect a test provider account. A second independent identity should see its own workspaces, connections and activity. Both owners can connect the same toolkit using Airport's shared project configuration.
2. Open the test connection, enable a specific read operation, and issue an invitation for a named agent. In a compatible agent client, claim the invitation through the HTTPS setup URL the console displays. Save the returned bearer in the client's private credential store. The setup guide uses `/gateway/<tenant>/airport/connect`; the MCP client uses the same tenant prefix followed by `/mcp`. A client must support Streamable HTTP and the configured bearer authorization.
3. Ask the agent to list its tools and run the approved read. Confirm the actor, workspace and result in owner activity. Block the tool and refresh the agent's tool list. Revoke the agent and confirm that its saved bearer loses access. An owner API request on the agent host should return 404. A missing bearer for an agent data request should return 401.
4. Restart the service using the same volume, tenant secret, project and public URLs. Sign back in and check that the same owners retain their state and their stable gateway addresses.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Render never becomes healthy | Read the first startup error in the service logs. Check both HTTPS URLs, the auth mode's required settings, the format of the tenant secret and the disk mount. `/healthz` returns 503 if the tenant directory is inaccessible. |
| The `onrender.com` address returns 404 | Airport routes by the original Host header. Visit the configured custom hostname to use the console. Use `/healthz` to probe the Render address. |
| No sign-in code arrives | Confirm the sender subdomain is enabled, both sender entries agree, and the Worker URL ends in `/sign-in`. Verify the two relay secrets match. A browser GET to the Worker intentionally returns 404. |
| The provider consented but the app stays pending | Return in the same signed-in browser, open the connection and check its status. If using deferred verification, confirm the project's callback matches the owner hostname and there is only one pending authorization for that owner. |
| MCP discovery works but an app tool is missing | On the connection, review the tool's version and access preset. Apply a permission and ask the client to refresh `tools/list`. Check Activity for the workspace, calling agent and policy outcome. |
| The agent receives a login page or 404 | Use the complete URL shown under **Agents**, including the tenant path and `/mcp`. Preserve the Host and Authorization headers at the proxy and exclude the agent host from browser sign-in. |
