# Explicit Human Reviewer Authentication

An isolated preview may select `REVIEWER_AUTH_MODE=human_authenticated` before
preflight when reviewer mint credentials are deliberately absent. This is an
explicit operator choice, never a fallback after automated authentication fails.
Provide the canonical `REVIEWER_UID` (and `REVIEWER_COUNTERPART_UID` for commerce)
and an exact HTTPS origin. UID-only resolution does not authorize another owner.
No passphrase or custom token is injected or fetched from Secret Manager in this mode.
The operator signs in through the ordinary provider UI and manually unlocks the vault.
The harness observes a visible locked-vault challenge for the exact authenticated
owner before accepting unlock; missing, foreign or lost identity, reauthentication,
and vault relocking invalidate continuity. Cold recovery uses a separate context
and another visible challenge. Credentials, vault keys and decrypted information
remain in browser/process memory; no storage-state export or protected capture is allowed.
Normal reviewer mode keeps its existing credential-pair preflight and mint contract.
The mutation guard admits only the narrow human provider exchanges; financial
writes still require the existing exact human-confirmed action admission.
