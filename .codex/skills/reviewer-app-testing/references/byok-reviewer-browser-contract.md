# BYOK Reviewer Browser Contract

Use this contract for browser rehearsals whose result depends on protected information after vault unlock. It applies across One, Kai, Nav, KYC, Gmail, RIA, and future private-agent surfaces.

## Identity and authority

1. Use the canonical environment-wired reviewer identity. Resolve it through `hushh-webapp/scripts/testing/reviewer-test-identity.mjs`; do not create a convenient replacement account.
2. Mutating a shared reviewer fixture requires explicit operator authority for that task. Read-only authentication, unlock, routing, and rendering checks do not grant write authority.
3. Never reset, delete, reseed, or broaden grants merely to make a rehearsal pass.

## Memory-only BYOK boundary

1. The vault passphrase, Firebase credential, owner token, wrapper-derived vault key, decrypted PKM, and raw source information stay in process or browser memory.
2. The browser derives the 256-bit vault key locally from the passphrase wrapper and verifies it against `vaultKeyHash` before trusting decrypted information. Playwright's Node harness may observe only encrypted vault state and the key commitment; it must never derive, decrypt, or compare raw vault keys.
3. Never place secrets or decrypted information in URLs, Playwright traces, screenshots, videos, console output, test snapshots, CI artifacts, model prompts, docs, or commits.
4. Exact decrypted evidence may be written only when explicitly requested, only beneath ignored `tmp/`, with mode `0600`, and never as a default test artifact.

## Navigation semantics

An unlocked browser context is a security state, not merely a signed-in cookie jar.

1. Start at `/login?redirect=...`, use the reviewer bridge, and wait for both the expected UID and `bootstrapState=vault_unlocked`.
2. Continue protected multi-route flows through the app's Next navigation event, `app-internal-navigation-requested`, or the equivalent user-visible link. Do not use `page.goto`, reload, or a new context between steps that claim same-session key continuity.
3. After every client navigation, assert that the unlock form is absent and the bootstrap state remains `vault_unlocked`.
4. Test cold-start behavior separately: close the context, open a fresh context, authenticate again, unlock again, and verify protected readback. A cold route is not evidence of same-session continuity.
5. Do not persist the key to survive refresh. A refresh must follow the real re-unlock/bootstrap contract.

## Reusable harness

`scripts/reviewer-session-harness.mjs` owns identity resolution, encrypted-state/key-commitment observation, memory-only owner-token capture, same-session client navigation, and fresh-context construction. Browser application code owns passphrase-wrapper decryption and vault-key integrity proof.

Run the read-only baseline:

```bash
node .codex/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs
```

Domain rehearsals import the harness and add only their domain assertions. They must not duplicate secret-resolution or navigation logic.

## Failure classification

Fail closed and classify the first broken boundary:

1. reviewer identity or environment parity
2. authentication or passphrase wrapper
3. vault-key hash integrity
4. same-session navigation continuity
5. cold-session re-unlock/readback
6. domain-specific storage, scope, projection, or consumer behavior

Do not weaken the BYOK or navigation assertion to turn an environment defect into a pass.
