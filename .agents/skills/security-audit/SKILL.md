---
name: security-audit
description: Use when the request is about IAM, consent, trust, ordinary vault encryption, failures decrypting PKM entries, PKM storage or persistence, encrypted PKM records, plaintext localStorage leaks, streaming safety, verification, or security audit workflows and no narrower specialist owns the change.
---

# Hussh Security Audit Skill

## Purpose and Trigger

- Primary scope: `security-audit-intake`
- Trigger on IAM, consent, trust, ordinary vault encryption, PKM storage or manifest persistence, encrypted PKM records, plaintext localStorage leaks, verification, streaming, and audit-oriented requests where no narrower spoke owns the change.
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
3. Owning ordinary vault/PKM persistence and choosing when work belongs to IAM/consent, reviewer/BYOK testing, PKM upgrade rehearsal, quality contracts, or streaming contracts.

## Do Not Use

1. Broad backend runtime work where trust is not the primary boundary.
2. CI/deploy/env parity work that belongs to `repo-operations`.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `docs/reference/iam/README.md`
2. `docs/reference/streaming/README.md`
3. `docs/project_context_map.md`
4. `docs/reference/iam/agent-delegation-boundary.md`
5. `consent-protocol/docs/reference/consent-protocol.md`
6. `.agents/skills/security-audit/references/anti-rationalization.md`
7. `consent-protocol/docs/reference/personal-knowledge-model.md`
8. `consent-protocol/docs/reference/private-browser-runtime.md`

## Workflow

1. Identify whether the real ownership surface is IAM/consent, vault/PKM, quality contracts, or streaming contracts.
2. For ordinary vault/PKM changes, preserve memory-only keys, encrypted persistence, manifest authority, revision safety, and cache invalidation.
3. Keep trust-boundary docs aligned with code and verification changes.
4. Route general backend runtime work back to `backend` when trust is not the primary concern.
5. For Computer Use, follow `consent-protocol/docs/reference/private-browser-runtime.md`: selected non-secret exports, manual login, encrypted opt-in sessions and generation-fenced Forget. No Secrets export, automatic credential injection or record-only cross-custody transfer is qualified by this pilot.
6. For Shared Files, follow `docs/reference/operations/private-files-library.md`: keep library keys in the unlocked browser, record storage incarnation before its first write, and retain erasure fences until the existing inventory has a qualified provider-absence receipt. A storage name or its present retention setting cannot establish historical cleanup. Shared upload session URIs are provider bearer credentials: encrypt their durable receipts through existing credential custody, bind them to the exact owner/library/operation/bucket, and require provider-terminal evidence before releasing a write fence. Never give Shared compute the browser library key.
7. For account/cloud erasure, read `docs/reference/operations/account-deletion-rollout.md` and the provider's canonical lifecycle contract. Prove the installed schema accepts the actual producer receipt before irreversible work; rollback must serialize with active admissions. Resource ownership, writer drain, absence and retained-provider outcomes require separate evidence. Key destruction or an accepted DELETE cannot establish complete cleanup.

## Handoff Rules

1. Route consent scopes, actor model, and IAM/runtime gate work to `iam-consent-governance`.
2. Route reviewer-account BYOK browser proof to `reviewer-app-testing`.
3. Route zero-loss PKM upgrade acceptance to `pkm-upgrade-rehearsal`.
4. Route cross-surface test policy to `quality-contracts` and streaming work to `streaming-contracts`.
5. If the request begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
./bin/hushh docs verify
cd consent-protocol && python3 -m pytest tests/quality -q
```
