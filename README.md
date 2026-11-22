# Airport Gateway

Airport lets you give an AI agent access to the apps in one workspace. Connect separate accounts for Personal and Work, choose which tools each connection allows, and see which agent made each request. The gateway checks workspace policy before calling Composio.

## Run the gateway

Use Node.js 24 LTS or later. From the repository root, install the server dependency and run the tests.

```sh
npm ci --prefix live
npm test --prefix live
```

For an always-on deployment, start the hosted entry point with `npm start --prefix live`. It serves the owner console and MCP gateway, signs owners in with a one-time email code, and persists each owner's workspaces on disk. The hosting guide lists the required environment variables, ingress settings and OAuth configuration. [Hosted deployment](live/HOSTING.md)

Hosted accounts support email verification, self-service signup, editable profiles, and sign-out. Share the console’s `/login` URL with customers. Self-hosters can also configure a Cloudflare Access identity provider. Each account owns a separate set of workspaces, connections and agent credentials.

For development on a Mac, the local entry point uses a one-use owner launcher and an optional tunnel to reach the agent endpoint. [Local setup and workspace controls](live/README.md)

To move existing accounts, policies, activity, and agent grants to a hosted owner, use the SQLite export and import utility during cutover. [Mac-to-host migration](live/MIGRATION.md)

## Repository layout

- `live/` contains the Node server, Composio adapters, workspace policy checks, storage and tests.
- `live/ui/` contains the console for managing real workspaces and inspecting activity.
- `dist/` contains the standalone demo and the design assets shared with the live console. The demo uses sample workspaces in browser storage.

Airport's Composio key belongs in the deployment's secret store. Each user authorizes their own connections through the provider's sign-in flow.

## Agent artwork

The agent icons identify third-party products. Artwork comes from the publishers of [Muse](https://apps.apple.com/us/app/muse-from-meta/id6760173601), [Dots](https://chatgpt.com/features/dots/), [Duet](https://apps.apple.com/us/app/claude-duet-by-anthropic/id6803276000), [Grok Bot](https://apps.apple.com/us/app/grok-bot/id6794501026) and [Instinct](https://instinct.com/).

When updating an icon in `dist/agents/`, copy the same PNG to `airport-landing/public/assets/agents/` so the dashboard and landing page show the same artwork.
