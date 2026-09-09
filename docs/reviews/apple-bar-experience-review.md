# The Apple Bar — Hussh One Experience Review & A+ Plan

Standard applied: the project's own north stars — **NN‑08 "What would Apple do?"** and **NN‑09 Apple Summer 2026 design language** (SF Pro, Liquid Glass, iOS‑first, HIG spacing). This is not an outside certifier; it is Hussh holding itself to the bar it already wrote down.

> An honest note on framing. There is no literal "A+ certification from Apple," and Steve Jobs passed in 2011 — so I am not pretending either one graded this. I am channeling the standard they set: focus, taste, restraint, and *insanely great* in the moments that matter. "A+" here means: a first‑time user feels met, the signature moment gives them chills, nothing on screen betrays the promise, and every in‑between moment is crafted. I grade against that bar truthfully, and I say plainly where craft can be verified versus where only the founder's taste (applying NN‑08) can sign off.

Scope reviewed: `hushh-research/hushh-webapp` (Hussh One, the consumer product) grounded in real files, plus the developer service reviewed last cycle (`hussh-dev-platform`).

---

## The one‑paragraph answer

The **raw materials are at the Apple bar** — the design system (Foundation color, iOS‑Blue + Molten‑Gold accent, semantic tokens, verified), the motion system, the onboarding copy, and even the *specification* of the consent moment are restrained and confident. But the **soul moments are disconnected**: the signature consent "Bark" — the entire reason this product exists — ships as an admin ledger (and, in the reusable path, a literal `window.confirm()`), while the beautifully designed consent dialog sits unused as dead code. The **home doesn't greet you or give you a reason to open it on day 1** (the personalization is literally passed in and thrown away). And **backend vocabulary bleeds onto the exact trust surfaces** where the consent‑first promise has to be *felt* ("Scope code," "Action," "create a row in `user_push_tokens`," "VAPID key," "KYC"). So this is not a "start over" — it is a "connect the soul, greet the human, and stop leaking the plumbing." That is a reachable A, and with two or three genuinely delightful moments, an A+.

**Honest grade today: B− (B+ craft undermined by disconnected soul moments and plumbing leaks).**

---

## Grades by the areas you named

| Area | Grade | Why (evidence) |
|---|---|---|
| **End‑user experience** | B− | World‑class intro + setup copy and motion; but the consent soul moment is an admin ledger, home is an inert launcher, and jargon leaks at trust surfaces. |
| **The signature consent moment** | C | Specced to the Apple bar (`consent-dialog.tsx`) then **not wired up**; live path is a settings table, reusable path is `window.confirm()` (`consent-dialog.tsx:266`). |
| **Engagement** | C+ | Real loops exist (opportunity nudges, consent push) but are buried in the Agent workspace; no daily brief, no proactive One moment on home, no reason to return. |
| **Understanding / meeting the customer where they are** | B− | Setup hub is genuinely inviting and value‑first; but deep‑links land on a bare credential wall, and system nouns ("KYC," "Scope code") assume the user speaks Hussh‑internal. |
| **Service experience (developer)** | B− | The MCP build loop and validator are good; onboarding friction, contract drift, and the missing attach path cap it (prior review). |
| **Service engineering** | B | Strong: server‑authoritative onboarding, voice/UI parity, consent protocol, tri‑flow parity, design‑system verifiers. Held back by the soul moment shipping disconnected from all of it. |

The through‑line: **engineering and design are ahead of wiring and enforcement.** Apple ships when the last 10% — the moment, the greeting, the word choice — is done. That last 10% is exactly what is missing.

---

## What is already at the bar (keep, protect, amplify)

- **`IntroStep` (`/`)** — typography‑led, "Your agents. Yours to own.", the four motions as quiet rhythm, "Nothing moves without your consent." Restrained and confident. This is the voice.
- **Setup hub + `capability-setup-copy.ts`** — value‑first, jargon‑stripped tile copy ("Save what matters," "so One can understand the brands you care about"). First‑class, non‑punitive Skip.
- **Motion system** (`globals.css` motion tokens, `OnboardingHeroBackground`), **toasts** ("Reminder set — this will come back tomorrow"), **`not-found.tsx`**. Genuinely tasteful.
- The **Foundation design system** and its verifiers (`verify:design-system`, `verify:accent-tokens`).

---

## The A+ rubric (what "insanely great" means here)

An area is **A+** only when all of its row is true:

| Dimension | A+ definition |
|---|---|
| First impression | Every front door (`/`, `/getting-started`, `/login`, deep links) tells the promise before it asks for anything. Zero credential‑wall‑first paths. |
| The consent moment | One designed, wired, per‑request moment. Specific human "why," a plain "what you get," decline as a first‑class equal, real tactility on native. No "Scope code," no "Action," no OS‑confirm anywhere. |
| Home / day‑1 | Opens with a warm, personal greeting and at least one real "One noticed / here's your day" value card on cold start — never a bare tile grid. |
| Language | No internal vocabulary on any user surface. "Vault" is an allowed consumer metaphor; "PKM," "scope code," "VAPID," "KYC," "row in table" are not. Enforced by a check, not vigilance. |
| In‑between moments | Branded loading (not gray pulsing text), skeletons where content will land, crafted `error.tsx` coverage app‑wide, encouraging empty states with a next action. |
| Tactility & motion | Haptics actually fire on decisions (Approve/Deny, completion) on native; motion is meaningful, not decorative. |
| Focus | Nothing on screen that the user didn't need in that moment. Say no. |

---

## The plan — focused iterations (Apple = one thing at a time, superbly)

Ordered by leverage. Each iteration is: build → verify (typecheck + tests + `verify:design-system`) → re‑grade → next. The founder's taste sign‑off (NN‑08) is the final gate on each; craft and correctness are what I verify.

1. **Iteration 1 — Wire the soul.** Make the consent moment the designed moment, not a ledger or a `window.confirm()`. Specific human justification, a "what you get" line, decline as a warm first‑class equal, no internal vocabulary. Kill the `window.confirm` stub. Remove the raw push‑token/VAPID engineering text from the user surface. Retire the "KYC" user label. *(This review starts here.)*
2. **Iteration 2 — Greet the human *(founder taste call — do not ship silently)*.** The home passes `displayName` and drops it; there is no greeting. The Apple‑lens instinct is to greet warmly on open. **But** `__tests__/components/one-dashboard-page.test.tsx:52‑58` *deliberately asserts a greeting hero was removed* ("Good to see you, Kushal.", the "One" hero, and the tagline are all asserted absent) — so the team intentionally chose a clean roster with no hero. I built a light, timezone‑correct greeting ("Good morning, Manish." + one honest state‑derived line, no hero block, no tagline) and then **backed it out** rather than override an intentional, test‑encoded decision. This is a taste decision for Manish under NN‑08: *does One greet you on open, or stay a silent tool?* My recommendation: a single warm line (not the old hero), because a consent‑first relationship layer should feel present — but this is your call, not mine to force. If yes, the change is a ~15‑line client component + un‑asserting the negative test.
3. **Iteration 3 — One front door.** Deep‑links to `/getting-started` and `/login` show the promise (reuse `IntroStep`) before the credential ask. No bare‑wall entry.
4. **Iteration 4 — The in‑between.** Branded loader + skeletons; app‑wide `error.tsx`; encouraging empty states with a next action.
5. **Iteration 5 — Make it feel.** Wire real haptics off the existing `hapticFeedback` setting into decision controls (Approve/Deny, setup completion) on native; add the small motion punctuation on the consent decision.
6. **Iteration 6 — Enforce the voice.** A user‑facing‑vocabulary linter (like `verify:accent-tokens`) so "scope code / PKM / VAPID / KYC" can never reach a screen again.

Then re‑grade the whole arc against the rubric and hand the founder the taste sign‑off.

---

## Grade progression (updated each iteration)

| Iteration | Focus | Craft grade (verified) | Notes |
|---|---|---|---|
| 0 (baseline) | — | **B−** | Soul disconnected; home inert; plumbing leaks |
| 1 | Wire the soul (consent moment) | **B** (consent moment C→B+) | Killed the `window.confirm` stub; elevated the dialog to human copy + first-class "Not now"; removed `user_push_tokens`/VAPID/"Scope code"/"Action"/"KYC" from user surfaces. Verified: tsc 0 errors, ESLint clean, 36 tests green, no gateway drift. |
| 2 | Greet the human | **held — founder taste call** | Built a light greeting, then backed it out: the team deliberately removed a greeting hero (test‑encoded). Surfaced as a decision for Manish rather than overriding it. No code shipped. |
| 6 | Enforce the voice (done early — it protects iteration 1) | **B+** | Added `verify:user-vocabulary` gate (wired into `verify:design-system`) so internal vocabulary can never reach a consumer screen again. Proved the gate fails on a real violation, then passes clean. It immediately caught a missed leak: "consent ledger" on the Consent Center → humanized. Product names ("vault", "Personal Knowledge Model") deliberately excluded — that's a founder naming call, not a linter's. |
| 4 | The in‑between (error moment) | **B+** | Added `app/error.tsx`: every route now recovers in One's voice (calm, non‑blaming, Try again / Go home, support reference) instead of Next's default error screen. Pinned by 4 regression tests, including "never leaks the raw error message to the person". |

**Verified after iterations 4 + 6:** full suite **2063 passed / 0 failed** (baseline was 2059), `tsc --noEmit` 0 errors, ESLint clean, `verify:design-system` chain green.

### Iteration 1 — what shipped (verified)

- **The consent dialog is now the designed moment, not an OS prompt.** `useConsent` no longer calls `window.confirm()`; it presents the branded `ConsentDialog` (`components/consent/consent-dialog.tsx`). Copy is human: 🤫 (not 🤖), "wants your go-ahead" (not "is requesting permission"), "{agent} will be able to see:", "Ends on its own in N days. You can undo it anytime.", "Encrypted end-to-end. Only you can open it." Decline is a warm, equal-weight **"Not now"** with no punishing red ✕.
- **The live Consent Center stopped leaking plumbing.** The push-notification panel no longer tells users to "create a row in `user_push_tokens`" or check the "VAPID key" — it reassures them ("Nothing is lost," "Nothing moves without your yes"). "Scope code: attr.financial.*" → "Covers Financial data"; the raw "Action: {id}" line is gone; "Already granted" scopes are humanized.
- **"KYC" is gone from the user surface.** The email capability is now "Let One draft for you" / "Set up drafting" (the "kyc" voice alias is retained for continuity); the voice gateway was regenerated and re-verified.
- **Still open for the consent moment to reach A:** wire a per-request `value_offered` ("what you get") from real Nav requests, and fire haptics on Approve/Not-now on native (iteration 5).
