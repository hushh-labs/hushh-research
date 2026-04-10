---
name: security-audit
description: Use when the request is broadly about IAM, consent, trust, vault, PKM, streaming safety, verification, or audit workflows and the correct security specialist skill is not yet clear.
---

# Hushh Security Audit Skill

## Purpose and Trigger

- Primary scope: `security-audit-intake`
- Trigger on broad IAM, consent, trust, vault, PKM, verification, streaming, and audit-oriented requests where the correct spoke is not yet obvious.
- Avoid overlap with `backend`, `repo-operations`, and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `security-audit`

Owned repo surfaces:

1. `docs/reference/iam`
2. `docs/reference/streaming`
3. `hushh-webapp/lib/consent`
4. `hushh-webapp/lib/vault`
5. `hushh-webapp/lib/pkm`
6. `hushh-webapp/lib/personal-knowledge-model`
7. `consent-protocol/hushh_mcp/consent`
8. `consent-protocol/hushh_mcp/trust`
9. `consent-protocol/hushh_mcp/vault`

Non-owned surfaces:

1. `backend`
2. `repo-operations`
3. `docs-governance`

## Do Use

1. Broad trust-boundary and audit intake before the correct spoke is clear.
2. IAM, consent, vault, PKM, streaming-safety, and verification questions spanning docs and code.
3. Choosing whether the work belongs to IAM/consent, vault/PKM, quality contracts, or streaming contracts.

## Do Not Use

1. Broad backend runtime work where trust is not the primary boundary.
2. CI/deploy/env parity work that belongs to `repo-operations`.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `docs/reference/iam/README.md`
2. `docs/reference/streaming/README.md`
3. `docs/project_context_map.md`
4. `consent-protocol/docs/reference/consent-protocol.md`

## Workflow

1. Identify whether the real ownership surface is IAM/consent, vault/PKM, quality contracts, or streaming contracts.
2. Keep trust-boundary docs aligned with code and verification changes.
3. Route general backend runtime work back to `backend` when trust is not the primary concern.

## Handoff Rules

1. Route consent scopes, actor model, and IAM/runtime gate work to `iam-consent-governance`.
2. Route vault and PKM storage/boundary work to `vault-pkm-governance`.
3. Route cross-surface test and verification policy to `quality-contracts`.
4. Route SSE and streaming contract work to `streaming-contracts`.
5. If the request begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
./bin/hushh docs verify
cd consent-protocol && python3 -m pytest tests/quality -q
```
