# Move an existing Mac workspace to the hosted gateway

This moves every workspace in one local Airport database to one hosted owner. It preserves account bindings, tool policies, activity, and the hashes and expiry dates of existing agent credentials. Use the same Composio project on both deployments so those bindings continue to resolve. The hosted server, volume, tenant secret, HTTPS origins and owner login must already be configured as described in [Hosting](HOSTING.md).

1. Sign in to the hosted owner console **as the person who owns the Mac workspaces**. Before adding connections, agents, invitations, or policies, open `/api/state` on that signed-in console origin and copy only its `publicURL` field. This is the gateway address for that verified owner. Check its HTTPS hostname and prefix against the deployed `AIRPORT_AGENT_BASE`. The migration also accepts the same owner's setup guide URL ending in `/airport/connect` or MCP endpoint ending in `/mcp`.
2. Allow in-flight requests and OAuth sign-ins to finish, then pause traffic and writes to the Mac gateways for cutover. On Render, set `AIRPORT_MAINTENANCE=1` and wait for that deployment to become healthy. Both the owner API and the agent endpoint should return `503` at the origin. The service's authenticated SSH shell and disk remain available for the import. On a host with an independently mounted volume, you can stop the service instead. The final snapshot includes committed SQLite WAL transactions up to the snapshot. Later changes on the Mac would belong to a separate history.
3. From the repository root on the Mac, create the snapshot in a private directory. Choose a fresh filename for each run.

   ```sh
   umask 077
   mkdir -p "$HOME/.airport-migration"
   node live/migrate.mjs export \
     "$HOME/Library/Application Support/Airport/live/gateway.sqlite3" \
     "$HOME/.airport-migration/workspaces.sqlite3"
   ```

4. Transfer the snapshot directly to a private path on the host using your authenticated operator channel such as SSH/SFTP. Use an encrypted transport and a directory accessible to the service operator. The snapshot contains personal activity and connected-account references. Keep it out of Git, container images, and build artifacts.
5. In a maintenance shell with access to the same durable volume as Airport, run the importer under the service account with `AIRPORT_HOSTED_DATA_DIR` and `AIRPORT_AGENT_BASE` set to the production values. Set `OWNER_GATEWAY_URL` to the value copied in step 1.

   ```sh
   node live/migrate.mjs import /private/migration/workspaces.sqlite3 "$OWNER_GATEWAY_URL"
   ```

   The owner must have signed in once to initialize the destination database. The importer checks that it contains exactly the empty starter workspaces, obtains a SQLite write lock, and commits all records together. A busy or configured tenant causes the import to stop. An unsuccessful transaction leaves the original destination intact.
6. Clear `AIRPORT_MAINTENANCE` and wait for the normal service to become healthy, or restart your standalone host. Check Personal and Work under the verified owner's login. Update Muse's connector URL to the copied gateway address plus `/mcp` (or its existing HTTP endpoint path). An unexpired credential issued on the Mac continues to work with the migrated state. For an expired grant, issue a new credential in Airport. Run a permitted read, confirm the actor, workspace and decision in Activity, then test a policy block. Keep traffic on the hosted endpoint once verification succeeds.
