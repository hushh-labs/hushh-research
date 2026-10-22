# BYOK Reviewer Browser Contract

Use this contract for browser rehearsals whose result depends on protected information after vault unlock. It applies across One, Kai, Nav, KYC, Gmail, RIA, and future private-agent surfaces.

## Identity and authority

1. Use the canonical environment-wired reviewer identity. Resolve it through `hushh-webapp/scripts/testing/reviewer-test-identity.mjs`; do not create a convenient replacement account.
2. Mutating a shared reviewer fixture requires explicit operator authority for that task. Read-only authentication, unlock, routing, and rendering checks do not grant write authority.
3. Never reset, delete, reseed, or broaden grants merely to make a rehearsal pass.
4. Automated authentication does not record legal agreement. Use the reviewer
   automation bridge; defer the specific Terms and Privacy dialog with “Not now”.
   Keep legal-acceptance writes blocked unless that separate agreement is explicitly
   authorized. Do not use an interactive sign-in click as an automation fallback.
   An isolated preview may instead explicitly select `human_authenticated` before
   preflight, as defined in [reviewer preflight](human-reviewer-authentication.md).
   This observes ordinary human Google sign-in and manual vault unlock without
   injecting mint credentials; it never converts a failed automatic run to human mode.
   Explicit headless `operator_issued_token` admission for an isolated preview
   follows that same reference: real operator-minted Firebase tokens, exact
   main-frame/origin/owner binding, no initialized passphrase and no backend
   receipt fabrication. It never falls back from another failed mode.
   Apple exchanges are not admitted by this rehearsal contract.

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
node .agents/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs
```

Read-only rehearsals locally suppress POST requests to the known Google Analytics
collection endpoint and send no measurement events through that path. This is not
analytics delivery proof; use the owning analytics smoke workflow for that evidence.
All other unapproved product mutations remain refused. The route guard must be
installed before the first navigation.

Domain rehearsals import the harness and add only their domain assertions. They must not duplicate secret-resolution or navigation logic.

Private Memory preparation may opt into `admitOwnerPodMemoryPreparation` together
with `allowMemoryPreparation`. This filters only non-navigation HTTPS
`POST /api/one/pod/memory/proposals`, without URL credentials, query or fragment.
Before accepting, the caller must discover the endpoint through the current
owner's authenticated hub API and verify it with the canonical `verifyHubSignature`.
Freeze the owner/environment/key/version/URL tuple and revalidate it before
forwarding; endpoint rotation or owner/vault retirement refuses the request.
Bind the request to the reviewed synthetic message, expected owner and body
contract. Keep discovery, signatures, tokens and source information in memory.
This filter supplies no pod-session authority and admits no enrollment, renewal,
encrypted save, consent or payment. Existing owner-session attachment checks its
lease before and after the asynchronous callback.

An explicitly authorized owner-cloud or Stripe-connector rehearsal may supply `admitProviderOAuth`
with `admitMutation`. This opt-in admits only reviewed POST document navigation
in the top frame at exact Microsoft sign-in origins or Stripe's declared
`https://access.stripe.com/mcp/oauth2/authorize` endpoint. Stripe token,
registration, login and payment endpoints are not admitted by this exception.
The callback must bind the exact selected page and current owner/PKCE attempt;
absent or failed admission remains refused. It never admits background writes.
At a full-page provider handoff, retire the app attachment and install a separate
provider-phase guard on the same task-owned page. Fence its captured route handler
before and after awaited admission and immediately before forwarding; remove only
that handler on retirement. App return requires fresh owner/vault admission and
an armed callback barrier before unlock. Never replay an ambiguous completion. The known Microsoft
`browser.events.data.microsoft.com/OneCollector/1.0/` telemetry POST is suppressed
locally, just like the known Analytics collection endpoint; no measurement is
forwarded. Owner OAuth state, code and credentials remain memory-only. Preserve
the original authenticated page, and exercise cold recovery separately rather
than changing Firebase or vault persistence.

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

Proactive private-agent wake requests use this same guard before touching owner,
cooldown or in-flight state. Mount, composer, foreground and visible-tab triggers
cannot wake a costed private runtime during a read-only or bounded rehearsal;
an explicitly authorized session retains its ordinary wake allowance.

Read-only reviewer sessions never write Terms and Privacy acceptance.
`LegalAcceptanceService.recordSignInAcceptance` returns before any request under
that signal. This defers the record, it does not drop it: the fixture's next
ordinary sign-in still finds the served version missing and records it. For
everyone else the write is version-aware: it reads
`GET /api/account/legal-acceptance` and posts only when the served Terms or
Privacy version is not already the latest acceptance.

## Failure classification

Fail closed and classify the first broken boundary:

1. reviewer identity or environment parity
2. authentication or passphrase wrapper
3. vault-key hash integrity
4. same-session navigation continuity
5. cold-session re-unlock/readback
6. domain-specific storage, scope, projection, or consumer behavior

Do not weaken the BYOK or navigation assertion to turn an environment defect into a pass.

Private connector rehearsals compose `admitOwnerPodConnectorOperation` with the
existing bounded `admitMutation` callback; connector-only configuration is refused
before browser or route installation. The port admits only non-navigation HTTPS
POSTs for a custom connector's catalog, verification and OAuth begin/complete/cancel
operations. The caller must verify the current signed owner endpoint, configuration
revision and OAuth attempt; the borrowed-session lease rechecks owner/vault authority
before and after asynchronous admission. This grants no generic tool-call endpoint
or payment-write authority. Cross-origin OAuth handoff and cold-return unlock remain
separate phases; retiring a session never authorizes continued protected requests.
