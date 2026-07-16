# Hushh One MCP for OpenClaw

OpenClaw bundle plugin for the Hussh One consent MCP. It lets OpenClaw agents search a user's available Personal Knowledge Model scopes, request explicit consent in Hussh One/Kai, poll approval status, and retrieve a scoped export through the Hussh MCP bridge.

This bundle does not grant direct access to personal information. The developer token identifies the external app, and the user still approves each scoped request in Hussh.

## What This Bundle Adds

- MCP server config that launches `npx -y @hushh/mcp` against UAT
- OpenClaw skill guidance for safe Hussh PKM consent flows
- No native OpenClaw plugin code
- No bundled secrets

The package includes a minimal `openclaw.plugin.json` because the current ClawHub package publish API requires plugin package metadata. OpenClaw still detects this package as a Codex bundle through `.codex-plugin/plugin.json`.

This is published on ClawHub as a plugin package named `@hushh/one-mcp`. Search for it under ClawHub **Plugins**, not **Skills**. The included skill is named `hushh-one-pkm`; it can also be published separately for Skills-tab discovery, but installing that skill alone does not add the MCP server config.

OpenClaw exposes Hussh tools with the `hushh-one__` prefix, for example:

- `hushh-one__search_user_scopes`
- `hushh-one__prepare_campaign_context`
- `hushh-one__request_consent`
- `hushh-one__check_consent_status`
- `hushh-one__get_encrypted_scoped_export`

## Get A Developer Token

1. Go to `https://uat.one.hushh.ai/developers`.
2. Sign in with Google or Apple.
3. Enable developer access.
4. Copy the developer token when it is shown.
5. Store it locally as `HUSHH_DEVELOPER_TOKEN`.

Keep the token local. Do not put it in a URL, prompt, committed config file, or public issue.

## Install From ClawHub

```bash
openclaw plugins install clawhub:@hushh/one-mcp
```

Then configure the token in the environment used by the OpenClaw gateway:

```bash
export HUSHH_DEVELOPER_TOKEN="<developer-token>"
openclaw gateway restart
```

If your OpenClaw deployment uses a service environment file or secret manager, store `HUSHH_DEVELOPER_TOKEN` there instead of exporting it in an interactive shell.

The bundle uses the public npm bridge package `@hushh/mcp`, so publish the current `packages/hushh-mcp` release to npm before publishing this package to ClawHub.

## Local Development Install

From this repository:

```bash
openclaw plugins install ./clawhub/hushh-one-mcp --link
openclaw plugins list
openclaw plugins inspect hushh-one-mcp
```

Bundles should show `Format: bundle` and `Bundle format: codex`.

## Consent Flow

Recommended high-level flow:

1. Call `hushh-one__prepare_campaign_context`.
2. Wait for the user to approve in Hussh One/Kai if consent is pending.
3. Use the returned consent/export metadata according to the tool response.

Manual flow:

1. Call `hushh-one__search_user_scopes` with `user_identifier`, optional `query`, and optional `country_iso2` or `country` for national phone numbers.
2. Pick the narrowest returned `attr.*` scope that satisfies the purpose.
3. Call `hushh-one__request_consent` with `user_identifier`, the selected `scope`, and a plain-language `purpose`.
4. If the response is pending, poll `hushh-one__check_consent_status` with the returned `request_ref`.
5. After consent is granted, call `hushh-one__get_encrypted_scoped_export` with the returned `grant_ref` and original `expected_scope`.

External agents must not request raw PKM, `pkm.read`, `pkm.write`, `vault.owner`, vault keys, connector private keys, or broad profile dumps.

## Publish Checklist

```bash
npm i -g clawhub
clawhub login
clawhub package validate ./clawhub/hushh-one-mcp
clawhub package publish ./clawhub/hushh-one-mcp --family bundle-plugin --owner hushh --bundle-format codex --host-targets openclaw --dry-run
clawhub package publish ./clawhub/hushh-one-mcp --family bundle-plugin --owner hushh --bundle-format codex --host-targets openclaw
clawhub skill publish ./clawhub/hushh-one-mcp/skills/hushh-one-pkm --slug hushh-one-pkm --name "Hushh One PKM" --owner hushh
```

The package name is `@hushh/one-mcp`, so the ClawHub publisher owner must be `hushh`. If publishing under a different owner, rename `package.json` before publishing.

## References

- Hussh developer workspace: `https://uat.one.hushh.ai/developers`
- Hosted MCP endpoint: `https://api.uat.hushh.ai/mcp/`
- npm bridge package: `@hushh/mcp`
