# Host Airport for multiple owners

Run one Node service behind an HTTPS reverse proxy, with a dedicated owner origin and a permanent volume. The hosted service signs owners in through Cloudflare Access, gives each owner separate SQLite state, and publishes a workspace agent endpoint after the owner authorizes it. Bring the repository's `live/` and sibling `dist/` directories together. The server serves the owner UI, fonts, icons and toolkit directory from those directories.

## Deploy on Render

The [Render Blueprint](../render.yaml) runs one paid Node.js web service with a 1 GB disk at `/var/data/airport`. The service runs independently of the operator's computer. A disk-backed instance briefly stops serving traffic during a redeploy. Review the selected region and recurring charges before applying the Blueprint. [Render pricing](https://render.com/pricing) · [Persistent disk behavior](https://render.com/docs/disks)

1. Choose separate owner and agent hostnames, for example `app.example.com` and `mcp.example.com`. Configure Cloudflare Access for the owner hostname as described below. An allowlist with a single owner is sufficient for a personal installation.
2. In the Render Dashboard, choose **New → Blueprint**, select the gateway repository and branch, and use the root `render.yaml`. For a private repository, authorize Render's GitHub app for that repository. The Blueprint runs `npm ci --prefix live` from the repository root so the server can access its sibling `dist/` assets. To validate the plan from a signed-in CLI, run `render blueprints validate render.yaml`. [Blueprint setup](https://render.com/docs/infrastructure-as-code) · [Git provider access](https://render.com/docs/git-provider)
3. Enter the owner origin, agent base, Access issuer, Access audience, stable tenant secret, and Composio project key in the Blueprint's environment prompts. Generate the tenant secret once using the instructions under **Runtime and persistent storage** and keep a recovery copy. Use the existing Composio project if bringing over accounts connected through that project.
4. Add both hostnames to the new service under **Settings → Custom Domains**. At the authoritative DNS provider, create a CNAME for each hostname pointing to the assigned `onrender.com` address. With Cloudflare DNS, begin with **DNS only** so Render can verify the names and issue certificates. Once Render confirms both certificates, enable **Proxied** for the owner hostname so Access can authenticate browsers. The agent hostname serves the MCP endpoint using Airport bearer authentication. [Render custom domains](https://render.com/docs/custom-domains) · [Cloudflare DNS setup on Render](https://render.com/docs/configure-cloudflare-dns)
5. Visit the owner hostname in a fresh browser and confirm it prompts for the configured identity. Complete **Verify a deployment** below, including an agent request from outside the operator's network. Test Composio callbacks before changing the verification URL for any project that already serves another installation.

Render probes `GET /healthz` directly. The gateway returns an empty `204` when its tenant directory is accessible and an empty `503` when the directory is unavailable. The probe works before custom-domain verification and does not open an owner database or call Composio. Back up the volume and keep the stable tenant secret available for restore. [Render health checks](https://render.com/docs/health-checks)

## Network and identity

1. Choose stable URLs. For example, publish the owner console at `https://owners.example.com` and the agent gateway at `https://agents.example.com/v1`. The owner UI needs the root of its own origin. The agent base can include a path prefix.
2. Create a Cloudflare Access self-hosted application covering the entire owner hostname, including assets, API and OAuth callbacks. Connect a human identity provider and set the Allow policy for the people using Airport. Record the Access team URL and this application's audience tag. Airport validates the RS256 assertion against the configured team's rotating JWKS and checks issuer, audience, expiry and application subject. [Cloudflare Access application setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) · [JWT validation and audience settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
3. Route both hosts to the Node listener, preserving the original Host and path. On the owner route, forward the edge-issued `Cf-Access-Jwt-Assertion`. On the agent host, publish the configured prefix followed by `/gateway/`. Agent setup and invitation exchange need a public HTTPS route outside the owner browser login. A data request requires an Airport-issued workspace bearer credential. Apply edge rate limits to the public enrollment and pairing routes.
4. Terminate TLS at the proxy and keep the Node listener private. By default it binds to `127.0.0.1:8080`. A private container may set `HOST=0.0.0.0` and configure its ingress to reach that port. Preserve `Authorization` on agent requests. Configure proxy logs to omit query strings, authorization headers, invitation bodies and OAuth callback parameters.

## Runtime and persistent storage

Use Node.js 22.16 or later with built-in `node:sqlite` support. From the repository root, install the locked dependency and run the isolated tests.

```sh
cd live
npm ci
npm test
```

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
| `AIRPORT_OWNER_ORIGIN` | Dedicated HTTPS console origin, e.g. `https://owners.example.com`. |
| `AIRPORT_AGENT_BASE` | Canonical HTTPS gateway base, e.g. `https://agents.example.com/v1`. Airport appends `/gateway/<tenant>`. |
| `CF_ACCESS_ISSUER` | Exact team origin, e.g. `https://your-team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | Audience tag of the owner Access application. |
| `AIRPORT_HOSTED_DATA_DIR` | Absolute durable volume path, e.g. `/var/lib/airport`. |
| `AIRPORT_TENANT_SECRET` | Stable base64url secret with at least 32 random bytes. |
| `COMPOSIO_API_KEY` | Airport's private Composio project API key, provisioned once by the platform operator. |
| `AIRPORT_AUTH_CONFIGS_JSON` | Optional toolkit-to-project-config map such as `{"gmail":"ac_yourGmailConfig","custom_crm":"ac_yourCRMConfig"}`. |
| `AIRPORT_COMPOSIO_VERIFIER_PATH` | Optional project verification callback path, e.g. `/oauth/verify`. See below. |
| `HOST`, `PORT` | Optional private listener address and port. |

With the required values injected, start the service from `live/` using `npm start`. If the service manager injects everything except the tenant secret generated above, launch `node --env-file=/private/airport-secrets/tenant.env hosted.mjs`. Configure the supervisor to restart the process after a crash or machine reboot.

Each owner gets a database under `AIRPORT_HOSTED_DATA_DIR/tenants/`. The namespace comes from an HMAC of the verified issuer and subject. Email changes preserve that namespace. A new tenant secret, issuer or identity-provider subject produces a different namespace. Back up the stable tenant secret and configuration privately. Use a consistent SQLite backup or stop the service before copying its volume, including any journal files. Keep a single active writer process per volume. Additional replicas require a routing and storage design that preserves each owner's SQLite state.

## Configure app sign-in once

1. Use a Composio project dedicated to Airport. Provide project permissions for listing toolkit/tool metadata, creating sessions and Connect Links, verifying connected accounts and executing approved tools. Pinned config lookup also needs permission to read the selected auth config. End users choose an app in Airport and complete that provider's sign-in or credential form. Airport supplies the project key server-side. [Composio auth configurations](https://docs.composio.dev/reference/api-reference/auth-configs)
2. Gmail supports managed OAuth. With the toolkit's default, Airport starts a session and requests a Connect Link without listing auth configs. Composio can reuse an existing project config before falling back to managed auth. Pin a config in `AIRPORT_AUTH_CONFIGS_JSON` when a deployment requires a specific OAuth app or specific scopes. An auth config can serve many users. Each connection obtains its own Composio owner ID and connected account. The operator config map also accepts custom toolkit slugs containing underscores. [Session config selection](https://docs.composio.dev/docs/configuring-sessions) · [Gmail OAuth setup and scopes](https://docs.composio.dev/toolkits/gmail)
3. For an auth-required toolkit without a managed configuration, enable its auth config in the project and map its ID on the server before offering sign-in. The hosted service requires an explicit mapping for that case. Owners see a setup message if the app is unavailable. Credentialless apps can activate directly when the provider explicitly marks them as such. Tools still start blocked per connection.
4. Review requested scopes at the provider consent screen. Gmail's default config can request full mailbox access. Operators who need the dedicated inbox counter can configure the narrower Gmail metadata scope, subject to Google app approval and Workspace policies. The scope needed by each general catalog tool depends on the operation. [Gmail toolkit scope details](https://docs.composio.dev/toolkits/gmail) · [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

### Verify the returning account owner

For hosted production OAuth, configure `AIRPORT_COMPOSIO_VERIFIER_PATH=/oauth/verify`, then set the Composio project's verification URL to the same public owner URL, for example `https://owners.example.com/oauth/verify`. Apply the same Access policy as the rest of the owner console. This project-wide setting affects every provider-redirect OAuth flow in the project. Start test connections from Airport. [Composio callback identity verification](https://docs.composio.dev/reference/api-reference/connected-accounts)

Composio returns a ten-minute, single-use `session_uri`. Start one app sign-in at a time per signed-in Airport owner. Airport finds the server-held owner and account for the pending connection, redeems the session, checks the returned account ID and toolkit, then verifies the upstream account before activating it. The dedicated Gmail path also checks the expected mailbox address. If multiple sign-ins are pending, cancel the other pending connections in Airport and retry the intended flow. The same operator may instead leave verification off in a separate development project. In that mode `/oauth/done` returns to the UI and Airport checks the stored account through Composio. [Complete a deferred connection](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth)

## Verify a deployment

1. Open the owner hostname in a fresh browser session. Complete Cloudflare Access sign-in, create a workspace and connect a test provider account. A second independent identity should see its own workspaces, connections and activity. Both owners can connect the same toolkit using Airport's shared project configuration.
2. Open the test connection, enable a specific read operation, and issue an invitation for a named agent. In a compatible agent client, claim the invitation through the HTTPS setup URL the console displays. Save the returned bearer in the client's private credential store. The setup guide uses `/gateway/<tenant>/airport/connect`; the MCP client uses the same tenant prefix followed by `/mcp`. A client must support Streamable HTTP and the configured bearer authorization.
3. Ask the agent to list its tools and run the approved read. Confirm the actor, workspace and result in owner activity. Block the tool and refresh the agent's tool list. Revoke the agent and confirm that its saved bearer loses access. An owner API request on the agent host should return 404. A missing bearer for an agent data request should return 401.
4. Restart the service using the same volume, tenant secret, project and public URLs. Sign back in and check that the same owners retain their state and their stable gateway addresses.
