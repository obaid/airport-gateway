# Contributing to Airport

A good first contribution is a reproducible bug, a clearer setup step, or a compatibility report from an MCP client. For an integration issue, identify the app, the workspace action you tried, the policy preset and the observed result. Use invented account and workspace names in any examples.

## Development setup

1. Fork or clone the repository and create a branch for your change.
2. Use Node.js 24 LTS and run `npm ci --prefix live` from the repository root.
3. Run `npm test --prefix live` for the gateway and `node --test workers/sign-in-email/index.test.mjs` for the mail relay. The tests use fixtures and temporary stores. They require no Composio key or external email account.
4. To exercise the UI, follow the [local guide](live/README.md). Use your own development workspace and Composio project for real provider calls.

For the browser suite, install the Chromium build corresponding to the locked Playwright dependency. The suite starts a local HTTPS gateway and needs `openssl` on your executable path.

```sh
cd live
npx playwright-core install chromium
npm run test:browser
```

If Chromium is already installed, you can set `AIRPORT_TEST_CHROMIUM` to its executable path. On Linux, Playwright can also install browser system dependencies with `npx playwright-core install --with-deps chromium`.

## Making a change

* **Tool permissions and agent access.** Review the [agent handler](live/agent.mjs) and [access presets](live/access-presets.mjs). Cover both an allowed call and a denied call. For workspace boundaries, use two separate fixture workspaces and verify which provider, if any, received the request.
* **Connector and catalog behavior.** Add a small, synthetic provider fixture to the relevant test. Use a stub for OAuth, verification or delivery so others can reproduce the behavior offline after installing dependencies.
* **Console changes.** Exercise the route through normal navigation and a direct link. Include a screenshot for visible changes when it helps the reviewer; use fixture names and data.
* **Setup documentation.** Give the working directory, command and expected result. Use example domains and configuration placeholders. Identify whether a step applies to local development or a hosted installation.

Open a pull request with the problem, what changed, and the checks you ran. If a change affects operators, describe any configuration or migration they need. Keep unrelated formatting and generated files out of the diff.

Contributions to Airport’s code use the project’s [AGPL-3.0-only license](LICENSE). If you add third-party material, include its source and applicable license or usage terms in [Third-party notices](THIRD_PARTY_NOTICES.md).

## Reporting a problem

For ordinary bugs and feature proposals, [open a GitHub issue](https://github.com/obaid/airport-gateway/issues). Include your Node version, deployment mode and the smallest example that demonstrates the issue.

For a security issue, use the repository’s **Security → Report a vulnerability** action if available. If the option is unavailable, ask a maintainer for a private reporting channel in an issue containing only that request. Share sensitive details privately. Redact bearer tokens, pairing or launch tickets, OAuth links, project keys, customer email addresses, tool payloads and database files from public reports.
