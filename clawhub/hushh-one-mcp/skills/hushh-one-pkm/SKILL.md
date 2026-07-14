---
name: hushh-one-pkm
description: Use when an OpenClaw agent needs to access a Hussh One user's Personal Knowledge Model through the Hussh MCP bridge. This covers developer-token setup, dynamic scope discovery, explicit user consent in One/Kai, consent polling, scoped export retrieval, and the privacy boundary for external agents.
---

# Hushh One PKM Consent MCP

Use Hussh One through the bundled MCP server `hushh-one`. OpenClaw exposes the tools as `hushh-one__<toolName>`.

## Setup Gate

Before calling tools, ensure the operator has configured `HUSHH_DEVELOPER_TOKEN` in the OpenClaw runtime environment. The token is created in the Hussh developer workspace:

1. Open `https://uat.one.hushh.ai/developers`.
2. Sign in with Google or Apple.
3. Enable developer access.
4. Copy the developer token once.
5. Store it locally as `HUSHH_DEVELOPER_TOKEN`.
6. Restart the OpenClaw gateway after changing environment variables.

Never ask the user to paste the token into chat. Never put a developer token in a URL, prompt, file committed to git, or tool argument unless the local OpenClaw secret/env mechanism requires it.

## Consent Flow

Prefer `hushh-one__prepare_campaign_context` for campaign, personalization, or customer-experience requests because it performs the full lifecycle with least-privilege scope selection.

For manual flows:

1. Call `hushh-one__discover_user_domains` with the user's Firebase UID, registered email, or phone number.
2. Choose the least-privilege discovered `attr.{domain}.{scope}.*` scope for the stated purpose.
3. Call `hushh-one__check_consent_status` with `user_id` and `scope` before creating a new request.
4. Call `hushh-one__request_consent` only when no active grant exists.
5. If the request is pending, poll `hushh-one__check_consent_status` with the `request_id` or same `user_id` and `scope`.
6. After consent is granted, call `hushh-one__get_encrypted_scoped_export` with `user_id`, `consent_token`, and the original `expected_scope`.

The user approves or denies consent in the first-party Hussh One/Kai app. Do not ask the user for an approval link, do not impersonate the user, and do not bypass consent polling.

## Scope Rules

Request only scopes returned by `discover_user_domains`.

Do not request or invent:

- `pkm.read`
- `pkm.write`
- `vault.owner`
- raw internal PKM paths
- full-profile dumps
- broad parent scopes when a narrower discovered child scope satisfies the purpose

Dynamic `attr.*` scopes are per-user. Two users can expose different scope catalogs.

## Data Boundary

This OpenClaw bundle launches the local `@hushh/mcp` stdio bridge. On that transport, `get_encrypted_scoped_export` may fetch the authenticated ciphertext resource, decrypt locally with the connector key stored on the user's machine, and return a bounded `delivery: decrypted_local` `data` object. Hosted HTTP MCP returns encrypted export metadata plus an authenticated resource link instead. Treat any decrypted payload as purpose-bound, scoped, and time-boxed.

Store only workflow metadata by default: consent request id, receipt/token reference, scope label, status, expiry, and audit reference. Do not persist raw PKM, KYC documents, full email bodies, vault data, user keys, connector private keys, or broad personal profiles.

If a downstream system receives plaintext personal information, that copy is outside Hussh's zero-knowledge boundary and must have explicit purpose, retention, encryption or masking, access control, deletion, and audit ownership.

## Tool Notes

- Use `country_iso2` or `country` when a phone number is national rather than E.164.
- Use `expected_scope` on export retrieval so broader reused grants can still be narrowed by the connector.
- If a result says a narrower scope is required, rediscover or choose a more specific discovered scope instead of requesting a broad export.
- If authorization fails, have the operator refresh `HUSHH_DEVELOPER_TOKEN` through the Hussh developer workspace.
