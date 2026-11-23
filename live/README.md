# Run Airport locally

The local server gives one person a workspace console on their own computer. Local agents can use it over loopback. Remote agents can reach it through an optional HTTPS tunnel while the computer is awake. For a shared installation with user accounts and an always-on agent URL, follow the [Render deployment guide](HOSTING.md).

## Start the console

Use macOS or a Linux desktop with a default browser and `xdg-open`. Install Git and Node.js with npm. Node.js 24 LTS matches the major version used by the Render Blueprint. These commands run from the repository root.

```sh
git clone https://github.com/obaid/airport-gateway.git
cd airport-gateway
npm ci --prefix live
```

In the first terminal, start with both listeners on loopback. This works without a Composio key. On Linux, set `AIRPORT_DATA_DIR` in both terminals to choose a local state directory, for example `export AIRPORT_DATA_DIR="$HOME/.local/share/airport"`.

```sh
AIRPORT_NO_TUNNEL=1 node live/server.mjs
```

Wait for the line that says the owner console is listening. From a second terminal in the repository root, run the launcher. It opens the browser and exchanges a one-use ticket for a local owner session.

```sh
node live/open.mjs
```

You should see **Personal** and **Work**. Open **Integrations** to browse the bundled app directory. Connecting a provider or running one of its tools requires your own Composio project.

## Connect your first app

1. In the [Composio dashboard](https://platform.composio.dev/), choose a development project and create a project API key.
2. Run `node live/configure-platform.mjs` in the second terminal. On macOS it opens a private configuration file in TextEdit. On Linux it prints the path to edit. Set `COMPOSIO_API_KEY` to your project key in that file and save. The running local server rereads the file. You can also inject the key from a secrets manager into the server process at startup.
3. In Airport, open **Personal → Integrations**, choose an app, name the connection, and finish the provider's consent flow. Return to the same browser. If verification is pending, reopen the connection and select **Check connection**.
4. Open **Tool access**, preview **Read only**, and apply it. A newly connected account starts with tools blocked. **Advanced** lets you review individual tools, including operations excluded from presets. A Composio managed auth configuration can serve multiple accounts. For toolkits that need your own OAuth app, see [provider configuration](HOSTING.md#configure-app-sign-in-once).

## Connect an agent and verify a request

- **Agent running on this computer.** Open **Agents → Add agent**, name it, choose its expiry and issue an agent credential. Set the client's Streamable HTTP MCP endpoint to `http://127.0.0.1:43871/mcp` and put the bearer in its secure authorization field. The client must support loopback HTTP and bearer authentication.
- **Agent running elsewhere.** Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Stop the first terminal with Ctrl-C and restart with `node live/server.mjs`. Wait for the public endpoint message, reopen the owner launcher and choose **Agents → Add agent**. Paste the single-use setup prompt into your agent within ten minutes. A quick tunnel forwards the agent listener and gets a new hostname after restart. For a managed tunnel, route its HTTPS hostname to `http://127.0.0.1:43871` and start the server with `AIRPORT_PUBLIC_URL=https://agents.example.com node live/server.mjs`.

Ask the agent which connections it can use. Airport exposes `airport_list_connections` for MCP and authenticated `GET /api/connections` for HTTP clients. Then ask it to run a specific read in the connected app. For example, approve a read in your test Gmail account and ask for its inbox counts. Expand the event in **Activity** to see the agent, workspace, operation, policy outcome and recorded result. Generic tools store a summary. The dedicated Gmail inbox counter records the total and unread counts. Revoke the agent under **Agents** when you finish.

## Local state and troubleshooting

| Symptom or task | What to do |
| --- | --- |
| A direct console bookmark asks you to use the launcher | Run `node live/open.mjs` with the server running. Restarting the server invalidates the old owner session. |
| Apps are visible but authorization is unavailable | Check the project key, refresh the console, and confirm the project supports the selected app. Provider-specific auth configs can be pinned with `AIRPORT_AUTH_CONFIGS_JSON`. |
| A remote agent cannot reach the MCP URL | Loopback belongs to the agent's own machine. Use the current HTTPS agent URL shown by Airport. Check the server and tunnel are running. |
| A port is busy | Set `AIRPORT_OWNER_PORT` and `AIRPORT_AGENT_PORT` to free ports for the server. Use the same owner port and state directory for the launcher. Default ports are 43870 for the console and 43871 for agents. |
| Move or back up local state | Stop the server and copy the whole state directory, including SQLite journal files and the private `platform.env` if present. Restore it with access limited to the operator. The default path is `~/Library/Application Support/Airport/live` unless `AIRPORT_DATA_DIR` is set. |

Run the gateway tests with `npm test --prefix live`. They use temporary storage and fixture providers. The hosted guide covers the [browser sign-in test](HOSTING.md#runtime-and-persistent-storage).

## Maintain the integration directory

From the repository root, `node live/export-public-integrations.mjs` emits public, connectable toolkit names and slugs for the configured project as JSON. The separate landing repository's `scripts/update-integrations.mjs` accepts the export on standard input. After changing `dist/toolkits.json`, run `python3 live/refresh-integration-icons.py` to refresh the bundled icons. The icon script requires Pillow, curl and rsvg-convert.
