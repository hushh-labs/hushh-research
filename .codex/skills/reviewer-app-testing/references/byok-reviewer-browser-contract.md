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

### PWM streaming and reviewed-save acceptance

`scripts/verify-reviewer-pwm.mjs` composes this harness for an explicitly
authorized UAT research-and-save run. It requires the intended verified email,
matching reviewer UID, bounded mutations, live incremental progress before a
terminal result, original Azure citations and a supported owner-linked finding.
It preserves the existing email preference. It never resets a fixture or
accepts an ambiguous identity to manufacture a save.

An explicit refresh starts a new proof epoch. Automatic `ensure` resumes retain
that epoch's acknowledgement and stream receipts; a separate response fence
rejects delayed status responses from before the resume. An old offered draft
cannot certify a new run, and usage remains bound to the received draft.

The existing Download Memory action supplies the browser-only preservation
check. Its armed Blob download is intercepted before disk access; the full
baseline and post-save `one_memory` stay in that browser. Only one exact bullet,
its accepted owner-declaration claim and authored timestamps may change.
A matching newer encrypted snapshot receipt, same-session saved row and fresh
authenticated/unlocked context provide separate persistence checks. The shared
reviewer's authorized new claim is retained.

GitHub UAT runs opt in with `run_pwm_acceptance`. They require an operator's
RSA public key in `pwm_evidence_public_key` (base64 DER SPKI); research results
are sealed using an ephemeral AES-GCM key wrapped with RSA-OAEP-SHA256 before
artifact upload. The corresponding private key stays with the operator. Logs
contain fixed stage/status codes only. This does not export old Memory, keys,
tokens, private baselines or request bodies, even inside the sealed report.
`pwm_expected_emails` binds the configured reviewer to the intended owner.
An observed, verified email mismatch is terminal before research or saving;
closed boolean diagnostics distinguish it from a missing lookup. An older
lookup response cannot restore admission after a newer mismatch.

When the human explicitly authorizes their existing account rather than the
configured reviewer, a local operator may call `runPwmAcceptance` once with an
in-memory `ownerLogin` capsule. The operator supplies a genuine Firebase custom
token for the verified existing account and its actual vault passphrase. The
test intercepts only its exact review-session transport; the Firebase SDK and
backend still verify the credential and the browser still unwraps the vault.
This mode is refused in CI and records `operator_authorized_existing_owner`.
It does not change reviewer configuration, create an account, reset a vault,
or persist credentials. Use a hidden local credential prompt, never chat,
command arguments, files or evidence artifacts. Separate processes are required
for separate owner runs.
`pwm_owner_confirmed_profile` must come from the human's explicit confirmation
of their exact GitHub profile. Azure's `candidate_for_review` and `uncertain`
decisions remain unchanged. Only a supported finding citing that exact profile,
with a selected candidate and no blocking conflicts, is eligible for the existing
owner-review Yes action. This confirmation does not extend to other social
accounts or linked repositories. The sealed report records the separate review
basis and original model identity; it never claims an independent contact link.
An opaque salted commitment crosses contexts in process memory only, letting
the cold export prove exact whole-domain equality; it is never an artifact.
The save rehearsal invokes the existing product Sign out action, requires
session-cookie deletion and a fresh anonymous landing document, then explicitly
signs in and unlocks again before cold readback. Its bridge enables automatic
login and supplies unlock material only on the trusted top-level login entry,
so logout cannot silently authenticate the landing page again.

### Additive Memory preservation proof

The Memory panel can install `window.__HUSHH_NATIVE_TEST__.pkmProof` only for
an explicitly enabled, owner-matching, unlocked `bounded_mutation` reviewer
session with `pkmProofEnabled: true`. This is test admission, not authentication.
The existing auth-owner/vault-epoch guard and current token readiness still apply.

Set `pkmProofExpectation` from the exact reviewed synthetic fixture, then invoke
parameterless `begin()`. It binds one immutable addition in Financial or
Professional before saving; one bridge cannot reset that allowance by remounting
the panel. It reads a coherent existing domain snapshot through
the application's forced browser-side loader. `verify` requires the successful
save's exact, newer content revision and checks both occurrence preservation and
exact resulting content, excluding unapproved additions. Both return only fixed
status codes. Missing domains, replacement writes and empty-container expansion
are not silently reinterpreted as successful additive proofs.

Use the exact reviewed card and admitted save receipt, not guessed expectations
or a historical request. The proof is one-shot and dies on panel unmount or
session change. Complete preservation before navigating; same-session revisit
and cold re-unlock require separate exact readback. This seam is not itself a
completed browser rehearsal, and a save acknowledgment proves neither readback
nor preservation. Never retain snapshots, expected private values, keys or tokens
in diagnostic artifacts.

## App-side read-only posture

The guard is not widened for writes the app makes on its own. The app withholds
them instead, behind the single shared signal
`shouldSkipReviewerBackgroundWritesForAutomation()` in
`hushh-webapp/lib/testing/native-test.ts` (the harness bridge with `enabled`,
`autoReviewerLogin` and a `read_only`, `preparation_only` or `bounded_mutation`
policy). A `mutation_authorized` run keeps ordinary behavior.

Read-only reviewer sessions never write Terms and Privacy acceptance.
`LegalAcceptanceService.recordSignInAcceptance` returns before any request under
that signal. This defers the record, it does not drop it: the fixture's next
ordinary sign-in still finds the served version missing and records it. For
everyone else the write is version-aware: it reads
`GET /api/account/legal-acceptance` and posts only when the served Terms or
Privacy version is not already the latest acceptance.

Evidence (2026-09-29): both BYOK rehearsals that ran after acceptance shipped
(UAT runs 36372988279 and 36518015330) reported
`POST /api/account/legal-acceptance` from the reviewer sign-in. The lane is
advisory in the UAT verdict, so it warned rather than blocked, and it arms only
when a vault or test-posture path changes, so most deploys skipped it. The
served legal version (2.1) was the same in both runs. The cause was that sign-in
posted on every sign-in, whatever was already on file.

## Failure classification

Fail closed and classify the first broken boundary:

1. reviewer identity or environment parity
2. authentication or passphrase wrapper
3. vault-key hash integrity
4. same-session navigation continuity
5. cold-session re-unlock/readback
6. domain-specific storage, scope, projection, or consumer behavior

Do not weaken the BYOK or navigation assertion to turn an environment defect into a pass.
