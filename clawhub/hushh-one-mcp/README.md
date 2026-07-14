# Hushh One MCP for OpenClaw

OpenClaw bundle for the Hussh One consent MCP. It lets OpenClaw agents discover a user's available Personal Knowledge Model scopes, request explicit consent in Hussh One/Kai, poll approval status, and retrieve a scoped export through the Hussh MCP bridge.

This bundle does not grant direct access to user data. The developer token identifies the external app, and the user still approves each scoped request in Hussh.

## What This Bundle Adds

- MCP server config that launches `npx -y @hushh/mcp` against UAT
- OpenClaw skill guidance for safe Hussh PKM consent flows
- No native OpenClaw plugin code
- No bundled secrets

The package includes a minimal `openclaw.plugin.json` because the current ClawHub package publish API requires plugin package metadata. OpenClaw still detects this package as a Codex bundle through `.codex-plugin/plugin.json`.

OpenClaw exposes Hussh tools with the `hushh-one__` prefix, for example:

- `hushh-one__prepare_campaign_context`
- `hushh-one__discover_user_domains`
- `hushh-one__request_consent`
- `hushh-one__check_consent_status`
- `hushh-one__get_encrypted_scoped_export`
- `hushh-one__validate_token`
- `hushh-one__list_scopes`

## Get A Developer Token

1. Go to `https://uat.one.hushh.ai/developers`.
2. Sign in with Google or Apple.
3. Enable developer access.
4. Copy the developer token when it is shown.
5. Store it locally as `HUSHH_DEVELOPER_TOKEN`.

Keep the token local. Do not put it in a URL, prompt, committed config file, or public issue.

## Install From ClawHub

After this package is published:

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

1. Call `hushh-one__discover_user_domains`.
2. Pick a discovered least-privilege `attr.*` scope.
3. Call `hushh-one__check_consent_status`.
4. Call `hushh-one__request_consent` only if no active grant exists.
5. Poll `hushh-one__check_consent_status` while pending.
6. Call `hushh-one__get_encrypted_scoped_export` after approval.

External agents must not request raw PKM, `pkm.read`, `pkm.write`, `vault.owner`, vault keys, connector private keys, or broad profile dumps.

## Publish Checklist

```bash
npm i -g clawhub
clawhub login
clawhub package validate ./clawhub/hushh-one-mcp
clawhub package publish ./clawhub/hushh-one-mcp --family bundle-plugin --owner hushh --bundle-format codex --host-targets openclaw --dry-run
clawhub package publish ./clawhub/hushh-one-mcp --family bundle-plugin --owner hushh --bundle-format codex --host-targets openclaw
```

The package name is `@hushh/one-mcp`, so the ClawHub publisher owner must be `hushh`. If publishing under a different owner, rename `package.json` before publishing.

## References

- Hussh developer workspace: `https://uat.one.hushh.ai/developers`
- Hosted MCP endpoint: `https://api.uat.hushh.ai/mcp/`
- npm bridge package: `@hushh/mcp`
