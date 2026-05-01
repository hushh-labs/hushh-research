---
name: kai-test-account-reset
description: Use when resetting a Kai/UAT test account by email for end-to-end onboarding, vault, RIA, consent, or profile retesting.
---

# Kai Test Account Reset Skill

## Purpose and Trigger

- Primary scope: `kai-test-account-reset`
- Trigger on requests to delete or reset a Kai test user, especially when the user provides an email and wants to retest onboarding end to end.
- Avoid overlap with `vault-pkm-governance`, `iam-consent-governance`, and `repo-operations`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `.codex/skills/kai-test-account-reset`

Non-owned surfaces:

1. `security-audit`
2. `vault-pkm-governance`
3. `iam-consent-governance`
4. `repo-operations`
5. `backend`

## Do Use

1. UAT/local test-account resets where the email is explicitly supplied by the user.
2. Dry-run discovery of Firebase UID shadows, actor profile rows, vault/PKM/RIA/consent rows, and email-linked developer/invite rows.
3. Operator-side cleanup that must remain separate from the user-facing account deletion UI.

## Do Not Use

1. Production account deletion.
2. Deleting accounts without an explicit user-authored email and action-time confirmation.
3. Bypassing the in-app `profile.delete_account` vault-owner flow for normal user-initiated deletion.
4. Firebase Auth account deletion or browser-local storage deletion unless explicitly scoped and confirmed.

## Read First

1. `consent-protocol/api/routes/account.py`
2. `consent-protocol/hushh_mcp/services/account_service.py`
3. `docs/reference/kai/kai-action-gateway-vnext.md`

## Workflow

1. Run a dry run first:
   ```bash
   consent-protocol/.venv/bin/python .codex/skills/kai-test-account-reset/scripts/reset_kai_test_account.py --email <email>
   ```
2. Report the matched UID preview and planned cleanup scope without printing secrets.
   Add `--include-counts` only when row counts are needed; it can be slow on large UAT tables.
3. Ask for action-time confirmation before deletion, naming the email, environment, and data classes.
4. Execute only after confirmation:
   ```bash
   consent-protocol/.venv/bin/python .codex/skills/kai-test-account-reset/scripts/reset_kai_test_account.py --email <email> --execute --confirm-email <email>
   ```
5. Re-run the dry run to verify there are no DB rows left for the email/UID.
6. Keep Firebase Auth and browser-local state separate unless the user explicitly asks for those deletions too.

## Handoff Rules

1. Route schema or account-deletion-service gaps to `iam-consent-governance` or `vault-pkm-governance`.
2. Route backend runtime/proxy failures to `repo-operations`.
3. Route user-facing Kai voice/search action changes to `kai-voice-governance`.

## Required Checks

```bash
consent-protocol/.venv/bin/python .codex/skills/kai-test-account-reset/scripts/reset_kai_test_account.py --email ankit@hushh.ai
consent-protocol/.venv/bin/python -m py_compile .codex/skills/kai-test-account-reset/scripts/reset_kai_test_account.py
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
