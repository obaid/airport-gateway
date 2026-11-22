# Airport

Airport connects agents to a workspace’s apps through Composio. Each workspace has its own accounts, tool permissions, agent credentials, and activity history. The owner console opens on a network graph. Select a node to manage it, or trace a recorded request to see its policy decision.

## Using a workspace

1. Create or select a workspace. Choose **Add app** to browse the Composio catalog. Select the app, name the account, and complete its sign-in flow. Airport verifies the provider account before marking the connection active.
2. A verified connection opens on **Tool access**. Choose **Read only**, **Write only**, or **Read and write**, review what the preset would change, and apply it. Each preset grants the eligible versions in its preview. Under **Advanced**, choose **Customize individual tools** to make exceptions or review destructive and unclassified operations. You can block an approved tool even if Composio is unavailable.
3. Open **Agents → Add agent**. Choose a name or let the agent choose one, then set access to 12 hours, 7 days, 30 days, or **Never expires**. An agent with **Never expires** keeps its credential until you revoke it. Copy the setup prompt into the agent within the invitation’s 10-minute claim window. Airport binds the returned bearer to this agent and workspace. Clients with a secure bearer field can use a directly issued credential. A new workspace can enroll agents before connecting an app.
4. Ask a named agent which apps it can access. The MCP tool `airport_list_connections` and the authenticated HTTPS endpoint `GET /api/connections` list active connections and their allowed tool counts, including zero. Agents use MCP `tools/list` to discover individual operations. Airport checks the policy again before dispatch and before returning the result. The activity log identifies the caller, request, and policy outcome.

Agents need remote MCP with bearer authentication or support for an equivalent HTTP connector. On an existing Gmail inbox connection, open **Tool access → Advanced → Customize individual tools** to browse the Composio Gmail catalog. The built-in inbox counter has its own permission for compatibility with the original Muse credential. Catalog tools start blocked. Named workspace agents can use the catalog tools you approve, subject to the permissions Google granted for that account. Airport blocks open-ended proxy and code-execution tools.

## Platform configuration

Airport supplies the Composio project key server-side. The browser never receives it. With Gmail, Composio’s managed OAuth app can handle Google consent; Airport can instead pin an operator-configured auth template for branded consent or a different scope set. Each authorized account has a separate connection in its workspace. Provider-specific credentials for apps that use API keys are entered in the provider authorization flow.

For a hosted multi-owner installation, see [Hosting](HOSTING.md). For a local installation, Node.js 24.2 or later and `cloudflared` support the private owner console and optional temporary agent endpoint.

```sh
node live/configure-platform.mjs
node live/server.mjs
```

The first command opens the operator’s private `platform.env` file on macOS. Set `COMPOSIO_API_KEY` there or inject it into the server environment. The file lives under `~/Library/Application Support/Airport/live`, outside the repository and HTTP assets. An already running upgraded server watches the file for saved changes. Project-owned toolkit auth templates can be pinned through the server environment variable `AIRPORT_AUTH_CONFIGS_JSON`.

In another terminal, open the owner console using its one-use launcher.

```sh
node live/open.mjs
```

The local owner interface listens on 127.0.0.1:43870 and the agent transport on 127.0.0.1:43871. A quick tunnel forwards only the agent listener. Supply `AIRPORT_PUBLIC_URL` for an independently managed HTTPS tunnel, or `AIRPORT_NO_TUNNEL=1` for local operation. A quick tunnel’s URL changes on restart.

During a side-by-side upgrade, set `AIRPORT_CONCURRENT_GATEWAY=1`, `AIRPORT_OWNER_PORT=43970` and `AIRPORT_AGENT_PORT=43971` for both the server and its launcher. The instances share local workspace records and use distinct launcher files. Concurrent mode leaves in-flight activity in the other process alone. The catalog is also browseable before the platform credential is configured, using the bundled directory from [Composio](https://docs.composio.dev/toolkits).

## Activity details

The owner can expand each activity. Successful pilot inbox reads from the upgraded gateway retain the total and unread counts. Generic tool calls retain an input/output summary, the approved version, and dispatch status; they do not retain arbitrary email bodies, file contents, or tokens. Historical requests keep the information recorded by the gateway version that handled them.

```sh
cd live
npm ci
npm test
```
