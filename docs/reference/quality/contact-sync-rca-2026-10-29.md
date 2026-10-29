# Contact sync investigation — 29 October 2026

## Confirmed findings

The results sheet counted matching address-book entries in **Matched**, but
rendered one row per unique account and counted **Connected** per account.
Two cards for one person therefore produced ten matches above nine rows. The
own-number filter already excludes the signed-in person's number before lookup;
the self-skip notice did not explain this difference and has been removed.

Read-only UAT observations found three repeated sync completions on 24 October
2026, between 22:12:20 and 22:15:13 UTC: nine matched accounts, six connected and
three suppressed. The corresponding graph contained legacy revoked relationships
for the two named contacts in the report, with a revocation timestamp of
10 October 2026 at 18:13:03 UTC. Neither a disconnect actor nor an exact-episode
disconnect event was retained on those relationships.

The confirmed cause of the **repeated failure to reconnect** was the unconditional
suppression of these legacy revoked rows. Repeating sync could never recover
them. A revoked aggregate can represent an explicit disconnect or the loss of
its last Circle origin; missing actor evidence cannot distinguish the two.

The initial writer/actor that revoked these particular rows is **not proven**.
Nearby historical DELETE requests targeted other row IDs that no longer exist.
At 18:13:04 UTC, the service also logged that one Circle membership ended as
part of a disconnect. This is consistent with Circle-origin cleanup contributing
to the old loss, but timing alone cannot establish the exact affected pair or
Circle after those records have been removed.
There is no evidence that Apple authentication itself disconnected these pairs.
Do not describe this investigation as proving that initial trigger.

No UAT or production records, preferences, connections or deployment settings
were changed during diagnosis. Queries used a read-only database transaction;
credentials stayed in process memory. This report contains no account IDs,
contact numbers, email addresses or connection IDs.

## Repair

- **Matched** now counts the same unique people as the results list. Checked and
  No match retain address-book entry counts for coverage and invitation logic.
- Own-number exclusion remains in the matching/invitation pipeline, with no
  self-skip paragraph or empty notice container in the results sheet.
- A currently eligible exact match with a legacy revoked relationship and no
  actor annotations returns the existing `request_required` outcome. Sync does
  not send a request or activate the relationship. The user can choose Request,
  and only the recipient's acceptance restores the connection.
- Known peer removals, partial/stale actor episodes and concurrent disconnects
  retain suppression. Own explicit removals retain the existing fresh-sync
  reconnection rules. Hidden and opted-out accounts remain undisclosed.
- Aggregate sync logging includes `request_required_count` so recovery cases
  can be distinguished from suppressed outcomes without logging identities.

No API enum, database schema, native permission contract, location grant or
information-sharing authority was added. Existing request/accept paths own
recovery and retain their blocking and recipient checks.

## Verification

The nine-row/ten-card UI regression failed on the original component and passed
after the repair. Both legacy recovery tests failed with `suppressed` on the
original backend and passed with `request_required` after the repair.

The PostgreSQL fixture runs actual matching, graph writes, Circle-origin removal, no-scope request
creation, recipient acceptance, repeated syncs, disconnect races and actor
episode checks in disposable databases. It verifies that a requester cannot
accept their own recovery request and that other connections remain active.
The identity fixture now reflects the existing confirmed-transfer requirement:
an OTP alone cannot take a live account's verified phone number.

Focused results: 213 backend contract/graph/request tests, 12 PostgreSQL
integration tests and 391 frontend contact-flow tests passed. The contact tests
also cover consent settings, invitations, onboarding, permission returns and
Google fallback. The original candidate passed 507 navigation cases; after
integrating Main, 506 passed and one timed out under host pressure. That case
passed alone at its unchanged timeout. Physical iPhone acceptance has not been
performed. The operator requested cloud deployments only; native apps bundle
the results UI and require a later native build for its wording/count changes.

Final type checking, focused ESLint, Ruff lint/format checks, Apache surface
verification, UI contract validation and capability-graph freshness passed.
The full repository architecture ratchet reported zero new or worsened findings.
Backend type checking passed across 448 source files and security scanning
reported no medium/high findings. The local core mirror was invoked and resumed
after task-local Python path, UTF-8 and LF checkout repairs. The unchanged clock
tests now pass. Broader governance tests require Unix process groups and
privileged symlinks unavailable on this Windows host; those gates remain intact
and must pass in hosted CI before merge. Do not describe the local core as green.
Cross-service client checks passed 213 cases; their backend collection requires
Unix `fcntl`. The broader protocol run and full web lint were stopped before the
latest Main integration; final TypeScript, focused lint and UI contracts passed
on that combined tree, along with 144 affected UI/navigation cases. MCP package
checks, its packed runtime and the commit secret scan also passed.
Final hosted/release status belongs to the exact PR head and deployment receipts.

The status decision now lives in the existing contact-policy module. Shared
SQL and UI test fixtures were extracted to keep the touched modules within
their existing size ratchet without changing the baseline or skipping checks.
