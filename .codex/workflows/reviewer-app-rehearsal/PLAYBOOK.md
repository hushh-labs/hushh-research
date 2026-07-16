# Reviewer App Rehearsal

Use this workflow when protected browser behavior depends on reviewer authentication, BYOK unlock, decrypted information, or an in-memory vault key.

## Goal

Prove same-session behavior and cold-session recovery as distinct contracts without leaking secrets or silently mutating the shared fixture.

## Steps

1. Route through `security-audit` and select `reviewer-app-testing`.
2. Resolve only the canonical environment-wired reviewer identity.
3. Record whether the run is read-only or explicitly mutation-authorized.
4. Authenticate and unlock; locally verify the wrapper-derived key against `vaultKeyHash`.
5. Execute protected sequential steps with app-internal Next navigation in one browser context.
6. Assert `vault_unlocked` after every route transition.
7. Close the context and prove cold-session authentication and re-unlock separately.
8. Add domain assertions through the owning spoke; keep BYOK/session mechanics in the shared harness.
9. Report only redacted status and aggregate counts.

## Common Drift Risks

1. A direct route, reload, or fresh context accidentally replaces the same-session test.
2. A trace, screenshot, console line, or output file captures protected information.
3. A domain test duplicates identity, unlock, or navigation code and drifts from the shared contract.
4. A shared reviewer mutation occurs without current-task authority.
