# Airport Gateway

Airport gives AI assistants controlled access to the apps in a workspace. Connect an app once, choose which operations it allows, and give each agent its own revocable credential. For example, you can let an agent read your Personal Gmail inbox while keeping the send operation blocked and your Work Gmail in a separate workspace.

**[Try Airport live](https://airport.so/)** · [Open the hosted app](https://app.airport.so/login) · [Set up locally](live/README.md) · [Deploy on Render](live/HOSTING.md)

## Try a real request

The live demo is the production service. Signing in gives you your own account and workspaces. You can also try the sample policy on the homepage before connecting an account.

1. Open **Personal**, choose **Integrations**, and connect an app you want to use. Gmail is a good first example.
2. Open the connection’s **Tool access** page. Choose **Read only**, review the eligible tools, then apply the preset.
3. Open **Agents → Add agent**. Name the agent, choose an access duration, and give the one-use setup prompt to a client that supports remote MCP and bearer authentication.
4. Ask the agent, “Which apps can you access in this workspace?” Then ask it to perform one of the reads you approved, such as listing Gmail labels.
5. Open **Activity** in the same workspace. Select the app request to see the agent, operation, policy decision and recorded response details. You can change its tool access or revoke the agent from the console.

## How a request works

An agent connects to Airport using the Model Context Protocol (MCP) over Streamable HTTP. Airport resolves its credential to a workspace. The agent can discover connected apps with `airport_list_connections` and list approved operations with `tools/list`. When it calls a tool, Airport checks the connection and policy before dispatching the operation through Composio. Activity records the outcome, including denied requests.

Each workspace can hold a different sign-in for the same app. A workspace’s tool policies apply to its authorized agents. The operator supplies the Composio project key on the server. Each user authorizes access to their own app accounts.

## Run it yourself

| Environment | What you need | Start here |
| --- | --- | --- |
| Local development on macOS or a Linux desktop | Node.js 24 LTS and npm. Supply your own Composio project key to connect real apps. | [Local setup, opening the console and connecting an agent](live/README.md) |
| Always-on, multi-account installation | A Render web service with persistent storage, two HTTPS hostnames and a Composio project. Choose email-code sign-in or Cloudflare Access. | [Render deployment, DNS, authentication and backups](live/HOSTING.md) |

For a quick look at the local console, run these commands from the repository root:

```sh
npm ci --prefix live
AIRPORT_NO_TUNNEL=1 node live/server.mjs
```

Leave the server running. From a second terminal in the same checkout, run `node live/open.mjs` to open the owner session in your browser. This starts with a loopback-only agent endpoint. The local guide covers real app authorization and remote agent access. For existing installations moving to a hosted service, see the [migration guide](live/MIGRATION.md).

## Find your way around the code

| Path | Purpose |
| --- | --- |
| [live/agent.mjs](live/agent.mjs) | MCP and HTTP agent requests, policy enforcement and audit outcomes |
| [live/catalog.mjs](live/catalog.mjs) and [live/access-presets.mjs](live/access-presets.mjs) | Composio integrations, available tools and permission presets |
| [live/store.mjs](live/store.mjs) | SQLite workspace state, grants, approvals and activity |
| [live/ui/](live/ui/) | Browser console for onboarding, connections, agents, policies and activity |
| [live/hosted.mjs](live/hosted.mjs) and [render.yaml](render.yaml) | Hosted entry point and Render deployment |
| [workers/sign-in-email/](workers/sign-in-email/) | Optional Cloudflare Worker that delivers account sign-in codes |

## Contributing

Bug reports, documentation fixes, client compatibility reports and code contributions are welcome. The [contribution guide](CONTRIBUTING.md) covers the development loop, test fixtures, pull requests and private reporting of security issues.

## License and artwork

Airport Gateway’s code is licensed under the [GNU Affero General Public License, version 3 only (AGPL-3.0-only)](LICENSE). You can self-host Airport and offer a commercial service. If you modify Airport and let users interact with that version over a network, you must offer those users its corresponding source under the AGPL.

Bundled fonts and third-party product artwork carry separate notices. See [Third-party notices](THIRD_PARTY_NOTICES.md).
