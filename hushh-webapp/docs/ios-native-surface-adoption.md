# iOS Native Controls and Liquid Glass

Implementation owner: frontend/native shell. Reviewed against source on 2026-10-26.
This is a component inventory and bounded adoption reference, not a claim that every
candidate is implemented or released.

## Visual Context

The package [docs index](README.md#visual-map) owns the overview. Native controls
remain presentation adapters below the existing React action and routing owners.
One Capacitor host retains the active document; adopting a control does not create
another navigation stack, WebView, session, or information store.

## Current Implementation

The newest entry below is current; older dated candidates are historical
evidence, not admission or release claims for the latest implementation.

### Shared overlay boundary — 2026-10-26

The shared `Select` root now has a qualification-only private immediate-choice
adapter (`NativeDrawers v1: ownedChoices`). Known plain-label compound options
inherit it without route patches. The original Radix trigger, form registration,
controlled value and reset owner remain mounted; only the owned popup is native.
Feature values stay in React behind random presentation handles. Private labels
exist only in volatile presentation models. Appearance updates retain the host.
Family capability is fixed at mount; owner authorization is checked on the user's
open action, so a form preloaded before unlock is not permanently demoted to web.
Selection is delivered once, after actual native dismissal, to the current
committed callback; unchanged values do not repeat writes. Back, owner/privacy
changes and capability failures retire the same lease before any web fallback.
An attached opening/retiring sheet cannot report confirmed absence.

Controlled opening, rich labels, custom event semantics, named groups and
authored direction remain complete React presentations. Their exclusion is
semantic, not route-specific. AlertDialog's busy/refused confirmation and rich
Popover content require their own complete presentation contracts; they are not
silently converted into immediate choices. This extension does not qualify those
families or change ordinary Release/TestFlight admission, which remains off.
Current evidence: ten shared Select/privacy contract cases, the existing native
Chrome/Popover suites and plugin-contract mutation controls pass. Native Release
compilation passes. The new UIKit retirement regression and adjacent alert test
pass on iPhone; integrated route-picker device acceptance is pending.

Overlay repair belongs to the shared primitive/presenter, not to Wallet or another
route. `useNativeNavigationOverlayRef` now observes the registered primitive’s
`data-state` and `hidden` lifecycle. A retained closed portal does not isolate the
shell; an existing isolation token survives its own finite exit motion. Reopen,
replacement and unmount invalidate older completions. Nodes without an authored
state keep the existing mount/unmount contract, including the Popover scrim.
This reads presentation state only, never DOM-inferred actions or protected values.

| Shared family | Owner and renderer boundary |
| --- | --- |
| Dialog, AlertDialog, Sheet, Drawer, Popover, Select, DropdownMenu | Existing React primitives share native-shell isolation and retirement. This is lifecycle handling, not native conversion. |
| Bounded public action/choice lists | Explicit semantic adapter and owned native presenter; existing feature callbacks remain authoritative. A moving trigger must not be replaced by a stationary native control. |
| Private or rich Wallet forms and confirmations | Existing feature validation/consent/security owners; adopt a complete private scene or retain the complete React presentation. Never bridge arbitrary React children or protected values through public NativeChrome metadata. |
| Native Profile menus/editors and transient feedback | Existing acknowledged NativeDrawers scene and owned feedback presenter, with document/owner/revision/privacy fences. |
| Unconverted React content overlapping foreground native chrome | Requires a presentation-owner handoff. CSS z-index cannot cross the WebView/UIKit sibling boundary; registry isolation alone does not prove correct visual layering. |

The retained-overlay regression fails before the lifecycle fix. Nearest navigation
and Popover tests pass; iPhone Wallet layer acceptance is not established by those
tests. Do not enable another family or claim a native Wallet conversion from this
change. Shared-family qualification includes nested selection, dismissal, return
focus and touch recovery, with the same WebView/session and no duplicate editor.

### Integrated source and physical rehearsal — 2026-10-26

| Boundary | Current evidence |
| --- | --- |
| Source preservation | Main `ffc159cb69` is integrated at `2c6c24785d`: 24/25 incoming paths match exactly; the document test harness retains Main’s session-generation/committed-recovery fix plus bounded diagnostics. Production web/native inputs remain identical to installed `a76e8b17b6`. |
| Verification | Canonical core passed at `e9d3432220`; subsequent affected stages remain source-bound. At `a76`, 81 backend/migration and 164 web tests plus canonical affected stages pass. CI `40391305123` exposed two WebKit failures: the document fixture fix now comes from Main; the scroll gate’s invalid zero-start assumption is corrected, with old-code failure and six passing width/engine cases. Combined `2c6c24785d` secret/governance, area backend, UI-contract/typecheck and four Chromium/WebKit document-delivery cases pass; hosted exact-head CI remains required before landing. |
| Native Profile | Installed `a76` passes both warm batches across all 15 destinations, including nested editors, Invite and Legal. Normal reviewer unlock succeeds through whole-value input. No account mutations; session/WebView continuity passes. |
| Current physical build | Qualification and ordinary flag-OFF `a76` Release payloads/signatures/UAT settings verify all 1,765 packaged files. The local qualification App and original matching runner are installed over Wi-Fi. Ordinary builds remain separate. |
| Functional qualification | `a76` passes ten One/Puppy cycles, ten background/resume cycles plus Control Center touch recovery, real native haptics feedback with preference restoration, and three bottom-chrome scroll/reversal cycles with keyboard/draft continuity. History actions still need an authorized fixture; visual/accessibility and three-run physical frame acceptance remain open. |
| Tools and privacy | Matching Xcode 27.2 passes both public whole-value samples and normal reviewer unlock on the current qualification build. Earlier ordinary secure-field AX length mismatches remain unexplained. An isolated public-only reveal diagnostic was never entered on the successful probe; private input guards were unchanged. Raw credential results were removed. |
| Simulator | Earlier `b8` ordinary guest admission supports diagnosis only. The owned simulator is shut down; no protected or physical-frame acceptance is inferred. |

Ordinary custom-native Release/TestFlight admission remains **off**. A standard
Instruments 27.2 trace exports, but current semantic motion capture is not
qualified. Flag-OFF delivery uses the existing release gates separately from
native-default qualification. No merge, UAT deployment, native distribution,
production or public App Store outcome is implied by these receipts.

### Owned native feedback candidate — 2026-10-26

Main `c2a5638606` is integrated at `82265c0cf1`; its 22 Drive recovery,
schema and documentation paths preserve main exactly. The preceding seven
operations and 48 Wallet/receipt paths remain preserved. PR #8474 remains draft. Exact-head CI passed native builds and the core/targeted jobs; two full
suite failures exposed missing authenticated-owner setup and stale payout-model
assertions. The corrected nearest suites pass 50 tests without changing runtime
authorization, shared financial owners, deadlines or release policy.

Native Profile transient feedback now uses an additive, private NativeDrawers
capability. Morphy still owns the Sonner promise and its single notification ID;
the qualified native renderer owns one bounded banner inside the active drawer
or exact editor sheet. It never becomes a window-level/modal overlay or an
operation owner. Loading and settlement retain their renderer and host. Pending
compatible admission coalesces the latest result; destination, form, owner and
privacy changes retire it. Ordered identities reject stale expiry and dismissal.
Private text remains memory-only; privacy retirement cancels timers and scrubs it.

The two native public-fixture checks now pass on the physical iPhone in Release:
retained hosting during banner replacement, bounded geometry/outside touch
delivery, reordered expiry, and cancellation before first admission. The initial
batch exposed retirement losing its tombstone when the first apply initialized
the owner; capturing that owner at retirement corrects the reproduced failure.
Combined native/web Release `4f5d31cee0` (runtime `408a2982b2`) also passes
the real Profile App haptics feedback path: two changes restore the original
preference; the banner appears without an interactive Sonner duplicate, and
Back/Close remain available. Provider editing opens and cancels without changes.
Ten background/resume cycles and Control Center return preserve touch response.
The instrumented performance attempt failed at XCTest accessibility snapshots,
so it produced no accepted performance result. These checks do not establish
visual, keyboard or accessibility acceptance. The feedback suite now has its own
bounded module, and scene-capability
admission retains its existing public facade. Architecture fitness reports no
new or worsened findings; the original ratchet was preserved.

Independent security review found that a retained Dismiss callback could ignore
the fence's rejection and remove a newer result. The shared dismissal entry now
matches the complete displayed receipt before changing timers, containment or
end events. The existing physical presenter case fails without that guard and
passes with it; both feedback cases pass, including higher-revision explicit
retirement. The broad `6a84280145` baseline passed canonical core. That result
predates this final native correction; its combined candidate requires its own
verification and remains qualification-only.

Profile's authored plain-text feedback uses this shared path. Rich messages and
callback-authored outcomes are not automatically flattened into native metadata;
their existing feature presentation remains explicit. Menus, confirmations and
forms retain their existing complete owned presenters and dismissal contracts.
Web, Android and unsupported wrappers keep Sonner. Ordinary custom-native
Release/TestFlight admission remains **off**. The candidate's physical banner,
touch, visual, accessibility and Release performance acceptance is not established
by bridge tests or compilation; record the installed candidate's results below.

### Root-worktree Profile completion candidate — 2026-10-25

The root worktree supersedes the retired ADK checkout as the active source.
Main `66f3855082` is integrated at `e0f036778c`, after `c0bf05df4f` at
`d827eccece` and the earlier integrations of `79674242c9`, `6e28a65e0b` and
`7d5546e471`. All 48 newly incoming Wallet/receipt paths match main exactly;
105 focused Wallet checks pass. Of the preceding 104 team-changed paths,
103 matched main exactly. The remaining Profile workspace combines the
team's pending-phone-transfer Close guard with the retained connector Back
owner. Phone verification and authentication changed, so this merge needs a
new combined build; earlier device results do not qualify those changes. The
historical `f77047caac` below includes phone-transfer integration. Its canonical
core stages pass. The newer combined `05ced189e0` includes the Wallet changes;
protocol, database, web and package stages pass. Integration initially timed out
while importing Providers inside its five-second behavior test. Loading the same
mocked production module during setup preserves every assertion and deadline;
the focused case passes in 427 ms. The integration stage requires its own rerun.
Preservation checks found no dropped team content; preserve subsequent peer changes.
Profile and Chat are **partially native**, not completely qualified. The
authored roster now contains 15 ordinary destinations, plus guarded Developer
tools and Sign out. Older 13-destination runs cannot cover the expanded roster.

| Shared family / destination | Current renderer and operation owner | Qualification / rollback |
| --- | --- | --- |
| Chat shell, One/Puppy, dock and History | Existing retained native adapters; React owns separate drafts, routes and operations. Transcript and rich cards remain React. | Qualification-only custom shell; ordinary builds retain the established renderer. |
| Account, Pricing, Memory, World Model, Preferences, Security, Devices, Invite friends, Help and Legal | Existing typed Profile pages/editors and shared feature callbacks; rich/unaccepted details use the complete React handoff. | Source mapping exists; exact-current-candidate transitions, accessibility, mutations and Release performance are not established by this scan. |
| Hosting and Software updates | Native Profile pages consume the same retained controller as `AgentSettingsPanel`: status/inspection, recovery, updates/notes/verification and Browser review. | New additive capabilities; Azure sign-in/rebuild and cloud removal preserve their existing website-only restriction. Native operation feedback uses the shared result, not dispatch success. |
| Payments and earnings | Complete native composition of information-access funding/refunds/history, source-bound Answer setup, and existing document payouts. Typed amount/country sheets keep edits private and staged until Done. | Requires `profilePaymentsPages` plus the complete editor handshake. Legacy `profilePayoutPages` alone cannot replace the newer composition. Financial owners, modes, preview tokens and retry keys remain separate. |
| Profile Connectors | One retained sibling publishes both shared and private hosting models. Native pages reuse catalog, Google/Stripe, custom editor, Drive review and confirmation owners; fallback receives that same owner's web body. | No Profile remount at hosting resolution and no competing reader/editor. Unmapped phone handoff retains the complete authored web presentation. Chat's established owner is unchanged. |
| Calendar workspace and setup | React content; existing `HushhAuth.connectCalendar` shared-runtime native authorization and ApiService transport. Private hosting retains the owner-pod connector flow. | Both routes now enter the native functional inventory. This is audit admission, not new SwiftUI/glass adoption or OAuth/device acceptance. |
| Mail, Connect, Consent and Wallet swipe tabs | Existing React pager/query owners. | Keep their continuous motion and retained drafts; do not replace them with a second native selection authority. |

This is a qualification candidate under the existing single custom-shell switch.
Ordinary Release admission remains off. Source review found and repaired refused
Back acknowledgments, auth-generation revalidation, stale Stripe callbacks,
request-bound Google approval and funding retry/empty-field edge cases. The
existing private-editor fence owns IME, final edits and actual sheet retirement;
no provider token or financial operation handle enters a native form payload.
Exact-candidate physical, visual, accessibility and Release performance results
must be recorded separately; earlier device evidence does not qualify this batch.

The native route inventory previously excluded Calendar and its setup page
despite their existing native authorization path. The surface-map author also
described them as browser-only. Both are corrected together. Calendar setup
now emits its own route/marker rather than impersonating the Calendar workspace;
the nearest rendered-owner test binds both inventory rows to their actual
authenticated, settled beacons. A failed connection read now reports `error`
with a bounded code rather than passing as `unavailable-valid`; Retry restores
the loading state and clears that code. The anonymous reschedule capability reader
remains a browser-only exception. No new token store or mutation path is added.

Next bounded adoption candidates are short directory/account menus and finite
Calendar duration choices. The Connect directory trigger moves inside the
existing pager/content: the current stationary 44-point native-control adapter
is not sufficient. An independent native popup must own its complete lifetime
without replacing that moving trigger. Calendar date inputs already use the
platform form control; no glass overlay is needed merely to open a native picker.
Mail/Consent/Wallet route tabs remain deliberate retained families.

The installed UAT-backed local Release qualification binary is source
`05ced189e0`, version 1.4.1 (69), on iPhone 16e/iOS 27.2 Beta. All 1,763 bundled
runtime files match the export and generated Cordova resources. Dependency pins,
deep code signing and the executable digest were checked before installation.
The app was launched without reviewer/bootstrap arguments; normal passphrase
unlock passes. UAT independently serves `7d5546e471` at 100% traffic on
`consent-protocol-02585-suf`; it does not yet include the merged phone-transfer
backend. Account/Phone cancellation and Payments inspection/return pass on this
candidate without sending an OTP or changing reviewer records. This is not a
TestFlight release.

The combined Wallet journey passes My cards / Shared with me, the actual visible
empty state, Add-sheet inspection/cancellation, covered-navigation isolation and
return to the unchanged Chat draft and WebView. The retired three-tab rehearsal
was replaced in the existing case. Its first updated guard incorrectly required
the named HTML section to be an XCUI node; observed metadata shows that node is
absent while the visible empty body is present and no sharing error is shown.
No card, grant or financial outcome was changed.

The strict UAT roster passed Hosting/Software updates, Account and Phone
cancellation, Payments history/filtering, Pricing editing, Memory readers/editor
cancellation, World Model, provider configuration, Voice, Vault methods and
Trusted devices. Profile is full-height and phone-width. Connectors reached its
catalog, provider details, link/custom editors and Drive trust page, then failed
the final return to Profile. Sanitized follow-up shows Back alternating between
Connectors and Google Drive: the retained adapter pushed a new catalog visit
instead of consuming the detail visit. This is a product history defect, separate
from the earlier corrected offscreen-row assumption.

Fix `34a843252a` routes connector return through the existing pane Back owner.
Repeated detail visits now preserve catalog depth before returning to Profile.
The regression fails on the old push behavior (depth 4 instead of 2). The
corrected physical five-destination batch passes Connectors, Invite friends,
Help, Privacy and Terms, including their nested editor/document cancellation
and return paths. The complete roster is accounted for across these batches;
this does not establish every mutation or accessibility state.

Native fix `308d9791c4` avoids identical UIKit interaction/accessibility writes
on compatible refreshes. The extended existing host test fails on the old
binary for redundant interaction writes and passes after correction, including
actual quarantine/readmission of both owners. Thirteen public synthetic header
captures are diagnostic `drawHierarchy` output; intermittent missing Close
glyphs there are not proven compositor defects or a visual acceptance pass.
No replacement Close control or new navigation owner was introduced.

On the guarded binary, the Preferences/haptics scenario, three-destination
route/software-keyboard continuity, ten background/resume cycles, an observed
Control Center interruption and three bottom-chrome hide/reverse cycles pass.
Draft, editor and single-WebView comparisons remain process-only. The connector
callback is now placed in its existing family module and the pane Back module;
the same regression moves to the existing route-motion suite. All 132 focused
checks pass, and the architecture ratchet reports no new or worsened findings.
The reorganized `a3e0bd4b69` candidate also passes the actual Connectors catalog,
provider/link/custom editors, Drive review and final return to Profile. The
combined `f77047caac` run initially failed the aggregate Add connector form guard
after cancelling a link editor. No retention defect was established. An unchanged
product rerun passes; the existing harness now waits for the secure field's
asynchronous admission and records only fixed control geometry on failure. Its
bounded repeat run also passes. The original failure remains diagnostic evidence,
not a claimed product fix.
The visible-page-only interaction policy retains its failing-before/passing-after
native host evidence. Retained connector loading/error/Retry preserves the single
feature controller, including routine token-renewal and reopen continuity.

The combined candidate passes ten background/resume cycles and an observed
Control Center interruption, including Profile, hamburger, agent selector and
editor touch recovery with the draft and single WebView preserved. These are
functional checks, not compositor or accessibility acceptance.

Rendered transitions, accessibility and three physical Release performance runs
need their own evidence. Three measurement iterations returned zero frame counts
despite positive FPS; no hitch/frame ceiling is accepted from those samples.
Instruments intermittently sees the phone offline while CoreDevice and XCTest
work. An all-process Animation Hitches probe saved its schema table only after
reporting a device disconnect; this does not establish measured gesture coverage.
Owned collectors exited and private raw traces were removed. The supported Xcode
device-symbol preparation subsequently completed. An all-process five-second
capture then recorded its requested duration and exported 145 frame-lifetime rows,
146 vsync rows and 143 displayed-surface rows. This establishes collection only;
global/idle rows do not satisfy app-attributed gesture or three-run acceptance.
PID attachment remains refused, and symbol-timeline overlap warnings need
capture-integrity review. No SDK cause is established.
First-entry whole-value XCUI typing also remains intermittently incomplete with
public text; an unproven preparation change was discarded. Normal warm
whole-value reviewer unlock passes and incomplete entries are never submitted.
Credentials remain process-only, raw private
results are destroyed and reviewer records are unchanged. XCTest authorization
is observed, not guaranteed to persist.

Verification for this mapping batch: 51 existing Calendar owner/service checks
pass, including both rendered route/marker cases; restoring the old shared
marker makes the setup case fail while the workspace case still passes. The
corrected cases pass again. The existing retry test also fails on the earlier
false-success status beacon. Native static parity and 501 existing Back-hierarchy
checks pass. The existing UI-contract generator refreshes the surface map and
dependent orchestration/capability/topology mirrors; it adds no new action or
route authority. Founder Wiki freshness is unverified because no Wiki tool is
available in this session.

### App haptics and shared cancellation checkpoint — 2026-10-19

The combined UAT-backed Debug candidate `73de296157` and matching signed runner
are installed separately from attach-only testing. Normal whole-value passphrase
unlock passes against the visible reviewer account; credentials remain process-only
and private result bundles are destroyed. The affected five-destination batch
passes Preferences, Security, Trusted devices, Connectors and Invite friends,
including provider/protected-editor cancellation, Voice return, full-height
geometry and two real haptics changes restoring the initial device-local value.
Invite friends remains in its native Profile pane rather than a route workspace.
Ten background/resume cycles and an observed Control Center interruption pass
touch recovery. Three bottom-chrome hide/reverse cycles pass with keyboard
clearance, unchanged draft and one retained WebView. These are functional checks,
not rendered-identity, visual/accessibility or Release-performance acceptance.

Reuse unchanged earlier thirteen-destination evidence below. The preceding
`e5d095c458` shell batch also passes ten Chat/History/Profile cycles, One/Puppy,
keyboard/editor continuity and rename/delete cancellation (515.682 seconds)
without changing reviewer records; it is not evidence for a newer executable.

The originally reported broken screen is not reproduced: XCTest activation
recovers the base interface and no full-window privacy cover is present.
Sonner is not established as its cause. LLDB remains connected-only; explicit
attach crashes twice in its Darwin image loader, including with parallel
loading disabled. Debug installation is not a successful debugger attachment
or proof of an application crash. No shared service or SDK is reset.

A separate shared lease defect is reproduced: an interrupted, unconfirmed
row/Back/Close choice loses its cancellation receipt, so React's correct negative
settlement quarantines the pane. History, Profile and agent-profile share this
owner. Bounded, single-use cancellation receipts now acknowledge absence without
confirming an operation; owner/privacy changes discard them. The nearest native
host regression fails before the fix, then passes on iPhone, including privacy
reordering and protection for a newer pending choice. Confirmed operations retain
their existing settlement authority. This does not prove the original visual
failure or qualify native release. Ordinary Release/TestFlight defaults stay OFF.

### Combined physical checkpoint — 2026-10-19

Installed iPhone candidate `4ca8c78c63` is signed Release 1.4.1 (69), with
bundled UAT assets and a separately installed matching runner. Normal passphrase
unlock passes. Ten strengthened background/resume cycles and an observed
Control Center interruption pass in 177.086 seconds, including Profile touch,
native hamburger, One/Puppy selector, editor, unchanged WebView and draft.

The candidate fixes two distinct resume defects: missing/invalid header leases
rejoin confirmed native retirement/admission, while valid hosts update in place;
Profile Open/Close uses the current History entry rather than a stale concurrent
Next query that can veto reopening. The header regression fails before its fix;
277 focused checks, typecheck/lint, 26 navigation checks and UI contracts pass.
Earlier `7e70d9885f` fails Profile opening on interruption cycle eight; that
failure remains recorded, and the query race is not claimed as its sole cause.

A separate ten-cycle Profile journey and three actual navigation/scrolling
measurement iterations pass functionally in 220.282 seconds. Both exported
frame counts remain zero alongside positive FPS, so **performance is not
qualified**. Instruments lists the iPhone but cannot resolve the app by name
or its CoreDevice-confirmed live PID; no recording is created. No private screen
recording, permission change or service restart is used to work around it.

Unchanged destination evidence is retained: app `09830bc94b` traverses all 13
native Profile destinations, their implemented editors/menus, Invite friends
and Legal return without saving reviewer changes. Its later One-profile Memory
footer check fails; runner `2309318afc` reveals the below-fold action through
owned scrolling, then the targeted journey passes in 47.402 seconds. The 13
destinations are not repeated merely for the shell-only repair.

Canonical core passes in 724 seconds for the preparation batch, not the latest
head. The host-isolation, shell and runner changes have their separate evidence.
Ordinary custom-native defaults remain OFF. Visual/accessibility, usable
performance evidence, accepted-family admission, exact-head CI and release
transitions remain separate; these functional results do not establish them.

### Covered Profile preparation — implementation checkpoint, 2026-10-19

NativeDrawers v1 now negotiates preparation of the exact current Profile visit
and required editor behind the existing full-window privacy cover. Auth grants
layout preparation only after committing its validated destination or safe gate;
raw privacy continues to block actions. Native release checks the ordered
authorization, document, owner, destination, privacy generation and actual
controller/form completion again when its cover disappears. A missing editor,
retiring popup, stale receipt or replaced composition cannot release coverage.

Rich/unaccepted Profile exceptions choose one complete React header and body
before reveal. Their existing single-WebView content plane can prepare under
the cover; an exact body-paint receipt, current geometry and actual native-menu
absence are required. Pane withdrawal cancels an admitted fade immediately;
rotation requires fresh painted evidence. No per-frame cross-renderer animation,
second editor, credential persistence or new workspace conversion is introduced.
Release notifications no longer invalidate matching native chrome again, and
the safe web gate regains touch even when no native bar is admitted there.

Focused frontend/bridge checks pass (276), as do typecheck and the initial native
Release compilation. The native reviewer found four rich-pane races; they are
patched with withdrawal and rotation negative controls in the existing host
transaction test. That transaction now passes on physical iPhone in 8.849 seconds.
Its first run exposed test-fixture interference with the live WebView's Auth:
the synthetic document used the production singleton. An isolated test-owned
shield passes the same assertions without relaxing document or release guards;
production adapters continue using the existing singleton. Final compilation
passes. Exact-candidate product acceptance,
accessibility and performance remain separate. Native defaults are still OFF;
this checkpoint establishes no merge, deployment or TestFlight completion.

### Invite friends native Profile correction — 2026-10-19

Invite friends now has an authored `referrals` page in the retained Profile
navigation stack, separately negotiated through `profileReferralPages`. It is
not the independent Referrals dashboard. The shared in-pane model owns both
renderers: summary and independent reward reads, push subscription and its
disconnected-only fallback, Copy/Share, progress expansion and handle saving.
The native page preserves those sections, paired Copy/Share, determinate reward
progress and the canonical generated row artwork. Handle editing reuses the
bounded ordinary-text scene lifecycle, with a distinct `referral-handle` scene,
destination fence and existing referral writer; it cannot invoke Account Save.

The previous Invite check admitted React Copy/Share beneath native header
controls and therefore did not establish native parity. It now requires native
destination controls and rejects an interactive web duplicate. Typecheck,
focused bridge/referral contracts, canonical artwork verification and an initial
Release native compilation pass. Exact-candidate physical, accessibility,
performance and release evidence must be recorded separately. Whole-composition
privacy preparation remains unfinished; this correction does not enable native
defaults or establish merge, UAT or TestFlight completion.

### Integrated preservation repair — 2026-10-19

The ADK worktree includes main `cfcdb3618f`, including the team's bounded
Vertex-readiness recovery, provider-usage and verified-phone recovery changes. No CI policy or readiness
gate is changed by this repair. The preservation reference remains pre-landing
main `f7b77b6781`; it is not a reset target.

| Inspected difference | Source evidence | Current disposition |
|---|---|---|
| Profile roster lost neutral outlines | ADK integration `95dfa163f7` replaced the pane's authored icon selection | Restored through `PROFILE_ICONS`; web and generated iOS assets share the existing geometry and accent layers. |
| Nested Account/Security/connector rows lost approved artwork | `e6456b8315` replaced the pane-specific selections | Restored selectively; operation callbacks and provider logos are unchanged. Account name and Legal entries now select their exact authored native asset. |
| One/Puppy switching replaced the composer DOM node | Stable editor/portal work in `141ec62448` and `7cf18524a4`; `5c86617f2c` coupled placement to the selected agent | Restored stable portals with separate active claims and hidden/inert inactive owners. The existing test fails on replaced nodes before the fix, then passes identity, selection, separate-draft and inactive-submit checks for both agents. |
| Compact Chat header and inline History connectors | `c9236dfd84`/`e4c25b71b1` and `f7890fae39` | Intentional requested replacements, retained. |
| Team Chat performance improvements | Originating batching, memoization, transcript scroll, drawer-retirement and deferred-work changes inspected through integrated main | Retained: frame-batched deltas, reader override/sticky follow, scoped gesture listeners, context preparation and avatar optimizations. No additional semantic loss was established by this bounded audit; physical frame pacing remains separate. |
| Subsequent main verified-phone recovery | `c0175d308d`, `01a33dfd5a` and `3bffa17c78`, merged at `c075c85262` | Integrated without conflict. Profile retains main's pending/retry semantics and avoids repeat OTP in both renderers. The subsequent additive Auth change coordinates native privacy preparation without another session/account refresh; identity service and backend remain unchanged. |
| Payment, Wallet and encrypted-answer protection | Pre-landing and integrated AST comparison of five affected payment/wallet services and routes | No lost protection established; no backend rewrite or restoration made. |

This table is bounded audit evidence, not proof that every historical semantic
difference is safe. The actual-roster regression replaces the former colored
palette expectation; import boundaries remain enforced. Brand generation and
typecheck pass. Physical acceptance of this candidate is not yet established.

Privacy release also has an independently verified host-level ordering repair:
the receipt and action admission wait for actual cover removal, not the start
of its fade. A full-window modal touch blocker stays at alpha 1; only its visual
child fades. Native host checks cover touch isolation, interruption, stale
completion, pending popup retirement and the actual recovery deadline. The
intermediate fading-blocker implementation fails the nearest regression; the
corrected three-test host batch passes. The 53 focused frontend/bridge checks,
479 Back checks, generated UI contracts and design/brand checks also pass.
These are not physical acceptance or Release performance receipts.

The first combined core run found four new transitive icon inputs missing from
the existing editor-lane path filter. Only those exact inputs were added; its
17 scheduling/negative-control checks pass. No lane, policy or readiness gate
was removed or redesigned. The preservation candidate `86e28853a9` passes core
in 443 seconds; integration of main `cfcdb3618f` at `0da80191b1` passes in 440
seconds. Its client source is byte-identical to the installed `86e28853a9`.

That Release qualification app and its matching runner are now installed on the
iPhone. Normal passphrase unlock reaches protected Chat. The warm Profile batch
passes Account/phone and confirmation cancellation, Payouts, pricing, Memory,
Personal World Model, Preferences/Voice/provider editing, Security/Vault,
Devices, Connectors and Referrals controls without saving or deleting reviewer
records. It then fails Referrals' return to Profile; Help and Legal are not
reached. This is partial functional evidence, not whole-Profile acceptance.

The shared handoff has a source-reproduced retirement race: a retained drawer's
layout publish can precede the outgoing workspace's passive cleanup, and native
admission rejects the still-retiring workspace. The nearest regression fails
before the repair. Workspace layout cleanup now registers actual withdrawal;
incoming drawers join its confirmed completion and recheck owner, disposal and
latest projection. Failed withdrawal retains an identity-scoped metadata fence
until exact native absence is read back. No route/business action is retried.
The 216 bridge/component checks and typecheck pass. Their dock fixture now uses
the actual shared portal instead of bypassing the authored active-editor seat.
The corrected application-source core subsequently passes; bounded physical
confirmation is recorded below, separately from whole-composition acceptance.

Invite friends also has a confirmed presentation regression: its native
route-workspace prototype flattens the team's dashboard into settings rows,
omitting hero/reward artwork, progress layout and streak presentation. The route
now selects the existing complete React dashboard before reveal, even inside a
qualified native shell. Shared shell navigation and the retained feature model
are unchanged. This is an explicit linked-workspace renderer exception, not a
new native conversion or an on-tap fallback. The nearest functional regression
fails on the flattened renderer with capabilities enabled; no broad shell inset
change is needed. The unused native prototype remains reversible and unqualified.

Clarified Invite friends ownership: opening it from Profile must not leave the
pane for `/one/referrals`. The shared authored row now pushes the existing
`referrals` Profile location and reuses `ReferralsPanel panePresentation`, its
typography, scroll container, Back and Close. The standalone dashboard stays
available separately. The real Profile row-click regression fails on the old
route push; the corrected Profile/referral suites pass 37 checks. Physical
qualification now exercises this nested pane rather than dashboard route tabs.

Release qualification app `0871aa0993` (UAT-backed) and corrected runner
`3255426ec1` pass the targeted Invite/Help/Privacy/Terms warm batch on iPhone
in 93.402 seconds, with no reviewer mutations. Invite retains Copy/Share and
native Back/Close inside Profile, returning to the same menu; Legal contents,
document switching and authored Profile return pass. One WebView, the draft and
session survive. The runner measures the owned full-window content plane, not
an AX descendant's rectangle or Debug-only history fields. CSS box alignment
has separate proof: the existing optimized WebKit pane fixture passes at phone,
tablet and desktop widths (7.1 seconds), including its negative controls.
These are bounded functional/layout checks, not transition-frame, accessibility
or physical performance acceptance. The application core passes in 454 seconds;
the subsequent test-only measurement correction passes its native Release build.
The same installed app then passes ten warm background/resume cycles and an
observed Control Center interruption in 150.385 seconds. Profile touch, the
draft and the retained WebView recover after each boundary. Private result
bundles are removed after extracting sanitized pass/fail metadata.

Team UAT run `39303947189` independently completes healthy at main
`cfcdb3618f`, with matching backend/frontend serving provenance and readiness.
It does not deploy the local Invite friends repair. No matching TestFlight
upload or new native-default admission is established by this checkpoint.

This ordering repair does **not** implement shielded preparation of the replacement
Profile/form/content-pane/chrome composition. That composition barrier remains
an explicit release/default-admission blocker; native qualification stays off in
ordinary builds. Existing iPad and unsupported-wrapper fallbacks are unchanged.

### Bounded team-preservation repair — 2026-10-19

The shared Profile registry restores the approved neutral-outline artwork for
web and generated iOS assets. Stable Agent Dock portals preserve editor nodes,
selection and separate One/Puppy drafts through agent switches; inactive owners
remain inert. These repairs do not enable custom native presentation or include
the separate native privacy/lifecycle development batch. Current main's Drive,
Chat and runtime-readiness changes remain intact. Ordinary Release/TestFlight
keeps the established renderer; this source statement is not binary acceptance.

### Bottom navigation scroll clearance — 2026-10-19

Physical reproduction found a real clearance defect: the 83-point native tab
bar moved only 55 points, leaving 28 points exposed on the 844-point viewport.
The old smoke required only six points of movement and missed it. The existing
check now requires full viewport clearance and upward-scroll restoration.
The retained compositor applies one progress sample in one UIKit transaction,
adding the tab bar's safe-area travel without moving the Agent Dock into the
home-indicator region. Resting geometry and stale-sample fences remain intact.

UAT-backed Release `31617014f0` passes two physical native host contracts,
three warm down/reverse cycles, keyboard/draft/single-WebView continuity and
actual Control Center touch recovery. Its app executable is
`d5f7d766b17dcb2133745a2a86e5f1ad05589c8e8a5448e9c7ce2adffe755995`.
This is bounded functional evidence, not visual/accessibility or performance
acceptance. The correction is independently reversible at `9528b46b63`.
Ordinary custom-native admission remains off; its pinned recovery navigation,
older wrappers and unqualified iPad behavior are unchanged.

### Resume release ordering repair — 2026-10-18

The shared bridge previously counted duplicate lifecycle deliveries as new
boundaries, which could discard the sole confirmed release observation. A stale
read also returned obsolete active state despite fencing its cached observation.
The nearest regressions fail on both old paths. Identical deliveries now preserve
the epoch; superseded readers receive the current observation. iOS broadcasts
confirmed release to all privacy consumers, retaining the same native notification
and exact-document/generation/active-app/retirement checks. No action is replayed
or interaction force-enabled. Release UAT app `487d02f1ad` (1.4.1/69) passes six
physical native privacy host contracts, ten warm background/resume cycles and
an actual Control Center interruption, recovering Profile/Chat touch without
losing the draft or session. The stress runner is `ae44dd1280`; its resume case
is unchanged from `487d02f1ad`. Its unrelated field-role experiment was removed
before release; current tracked source at `2a58e1bb30` is byte-identical to
`487d02f1ad`. The installed app executable digest remains
`f0b7e6df2fadd6ebf19b5382349ebb880e6718d5c718275a424b164ea2248469`.
These checks did not reproduce every intermittent report and are not visual,
accessibility or frame-pacing acceptance. This bounded ordering fix does not
close the staged-reconstruction gate below.

### Current candidate and Memory owner boundary — 2026-10-18

Native Profile now reads its URL, query and sanitized visited-parent metadata
from one browser-entry snapshot. Previously Next could still render Voice after
browser Back had already replaced its ancestry with Preferences' entry, emitting
an intermediate `[Voice]` stack before `[Preferences]`. The nearest navigation
regression reproduces that mixed-entry path when the old split reads are restored;
the atomic read-only subscription rejects it. Back and all operations keep their
existing owners. Connector callbacks consume the same snapshot. This fixes a
source-proven ordering defect, not yet physical acceptance of all reported flicker.
The compact Back harness now awaits the Drive destination body before a second
Back; a shared `Back` accessibility label alone cannot prove arrival.

Installed stabilization candidate `cbaa3849ec` is a UAT-backed Release iPhone
qualification build, with matching app and runner, strict signatures and bundled
asset/runtime checks. It includes main through `135d3c9d2a`. Ten warm Profile →
Preferences → Back → Close cycles and three further measured iterations pass,
preserving the draft and one interactive native composer. This is functional
evidence, not whole-Profile or release acceptance. The broader shared-shell
journey completes ten History/Profile/One/Puppy cycles, including Rename/Delete
Cancel and connector return, before failing an unsupported Release assertion:
its final route guard requires a Debug-only host ledger. That failure does not
prove a route leak. The corrected harness preserves that ledger assertion in
Debug and separates observable Release route/keyboard checks from host-retirement
proof. A focused continuation with runner `d19d59dcfc` and the unchanged installed
`cbaa3849ec` app passes One/Connect/Feed withdrawal/return and keyboard/History
return, preserving one composer and the draft. It does not repeat the ten
completed cycles or claim the Debug-only host ledger was observed in Release.
Two background/resume cycles and actual Control Center interruption also pass
on the same installed Release candidate. The final canonical core passes in
1,001 seconds, including protocol, web, package and integration gates.

The shared Back owner now explicitly returns `false` when a feature consumes
Back locally and `true` when requesting the Profile query pop. Previously its
implicit result was accepted by the native callback even when no destination
change would follow. The nearest regression fails on that old result; static
review confirms the current callback preserves the return value. This fixes a
real contract defect, without attributing every earlier freeze to it.

XCTest again reports zero frame counts alongside positive frame rates; these
receipts do not qualify performance. A separate finalized Instruments capture
contains 1,487 frame-lifetime records and six hitches (about 2.07 ms/s over its
observed span). Frame lifetime is not a presented-frame interval, and the whole
capture is not a gesture-only window. It is one diagnostic capture, not the
three-run gesture/frame-limit acceptance. Ordinary custom-native admission
remains OFF; the standard native bottom navigation remains independent.

Current source review also confirms the staged-resume gate below is still open:
Auth waits for its React paint, then releases privacy; native drawer/form
consumers cannot reconstruct until that release. Old-presenter retirement is
not replacement readiness. The repair must authorize owner-fenced preparation
behind the opaque cover, declare the complete expected destination (including
its form/content pane), and uncover only after actual presentation completion.
Waiting for readiness without changing shielded admission would deadlock.
Default iPhone admission must also be distinct from explicit iPad qualification;
the present coherent qualification switch can admit both. Passing the narrow
interaction checks above closes neither architectural gate.

Back-label RCA now includes a controlled UIKit comparison: the labelled button
blurs during both `setViewControllers` and ordinary `pushViewController` with no
SwiftUI, bridge or product operations. The retained product fixture reproduces
the same effect with zero title/tint/style writes. Those raster samples disprove
an app-only rerender diagnosis; they do not establish physical compositor timing.
The shared Profile page configuration now uses UIKit's `.minimal` Back display
mode at every nesting level, preserving page titles and the system Back owner.
This removes the expanding title pill rather than replacing navigation with a
custom button or disabling its transition. It is installed in `cbaa3849ec`;
physical visual/accessibility acceptance remains separate and build-bound.

| Surface | Current evidence | Admission |
| --- | --- | --- |
| Profile navigation / privacy recovery | Installed `cbaa3849ec`: ten warm Preferences/Back/Close cycles, ten broader History/Profile/agent cycles, two background/resume cycles and a real Control Center interruption pass their interaction checks. Corrected runner `d19d59dcfc` passes the separate Release route/keyboard continuation on that same app. | Functional evidence only; staged reconstruction before uncovering, transition visuals and performance remain separate. |
| Full Memory workspace | `usePkmNaturalModel` retains the existing Saved/Add/Sharing owner and one `useSoulMemoryModel`; web bodies consume these models. Native route-body adoption is not yet enabled. | Established web fallback; no new native capability. |
| Private Memory replicas and exports | Selected records/card caches are owner/key/unlock-tagged; token renewal preserves selection. Retired Save bindings cannot submit older drafts or credentials. Exports recheck owner/vault lifetime before handoff and reuse temporary Cache sharing, not Documents. | Source/core-contract evidence only; actual UAT writes and physical qualification remain separate. |

Keep feature models above renderer selection. They expose private in-process
presentation values and existing operation callbacks, never vault credentials.
Do not serialize the whole model into native metadata: each adopted scene still
requires its closed, bounded projection and current owner/visit fence. Temporary
file cleanup is best-effort; process termination is not proof of secure erasure.

### Profile roster and source coverage — 2026-10-18

Installed `a8efed082b` (UAT Debug iPhone qualification, matching app and runner)
passes normal passphrase unlock and one attach-only traversal of all 13 Profile
destinations. The run reaches Account/Phone and destructive Cancel, Payouts,
Pricing, Memory/editor Cancel, World Model, Preferences/Voice/provider editor,
Vault/editor Cancel, Devices, Connector details/editors, Referrals' three tabs
and rules/Back, Help without sending, and both legal readers. It performs no
record mutations. This supersedes earlier runner-startup failures, not their
diagnosis: OS automation authorization was established before the passing run.
It does not establish visual/accessibility, actual-save or Release-performance
acceptance, and predates the following shared/protected Memory source batch.

Memory's private native stack now source-maps received consented records and
Drive collections/files through the same retained readers as web. Sensitive
fields require explicit disclosure; Copy checks the exact grant, content and
privacy lifetime before clipboard work and any asynchronous fallback. Secrets
uses the shared list/reveal/removal/identity-filing owner, the existing 45-second
hide and second-tap Copy policy, and existing encrypted writers. Native Back and
confirmations stay within Profile. Values remain private in-process replicas;
vault keys, tokens and wrapping material never enter projections. These new
paths require additive iPhone qualification capabilities; old wrappers retain
their complete web bodies. Installed `7c71028adc` passes the attach-only received
records/Drive/Secrets and Preferences read/Cancel journeys, without mutations.
This is functional evidence, not visual or whole-family acceptance.

The reported nested Back-label flicker exposed unconditional UIKit title and
`backButtonTitle` assignments on every model refresh, including active push/pop.
The candidate updates navigation metadata only when changed and after UIKit
settles. Controllers, navigation items and the native transition remain retained;
appearance/content refreshes are not a reason to rebuild Back. The nearest host
regression observes actual navigation-item writes and mid-pop refresh ordering.
On installed `7c71028adc`, the user still observes Back text appearing, blurring
and returning. The title-setter fix is therefore insufficient; that candidate
fails visual acceptance. The next controlled correction makes ancestor style
and tint updates idempotent and moves the SwiftUI body accent below the UIKit
navigation boundary, leaving UIKit as the sole navigation-bar tint owner. The
existing synthetic host regression fails on the prior implementation with three
redundant ancestor tint/style writes for three compatible content updates. This
establishes the redundant appearance writes, not their physical pixel effect.
Expansion is held until the corrected integrated transition is reviewed.

Installed `bf3c5a1620` passes Account/Phone, Payouts and Pricing read/Cancel
journeys. The combined traversal then fails Live memory → Memory return; its
failure diagnostic sees the privacy cover. Later attach-only admission restores
interactive Chat in the same unlocked session. The cover's triggering path is
not yet established, and the remaining destinations in that run are not passes.

The nearest bridge regression separately reproduces a completed Back being
dropped when compatible content refreshes during native confirmation. The
qualification candidate adds `compatibleBackRefreshes`: Back/root/ancestor keep
their exact native emission and one-shot consumption but survive updates within
one destination. Owner/document/revision, privacy, destination/path, open/enabled,
Back eligibility and navigation-lock transitions fence that compatibility;
A → B → A does not revive an old choice. Older wrappers and row operations stay
strict. Confirmed settlements survive their own committed destination change.
Memory also projects its busy navigation lock and rejects a native pop that its
existing feature Back handler merely consumes without committing. These are
source/contract corrections, not proof of the physical failure's cause or visual
acceptance. Ordinary native admission remains disabled.
Installed `297349486a` passes the previously failed Live memory → Memory return,
sharing, received records/Drive/Secrets returns and the financial-context editor
keyboard/Cancel journey. It returns to Profile in the same warm session without
mutations or privacy coverage. This is functional evidence, not acceptance of
the reported Back-label blur or whole-family visual/performance qualification.
The same installed candidate then passes the remaining nine destinations:
World Model research/source editor Cancel, Preferences/provider editor and Voice,
Vault/protected editor Cancel, Devices, Connector details/editors/trust, Referrals
tabs/rules, Help without sending, and both native legal readers with document
switching and return. These are read/Cancel journeys, not real-save or mutation
proof; the separate Account/Payouts/Pricing evidence above remains build-bound.
The subsequent shared-shell stress run completes nine warm cycles, then stops
with XCTest snapshot/session errors and a privacy-cover diagnostic. The process
remains alive and a fresh service probe reports an unlocked, authenticated Wi-Fi
connection. This does not establish the cover's cause or a ten-cycle pass; the
ordered background-recovery check was not reached.
One subsequent attach-only recovery enters XCTest but finds no admitted Try again
control beneath the cover. The current cover/recovery failure therefore remains
unresolved; neither healthy transport nor the earlier passing batch clears it.

A follow-up negative control reproduces a second Back admission gap: a compatible
apply dispatch can start after the choice awaits the preceding drain. Follow the
replacement drain before comparing acknowledged/current state; do not confirm an
unacknowledged projection or discard a valid pop merely because of that gap.

The candidate also adds negotiated `closeSettlements` using the existing private
choice settlement port. Authored busy rejection returns false, restores the same
native drawer promptly and cancels its terminal deadline without replay. Accepted
Close still waits for an authored closed projection before releasing coverage.
The native controller fences restoration by the exact Close sequence, motion
lifetime and privacy generation; stale and duplicate settlements cannot reopen a
new visit. A late receipt from a closed/reopened lifetime also cannot quarantine
the newer root merely because both visits share its destination key. Older
clients retain the existing bounded timeout/readmission path.
Focused negative controls fail on the prior JS implementation; physical rejection
and transition qualification remain separate from contract/host evidence.

Referrals continuation (qualification-only candidate): the standard route has a
private body projection independent of Profile's modal lifetime. It maps You,
Ranking, Rewards, rules, existing Share, Circle selection/joining, creation and
people selection through shared feature models. Catalogue filtering and reward
claims use the same server-authoritative model as web; a threshold never mints
an entitlement. Ordinary builds remain unchanged. The explicit iPhone qualification
shell now advertises `routeWorkspaces: ["referrals"]` for integrated device testing;
this is not general admission or whole-family acceptance. Main is integrated at
`a8f125475b`. The route's authored `AppPageShell` owns width and gutters, while
the stationary shell seat owns vertical chrome clearance; scrolling page height
never becomes native viewport height. Titles and the existing route beacon match
the web presentation. The latest five native host editor/owner/scroll cases pass;
the changed-family physical journey also traverses all three tabs and rules/Back.
The installed `a8efed082b` journey passes those tabs and rules/Back; mutations and
visual/performance qualification remain separate.

The body uses retained UIKit containment below native drawers, a shared owner
fence, exact post-confirmation projection checks, cancellation tombstones,
privacy-retirement barriers and tracked native edit-menu completion. Circle
names and search queries stay private and memory-only. An unsupported DOM
overlap withdraws the whole family before web fallback; this is deliberately
not a native overlap-continuity pass. The focused stale-confirmation regression
fails when its exact projection fence is removed. Route-body visual, physical,
mutation, accessibility and Release-performance acceptance are separate from
the older installed Connector/Memory evidence below.

Installed candidate `db43537926`, UAT Debug qualification, passes normal reviewer
passphrase unlock and ordered, attach-only Connector and Memory journeys on the
physical iPhone. Catalog search, Gmail/social detail, public-link and custom
editors, Drive document trust, Live Memory, sharing and financial-context
multiline editing/Cancel return through native Back without record mutations.
Both matching app and test runner were installed and executable digests retained.
The device run exposed and resolved a missing live-access callback in Profile's
retained Connector path; its focused regression fails on the original wiring.
This is functional read/Cancel evidence, not actual encrypted-save, OAuth-grant,
file-operation, visual/accessibility or Release-performance qualification.

Memory continuation (bounded physical journey verified; not whole-family qualification): the retained native
stack now maps categories, sections, entity details, permission choices,
connections, revocation/removal confirmations and Live Memory facts/history/preview.
The private native search submits to the existing complete category model; it
does not search only its current 40-row presentation window. All dynamic record
and scope keys stay behind per-visit opaque action handles. Navigation text is
bounded, with complete long content available in paginated details.
Stored entity/context IDs are bound to original local preview objects outside
display/export JSON. Display keys such as `entity-1` cannot address mutations;
cloned/shared previews have no edit/delete target. No historical record cleanup
is inferred from this forward fix.

The shared operation owner now rejects superseded/dismissed preview loads and
old-owner refreshes, serializes whole-domain sharing/context writes and keeps
confirmed mutations distinct from a later refresh failure. Native revocation
retains the existing scope-wide effect, explicitly explained in confirmation.
Shared records and protected details now have the source mappings described
above; the route-bound full Memory workspace retains its explicit complete-body
handoff. Search, native row presence and a successful build do
not establish visual, accessibility, device-performance or whole-roster parity.

Financial-context creation/editing now uses a closed NativeDrawers v1 private
scene, the existing retained encrypted writer and the same revisioned draft as
web. Native multiline text, category, Save/Cancel and final-input reconciliation
reuse the shared private-form lifecycle used by Connector editors. Record targets
stay in React; the writer rejects an entry removed after the editor opened. A
confirmed save closes the form; an error retains its text. This source mapping
does not qualify a real save, IME or device transition. Ordinary builds stay OFF.

Native menu presence is not feature conversion. The authored normal roster has
13 destinations; Developer tools is an additional guarded destination. Current
source coverage, not whole-program or installed-candidate acceptance:

Connectors now has a typed in-process presentation boundary around its existing
keyed owner, retained above the native/web body boundary. The native stack maps
catalog/filter, Gmail, Calendar, bank and curated-provider details, Drive file
selection/confirmation, background access, preparation, packet browsing/listing
and document-trust inspection/revocation. Custom setup, discovered tools,
sign-in/refresh/block/removal and invalid-record repair reuse the same shared
controllers. Provider artwork is generated from the web's authored vendor assets,
including its crop and monochrome treatment—not a parallel system-symbol map.
Private custom-server, public-link-draft and packet-price editors share retained
input/retirement mechanics but have separate closed wire shapes. A public-link
draft grants no connection; Done on a price draft never lists the packet.

Replacing the body does not create another catalog, OAuth session, file-review
draft, packet writer or trust owner. Catalog/confirmation commands are revoked
after a superseding commit or retirement; native action handles also bind to the
actual private target/version rather than its display ordinal. Large trust/file
lists use bounded nested pages rather than dropping records or exceeding the
bridge row budget. Native Back and ancestor choices use those existing owners.
`profileConnectorPages` is advertised only by the explicit iPhone qualification
shell. Ordinary builds remain qualification-OFF; iPad and older wrappers retain
their established renderer. This source mapping is **not integrated device or
whole-family acceptance**. The installed provider candidate cited below predates
these changes. A retained owner gates inactive reads and retires closed requests,
focus and queued callbacks without writing the old Profile query. An unsettled
background-access write retains serialization through close/reopen; its same-owner
settlement reconciles through a fresh read without replaying the write. Old visit
cleanup cannot release a reopened visit's lock or erase a newer OAuth marker.

Custom setup uses live vault getters to reject a lock synchronously, before
React commits; callers without those getters retain conservative epoch fencing.
The focused regression covers that pre-commit window and same-owner renewal.
The vault credential epoch also advances during ordinary token renewal; it is
not the unlock lifetime. Connector operations use the existing owner/key lifetime
while current-token reads and action bindings retain their credential fences.
The nearest regressions advance the real credential epoch during renewal, not
only a mocked token string. This controller proof does not qualify native host,
editor or gesture continuity: the existing native drawer lease and Profile detail
owner still rotate with that credential epoch, so their presentation continuity
requires its own integrated evidence before family qualification.

The extracted native private-editor mechanics also offer committed input at
retirement when its edit revision exceeds React's acknowledgement. A successful
bridge dispatch is not an acknowledgement; callback rejection must not suppress
final readback either. Actions remain revoked and fields/undo buffers are scrubbed
after that offer. The bounded native review found and confirmed this correction;
it does not transfer the older provider candidate's physical evidence to this source.
The iOS 27.1 Debug simulator build-for-testing and both Connector/Provider editor
host regressions pass on 2026-10-18 (two tests, no skips or runner startup
signals). The Connector case covers all three closed editor variants. The
nearest web/bridge batch passes 360 contracts; the live-lock negative control
fails on the disabled guard and passes after its exact source is restored.
Independent security and native-editor reviews close their bounded findings.
These are source/model/input-lifecycle checks,
not integrated Connector presentation or physical-device qualification.

| Destination | Native source coverage / remaining body mapping |
|---|---|
| Your account | Rows, name, Phone/OTP and Reset/Delete confirmation; photo actions retain the existing presentation owner |
| Payouts | Native balances, activity/filter/pagination, Stripe detail, bank actions, redemption and linked receipts; installed activity/filter/Back journey passes, mutation and receipt-path qualification remain separate |
| Request pricing | Native rows and amount editor; existing confirmed/conflict-aware writer |
| Memory | Native category/section/entity browsing, search, sharing, Live Memory, financial-context editing and source-mapped received/shared/protected details; the route-bound full workspace retains its explicit handoff. Exact-candidate qualification is separate |
| Personal World Model | Native research/status, cited facts/decisions/corrections/removal, public-source preparation/review/sharing confirmation, invitation create/share/revoke/claim and research/email settings are source-mapped; combined candidate qualification is separate |
| Appearance & preferences | Native appearance, accent, haptics, writing and Voice; Finance wizard/anchor and Gemini configuration now source-mapped through shared controllers; their candidate qualification remains separate |
| Security & privacy | Native Security, Session and Vault methods/details/password; system authentication remains with existing owners |
| Trusted devices | Native list/details/unlink confirmation; existing session authority |
| Connectors | Catalog/filter, provider details, Drive/preparation/files/packets/trust and custom setup/tools/removal now map through retained shared owners; three closed private editor variants. Qualification-only iPhone admission; exact-candidate device/visual/performance acceptance separate |
| Invite friends | Profile-contained native candidate shares the existing in-pane model and ordinary-text editor family; `profileReferralPages` is required. The independent dashboard retains React. Historical route-workspace prototype evidence does not qualify this page. |
| Help & feedback | Native form, message types, draft and delivery outcomes |
| Privacy | Native authored-document reader and links |
| Terms | Native authored-document reader and links |

The Payouts adapter uses the existing wallet/live store, bank, redemption,
activity and receipt models; there is no second financial writer or poller.
Receipt rows contain private display fields and opaque action handles, never
provider IDs, token authority or Stripe URLs. Related receipts retain local
Back ancestry, reject cycles and have six bounded receipt levels. Only Payouts
can admit that longer stack; other Profile ancestry limits are unchanged.
Receipt bank steps wait for the acknowledged native return to Payouts and are
consumed once; their originating privacy generation must still be current.
Activity uses 20-row presentation windows over the existing paged history;
receipt details use 40-row windows, preserving access without overflowing the
unchanged 500-row bridge budget. Payout-specific ancestor Back choices remain
owner-acknowledged and cannot reach unrelated Profile operations.
Shared web/native bank guards preserve informational `in_review`
states. Vault mutation outcomes now also project into the native page instead
of relying only on a covered web toast. Ordinary custom-native admission stays
off. This entry does not establish device, mutation or release acceptance.

Installed Memory candidate `82f9dd038c`, Agent One 1.4.1 (69), UAT Debug
qualification, passes both native host contracts, credential-free UI admission,
normal configured passphrase unlock and one attach-only Memory journey. The
native Memory body opens Live Memory and sharing, returns to Profile, retains
one WebView and changes no records. Search is exercised only when its existing
category threshold admits it. The executable digest is
`132d103fd4b6fea14d3fe6b3cfab2342fc1ca38c47f81b6ced039c5c28a113c7`;
1,681 bundled/exported assets match at
`da8961f8839d8cb5f4bd0336d42286fa6068acae82ae8b1ef113db6e2f84d909`.
Strict signatures, seven UAT targets and no remote override pass. The first UI
admission attempt reached the test body but found the app stopped after host
testing; separate normal preparation resolved that precondition. This is not
an automation-authorization failure or a broad visual/performance pass.
A separate attach-only Payouts activity/filter/Back journey also passes on that
same installed candidate, retaining the warm single-WebView session and making
no financial mutation. Receipt, bank and redemption outcomes do not inherit
that read-only journey's acceptance.

Finance continuation (source only): Profile and the existing onboarding wizard
now share one answer/step/anchor controller. The complete native finite wizard
retains the explicit horizon-date confirmation and existing encrypted save;
neither native choices nor voice bypass that confirmation. Owner/epoch fences
reject retired reads/actions, a synchronous guard rejects duplicate saves, and
the confirmed writer result is used without a potentially misleading second
read. Async onboarding draft echoes do not reset the active question. Native
ancestor Back returns from the anchor to Preferences through the existing
owner. The old source-string layout test is replaced by focused behavior
contracts; Finance is not included in the installed Memory candidate's proof.

World Model continuation (source only): the retained Profile navigation stack
now maps the complete research body and its nested fact, removal, settings,
source-review and invitation destinations. Three closed private form variants
own corrected wording, public-page links/acknowledgment and invitation contacts.
Native sheets reuse the existing completed-dismissal barrier, editor ordering,
IME and privacy fencing; they do not receive vault authority or invitation
tokens. Native links are opaque callbacks to the existing external-link owner.
Provider attribution is rendered as inert text and validated HTTPS citations;
its visual fidelity has not yet been accepted on device.

Both renderers consume the extracted feature controllers: the existing research
store remains the only app-level reader; decision, source-preparation, review,
consent-aware encrypted-save and invitation services retain their operations.
Owner-scoped local state hides retired values before paint and preserves React's
no-op update behavior. A sibling cannot adopt the previous provider owner's
snapshot before that provider's layout effect runs. Source preparation does not
confirm facts or dispatch ambient account research.

Correction forms bind the exact report and fact instance, not a reusable display
ordinal. Success retires the owned form before leaving its fact detail, so a
later destructive confirmation cannot display the old text. An incoming source
reply cannot overwrite a pending or uncertain save's prepared cards, committed
set or idempotency scopes. Profile-only `navigationLocked` blocks Close, Back,
ancestor and drawer gestures during reconciliation, while keeping the existing
Retry action usable; it is not a global content-disable flag. These contracts
are additive to NativeDrawers v1 and do not enable ordinary native admission.
Installed World Model candidate `9e030cd669`, Agent One 1.4.1 (69), UAT Debug
qualification, passes two native host contracts, credential-free XCTest admission,
configured normal passphrase unlock and one attach-only World Model journey.
Research/email settings, sources, the native URL editor and software keyboard,
Cancel and nested Back return successfully without a record mutation. The batch
observes full-height Profile and one accessible WebView on return; these counts
are not object-identity, transition-frame, accessibility or Release-performance
acceptance. The executable digest is
`9a21e8f5aadefa4d0fef59e18a9b9134d25102bdeb4e179780d5c630453425f3`;
1,681 bundled/exported assets match at
`65597307516f01c02ee86420e8dc8f2fbce8c7022f63632644bc2639d5580c8e`.
Strict app/runner signatures, seven UAT targets and no remote override pass.
This installed candidate includes the Finance source, but that family has not
inherited this World Model journey's acceptance.

Gemini continuation (source only): Preferences and the established web/setup
surfaces now share one owner/credential-visit controller. Native mode rows and
the complete private editor retain endpoint, project/location, secure key input,
validation, explicit Save, removal, cancellation and existing encrypted writers.
The API key never enters public chrome, native persistence or diagnostics.
Provider validation is distinct from a saved configuration; coming-soon providers
remain read-only. Ordinary custom-native admission stays off.

Token/epoch replacement retires the old controller and editor binding. Saved
configuration reads cannot replace a staged or freshly validated tuple, and a
retired write stops before its next operation. Final committed native input has
a read-only, revision-fenced reconciliation path before replica scrubbing; it
cannot restore actions or overwrite newer input. Explicit Cancel and successful
Save discard that readback. These source contracts and candidate builds are not
physical provider, real credential-save or whole-roster acceptance.

Installed Gemini candidate `061048d6c8`, Agent One 1.4.1 (69), UAT Debug
qualification, passes two native host contracts, credential-free XCTest body
admission, configured normal passphrase unlock and the attach-only Preferences
journey. The native credential editor, endpoint selection, Vertex fields,
software keyboard, Cancel and nested Back pass without a credential mutation.
The batch observes full-height Profile and one accessible WebView on return;
this is not transition-frame, accessibility, object-identity or Release-performance
acceptance. Strict app/runner signatures, seven UAT targets and no remote
override pass. The executable digest is
`617f2d6285ca84bc364e6c15d8c98835822f6ef7b01760fb96155131d7b522b3`;
1,681 bundled/exported assets match at
`1513560d35edcbc2da87bae6e10276ac9242685e8a3403cc479b2b186b38e43f`.
The subsequent main integration is a different source candidate and does not
inherit this exact-build proof.

The subsequent cold export exposed an independent source-discovery problem:
the compiler opened ignored `ios/App/build` object/dependency files and its
worker reached approximately 20 GB. Explicit Tailwind exclusions now keep iOS,
Android, static export and Next output outside the UI source graph. The nearest
native CSS contract exercises the installed compiler/scanner with included
application classes and a negative control that admits native output without
the exclusions. No application source, utility or verification gate is excluded.

### Profile Vault and Request pricing conversion — 2026-10-17

The qualification source now maps Security → Vault methods into the retained
native Profile stack: friendly method rows, method details, default selection,
enrollment, removal confirmation and a private native password editor. Both
renderers share `useProfileVaultMethodsModel` and the same label/opaque-handle
projection. No wrapper material, credential identifiers or Vault authority is
projected. Password fields use a separate closed memory-only contract and are
scrubbed before native retirement. Complete capability/ancestry admission owns
both native selection and web-dialog suppression. Busy page operations disable
navigation; a refused native pop now receives a negative settlement instead of
acknowledging an unchanged route.

Request pricing has a native page and decimal amount editor under that same
stack, with native Save/Cancel and the existing Ask each time action. The web
card and native adapter use one extracted pricing model, including cents
validation, expected-version conflicts, confirmed outcomes and the same draft
through confirmed renderer fallback. Neither native adapter writes directly to
a provider. The new capabilities are additive to NativeDrawers v1; partial and
ordinary wrappers retain their established interfaces.

The nearest 207 web behavior cases, typecheck, focused lint, static parity and
native build pass at their recorded development checkpoints. The new busy-Back
negative control passes. These are not an installed-build or physical/native
mutation acceptance claim. Full Profile conversion remains the active program:
the five rich root families below, provider/Finance preferences and other nested
exceptions cannot inherit Account, Vault or Pricing acceptance. The ordinary
custom-native qualification switch remains off; no deployment is implied.

The first physical host run caught a shared Profile envelope defect: a retained
keyboard reduced its UIKit navigation view to 516pt inside the 844pt panel.
Ignoring container safe areas alone was insufficient. The outer navigation
envelope now ignores keyboard safe-area reduction as well; its content and
owned editors retain their own keyboard clearance. The same physical contract
fails on the old source and passes the native-only correction without relaxing
its one-point threshold. Both native host contracts pass, including final-pair
acknowledgement and immediate password-replica scrubbing. Host contracts remain
separate from installed-product warm journeys and Release performance evidence.

Installed iPhone candidate `2455bf461d`, Agent One 1.4.1 (69), UAT Debug
qualification, passes credential-free XCTest admission and normal configured
passphrase unlock. Separate attach-only Pricing and Security batches each pass
one test with zero skipped: native price editor → synthetic edit → keyboard →
Cancel → Back, and native Vault methods → protected password editor → keyboard →
Cancel → Back. Both retain the same WebView and warm session; neither saves a
price, changes a credential or fulfills a payment. The executable digest is
`086cad4ddc369c30bc54efbd5cff8991c8a0378aac7d0590f88ad1e38d2e9d3f`;
1,681 bundled/exported assets match at
`240c5ffe8919ae1d4cae1b92d52f077910978a5d05904d3c0fba763e316dd43f`.
Strict app/runner signatures, seven UAT backend targets and no remote WebView
override pass. Mutation, transition-frame, full accessibility and Release
performance acceptance remain separate from these bounded functional receipts.

### Latest-main integration and preview boundary — 2026-10-17

Merge `5f70c584e9` incorporates main through `a01b055edd`. The installed iPhone
now runs `4550df9656`, Agent One 1.4.1 (69), UAT-backed Debug custom-native
qualification. Main's version increment is preserved. Ordinary custom-native
admission remains disabled.

The shared One pane keeps the existing name/owner model, live Memory preview and
retained native content plane, and incorporates main's Feed / To-do / Profile
tabs. Task rows, date grouping and pure task types now have feature-owned leaf
modules; the preview no longer imports the whole To-do workspace. Existing Page
and service exports remain compatibility facades; persistence and mutation
authority are unchanged. The public browser fixture substitutes only its private
task-service port, rather than importing Firebase or inventing native SDK exports.

The nearest 45 unit cases, 16 existing stationary-header/tab browser cases across
320/390/768/1440px, 469 Back cases, all UI-contract generation/checks, typecheck,
lint, static parity and design/render checks pass. The source-only independent
review found matching extracted behavior and retained exports. These are not
native material, iPad or integrated physical acceptance.

The combined candidate's native build, separate app/runner installation and
preparation pass. Credential-free XCTest admission and normal configured
passphrase unlock pass without skipped tests; private-run diagnostics are removed.
The attach-only photo journey passes root/Account web-aligned top portraits,
existing options → preview → Close → Account → Chat, one retained WebView and no
photo mutation. Executable digest:
`5c1f7ea6aecc1551e34ad8a9aa68d8ab4fe7b66a665a8e11a7d6b42e718c5163`.
Its 1,681 exported/bundled assets match at
`19ea87577fa8c1761789dfd1d75cdfe73801651bad7f66f1bd8335a618114fe8`;
strict app/runner signatures, seven UAT targets and no remote WebView override
are verified. This is bounded functional/layout proof, not full visual,
accessibility, staged-resume or Release-performance acceptance.

The current core attempt was deliberately interrupted during protocol collection
after host gaming activity began; its 16 automatic workers exited. It is neither
a core pass nor a product-test failure. Rerun the complete canonical gate on a
quiet host, using supported `PYTEST_XDIST_AUTO_NUM_WORKERS=2` and `CORE_SERIAL=1`,
before pushing. No current-head CI, merge or deployment is inferred.

Review also identified incoming To-do-preview stale read/write settlement and
shared-files owner/epoch/Undo fencing gaps. They remain unresolved implementation
work, not waived acceptance. Preserve same-owner, same-epoch Undo after closing
the files sheet when repairing it. Full staged privacy/resume composition and
the remaining native scene conversions remain separately tracked below.

### Profile height, photo header and current physical checks — 2026-10-17

Historical installed candidate: UAT-backed `a00d04764c`, Agent One 1.4.0 (69),
Debug custom-native qualification. Its warm physical journey passes the root
and Account top-portrait geometry, existing photo options → preview → Close,
Account return and Chat/session continuity. Ordinary builds remain unchanged.

Historical `6e24a47dbf`, also 1.4.0 (69), passes
the bounded native Account → Phone → country choice → Back/cancel journey with
the software keyboard, one WebView and the warm draft/session; no SMS was sent.
The same installed candidate passes three real Feed scroll hide/reveal cycles
with navigation and dock moving together, then restores Chat and its keyboard.
These are functional receipts, not visual/accessibility or Release-performance
acceptance. Its canonical local core passed; no current-head CI or release is
inferred.

The new source fixes a separately reproduced Profile-height defect: the outer
panel was full height, but its SwiftUI-hosted UIKit navigation envelope respected
an extra safe area. The nearest native regression observes a 47pt top/34pt bottom
gap on the old code and passes with vertical safe-area expansion. UIKit retains
content and navigation-bar insets; no outer-frame or global-padding workaround.

The capability-negotiated `profilePortrait` header replaces the Account photo
list row with a top identity hero, and supplies the same effective photo to the
root identity header. The shared native hero now follows the web pane's geometry:
44pt leading portrait, 13pt column gap and adjacent name/email. Only the portrait
is a button, retaining its existing authored action; the surrounding identity
copy is not a selectable settings row. The root portrait retains its Account
action; Account's portrait retains the photo-options owner. Root photo-preview
operation parity is not inferred from geometry. This replaces the oversized root portrait
and separate centered Account photo/options block. Native receives bounded JPEG bytes
only, decoded with bounded ImageIO dimensions; there is no native URL fetch or
image persistence. The existing provider fallback can request a larger Google
avatar using its documented FIFE size option; uploaded images remain unchanged.
Apple sign-in supplies no photo field, so absent media keeps the real fallback.
Provider evidence: [Google image dimensions](https://developers.google.com/identity/sign-in/ios/reference/Classes/GIDProfileData),
[Apple identity credential](https://developer.apple.com/documentation/authenticationservices/asauthorizationappleidcredential).
Media preparation caps source bytes and dimensions before browser decode, uses
the SDK-preserved WebKit fetch rather than CapacitorHttp's buffering proxy, and
aborts on timeout, owner/privacy change or retirement. The nearest transport
regression fails against patched fetch and passes with that boundary restored.
Photo preview/actions still use the existing React exception and are **not**
counted as complete native photo-operation conversion. Unsupported wrappers
retain their ordinary row.

The combined header/height source was first installed at `c6c317b4f2`. Credential-free
automation admission and the normal configured passphrase unlock pass. A bounded
four-destination Payouts/Pricing/Memory/World Model traversal passes entry, full
height, Back, Chat/draft return and one-WebView checks; these rich bodies remain
React. The actual photo check caught a text-sized native button hit target;
installed `ea6d11dee6` fixes its label frame and passes that geometry assertion.
The next photo action was present but covered and untappable. Header-disabled
diagnostics alone did not prove an admission deadlock: those controls also
correctly disable beneath an admitted modal. The guarded `a5bdfc49f0` candidate
still reproduced the tap failure. Optimized product-CSS hit testing then proved
the layering defect: a full-page parent borrowed Dialog's 801 tier, covering its
nested Sheet at 712. The shared feature-page tier now sits below sheets/dialogs;
normal primitives retain their existing layers. Chromium and WebKit reproduce
the old failure by restoring the borrowed Dialog tier and pass the corrected
sheet → preview → return interaction.

The independently characterized admission-race correction gates that modal on the current detail visit's parent
readiness and the native menu's actual exit completion, using the existing
presentation owner, privacy generation and ordered receipt. It does not bypass
modal isolation, add a timeout, or retry an action. Interrupted same-context
re-entry requires a fresh parent binding acknowledgement without remounting the
pane. Confirmed native retirement can satisfy absence; quarantine cannot.
That evidence is retained for the current lease when retirement precedes parent
readiness, and delivered once the port closes. The incoming detail owns its
fallback; a second failure pane must not block that same handoff.
Its nearest regression fails when early modal mounting, a stale visit binding,
or a missing confirmed-absence callback is restored.

Installed `d35566d7ba` (UAT-backed Debug qualification, 1.4.0/69) passes the actual
native Account portrait → photo options → preview → Close → Account → Chat
journey, with one WebView and no photo mutation. Its executable digest is
`1fc01be3487d3e5a705f28d8b86c390fa03e9a84fc5654e8be513811b49025c9`;
the exported/bundled assets match. This proves the repaired hit target and modal
layer/handoff on that installed source.

The subsequent installed `a00d04764c` passes the extended same journey with
44pt root/Account portrait targets, 13pt adjacent name/email columns, top-before-
settings placement and one Account photo action. The same test rejects the old
installed layout with `PROFILE_PHOTO_ROOT_DIFFERS_FROM_WEB_PANE`. Warm reopens
use the authored Profile Back control; a nested scroll view does not establish
root admission. No photo, provider, or backend mutation is part of this check.
Executable digest: `9c928404507435ebcdfacbb4d90c39e4d9af2e3235384ad19acf9a74f611000f`.
The 1,681 exported/bundled assets match at
`d4d038e2e297ac83747ae56bd92c696eb1a936a460d1ab288f527b05ed147b42`;
strict app/runner signatures and all seven UAT targets pass with no remote
WebView override. The nearest 198 behavior cases, 469 Back cases, UI-contract
checks, typecheck, static parity and native build pass. Older wrappers keep the
ordinary photo row without the hero's email subtitle; the existing capability
test fails on that actual regression and passes with the bounded correction.
These receipts do not establish actual-provider pixel quality or full visual,
accessibility, staged-resume or Release-performance acceptance.

Vault methods now have one extracted React feature model for reads, enrollment,
default/removal and password changes. Existing services and owner authorization
remain authoritative. Its nearest regressions cover canceled/replaced removals,
first-read errors, uncertain writes requiring fresh reconciliation, secret
cleanup and acknowledged rekey outcomes. Native protected scenes are not enabled
by this extraction.

Coverage proceeds through every shared Profile roster item and its nested states;
a passing Account or Appearance journey never qualifies the other destinations.
Rollback: revert the bounded family change or disable the existing single
qualification switch. Ordinary builds remain on their established renderers.

### Native Phone/OTP and current-visit admission — 2026-10-17

The qualified iPhone wrapper negotiates `profilePhoneScene`: a complete owned
form for country selection, number/code entry, resend, OTP Back, cancellation
and recovery. It shares the existing Phone model and authentication operations
with web/Android. Provider challenges, identity objects and vault credentials
never enter its private field projection. Ordinary builds remain unchanged.

Account stays in the retained Profile stack beneath the form. The parent must
acknowledge the current destination **and privacy generation** before any editor
is installed. Same-owner phone publication does not retire an active attempt or
its native host. Departure and owner replacement reject late results. Successful
verification remains successful if Account refresh fails; Continue retries only
that completion, not an OTP operation. An international paste retains its own
dialing prefix rather than being reinterpreted using the picker country.

One volatile feature model survives confirmed renderer fallback. Unfinished
native composition is preserved in a private presentation replica; old committed
digits cannot be submitted until a normal edit commits through the shared
normalizer. Owner/stage/privacy invalidation clears that replica. Native menu,
keyboard, sheet retirement and final-edit acknowledgments retain their existing
owners; no provider transport or persistent native draft store is added.

Nearest behavior tests include real negative controls for stale completions,
changed recipients and stale parent admission. Native compilation and the
simulator's Phone host contract pass. These are not installed-product visual,
live-phone mutation or Release performance acceptance. The global staged-resume
composition gate remains a separate shared-lifecycle requirement.

Rollback: revert this family increment, or disable the existing qualification
switch; unsupported/partial wrappers keep the complete shared React form.

### Trusted devices and current-main integration — 2026-10-17

Main through `fd3b00b3c1` is integrated by merge `e8aef014c3`; combined
base-relative contracts are regenerated after that merge. Ordinary builds keep
their established renderer behind the existing single qualification switch.

Qualified iPhone builds negotiate `profileTrustedDevices` and retain the native
Profile stack for the device list, status, paging, Unlink confirmation and Back.
Actual visited ancestry comes from the existing pane-history owner; direct entry
does not invent Security. Its bounded ancestor choice consumes local confirmation
before invoking the existing query-parent operation. Other/partial wrappers keep
the complete React page. Both presentations share one feature model and existing
authenticated service, cache and sync-status semantics.

Owner/vault/visit and consumed-action fences reject stale callbacks, including
after Cancel or uncertain delivery. The owner predicate reaches final transport
dispatch and authenticated retries. Reconciliation requires a successful read
started after the attempt, not an older in-flight GET. A confirmed unlink stays
confirmed if refresh fails; no automatic mutation retry is introduced. Native
receives opaque action handles and friendly details, never credentials or keys.
The incoming referral Share path now uses the same existing session-fenced Share
transport and suppresses late delivery/toast callbacks after departure.

Nearest behavior tests and actual-guard negative controls are recorded separately
from native build, install and physical qualification. The warm Profile harness
can select a bounded start/end range; a scoped run is not whole-program acceptance.

Source `b1609c005d` was exported, built and installed on iPhone, UAT-backed
1.4.0 (69), with three native host tests passing and zero skipped. Its combined
core run passed web-core and 13,599 protocol tests, but failed two editor-lane
path-filter checks for newly imported Legal inputs. The filter now covers those
two exact inputs; all 14 focused path-filter checks pass. No complete core/CI
pass or new physical visual qualification is inferred from that repair.

### Native Account confirmations and private result fencing — 2026-10-17

Qualified iPhone builds keep Reset/Delete confirmation content and explicit
actions in the retained Account navigation stack. NativeDrawers v1 negotiates
`profileAccountActions`; older wrappers retain their complete React flow. Busy
state revokes interaction without retiring the host. Immediate/global Back
cancels the local confirmation; explicit root navigation uses the existing
Profile query owner. Close cancels idle state rather than restoring a destructive
confirmation on the next visit. This does not convert photo or phone/OTP forms.

Both existing Reset/Delete preflights now use one bounded feature helper. Its
visit, auth owner and vault epoch fences reject an old probe after Close/reopen,
destination departure or owner change. Failed probes do not infer a vaultless
account; actual reset/erasure and their confirmed/unknown outcomes remain with
the existing authenticated handlers. No real destructive fixture action is
performed by the reviewer navigation test.

The shared Secrets reveal owner now rejects late decrypts and retained Hide
callbacks after owner/epoch replacement, privacy transitions or withdrawn live
authority. Private results stay memory-only; no keys enter native projections.
Core behavior replaces the two obsolete preflight source-string assertions and
one redundant CSS assertion. Negative controls reproduce both stale-result
defects. Native build and physical evidence for this increment are recorded only
after the final combined candidate is prepared; source checks are not acceptance.

Combined source `8104fb3fe7` is now built and installed on iPhone, Agent One
1.4.0 (69), UAT-backed Debug qualification. Static export/CSS, sync, native
build-for-testing, signature, seven backend targets, installation, launch and
target-process readback pass. Executable SHA-256:
`4360ee719eea82366adaa98383b48a519e820befa1a6f43877a1bfd0d59fb7fe`;
public-assets digest:
`3aa3f42cfe9ca1b506023753cef3e7f7004db30a884f1f9789f5a49df08c8709`.
The credential-free attach attempt on the preceding candidate still timed out
before test entry after alignment with Xcode's generated runner environment.
No new warm assertions or private-input retry are claimed for this candidate.

### Native Voice preferences — 2026-10-17

The qualified iPhone stack now owns the complete Voice page: Live readiness,
microphone check/results, speakerphone policy, command availability, Location
defaults, connection-access reuse and currently supported voice domains. The
existing React feature models and preference writers retain all operations;
there is no native voice runtime or preference store. Unavailable server defaults
remain explicit and can be retried deliberately. Unsupported domains remain
unavailable rather than receiving new authority.

NativeDrawers v1 negotiates `profileVoiceSettings`. Partial/older wrappers retain
the coherent React page before reveal. The existing Profile history owner now
exposes public parent-panel metadata, so UIKit represents actual visited ancestry
rather than inserting Preferences for a direct Voice entry. Ambiguous older
entries retain their established renderer; actual Back routing is unchanged.

The shared microphone check cancels both its preliminary probe and capture on
owner departure/privacy transitions. A late permission grant is released before
worklet setup; cancellation during worklet loading immediately releases the
actual stream. Native receives a bounded result, never microphone frames.

Source verification: 228 nearest contracts, typecheck, focused lint, UAT static
export/CSS freshness, Capacitor sync and iPhone build-for-testing pass. The real
probe cancellation regression fails with its post-permission guard removed and
passes after restoration. Independent read-only native/security review found no
blocking issue after the probe fix. Physical qualification is recorded separately
after installation; this section does not qualify the combined Profile program.

Rollback: revert the Voice-family increment, or disable the existing single
custom-native qualification flag. Standard native bottom navigation and ordinary
web/Android behavior are unchanged.

Source `99ea706d9d` is installed on iPhone, Agent One 1.4.0 (69), UAT-backed
Debug qualification; executable SHA-256
`846b7666ec14b96d567903cb12d8d3a5dfba5c41fdfc406d7e9ed1f8024503dc`.
Product/runner installation and launch pass after a wireless tunnel reconnection.
The new XCTest attempt times out enabling automation before test entry despite
healthy paired/unlocked transport and a usable compatible DDI. Device
reauthorization is requested; no new Voice physical acceptance is inferred.

### Native Legal reader — 2026-10-17

Initial source checkpoint: `c459cf1332` (local, not pushed).
The qualification build now has a complete SwiftUI Privacy/Terms reader in the
retained UIKit Profile stack: full authored sections, paragraphs, subheadings,
lists, inline links, effective date/version, contents scrolling and See also.
`legal-documents.ts` remains the only content source; nothing is summarized or
flattened into settings rows. Document switches replace the current detail via
the existing Profile query owner. Native ancestry must mirror that owner's
actual Back destination, not an invented Legal intermediate page.

NativeDrawers v1 negotiates `profileLegalReader`. Older wrappers keep the
established React reader before reveal. Only bounded document content and
current action handles cross the bridge; URLs stay with authored React
callbacks. Those callbacks retain in-pane document switching, the existing
account-deletion entry route and external/mail handling. An action never deletes
an account itself. Current document/owner/update/privacy fences reject late
links, and pending projections deep-copy the Legal content.

Focused Legal/chrome contracts, typecheck, native compilation, fresh UAT static
export, plugin parity, surface-map freshness, docs and source-performance checks
pass. The undeclared-field negative control fails when the closed-shape check
is removed. Independent read-only native/security review found no blocker.
The isolated headless native host contract passes (one executed, zero skipped),
including rejected executable fields and inactive-document links. The new
reader's physical interaction/accessibility acceptance remains separate; the
host contract is not visual acceptance.

The first Legal candidate was installed from `0dda4cbabb`, Agent One 1.4.0 (69),
UAT-backed Debug qualification, executable SHA-256
`5a475a5041a62d07d1af2d8904f62e772d9dab31303877b85caf311a7c94dc07`.
The user authorized installs/restarts with draft/attachment loss for this work.
Assets/signature, credential-free XCTest admission and normal private unlock
pass. The real reader opens, contents navigation and document switching work;
the first physical batch fails its Back-depth assertion. The failure is
retained in local evidence, not relabeled as visual acceptance.

RCA: the projection always inserted Legal, even for a document opened directly
from Profile. UIKit popped to that unvisited parent before the existing browser
history owner correctly restored Profile. The correction adds one nonsecret
`legalParent` presentation bit to that existing history owner and retains it
through document replacement. It does not change actual Back. Direct/resumed
entries follow the existing authored fallback; ambiguous older owned entries
retain the web reader. TypeScript/native admit a validated document at stack
root. The focused negative control reproduces the invented parent; 211 nearest
cases, lint/typecheck and independent read-only review pass with the correction.
**Corrected installed candidate:** `b4bf1e869e`, Agent One 1.4.0 (69), UAT-backed
Debug qualification; executable SHA-256
`66e4a1b54f84164d12fc186dec94f47ebf3a8fc28123a099011d5cbd7958160b`.
Fresh static export, native build, packaged assets/signature, credential-free
admission and normal private unlock pass. The affected physical batch now passes
for both Privacy and Terms: native reader, contents navigation, related-document
replacement, direct Back to Profile, Close and warm Chat draft continuity.
The separate remainder passes Invite, native Help edit/cancel without submission,
both documents through their untracked Legal parent, Close, warm Chat draft
continuity and the One Profile tabs/return (one test, zero skipped). Earlier
Account/Phone, Preferences/Gemini/Voice, Security/Vault, Devices and Connectors
receipts remain separate; this is not one green combined full-content run.

The warm runner now distinguishes configured native admission from temporary AX
absence, verifies the admitted root menu rather than an offscreen first row, and
asserts the actual entry's Back parent. `HUSHH_EXPECT_COHERENT_PROFILE=true`
requires native entry. An explicit `HUSHH_PROFILE_LEGAL_RETURN_ONLY=true` remainder
reuses the earlier contents/switch receipts and emits return-only evidence; the
default still requires contents and replacement. Retained long-document scroll
acquisition failed in the full-content follow-up (contents more than 11,000
points above the viewport; a fast-scroll attempt produced XCTest issue 103).
Those failures remain recorded, not converted into a full-content pass or a
proven product freeze. Independent read-only review finds no blocking ancestry
or admission issue in the harness corrections.

These functional results do not qualify external/mail launch, transition-frame
pixels, accessibility or Release frame pacing. Ordinary-build native admission
remains disabled.

Rollback: revert the Legal-family increment, or leave the existing global
qualification flag off. NativeChrome v2, NativeDock v1 and the normal web/Android
renderers are unchanged. The broader Profile/linked-workspace program below is
not complete.

### Complete Profile and linked-workspace program — 2026-10-17

Profile-first correction: native and web detail Back now compose the same local
feature and query-parent owners. Account phone entry binds its existing OTP Back
callback, so code entry returns to number entry before leaving Account. Missing
Memory domain/connection queries retain a loading/unavailable detail instead of
silently displaying their parent. Nearest navigation/phone/destination checks
pass. The existing physical Profile batch now also enters Phone, Gemini, Voice
and Vault methods from native parents; its former early return skipped those
handoffs. The earlier nine-destination pass is not proof of these nested flows
or complete native conversion.

**Installed Profile-first candidate:** `ad6c04cdad`, Agent One 1.4.0 (69),
UAT-backed Debug qualification; executable SHA-256
`820f0c88d8139d5ddc8866fcdac7a75c15eab68792978989fec7edc5de090ba7`.
Fresh static export/typecheck, native build, signature and packaged runtime checks
pass. The authorized install and normal reviewer unlock were separate from warm
testing. The expanded physical batch reached Phone, Gemini, Voice and Vault
methods, then failed a lower-menu query return with the privacy cover present.
That failure is retained, not erased by a retry. After authored recovery without
restarting One, the targeted Privacy/Terms return batch passed; the exact cause
of the earlier cover is unconfirmed. The user reports transitions and touch look
correct. Two background cycles and an observed Control Center cycle also passed
with the warm session preserved. These are functional results, not Release
performance, transition-frame or full accessibility qualification.

The shared fallback Back now stays actionable when a wrapper cannot own native
panes, without attempting native control admission. Its focused negative control
fails on the broken eligibility condition; all 183 nearest chrome tests and
focused lint pass with the correction. This fallback correction is not in the
installed candidate above. Temporary query-return diagnostics were removed.

Scope now includes protected and rich Profile bodies and linked workspaces.
Older entries calling these deliberate retained bodies describe the installed
baseline, **not exclusions from the approved conversion**. Qualification remains
one build-time flag; ordinary builds, Android and web keep established renderers.
iPad qualification is on demand and is not inherited from iPhone.

Verification stays contract-focused. The current hygiene pass removes 18
redundant or implementation-restating cases: CSS/class-name assertions,
the weaker duplicate of emitted native UI-flow scripts, and a duplicate History
Close case. Credential privacy and mutation authority now live in the focused
Vault Methods component suite; drawer cancellation, scroll restoration, stale
choices and actual dismissal remain covered. The History qualification check no
longer assumes that independently enabled shell qualification is always off.
Run focused automation after coherent implementation chunks; do not treat source
strings or repeated button checks as visual or device acceptance.

Existing Profile scenes now share one complete-method admission check for Apply,
Confirm, Settle and Retire. The native stack additionally requires whole-menu,
content-handoff and actual-completion support; Preferences requires its Writing
style handshake, and Help requires its support handshake. A partially capable
wrapper keeps the coherent existing detail page instead of accepting a native
destination whose editor cannot complete or withdraw. This is admission hardening
for implemented scenes, not completion of the remaining conversion scope.

The latest combined source passes 268 focused cases, lint/typecheck, static
native parity, design/performance contracts and documentation. The canonical
UI refresh now passes all 469 Back cases and every UI-contract verifier;
Back/Search receipts were generated only after that behavior pack passed.
Earlier Location-map readiness/timeouts remain historical failed evidence with
unconfirmed cause. No Map code, consent check, timeout or test requirement was
weakened to obtain the current pass. These local checks are not release proof.

Local foundation checkpoint: `599901c449`. A bounded native recovery follow-up
now handles readmission that stays stalled: after the existing five-second
terminal deadline it requests fresh presentation once, then after two further
seconds enters the existing full-window native recovery cover. Fresh updates
and retirement cancel that armed deadline. The current controller, document,
owner, privacy generation and active-app state are rechecked before escalation.
The cover is installed before private presenters retire. Try again and Restart
session remain user actions; there is no automatic reload, sign-out, action
replay or retirement-token bypass. Restart copy explicitly warns about vault
locking and possible unsent-draft loss. Four nearest hosted privacy/recovery
cases pass, including delayed-update/retirement cancellation and the genuinely
stalled case. These are not physical-device acceptance.

**Remaining foundation gate:** staged resume is not implemented. Current Auth
release can precede reconstruction, while native admission rejects shielded
state. Additive prepare-versus-uncover coordination is required across the
existing privacy owner, native presenters and current JS consumers; adding only
a local readiness wait would deadlock. Keep private replicas scrubbed and actions
rejected until the authorized destination is ready. This gap blocks full native
qualification and must not be described as fixed by the recovery escape path.
The reviewed boundary must also declare an expected editor or rich pane before
the parent drawer settles; an empty registry or a closed menu cannot prove that
destination is ready. Safe lock/recovery gates supersede private preparation.

Main is reconciled through `fd3b00b3c1` in merge `e8aef014c3`. Preserve its
four-tab navigation and native navigation contract v3; this is independent of
NativeChrome v2, NativeDock v1 and NativeDrawers v1. The developer's root worktree
and its unrelated edits were not changed.

| Family | Current presentation / operation owner | Implementation gap |
| --- | --- | --- |
| Shared navigation | Retained UIKit Profile stack; `native-profile-menu.tsx` and existing Profile query/Back owners | Current change fences a completed pop across compatible refreshes and separates admission from completed presentation; physical acceptance pending |
| Account and identity | Native rows/name form, negotiated Phone/OTP form and Reset/Delete confirmation pages; shared phone model and existing account/identity services | Photo/preview conversion and combined native qualification are separate; disposable-fixture mutation outcomes remain unverified |
| Preferences | Native Appearance/Accent/haptics, Writing style and complete Voice page; existing Settings/theme/Voice feature writers | Finance and provider scenes need conversion; Voice source/build passes are distinct from pending device qualification |
| Security and devices | Native Security/Session, Trusted devices and negotiated Vault list/details/default/enrollment/removal/password scene; shared feature models and vault/session services | Combined physical interaction/accessibility, recovery and disposable-fixture mutation outcomes remain unverified |
| Memory and sharing | React `LivingMemoryDocument`, `pkm-data-manager`, `SharedWithYouGroup`, `SecretsListGroup`; existing encrypted PKM/consent operations | Native living document, section editing, search, sharing and secret controls remain to map |
| Personal World Model | React `PersonalWorldModelPage`; existing research/review services | Native research, facts, sources, review, invitations and preferences remain to map |
| Connectors/systems | React Profile connectors and `ConnectedSystemsPanel`; existing catalog, provider authorization and CRM owners | Native catalog/detail/configuration and authorization-return states remain to map |
| Payouts/pricing | Negotiated native Payouts balances/history/receipts and Request pricing; shared existing financial models | Payouts current batch awaits installed qualification; physical Pricing edit/cancel passes; sandbox mutation outcomes remain unverified |
| Help/Legal | Owned native Help sheet and complete native Legal reader; existing support composer/service and authored Legal documents | Installed Legal has bounded contents/switch/return proof; full visual, accessibility, external-link and Release acceptance remain separate |
| Wallet Profile/cards | React `wallet-card-workspace`, `wallet-card-setup`, `wallet-card-manage`, payment-card owners under `components/wallet` | Complete native workspace/editor/reveal/sharing scenes remain to map; system camera/Share/Apple Wallet owners stay unchanged |
| Portfolio import | React `portfolio-import-view`; existing import and explicit encrypted-commit owners | Native selection/progress/cancellation/review remain to map; no competing import store |
| Referrals/developer | React `referral-dashboard-page` and existing developer owners | Native dashboard/local diagnostics remain to map; reward authority and both developer-build/host restrictions must remain enforced |

Every mapping must include loading, empty, unavailable, error, busy, success,
cancellation and nested overlay states. Route-bound scenes outlive the Profile
menu under the same presentation owner. A root navigation test is not proof of
any rich or protected conversion. No generic executable UI schema, DOM inference,
credential projection or second operation store is permitted.

The foundation adds negotiated `presentationCompletion`, a `presentationSettled`
event and targeted `getPresentationState` readback. An `active` apply receipt
remains admission only. Coverage/form handoffs use current actual layout and
UIKit transition completion. Events/readbacks are document/owner/revision/update/
privacy-fenced; a late completion cannot activate a replacement destination.
Direct stale Back setters remain rejected. Only the owned UIKit completed-pop
boundary may reconcile the same destination's compatible content/theme refresh.
The retired Device-preferences path resolves to Preferences, not an empty page.

Hosted reproduction exposed a second ordering boundary: UIKit can defer
`willShow` until after a pop API returns. A compatible SwiftUI reconciliation in
that interval restored the outgoing stack and marked the pop as projected.
The retained navigation owner now fences at the pop entry point, preserves the
original binding until actual completion, and compares the exact displayed
controller sequence rather than depth. Offscreen/unattached hosts cannot report
visible completion. An uncertain retirement uses one targeted absence readback;
pending native forms/menus still block fallback, and no operation is replayed.

Current local evidence: typecheck, focused ESLint, 234 nearest bridge/Voice/route
cases, 467 Back hierarchy cases, four hosted native lifecycle/retirement cases,
static Capacitor/Siri parity, design/accent/brand and source performance contracts
pass. The native Back regression failed before the pop-entry fence and passes
after it; stale visit/privacy controls still reject Back. Earlier compile and
host failures remain in ignored local diagnostics, not relabeled as environment
failures. The Voice command model was independently reviewed for owner fencing;
its retained-callback and reordered-write regressions pass. Neither these checks
nor source performance budgets prove physical rendering or frame pacing.

Founder Wiki discovery/search refreshed, but its advertised constitutional/index
read addresses returned not-found and the scoped native search returned no page.
No wiki article was rewritten or promoted to current implementation truth.

Rollback: independently reversible increments, with the existing qualification
flag left off in ordinary builds. Only the exact physical candidate and bounded
checks identified above are established; no broad acceptance, cloud deployment
or distribution is established. Dedicated
disposable UAT fixtures are required for actual saves/destructive outcomes; the
shared reviewer and real financial fulfillment remain out of scope for mutation.

### Profile conversion coverage — 2026-10-17

Qualification-only iPhone families are tracked separately from navigation tests.
Opening nine destinations does not establish nine native form conversions.

| Profile family | Current renderer / operation owner | Qualification state |
| --- | --- | --- |
| Root, Account, Preferences, Security, Session | Retained UIKit navigation and SwiftUI rows; existing React callbacks | Earlier installed candidate passed the broad Profile journey; visual/Release acceptance remains separate |
| Name editor | Owned native form; existing authenticated account writer | Implemented; no new physical acceptance in this continuation |
| Writing style / communication | Owned native form and finite menus; existing encrypted Settings writer | Ten edit/cancel cycles passed on the earlier installed candidate |
| Appearance, Accent, App haptics | Native menus/switch; existing theme and Settings owners | Earlier physical Preferences journey passed; no broad admission change |
| Help & feedback | Complete native sheet over the retained Profile root; existing support composer/service | Exact candidate installed; physical edit/cancel, keyboard, type selection and Chat-draft continuity pass. Visual/accessibility/Release acceptance remains separate |
| Voice | React readiness, microphone check, switches and Location/Connect defaults | Native body still missing; not counted as converted |
| Photo | React preview/options and existing native camera/library/crop | Complete native presentation still missing |
| Privacy, Terms | Complete native reader behind `profileLegalReader`; existing authored content and Profile routing | Installed UAT candidate `b4bf1e869e` passes initial contents/switch/direct-return and separate Invite/Help/untracked-parent returns. Retained long-scroll acquisition, external-link, visual/accessibility and Release acceptance remain separate |
| Protected vault/phone/provider forms, Devices, Connectors, Invite | Established React content handoff | Retained baseline bodies, not completed approved native conversions |

Help negotiates `profileSupportScene` within NativeDrawers v1. Its private,
memory-only message replica is separate from public chrome metadata and uses
the existing scene ordering/owner/privacy fence. A bounded destination token
anchors the sheet to the still-painted Profile root; no empty page is pushed.
UIKit owns the sheet, keyboard and actual dismissal above retained navigation.
React retains the three message kinds, validation, draft and sole delivery
operation. Send waits for committed, acknowledged edits; a synchronous operation
guard rejects duplicate submission. Accepted delivery cannot clear a newer draft
or a different unsent draft when voice supplied an override. Uncertain delivery
retains the message, is narrated as uncertain and is never automatically retried.
Native retirement scrubs message and reply information before dismissal.

The support candidate is built from `ae030c921acd42e56c1945786f5a2ee9ae9c4741`
with the same fresh web export, production profile and qualified native renderer.
The executable SHA-256 is
`fcbd57425e3d15ebc83b079aa6cb8ef9839060fbba7626b8a3a009bd25ebf2d6`;
strict signature verification and the unchanged product-assets validator pass.
Focused evidence: 186 bridge/support cases, 22 support/outcome cases, the native
host IME/acknowledgment/one-shot-send/scrubbing regression, typecheck, focused
lint, plugin parity and generated UI contracts. The user authorized the candidate
installation/restart accepting possible draft loss; installation, credential-free
XCTest admission and normal identity-fenced reviewer unlock pass. The attach-only
Help check now passes all three kinds, multiline editing with the software
keyboard, reachable/enabled Send without tapping it, original support-draft
restoration, actual Cancel dismissal and return to the original Chat draft and
single WebView. The product process remained unchanged through runner-only
updates. Private result bundles were removed; no real email was sent.

Earlier failed checks remain recorded: the native Form lazily realizes Send
below the initial sheet viewport, and a scene-wide swipe can hit the keyboard or
nested text editor. The corrected fixture scrolls the visible Form gutter rather
than requiring an offscreen action on admission. It never retypes an existing
private message into XCTest's activity stream. This is a fixture correction,
not a demonstrated production rendering defect.

A separate follow-up fixes destination supersession bookkeeping: a late failed
root-row settlement must not retire a newer Help sheet. The existing bridge
regression reproduces that failure on old code, passes after tracking destination
kind/token, and still quarantines current-destination failures. All 188 nearest
bridge/support cases, typecheck and focused lint pass. This TypeScript follow-up
is not part of the installed `ae030c921a` executable/web export; its source tests
must not be presented as physical acceptance of a newer candidate.

The previously installed artwork candidate (web `d1c2b333c8`, native/test source
`055789f04f`, executable hash recorded below) is superseded by the Help candidate.
Its credential-free XCTest admission and normal identity-fenced passphrase unlock
passed; those historical checks do not qualify the newer source.
The older shell rerun completed nine cycles then failed on accessibility
snapshot/session availability; its failure remains recorded and does not qualify
the new support scene. No account reset, sign-out, real support send or cloud
deployment occurred. Rollback is the independent support-family commit; ordinary
wrappers and web/Android/iPad retain their established renderers.

### Profile artwork parity and runner admission — 2026-10-17

The existing shared artwork generator now projects the active web Gemini brand
mark and Vault methods fingerprint into the qualification-only Profile stack.
Gemini retains original colors and its authored 32-point footprint; ordinary
glyphs retain 28 points inside the shared 32-point column. Accent uses a separate
app-colored layer in both SwiftUI rows and UIKit finite-menu triggers, rather
than silently becoming the semantic foreground. No new icon registry, operation
owner or renderer admission is introduced.

The nearest native artwork regression passes on the headless iPhone simulator,
and all 467 existing Back cases pass. These are source/host checks, not physical
visual acceptance. The physical results below were obtained on the historical
`67ed4931e4` baseline; the coverage entry above records the subsequent installation.

The iPhone's wireless tunnel, unlocked state and compatible/usable developer
image were verified. Its attach definition was corrected against Xcode's
generated runner metadata and installed `xcodebuild.xctestrun` manual, preserving
destination artifacts and disabled attachments. Initial admission attempts timed
out before test-body entry. Subsequently, the installed runner was successfully
activated through supported CoreDevice tooling and credential-free XCTest
admission passed. This sequence does not establish the original timeout's cause
or a permanent workaround; a timeout category alone does not prove a visible
authorization prompt.

On the installed `67ed4931e4` app, normal identity-fenced passphrase unlock passed,
followed by Light/Dark/System, both accents, cancellation and ten edge-tap Profile
reopens. Two background/resume cycles and an observed Control Center interruption
also passed touch recovery. Writing style passed ten native sheet edit/cancel
cycles after correcting its existing test's parent/roster assumptions. The
updated `31b6c1c736` test runner was installed separately: the product process
remained alive and its draft/session were retained. Private result bundles were
removed; diagnostics contain only sanitized stage/identity-bound status.

The wider Profile test reached and returned from all nine authored destinations,
then failed on an obsolete One-profile Memory control label. The current shared
surface and its 14 React tests require `Open Memory`; the nearest device test now
uses that control without weakening its visibility or continuity assertions.
The corrected full journey passes, including One's Feed/Profile content and
return to the same Chat draft; the original failure is retained. These nine
destinations include deliberately retained React content, not nine newly native
form scenes.

The wider shell rehearsal also reached History's native rename cancellation,
Delete confirmation/cancellation and connector return without a crash or record
deletion. It then stopped on another pre-conversion test assumption: Preferences
Back is now UIKit navigation, not the former standalone `profile-back` button.
That existing test now follows the owned native Back and requires covered-web
accessibility isolation; exposed returns still require the single retained host
and original draft. Full shell acceptance remains pending its corrected rerun.

The production-backed qualification candidate at `31b6c1c736` is built with a
fresh `d1c2b333c8` web export (the intervening application delta is test-only).
Executable SHA-256:
`20250f396e2460480a7d4d034348e118878ddab4edc12718bfebb66e9cc37357`.
Initially it was not installed: the session's draft/attachment safety check could
not prove an empty state, so only its runner was updated. The user subsequently
authorized installation/restart accepting that loss, and installation and normal
unlock passed as recorded above. Visual, accessibility
and physical Release-performance acceptance remain open. Rollback is the
independently reversible artwork/test commits; the custom-native flag remains
opt-in and established platform fallbacks are unchanged.

### Shared Profile navigation and finite settings — 2026-10-16

The qualification-only Profile stack now supports Account, Preferences, Security
and Security → Session through retained UIKit page controllers and SwiftUI
bodies. Standard Back, including the system Back-history menu, reports explicit
bounded intents to the existing React navigation owner. Destination visits have
fresh tokens; compatible appearance updates retain their controller and token.
Opaque semantic page backing prevents a not-yet-drawn SwiftUI body from exposing
the underlying workspace. This source change is not physical flicker acceptance.

| Family | Renderer and operation owner | Current evidence / limit |
|---|---|---|
| Account, Preferences, Security and Session navigation | Retained UIKit stack; existing React query-state owner | Three nearest native regressions pass, including retained hosts, immediate/root Back and stale callbacks. Physical candidate acceptance pending. |
| Appearance, Accent and App haptics | Owned UIKit finite menus / SwiftUI switch; existing theme, accent and Settings writers | Typecheck and 178 existing bridge tests pass. Blue/Molten Gold swatches use the authored CSS palette; no new setting store. |
| Writing style | Existing owned native editor and encrypted React writer | Destination-bound admission/dismissal; preserve unsaved editor state throughout the Preferences subtree. Host regression passes; physical nested-editor journey pending. |
| Voice, Gemini, Help, photos and other rich/protected details | Existing owned React content; native conversion not claimed | These remain explicit follow-up families, not qualified by the new settings stack. |

Custom-native admission remains opt-in. Web, Android, older wrappers and
unqualified iPad retain their established renderers. Capacitor core/iOS/Android
and CLI are aligned on patched 8.4.3, including both Swift package locks; a
successful build alone does not prove installation, visual or release acceptance.

The installed iPhone candidate is bound to `67ed4931e4` (production-backed
Debug qualification, iOS 27.2). Its web export is from `ab41daafb0`; the intervening
app delta is iOS-only and was checked before reuse. Executable SHA-256:
`ef3202c76e3cf62e354f774bfdd120b23694b228fe19a98d40e484e78b660142`.
The three nearest simulator host regressions pass. Reintroducing the old menu
interaction policy fails the retained-menu touch and accessibility assertions;
the fixed policy delegates transient push/pop gating to UIKit's page ancestor.
No extra settings projection is needed to recover the control. The physical
attach-only attempt timed out before XCTest body entry, separately from vault
unlock; no private input was attempted. Physical transition, accessibility and
Release performance qualification remain open, and no release admission changed.

Android's production-backed APK from `ab41daafb0`, including main through
`6ab7790055`, installed and launched on the S24. APK SHA-256:
`0bb20c56bbcb3cb9688180cd13fafa12eeccdc75ce9a44ae5cdb702435d1d8b9`.
This proves installation/launch, not protected native-journey parity.

### Shared-renderer recovery and release gate — 2026-10-16

The current recovery integrates main through `190c77fab6`, including Calendar's
local-time/invitation corrections and the intentional Mail connection-screen
rollback, Wallet CVV entry/presentation warming and independent email/Microsoft
authentication, immediate onboarding-picked names and tighter welcome spacing.
It also preserves main's UAT Drive request-flow restoration and retirement
migration: continuous collection processing and packet listings are disabled,
not deleted. This source integration does not execute that migration or deploy
the restored workers.
Authentication still grants identity, not vault or consent
authority. Receipt request fences
and Wallet owner/visit/session fences remain intact; warmed Wallet content is
admitted only for the current owner and vault epoch.
Custom native
qualification remains opt-in; ordinary Capacitor/React and the independent
native tab bar retain their existing admission policy. No additional Profile
family is qualified by this integration.

At `c18dc294ff`, all product CI lanes except one WebKit Wallet Sharing return
case passed. Source review and a failing old-code browser control establish a
missing modal focus owner, not the cause of that CI timeout. Wallet now returns
confirmation cancellation to Revoke, committed revocation to Back, and detail
dismissal to the original row without scrolling. Owner/activation fencing and
the existing single-send and viewport assertions remain. Eighteen focused
Chromium/WebKit cases pass; combined core and exact-head CI are still required.

Exact-head PR validation at `d44a883d76` failed one Vitest shard and three
browser lanes despite passing canonical core and the iOS, Android and strict
macOS timing lanes. Repairs preserve authored web focus return without granting
native action authority, suppress duplicate programmatic pager choices, and
apply Profile's WebKit material policy to its portaled row menus. Confirmed
chat-key recovery is bound to the original authentication generation and
conversation, cancelled by later edits, and rechecks Calendar sources rather
than retaining fetched meeting text. The authoritative composer still clears
on lock. The repaired `67cc084bbc` head passed canonical core and all exact-head
PR Validation lanes, including the browser packs and native builds. Main then
advanced into overlapping files, requiring the new integration above. Fresh
combined-head core and CI remain required; the earlier pass does not qualify a
different head or establish physical acceptance.

### Earlier main integration and shared-pane repair — 2026-10-16

Main through `745911d536` is merged locally, retaining current Calendar meeting
recovery, semantic name saving, presence sequencing and Wallet behavior alongside
ADK draft, Retry and owner/vault fences. Ordinary custom controls remain React;
the native-shell qualification policy and independent UITabBar are unchanged.

PR CI at `2462c0bc6f` passed iOS, Android, protocol and the full Vitest shards,
but failed browser layouts. Shared material specificity and oversized animated
pane decoration were reproduced and corrected; twelve focused Linux WebKit
cases pass, including repeated Accent selection and provider handoffs. History's
unchanged timing assertions use the existing required macOS performance lane,
with a focused real-drawer/sidebar fixture rather than the entire Chat workflow.
Six focused runs across both engines pass locally; disabled transitions and
delayed-opening negative controls fail. The combined editor/motion command
failed latency assertions during concurrent game load and was interrupted; it
is not acceptance evidence. The path/dependency and native-collection guards
preserve lane coverage. Hosted macOS confirmation and Linux/WPE frame pacing remain unverified;
moving this test is not a claim that WPE timing is fixed. The combined merge passes 150 focused
tests, typecheck, design-system and UI-contract checks; its native source builds.
These are bounded source checks, not an installed current web bundle, physical
transition/performance acceptance, complete Profile adoption or release approval.

### Profile return, scroll ownership and privacy recovery — 2026-10-15

Release admission: ordinary Release, TestFlight and App Store builds do not set
`HUSHH_NATIVE_SHELL_QUALIFICATION`; the non-Debug policy returns false without
that compilation condition. Launch arguments cannot enable it in Release.
The standard native tab bar remains independent. This isolates the experimental
custom presentation, not shared React/navigation changes; those still require
exact-head verification before landing. The latest integration includes main
through `dec7043e33`, preserving the compact shared header and native draft ports
while retaining upstream conversation-epoch guards, Calendar continuation and
the shared Live Memory preview and upstream referral/schema corrections. The
four-state HD mascot assets and playback safeguards are integrated without
reintroducing the taller centered identity: shared header geometry stays 60px,
with a 44px transparent hit region and 32px artwork beside its name/activity.

The ordinary Capacitor/React renderer remains the default for custom controls.
Development qualification uses `HUSHH_NATIVE_SHELL_QUALIFICATION` (or the
existing Debug-only launch opt-in); neither changes React's route, draft,
permission or operation authority. Shared frontend changes still need their
own regression proof: the first combined-head CI at `1231e70ead` failed, despite
its green local core. Focused fixture, uniform-row, mobile-detail/safe-area,
optional-feedback and connector-focus corrections now pass. The repaired iOS
test target builds at `3872060bd8`; integrated exact-head CI remains mandatory.
The subsequent PR run at `5d50308dda` also failed. Its Feed capture, shared-pane
markers, WebKit viewport extent and Wallet fixture regressions were corrected
without relaxing checks. Focused browser checks pass locally; the Linux WebKit
result must still be established by exact-head CI. Account pages now contain
their SwiftUI bodies inside UIKit-owned page controllers, keeping Back/Close
navigation items outside SwiftUI body ownership. Four nearest native tests pass
at `ade38e4fb6`; local iOS 26.2 does not substitute for older-runtime CI evidence.
Dock capability discovery also dispatches UIKit host reads to the main queue.
The Calendar Invitations and working-presence integrations retain the shared
composer and response-owned Retry cleanup. Main's deliberate terminal-close and
automatic preferred-name rollback is preserved; Calendar's owner/conversation
fences remain in place. These source integrations are not device qualification.
No main landing or release acceptance is implied by the experimental flag.
Custom native descriptions below refer to qualification builds, not the
ordinary Capacitor/React default. After verified landing, complete the remaining
nested Profile navigation and ordinary form families through the same owned
presentation before expanding admission; Account alone does not qualify them.

The core Feed scroll rehearsal passes on the signed simulator at `45de35508d`:
three down/reverse cycles, paired displacement, unchanged WebView, keyboard
clearance and draft continuity. It uses ordinary XCTest scrolling; the earlier
press/drag rehearsal did not reliably reverse actual content. No product motion
threshold changed. Core smoke repetition is separate from ten-cycle physical
qualification and Release frame-pacing acceptance. This predates the latest
main integration and does not qualify its installed product.

| Family | Development renderer/owner | Evidence and limit |
|---|---|---|
| Account navigation | Retained UIKit stack with SwiftUI bodies; React operations | Existing physical Account proof below remains bounded; no whole-Profile conversion claimed. |
| Other Profile details | Existing React body in the owned native content pane | Committed outgoing body/title are retained, inert and owner/vault-bound until native return admission. Nine-destination functional batches passed on iPhone at `bd9f375821` and simulator at `a23712046f`. |
| Bottom navigation and dock scroll | Retained native pair; existing shared frontend scroll owner | Capability-negotiated ordered progress, bounded latest-wins delivery and acknowledged pinned fallback. Physical native pair/keyboard regressions passed at `af209c47da`; bounded simulator journey passes at `45de35508d`. Latest combined-head physical acceptance remains open. |
| Privacy recovery | Existing native validation and presentation owners | Navigation now requests fresh permitted admission after release, including completion readback without a listener event. The regression failed without that completion path; 198 nearest navigation/chrome tests pass. This is not UIKit transition acceptance. |
| Rich/protected forms, pagers and unqualified selectors | Existing React feature owners | Retained exceptions, not native conversion. Older wrappers, web, Android and unqualified iPad keep their established paths. |

Native compositor admission can withdraw UIKit interaction independently of a
plugin's requested state. A visible host or active scroll binding is therefore
not touch acceptance. NativeChrome's global conceal on privacy notifications is
a separate notification-ordering risk; fresh React projection must still pass
current document, overlay, owner and privacy admission. Never force interaction
or replay an uncertain choice to recover a screen.

The compact launcher may have no scroll range. Scroll qualification uses actual
Feed overflow, normal tab navigation and preserved drafts—not inserted records,
forced progress or changed motion thresholds. Simulator background/resume passed
two cycles, but its Control Center step did not open the system panel; the whole
interruption check is not accepted. Physical transport and XCTest authorization
must be distinguished from vault entry.

Canonical core passed at `adeec1fb2e` in 808s, before the later privacy readmission
changes; optional local PostgreSQL skips are not CI proof. Those later changes
have focused tests, lint and typecheck evidence, with final core/build/device
qualification still required. The signed UAT simulator candidate at
`c9939989bd` has a fresh web export; the physical iPhone remains on
`eb4774d9f1` until the next separately prepared installation. Visual, VoiceOver,
Dynamic Type and three physical Release performance runs remain unqualified.
Use the existing single custom-shell switch below for rollback; no new family or
release is enabled by these receipts.

### Profile transition owner and single custom-shell switch — 2026-10-15

Profile's bounded Account stack now uses an owned `UINavigationController`
containing retained SwiftUI page hosts. UIKit owns push/pop and actual completion;
React retains route, operation and authorization ownership. Pending native
transitions quarantine page touch/accessibility, coalesce compatible projection
updates, and emit user Back only after a completed pop. A cancelled edge swipe
does not emit Back. Retired controllers cannot revive presentation or callbacks.
The drawer, WebView, private editor and session are not recreated by page Back.
This replaces the experimental SwiftUI path binding, not the React router.
Physical functional verification passes at `0c35f5a73a`: ten warm Account →
Name → Cancel → Back cycles, preserved draft/single-host assertions, two
background/resume cycles and an observed Control Center interruption with touch
recovery. No checks were skipped. Three native regressions also pass, including
superseded Account-pop rejection and callbacks after retirement. This is not
whole-Profile conversion, visual/accessibility qualification or Release frame
pacing acceptance. The installed UAT-backed Debug 1.4.0 (69) contains the full
web export prepared at `9cabdfe234`; authored web sources are unchanged at
`0c35f5a73a`. This includes main's latest Wallet artwork. The native executable
SHA-256 is `79abf32ad0ad87b365040481b3b859e579908a0db0f8755c41c7bf3fdcac0776`;
sealed-resource manifest SHA-256 is
`0f2f2bf6b9b3d45e7ce3a812650c7009458cdb59bf2fc136e0d9055d86be444c`.
Strict signatures, packaged assets, UAT target, typecheck, native static/Siri,
design-system/brand checks and UI-contract validation pass. Core/exact-head CI,
iPad and Release visual/accessibility/performance acceptance are not claimed.

Keep interaction gates with their renderer. UIKit's transition flag must not be
sampled into a SwiftUI hit-testing/accessibility modifier without observation:
that left Account visible but inert after `didShow`. UIKit now gates transition
touch/AX directly; SwiftUI observes only the published route-acknowledgement
state. Actual destination and touch evidence supersede path/host receipts.

The complete custom shell has one build-time kill switch:
`NativeDrawerQualificationPolicy.customPresentationAllowed` in
`ios/App/App/Plugins/HushhNativeDrawersPlugin.swift`. Set it to `false` and
rebuild/reinstall to select established web controls before reveal. It gates
bootstrap, dock, chrome, drawers and legacy Debug opt-ins together. It does not
disable the independently owned standard `UITabBar` or switch live documents
between renderers. `true` permits the existing qualification policy; it is not
blanket production qualification or iPad acceptance.

### Current-main sync and Account navigation investigation — 2026-10-15

Merges `f7f38e6236` and `fdb43cec37` include main through `edcff65ed5`, including Wallet capture,
Calendar availability and Chat detail presentation changes. Mobile header
geometry and caller-sized artwork deliberately retain the reviewed compact
shell rather than main's centered/larger variant. Web Drive details inherit
main's side pane; the native full-page handoff retains its existing owner.
The advisory merge checker inspected 94 files and flagged these intentional
avatar fixture differences plus a still-used `JSONResponse` import. No semantic
operation was removed to satisfy that text heuristic.

The preceding SwiftUI Account candidate was **not accepted**. Device tests reproduced a
projected Account path with no reachable name row, despite active drawer touch
and no pending choice. The bounded Back presentation fix passes its physical
native regression but did not resolve the integrated failure. Destination
appearance diagnostics therefore remain Debug-only booleans, not private body
logs or a new product telemetry stream. Do not enable additional families on
the strength of those admission receipts. The retained UIKit replacement's
bounded functional evidence is recorded above.

On this merged source, typecheck and plugin parity pass. The Back run passed
458/459 cases; its one timeout passed unchanged in isolation. Back/Search
contracts were regenerated, and UI contract validation passes. These checks
do not establish integrated visual, accessibility or Release performance
acceptance. Those earlier diagnostic artifacts retained a preceding web bundle;
the final combined artifact's provenance and bounded checks are recorded above.

### Main integration and Profile escape control — 2026-10-15

Merge `a2d1a7fff2` incorporates main `57a2c39744`, preserving native presentation
and owner/revision fences. Profile's native Account stack attaches Close to its
root and destination content, not outside `NavigationStack`. Generated Profile
artwork now uses the shared outline registry. Typecheck, 459 Back cases, the
focused Profile/icon/bridge checks, design-system and native-static checks pass.
The advisory text-based merge heuristic exceeded its budget; its outcome is
inconclusive, not a fidelity pass. Conflict resolutions were reviewed directly.

The installed escape-control candidate reaches Account and the native Name form.
Its follow-up test incorrectly counted an accessibility-hidden WebView as a lost
host; the check now requires isolation while covered and one web workspace after
Close. The corrected combined candidate still needs device execution. Other
Profile destinations retain their documented handoffs; this does not qualify
those transitions, accessibility or Release frame pacing.

### Retained native Profile Account stack candidate — 2026-10-14

The iPhone qualification path now projects the ordinary Account destination
into one retained SwiftUI `NavigationStack` inside the existing Profile drawer.
The drawer does not close or hand its Account body to React during that push/pop.
The existing native Display name sheet retains its React validator and account
writer. Read-only identity rows cannot emit actions. Account icons are generated
from the same React icon exports. Photo, phone, wallet and destructive operations
keep their existing owners; rich/protected React presentations remain explicit
exceptions, not native-stack conversions.

Native path changes are bounded presentation intents delegated to authored Back.
Account incarnation identities fence form edits/actions across leave/return.
Active and retiring forms quarantine underlying drawer touch, accessibility and
queued choices until actual dismissal. Native nested Back excludes the outer
drawer pan. No second WebView, application router or credential store is added.

This is source implementation, not physical visual, accessibility or performance
qualification. The preceding native-menu/React-detail readiness changes did not
resolve the user's observed route flash. Do not transfer their receipts to this
new composition or claim that the remaining React exceptions are fixed.

### Menu tap acknowledgement stability — 2026-10-14

Profile and One-profile roster rows no longer apply SwiftUI `disabled` to
every row while a choice awaits bridge acknowledgement. Only authored row
availability and actual operation-busy state change disabled appearance.
Pending acknowledgement instead quarantines hit testing and accessibility
interaction; the existing model/lease one-shot guards remain authoritative.
No renderer, host, route, material or transition is replaced by this change.

Product `a901ae4a9e` builds and is installed on the physical iPhone as
UAT-backed Debug 1.4.0 (69), native-shell qualification enabled. Executable
SHA-256: `e49d4c76a48523215d86692e352041cb828807d5036ba352749903808e47c8b8`;
sealed-resource manifest SHA-256:
`d16ebef5afd1f41b55c3de9a4443561ccc4a634ed54e80dbf58c1447ab075fa3`.
Strict app/runner signatures, bundled assets, UAT target and native static/Siri
contracts pass. Configured reviewer passphrase unlock passes without account
or vault changes.

Two focused tests pass on the physical iPhone. The new regression attaches the
actual shared SwiftUI menu to a native window with public synthetic content,
measures its row and enabled environment, and compares row pixels across choice
and settlement. Duplicate choices remain rejected, the next settled action is
accepted, and authored unavailability still reaches the rendered row. Restoring
the old pending-disabled expressions fails specifically at the enabled-environment
assertion. The initial offscreen pixel test was superseded because its disabled
negative control could not distinguish states; it is not visual evidence.

These receipts prove removal of tap-driven disabled-state churn and synthetic
row-paint stability, not attribution of every reported visual artifact or full
accessibility/Release-performance qualification. Other native Profile families
remain at their separately documented implementation and acceptance states.

### Writing Style functional candidate — 2026-10-14

The complete private Writing Style sheet is implemented behind the iPhone
qualification capability. It uses the existing React draft and encrypted
Settings writer; native code owns its fields, finite dropdown menus, keyboard,
scrolling and dismissal. Save stays in the editor, and closing retains the
unsaved React draft. Other platforms and unsupported wrappers keep the existing
inline form. Field icons are generated from the same Phosphor row exports as web.

Name and Writing Style share the UIKit sheet lifetime and one active/retiring
form registry. Retirement clears private replicas immediately and waits for owned
menu and sheet completion. Compatible appearance updates retain open-menu choices;
withdrawing a trigger keeps Save/swipe dismissal blocked until popup disappearance.
The single-line editor distinguishes Return from a multiline paste.

Product `779db926eb` is installed and normally launched on the physical iPhone:
UAT-backed Debug 1.4.0 (69), native-shell qualification enabled. Executable SHA-256:
`33d00e4d46d63c42778ad937691aae405a403f2e94dfb1a6d08e88e9fc1f7434`;
sealed-resource manifest SHA-256:
`b41a3723229849ada36b96c6f9140e3e5f504078147cbb1411e876b2a8237377`.
Canonical 154-page preparation, native build, strict app/runner signatures and
bundled UAT targets pass. Focused JS tests pass 202/202; Back/navigation behavior
449/449; typecheck, scoped lint, UI-contract freshness and native static parity pass.

Five physical native tests pass for both form models, actual sheet/opening/popup
retirement, private clearing, one-shot Save, compatible dropdown updates and paste
admission. The real Writing Style journey passes ten warm Close/reopen cycles,
including native dropdown changes/restoration and two unsaved keyboard edits. It
verifies modal isolation, restored touch, no DOM editor duplicate, one WebView and
the unchanged Chat draft; the application PID remains unchanged through the warm
journey. Normal configured reviewer passphrase unlock passes. No account name or
Writing Style preference was saved.

These are functional receipts, not full visual, accessibility, IME or physical
Release-performance acceptance. Live Save round-trip remains unverified; ordinary
Voice, Feedback, photo actions and pane tabs remain separate unfinished families.
No current-head core, CI, merge, deployment or distribution acceptance is claimed.

### First ordinary native Profile form — 2026-10-14

Product source `88623a6d6c` was installed and normally launched on the physical
iPhone: UAT-backed Debug 1.4.0 (69), native-shell qualification enabled.
The executable SHA-256 is
`6c875e2c6d5f2091b89b88f9330806c6222f53978f1d71c84f69f623022478ae`;
the sealed-resource manifest SHA-256 is
`e400a9d44a94657a9a7b4acea235e2e4364b60e34fe8fd223d77e65eab9a021d`.
Canonical UAT preparation, full typecheck, 154-page export, pinned native
build, strict app/runner signatures and built product/backend checks pass.

Three physical native tests pass for edit acknowledgment, one-shot Save,
private-replica clearing, restored gesture dismissal after settlement, and
joined UIKit dismissal completion. The actual Profile → Your account →
Display name → Edit journey also passes ten warm Cancel/reopen cycles,
including two unsaved synthetic keyboard edits. It verifies modal isolation,
touch recovery, no interactive DOM editor, one WebView and the unchanged Chat
draft. Normal reviewer passphrase unlock passed; no account name was changed.

This is functional qualification of the account-name scene, not completion of
the other Profile scenes or visual/accessibility/Release-performance acceptance.
Native bodies and editor identity survive compatible updates; superseded React
edit echoes do not retire a valid editor. A confirmed web fallback stays the
renderer for that editor lifetime rather than retrying native on privacy resume.
Back/Search review receipts remain stale, the broader behavioral gate is not
green, and no core/CI/push/deployment acceptance is claimed at this head.

### Preceding physical Profile gate — 2026-10-14

Product source `cd09a3779d` was installed on the iPhone as UAT-backed Debug
1.4.0 (69), with native-shell qualification enabled. Executable SHA-256:
`8a80b6172db382324a75f448ff1b2ac596c75c2f3c30b346f2d9d5ef4c9bdf11`.
Sealed-resource manifest SHA-256:
`f13bfa5316db570bb6a3219b758e931720fe802d5841564362dc92b80561ca45`.
Strict app/runner signatures, bundled assets and UAT target were checked before
installation; reviewer unlock used the normal process-only passphrase path.

Two complete attach-only runs pass on that installed candidate:

- Eight Profile destinations and their authored Back stack retain a single
  WebView, its frame, draft and unlocked session. Profile is full-height and
  full-width on the phone.
- Light/Dark/System, both accents, popup cancellation and ten alternating
  Close-edge/reopen cycles pass together; original preferences are restored.

The first gate was a diagnostic/test admission gap, not evidence to remove
interaction guards: Radix exposes an owned popup outside its hidden underlying
Profile accessibility subtree. Tests now target the actual popup and wait for
its real cancellation. The native active-pane diagnostic also retains the
already-sanitized geometry required by Back admission. Neither change broadens
operation authority.

| Family | Renderer / owner | Current evidence and boundary |
| --- | --- | --- |
| Profile menu and Back/Close | NativeDrawers menu; React query/Back owner | Physical functional stack and ten-cycle reopen pass at `cd09a3779d`; not visual, accessibility or Release-performance acceptance |
| Appearance / Accent detail triggers | Existing React detail; current bounded selection owners | Physical functional values/cancellation pass; no new native settings scene claimed |
| Account name | Shared React controller; qualification-only complete native sheet through NativeDrawers v1 | Physical native lifecycle3/3 and actual ten-cycle edit/cancel journey pass at `88623a6d6c`; live Save, visual/accessibility/Release-performance acceptance remain unverified. Web/Android/older wrappers retain the existing form |
| Communication | Shared React controller and encrypted `saveOwnerStyleSettings` writer; qualification-only complete native sheet | Native lifecycle5/5 and real ten-cycle dropdown/edit/Close journey pass at `779db926eb`; live Save, visual/accessibility/Release-performance acceptance remain unverified. Web/Android fallbacks retained |
| Ordinary Voice preferences | `VoicePreferencesPanel` and its existing preference services | Native ordinary scene not implemented; do not turn Location auto-approval/nearby policy rows into unguarded local settings |
| Help & Feedback | `ProfileWorkspacePage` support composer and existing delivery service | Native multiline scene not implemented; preserve three intents, accepted/failed/uncertain outcomes and no uncertain-send replay |
| Profile photo | `ProfileAvatarEditor` and existing camera/library/remove owners | Complete owned native action-menu adoption not qualified; no new camera or persistence owner |
| One Feed/Profile finite tabs | Existing One profile content and local selection owner | Pane-bound native tab family not implemented; do not conflate finite local selection with route/swipe pagers |

The name-controller prerequisite uses the existing authenticated service writer.
Confirmed provider writes remain distinct from failed shadow readback; stale
owner callbacks and older refreshes cannot replace a newer presentation draft.
The new native name scene owns its full sheet, keyboard and dismissal above
retained chrome. Its private name/edit replicas are memory-only; public chrome
metadata carries neither names nor feedback. Listener admission must finish
before a scene can be applied, and fallback requires confirmed retirement.
Profile retirement joins the sheet's actual dismissal, including an already
retiring sheet. Presentation-time owner revocation withdraws that exact scene.
The Name journey was verified at `88623a6d6c`, as recorded above; the earlier
`cd09a3779d` receipts establish only their stated preceding gates. Protected forms, rich
content, complex multiselects and other-platform fallbacks remain unchanged.
No merge, deploy, distribution or new family qualification follows from these
functional receipts. Transition frames, accessibility and physical Release
performance retain separate acceptance gates.

Behavioral Location tests isolate the decorative page-entrance hook only; they
retain operation, consent, cancellation and gesture owners and all existing
assertions. Actual animation/scroll frames remain owned by
`location-switch.layout.spec.ts` and `one-location-people-rows.layout.spec.ts`.
Removing an animation from JSDOM is not physical motion acceptance or a reason
to increase timeouts.

### Historical Profile admission investigation — 2026-10-14

Product source `aa4197aad3` is installed on the iPhone as UAT Debug 1.4.0 (69).
Its executable SHA-256 is
`c3ddc54d01414476175d2b637187e061998ed4c4a53344cb07b0b766228148ef`;
its sealed-resource manifest SHA-256 is
`e288442f9af6c8b115aaa06fdea5af0d260f7a561125c9637c9cb080599c391c`.
Strict app and runner signatures, bundled assets and the UAT backend pass.
Missing pinned framework artifacts were recovered through isolated, locked Xcode
package resolution, without dependency upgrades or shared-cache deletion.
The generated runner was resealed with its existing identity and entitlements
after Xcode rebuilt its nested test bundle; both signatures were reverified.

Installation/restart was explicitly authorized. Credential-free XCTest admission
and normal process-only reviewer unlock pass. Same-run failure diagnostics show
that an open Accent popup is the sole interaction blocker. Both public choices
are hittable through the application accessibility root; Radix hides the underlying
Profile subtree that the previous test queried. The test now queries the popup
and uses its existing outside-press dismissal contract, without bypassing disabled
Back/Close or changing operation authority.

Light/Dark/System changes, both Accent choices and two cancellations complete on
the physical product. The combined run later stops during Close with its privacy
cover active; that interruption is not a successful combined qualification.
A separate focused run passes all ten alternating Close-edge/reopen cycles,
retaining one WebView, its frame and normal vault admission. Its receipts explicitly
exclude the skipped Appearance/Accent subcases. Nested Back, visual transitions,
accessibility and Release performance require their own evidence.

The existing opt-in diagnostic now distinguishes overlay, inert ancestry,
movement, session suppression, voice-layer blocking and document visibility with
six booleans. Its whitelist excludes identities, private bodies and provider
errors; it changes no permissions or operations. Native ordinary form scenes,
support composition and pane-bound finite tabs remain unimplemented; this diagnostic
and test repair does not qualify those families.

### Profile readiness during appearance changes — 2026-10-14

The shared `NativeChatChrome` adapter now reports presentation readiness after a
matching in-place update or readmission, not only initial activation. Previously,
an appearance change during activation could suppress the initial receipt without
ever completing Profile's destination handoff. Readiness is emitted once for the
current installed lease, document, owner, context and committed appearance. It is
staging evidence, not permission to interact with a covered destination.

The regression fails on the prior source and passes with the repair. All 159
bridge cases pass, including changed-owner and dismissed-pane negative controls;
449 Back cases, generated UI-contract checks, native static parity, typecheck,
focused lint and design-system checks pass. Subsequent physical XCTest enters the
test body and normal reviewer unlock succeeds. That proves automation access, not
this readiness race as the cause of the earlier popup accessibility failure.
Historical installed and prepared identities below are not the current candidate.

Ordinary native Profile forms, support composition and finite local tabs are not
implemented by this repair. The subsequent physical Back/Close gate is recorded
above; it does not establish acceptance of those new families. Existing
protected-form, rich-content and platform fallbacks remain.

### Profile continuity and system-resume repair — 2026-10-14

Source `c99498179e` corrects three demonstrated contract gaps: drawer admission
now observes acknowledged privacy releases even without another native event;
nested Back retention includes its exact content-pane identity; transient motion
quarantine changes hit testing and accessibility, not authored disabled appearance.
Retiring drawers remain isolation owners until their popup and host disappear.
Profile header/body use the same responsive gutter; route Back stays inside its
authored reading frame rather than using a negative margin.

Both new bridge regressions fail against the broken source. Focused bridge,
Profile and privacy checks pass; optimized Chromium/WebKit layout checks pass
16/16, including the former fixed-inset negative control. Three actual native
simulator tests pass for motion quarantine, popup retirement and Profile handoff.
UI contract build/check, typecheck, signed iPhone build and exact local core pass
(535 seconds). Simulator results do not qualify physical interaction or material.

The built UAT qualification candidate is Debug 1.4.0 (69), executable SHA-256
`60cacf2510aac712309adc714acabca9e2aa313589c1418eb1b875f706e9f476`.
This product was installed after explicit one-restart approval. Normal reviewer
passphrase unlock passed once through process-only, whole-value input. The
attach-only run passed two background cycles with actual Profile open/close,
retained draft and session. It then stopped before Control Center touch recovery
because the harness did not identify the system panel. That is not a combined
resume pass. Preferences subsequently failed with an unavailable element/snapshot;
the still-running product was left in a detail pane without admitted Back/Close.
A focused Control Center rerun stopped at that entry gate, not at Control Center.
One bounded normal hardware Escape did not recover the pane. No second product
restart, account reset or credential retry was performed.

Follow-up source `cff517c134` fences retained Back replacement to the exact pane
identity, including privacy generation. Same-pane nested navigation retains its
host; changed panes require ordinary retirement/preparation. All 156 bridge cases
pass; removing the fence fails the changed-pane regression. Typecheck, UI contracts
and native static checks pass. This replacement capability is disabled in the
installed foreground shell, so the defect is not established as that physical
failure's cause. The existing bounded Debug probe now samples the actual pane
Back/Close admission rather than withdrawn History. Its further candidate install
requires separate restart approval. Canonical UAT asset preparation and the signed
iPhone app/test build pass at this source; the uninstalled executable SHA-256 is
`4ca913cb4d6ea2f0f8a18482078d9e7be8c550583814b2274896667dd708954e`.
No exact follow-up core or CI result is claimed. Transition-frame, accessibility, Control Center
and physical performance acceptance remain open; no family was newly qualified.

Consumers of lifecycle state must observe authoritative validation receipts as
well as events. Preserve generation/owner fences, require fresh admission, and
never release the privacy cover on a presentation timeout alone. Distinguish
semantic disabled/busy appearance from temporary touch/accessibility quarantine.
Bounded native choice adapters exist; complex multiselects and route pagers remain
React-owned until their complete overlapping presentation is separately qualified.

### Active Profile parity correction — 2026-10-13

The previously installed iPhone qualification product was `e6456b8315`, Debug 1.4.0 (69),
UAT-backed; executable SHA-256
`fcbb4229acf1e75e1516397392713298117a8eb0539e55766c2983b46f8be116`.
Exact local core passed in 485 seconds. Signing and packaged assets pass.
The iPad retains `8cdf24f098`, with executable SHA-256
`01fb5e14afcb2bb86a523143ed5d05e939f96a7ec4396d2b5994f1dfacc8a725`.
Its exact local core passed in 475 seconds. These supersede installed identities
in the historical checkpoints below, not their stated verification limits.

The Delete crash was an attempt to replace UIKit's alert presentation delegate.
Owned alerts now retain UIKit's delegate and their actual dismissal completion;
custom sheets retain the adaptive delegate. The actual alert regression passes
and fails with the old assignment. Physical iPhone Delete confirmation/Cancel
passes without deleting a chat.

Profile Close delivered successfully but traversed to an earlier open query root.
The shared history owner now preserves untracked in-place nested navigation.
The iPhone Invite/Help/Privacy/Terms return sequence and final Close restore the
same Chat host/draft; the exact core and 47 owning cases pass. Readmission alone
was not the Close RCA. An iPad warm run reaches Preferences/Gemini/Voice,
Security/Vault, Devices and Connectors, then stops at Referrals route admission.
That run does not qualify its remaining destinations or final Close.

The installed iPhone candidate corrects a separate pre-slide scroll jump: mounting a retained
destination must not restore the outgoing screen's scroll or overwrite its return
position. Restoration follows the active screen key, not retained-entry changes.
The owning regression holds the entry frame and checks push/pop positions; the
old dependency list fails. This is not proof of all reported physical flicker.

| Family | Current renderer and operation owner | Next correction / qualification limit |
| --- | --- | --- |
| Profile root icons | Native templates generated from the shared React roster | Match the 28px glyph / 32px well and title column; regenerate matching-resolution assets. Actual packaged-artwork native regression passes, including accent layers. No second artwork source. |
| Nested Account, Security, Legal, Devices, Referrals and Memory rows | Shared React content; native acknowledged Back/Close | Remove pane-only legacy glyph selections. Reuse the pane styling context and preserve capability colors/sizing. Optimized Chromium/WebKit phone/tablet geometry passes; installed iPhone functional results below are not pixel acceptance. |
| Emoji-opened One panel | Shared hero, owner-gated name, model control and Feed/Profile body inside the owned content pane | Native Back/Close; eliminate the divergent two-row menu and tab-dependent handoff. Feed read/filter boundaries and owner isolation remain authoritative. Rich body/tabs remain React, not a qualified whole-native sliding drawer. |
| Appearance, Accent and One/Puppy | Existing authored NativeChrome finite-choice families | Update retained presentation and existing controlled values. Moving/stacked controls remain React until their complete overlap composition is qualified. |
| Short menus and bounded single-value/date choices | Existing owned native presenter and React validation | Single-value contract only; no production date/finite-wheel consumer is declared qualified by this audit. |
| Searchable multiselects and Connect/Memory/Mail/Finance pagers | Existing React selection or pager owner | No array-value native contract exists. Do not map them to a single-value picker or add a second tab/router authority. Independent native adoption requires complete semantics and device evidence. |

The iPhone install/restart was explicitly authorized despite its detected unsent
draft; the safety check did not clear it. One normal passphrase unlock passed,
followed by attach-only tests. The new iPhone passed eight Profile destinations
from Preferences onward, nested Gemini/Voice/Vault Back, final Close and the
shared One hero/Feed/Profile journey. The same host and draft survived.

History Rename Cancel, Delete Cancel and Connectors handoff pass. Ten warm shell
cycles pass with keyboard, One/Puppy, drawers and one retained composer. History
Close and opener share the measured `(16,72)` leading slot and independent
44-point hit regions. No reviewer chat was renamed, deleted or submitted.
These are functional/geometry receipts, not transition-frame, material,
VoiceOver/Dynamic Type or three-run physical Release performance acceptance.
iPad installation remains session-preserving pending separate restart authority;
its Referrals, History AX and keyboard gates remain open.

### Wireless follow-up and reviewer contract corrections — 2026-10-14

The iPhone service probe confirms `localNetwork`, paired, Developer Mode enabled
and device-unlocked. Credential-free attach-only XCTest entered successfully;
the first admission exposed the existing native editor, History and One/Puppy.
The iPad was unavailable and was not installed or restarted. The installed iPhone
product remains the `e6456b8315` executable above; subsequent installs updated
only its test runner, with destination-artifact mode preserving the product.

Mail's real software keyboard, bidirectional pager and Chat draft return pass.
Connect's Circles/Connections selections and same-host/draft return pass.
The three-test batch failed Memory's first Saved → Add swipe (two passed,
one failed). A later bounded probe positively observed the fixed viewport
coordinate over an interactive control; another earlier probe did not attribute
it. Do not retroactively classify every failure as that one cause. No private
labels, values, screenshot or result bundle were retained.

The Memory rehearsal now targets the authored gap after Search Memory or Memory
note and refuses a guarded start. The Profile preferences rehearsal now admits
the actual native roster entry and shared React body controls, rejecting native
Appearance/Accent duplicates instead of requiring those disabled families.
Cancellation still must dismiss the real selection presentation; theme/accent
restoration, 44-point targets, ten edge reopens and single-host checks remain.
The signed runner compiles; static native parity and 86 owning Memory/pager tests
pass. These harness corrections are not physical acceptance: the subsequent
preferences batch had an element/snapshot interruption, and the final corrected
Memory run stopped at `MEMORY_ENTRY_UNAVAILABLE` before the swipe. Later generic
XCTest admission exposed no Chat controls and proves automation entry only.
Classify this remaining navigation/admission failure before another gesture run.

No product renderer, pager arbitration, vault, routing authority or release
admission was changed. No sign-out, product restart, chat mutation, push or
deployment occurred. Material/transition, accessibility, iPad and physical
Release performance gates remain independently open.

The following sections retain dated experimental and preparation history.

### Merged candidate and preparation authority — 2026-10-13

The current candidate incorporates main through `ae85461ceb`, including Rive
presence, World Model, Wallet and onboarding updates. Phone Chat keeps the
compact single-row presence/name/activity layout. Chromium and WebKit pass 46
focused layout cases, including 44-point controls and the previous stacked-header
negative control. These browser results are not native visual acceptance.

An explicitly compiled `HUSHH_NATIVE_SHELL_QUALIFICATION` candidate retains its
coherent renderer on normal manual launches. Ordinary Debug and Release builds
keep their existing admission policy; this is not production qualification or a
user preference. Native controls are still subject to owner/privacy fencing.

The owner authorized installing this candidate and restarting One once on both
physical devices, superseding the earlier preserve-session preparation
restriction below. No sign-out, account reset or backend deletion occurs.
Subsequent acceptance runs remain attach-only. Historical installed identities
below do not identify this new candidate; source, executable and runtime receipts
must be recorded after its build and installation.

The installed product on both devices is Debug 1.4.0 (69), UAT-backed, from
`12180b51b5`; executable SHA-256
`324a70d777104e90cb00e3251d05a7ffa71ac7c62d264ae92d5a62b7c9ce402b`.
Strict signatures and 38 packaged presence/onboarding asset hashes pass. Both
devices passed XCTest body admission and normal passphrase unlock. Core passed
in 445 seconds at `3501811eb6`, after correcting owner-scoped message-delivery
effect dependencies. Later runner builds do not replace that installed product.

Physical results remain bounded: both outer Profile panes pass full-height
geometry. Nine iPhone destinations and their return paths passed across focused
runs, including Gemini, Voice and Vault methods. Referrals correctly restores
its initiating Profile query through the existing destination-origin owner;
One is its direct-entry fallback. Earlier detail-frame failures measured AX title
hulls rather than pane bounds. The harness now uses fresh, document/privacy-fenced
authored DOM bounds while retaining physical edge and control checks.

The final Profile Close exposed a visible disabled native menu excluding Chat.
Source confirms that the terminal deadline waits for readmission without sending
a request. The new capability-negotiated NativeDrawers v1 handshake invalidates
the original token and asks the current React owner to republish presentation.
It never repeats Close or another operation. Requests are identity, update,
privacy and interaction-generation fenced; duplicate/stale requests are ignored,
and lost authority retires the presentation. These changes are not yet installed.
The nearest web contracts pass 169 cases, including an old-listener negative
control. Original Close-delivery cause and integrated device acceptance remain
unverified; readmission is a liveness repair, not evidence that delivery succeeded.

iPad lost its device-service tunnel after Account/Gemini. Its History AX and
keyboard gates remain open. iPhone History geometry/Rename cancellation passed
before the unclassified Delete-menu interruption. No result here completes ten
integrated cycles, accessibility or physical Release performance.

Nested Profile content now retains the shared `DialogOverlay` backdrop. The
transparent rule is restricted to bounded non-pane feature pages. The optimized
real-component fixture passes in Chromium and WebKit at phone/tablet widths;
reinstating the old rule removes dimming/blur and restoring the fix restores
them. Body push/pop remains owned by the existing `ProfileStackNavigator`; no
new outer-pane animation is introduced. This correction is in the installed
executable above.

Dismissal now revokes both native header bindings immediately through `open`;
closing DOM fallbacks are disabled while the existing pane keeps exit isolation.
Both deferred-confirmation cases pass and fail when the former eligibility
expressions are restored. The nearest native-chrome suite passes 152 cases.
This fixes a stale-action window, not the still-unclassified first-tap failure.
The Debug-only physical probe now includes bounded Back/Close choice outcomes;
when packet space is exhausted inside a detail, it prioritizes those outcomes
over withdrawn base-History hit geometry. No protected payload or authority is
added to diagnostics.

### Profile content handoffs and circular controls — 2026-10-13

At this earlier checkpoint, custom-native controls were qualification-launch-only
and neither product was updated. The current candidate policy and installation
authority are described above. Bottom navigation remains independently enabled.

NativeDrawers v1 now negotiates `profileContentHandoff`. Its optional, Profile-only
`surfaceOpen` field distinguishes the encompassing Profile lifetime from menu
visibility. Once detail content is acknowledged, menu/detail replacements within
the same enabled, owner-bound privacy generation settle without another outer
drawer slide. Initial opening, real dismissal and unnegotiated wrappers retain
their existing motion. Nested detail content keeps the existing React stack and
Back owner; this does not introduce a native router or another WebView.

The focused native regression passes, fails when the former animated handoff is
restored, and retains negative controls for actual opening and privacy changes.
The 160 nearest web cases, 443 Back cases, typecheck, plugin parity, generated UI
checks, design and static render checks pass. The signed device build passes.

Shared native circle buttons now use circular interaction and hover shapes, with
the existing 44-point layout, standard glass border and action owner. Apple's
[`hoverEffect` shape](https://developer.apple.com/documentation/swiftui/contentshapekinds/hovereffect)
supports iOS; the custom `focusEffect` shape does not, so system focus remains
unchanged. This corrects inconsistent authoring but does not establish the cause
or physical resolution of the reported square artifact. Visual/cardinal-edge,
integrated transition and device performance acceptance remain open.

### Retained nested panes and History actions — 2026-10-13

The follow-up separates a pane's revealed lifetime from its changing Back
binding. Initial plane/header admission still gates first paint; nested Profile
push/pop retains the visible pane while obsolete Back choices are invalidated.
Owner, privacy and failed plane admission remain fail-closed. Close is bound to
the pane lifetime, not every nested query.

History's Connectors footer now opens a leading child pane and Back restores
Chats. It reuses the existing Profile connector/OAuth owner, without another
provider flow or transcript. Web retains one leading drawer and mounted connector
panel; native stages the destination before withdrawing the History roster.
Inline Chat cards retain their existing Profile destination.

Native Rename edits its own row while search, other chats and footer remain
mounted. Delete uses an owned UIKit destructive confirmation; retirement waits
for real dismissal and captured identity/privacy/update fences reject late
choices. Device tests cancel these actions without mutating reviewer records.

Source tests cover retained visibility, owner changes and the web connector
round trip: 201 focused cases and 443 Back behavior cases passed. The local core
mirror passed in 421 seconds at the `d26071b40a` follow-up, before the later
runner-only secure-field targeting correction. Exact-head CI is not established.

Product implementation `f7890fae39` is installed as Debug 1.4.0 (69) on iPhone
16e, UAT-backed. Its installed executable SHA-256 is
`216ae9fd6fa6efece5175590392fb0fceb68bbfbef29ebcae4bf05abb231f61a`.
All 69 physical native support cases passed; integrated action/navigation
acceptance has not passed. The footer AX-role query was corrected, and guarded
action stages now distinguish Rename, Delete cancellation and Connectors handoff.
A public synthetic input check reproduced app-wide typing loss; the named
secure-field path passed both fixtures. A later reviewer run acknowledged whole
entry but failed before submission; an independent device-service probe then
reported a wireless tunnel reset. That probe does not establish the earlier
failure's cause. No reviewer record was renamed/deleted or authentication guard
bypassed. Private result bundles were removed.

A subsequent wake/reconnect check still reported the paired iPhone unavailable:
the lock-state service returned CoreDevice 4016 and the existing-pair reconnect
returned 4000. Bonjour announcements appeared and disappeared, without a
successful trusted service probe. This is a transport blocker, not a vault
rejection or a product acceptance result. The final runner-only build passed.

After the operator corrected the network, both devices established trusted
`localNetwork` connections and passed XCTest body admission. The iPhone's
ordinary React-composer session passed ten warm Profile/One/Puppy cycles,
keyboard layout and route-return checks without submission; this is fallback
evidence, not native composition acceptance. A later account-verification guard
was recovered through its authored **Try again** action without sign-out. The
qualification preparation guard cannot yet prove its unsent state empty, so no
iPhone qualification relaunch or draft deletion followed.

The iPad product transfer initially timed out. Following a bounded verification
of the installed fallback, the next transfer returned a successful installation
receipt for executable SHA-256
`d67adf72814bb8c21e33713c11dd1e31fc0785f5fc71f3fa9d67f1de2332768f`
(same product implementation, Debug 1.4.0 (69), UAT-backed). Its normal
passphrase unlock passed with whole-entry acknowledgment and protected Chat.
The native composition check stopped before History actions: its 44×44 opener
at (24, 72) was present/enabled but not hittable, while the selector was
hittable. A later sample lacked the editor. Adding the authored One-profile
dismissal did not resolve admission; an advertised drawer alone does not prove
an active blocker. No native hit-test, isolation or geometry correction was made
without further evidence. Native window-level hit admission remains unverified.

The nearest runner now distinguishes the One-profile family, reports bounded
public control frames, optionally retries the authored verification guard once,
and fails closed before qualification preparation when either editor's empty
state is unknown or a draft, attachment or action is pending. These are
diagnostic/preparation controls, not new application action or unlock authority.

The next bounded diagnostic uses the existing Debug admission probe to report
synchronous native lease, ancestor eligibility and five interior hit targets at
both container and window level. It emits only fixed roles, flags and bounded
geometry, without a WebKit completion, account identity or editor contents.
An explicit coherent-shell qualification launch enables the existing probes;
ordinary product and Release admission are unchanged. A focused simulator
negative control passes: a covering window sibling is detected even with an
unchanged control frame, and observing a withdrawn lease never re-enables it.
The signed device build passes, but this diagnostic product is not installed.

The owner explicitly chose to preserve the iPhone's drafts and current session.
No iPhone product update or relaunch is authorized for qualification. The iPad's
new runner entered XCTest but its editor was unavailable to the preparation
guard, so empty/idle state could not be proved. Its product also remains
untouched pending an iPad-only preparation decision. These are safety stops,
not evidence that the native touch regression is repaired.

Physical acceptance remains pending. This does not enable ordinary custom-native
admission, qualify iPad material composition or waive visual/accessibility/Release
performance gates. No push, deployment or distribution occurred.

### Compact header and owned Profile content plane — 2026-10-12

The follow-up keeps Chat's mark, title/activity, History and One/Puppy on one
60px header row. The SVG mark has a transparent 44px action region; the artwork
stays 32px. Phones use One's existing profile for the cloud-model picker rather
than crowding the header. Puppy is labelled **Puppy One**, without a second
conversation description. These are shared web/Android/iOS geometry changes.

In the qualification wrapper, the mark opens an independent `agent-profile`
NativeDrawers v1 menu. Its Feed and Profile content retain their existing React
owners. Account Profile details retain the existing query/Back stack and use the
same full-height pane bounds, not the earlier shorter reserved band.

NativeChrome v2 negotiates `ownedContentPane` before this geometry is admitted.
The existing container retains base hosts behind the single WebView for that
content lifetime; a separate bounded foreground plane hosts its Back/Close.
Plane ownership is document/opaque-owner/generation/privacy fenced. Compatible
viewport updates retain it. Header layout acknowledgments and the plane receipt
are both required before menu dismissal. Retirement tombstones the lifetime
before asynchronous popup dismissal and restores base order only after actual
DOM exit and confirmed header removal. Privacy validation completion is observed
even when native emits no JavaScript event. No extra WebView, router, store,
snapshot, aperture or per-frame clipping is introduced.

This whole-plane demotion **does not prove base-glass visibility outside a narrow
tablet pane**. iPad remains qualification-only; physical transition and visual
acceptance cannot be inferred from header receipts. Older wrappers retain the
previous bounded feature-page fallback. Ordinary custom-native admission remains
off, and this local change does not authorize a release.

Verification before installation: typecheck, 216 focused cases, 28 WebKit layout
cases using optimized product CSS (including phone/tablet pane bounds), UI
generation/check, design/accent/performance/cache/docs/brand checks, signed native
build and 69 physical native-support cases. Device product journeys must be tied
to the subsequent exact build, not the previous evidence below.

Maintenance rule: paint-plane ownership, action admission and privacy are separate
contracts. Never release a mounted content pane on resize, restore captured base
permissions, or let late preparation revive a retiring pane. Native Back/Close
are authored adapters, not DOM-inferred operations. Keep the existing overlay
registry through actual DOM exit; a target `open=false` is not disappearance.

### Integrated native shell candidate — 2026-10-12

Current candidate `64ea4a5d1c` contains fetched `main` at
`1d691714135e` on the ADK verification lane. The live development branch remains
`feat/adk-orchestration-runtime`; it advances only after combined verification.
The merge preserves retained native controls and their authored operation ports,
while integrating current Wallet network lookup, Profile review and routing.
History keeps leading Close and inline age. Shared mobile Profile and History
are full-window surfaces; touch tablets keep the bounded reading width but
extend Profile from top to bottom. Desktop cards remain inset. Chat uses a
compact left-aligned phone mark and the existing thinking/tool subtitle, with separate action tracks at constrained widths and a
single row from 1280px. History has one scroll owner with fixed New chat,
search and footer tracks; default titles stay on one baseline with the full
accessible name retained. Accessibility text may grow. Native route-retirement
checks require host removal, not just accessibility absence.
Normal product admission remains **off**. The document-start coherent-shell
bootstrap is available only through the explicit qualification launch switch;
old experiment flags do not enable it. Web, Android and older wrappers keep
their established renderers. iPad is eligible only under the explicit coherent
qualification switch; its ordinary renderer is unchanged. Earlier dated receipts qualify only
their named builds, not this candidate.

| Shared family | Renderer and operation owner | Candidate status / rollback |
| --- | --- | --- |
| Bottom navigation | Existing native `UITabBar`; existing React tab intent | Retained beneath the keyboard and native drawers; integrated functional receipt below, visual/performance acceptance pending |
| Chat History opener and One/Puppy | Retained NativeChrome v2; authored Chat callbacks | Foreground content-backed composition, coverage disables interaction rather than hiding hosts; qualification only |
| Agent Dock | NativeDock v1; existing One and Puppy draft/submission ports | One editor/glass container; private final-draft reconciliation on native coverage; qualification only |
| History | NativeDrawers v1 owns the complete panel/scrim/gesture; existing search/rename/delete callbacks | Full mobile frame, compact rows, separate 44pt More, one native chat scroll owner and pinned footer. Rich-path, visual and performance qualification pending |
| Profile menu | Same native drawer family; shared authored Profile roster and existing callbacks | Actual React Phosphor/custom artwork generated by the existing brand-assets owner, including authored color/duotone/accent layers; no separate vector roster. Root photo/provider branding and physical visual acceptance remain incomplete |
| Profile details | Bounded full-page React content in the existing WebView; existing query/Back owner | Destination Back acknowledges layout before menu dismissal; scroll restoration targets the owning feature body; viewing does not change vault authority |
| App haptics | Existing Settings preference/plugin; accepted React interaction owners | iOS/Android capability-negotiated feedback; no new generator/store on web; native/system accessibility behavior retained |
| Other rich Chat overlays | Existing feature owners | Attachment editors/viewers and Drive activity/detail now use the shared bounded feature page in the qualification candidate; remaining rich paths are not qualified |

Presentation identity is separate from interaction eligibility. Closed retained
Profile content is inactive for voice/action metadata. Profile Back retires when
its content page ends; ordinary shell slots may retain compatible hosts. Native
coverage snapshots only committed editor text, fences owner/context/privacy and
edit revisions, and never submits or replays a turn. Final IME commit advances
the native edit fence even after touch admission is withdrawn.

The current integrated composition is **not accepted**: complete first-reveal
composition readiness and coherent whole-shell failure fallback remain gaps.
A bounded Profile error page is not whole-shell fallback. Rich overlay parity,
transition-frame inspection, accessibility and three physical Release performance
passes remain required before product admission or shared-family expansion.

#### Current shared geometry and artwork evidence — 2026-10-12

Reversible implementation commits `c9236dfd84`, `d1006811ac`, `5ead2c5da8`
and `3e1d97510d` preserve current operation owners. Follow-up `187a9df2fa`
restores the left-aligned phone mark and full-height touch Profile; the native
background ignores safe areas while interactive content respects them. The existing generator loads
the real shared Profile icon components at build time and emits 14 allowlisted
artwork IDs (48 template PNGs). Native consumer rows use 22pt artwork inside
the existing 32pt well and align separators at the shared text column.
Mobile safe areas belong to full-window content; legacy reserved wrappers do
not add them twice. Inset tablet travel includes the outer gutter and retains
the last applied layout's travel when reconstructing an interrupted resize.

Focused evidence: 157 existing family unit cases plus 22 History/header cases,
26 WebKit layout cases, typecheck, brand-assets freshness, UI-contract generation
and verification, signed Debug/UAT native build, product assets, and all 68
native support cases on physical iPhone. The default-height regression fails
wrapped long rows; the inset tablet negative control exposes width-only travel.
These are functional/layout receipts, not complete visual or performance acceptance.

Product source `6344f9778f` exports, syncs and signs as Debug/UAT
`com.hushh.app` 1.4.0 (69). Its executable SHA-256 is
`a8b0d6c926eab4ae25d61eec14bdcc1795d0766b39fce6f850e157a94e699260`;
UI-test runner SHA-256 is
`f5f0dc675f0685e2961a39c73d764a0f2341d28689aad34b184820defe6c1803`.
The combined head passes typecheck, UI-contract generation/verification,
26 WebKit layout cases and product-asset/signature checks. Its 68 native support
cases pass on the physical iPhone, including actual generated artwork, compact
History text layout and full-height tablet geometry.

At the previous installed `016aa5d552`, the iPad completed all nine nested
Profile destinations through native Back with the same protected session.
The iPhone's integrated cycle run stopped after four successful cycles because
History did not open. Latched `applied`/`confirmed` diagnostics do not identify
that failed tap; `6344f9778f` adds a bounded native tap counter to distinguish
physical delivery from admission. It does not weaken fences or retry a tap.
The Dock run's keyboard fence was corrected to capture its sequence before
Profile opens; a subsequent runner-only check failed without a classified
assertion, so neither run qualifies the keyboard/route journey.

Both physical devices subsequently accepted the `6344f9778f` product and
normal process-only reviewer passphrase unlock. iPad transport is verified as
`localNetwork`; its first 60-second install timeout is retained as preparation
failure, followed by a confirmed bounded install. The iPhone follow-up opened
History with matching leading Close, then failed the 44pt assertion after
scrolling. Runner `dcb2944dd8` measures a fully exposed cell instead of a partly
clipped scroll-edge rectangle without reducing the required hit region;
`64ea4a5d1c` additionally requires the actual Profile host to fill the vertical
window bounds. These runner-only refinements do not establish physical passes.

#### Historical shared Profile follow-up — 2026-10-12

The History follow-up restores the web drawer's 24-point right-hand curves by
shaping only its SwiftUI background. Its transparent host and unmasked controls
retain system effects. Age is compact inline metadata; it no longer reserves a
second line or changes the title's vertical centering. The shared feature-page
header wraps long destination names within the existing Back/gutter tracks.
Production-optimized Chromium/WebKit checks cover portrait, landscape and
enlarged text; the old truncated title fails the overflow negative control.

Warm checks at `75cc325072` completed ten integrated Chat/History/Profile cycles
and, separately, nine Profile destinations. Subsequent runs failed initial
composition admission and Puppy selection after four cycles; those failures
remain evidence, not discarded retries. The credential-free probe found History
and the selector absent while the editor and Profile opener remained admitted.
Source-backed reproduction isolates a retained-control defect: native privacy
invalidation removes a host, but its adapter tries to suspend that absent host.
The native-invalidated lease now requires confirmed retirement before fresh
admission; ordinary drawer coverage still retains presentation. Existing owner,
privacy, choice and popup fences are unchanged. The retained History/Profile Back
regression fails the old adapter and the full 147-case suite passes the correction.
Independent native review confirms the bounded correction by source. Follow-up
regressions deliver both native/privacy invalidation and a deferred retirement;
they reject old choices and prohibit fresh preparation before its acknowledgment.
The enlarged-title checks also retain vertical containment and usable body space.

Source `523d016849` exports, syncs, signs and builds as Debug/UAT
`com.hushh.app` 1.4.0 (69). Product executable SHA-256 is
`f7ba5cc5853fd866839df76499165defd9764c1d059deb6ee203f9493c5903e6`;
the UI-test executable is
`ea748335aa25c46d208d91487b6f0ac0111eb752ef48f9500f1975a233a7bd55`.
Packaged-CSS and static plugin/Siri checks pass. This product is now installed on
both physical devices. On iPhone, normal passphrase unlock and nine Profile
destinations pass; on iPad, public vault rotation/resume, protected admission,
Memory and the Connect/Finance/Consent/Wallet batch pass. These are bounded
functional receipts, not acceptance of every route or transition.

The follow-up runner at `4211c4f01d` fails initial iPhone composition admission
and the iPad Profile-frame lookup. The harness now returns through authored Chat
before admission and locates the actual Profile dialog across WebKit's accessible
container types; neither correction is a physical pass until rerun. The product
remained `523d016849` during those runner-only checks. No account reset or sign-out
was performed. The merged source has canonical `ui:doctor` and UI-contract commands;
regeneration and generator checks use its committed `main` merge base.

`components/profile/profile-menu-model.ts` now authors the roster, labels and
availability for both renderers. Callbacks remain in the Profile workspace;
the projection carries no executable action, URL or credential. Existing Legal
readers reuse the same entries. Capability icon colors are shared with the React
registry; native glyphs remain SF Symbol counterparts, not identical Phosphor art.
NativeDrawers v1 negotiates `profileMenuRows` before sending its bounded color,
chevron and trailing-label extensions. No authority or renderer-admission default
is changed. Independently reverting this follow-up restores the prior roster.

The native menu matches the existing 16-point row inset, 32-point leading well,
28-point glyph, 12-point gap, 18-point group radius and 56-point row minimum.
Dynamic Type may grow rows. Legal rows previously bypassed the web height rule
because their test IDs differ; row-semantic CSS now applies the rule and aligns
separators to the text column. Production-CSS browser regression fails at all
four widths with the old selector (49px minimum), rather than merely inspecting
source strings. The prior S24 mounted-root measurements were offscreen intrinsic
geometry, not visible-root acceptance; its warm owner/document/draft and Chat
position were restored without install, unlock or mutation.

The first intermediate export was terminated after source refinements and is not
installation evidence. Physical receipts must identify the rebuilt follow-up,
not reuse the earlier `6e77827fe6` Profile/Chat acceptance below. Native photo and
provider identity still use a generic fallback; no photo parity is claimed.

Committed follow-up `0e8bbaeb4d` passes canonical core, 165 focused JavaScript
cases, typecheck, eight production-CSS layout cases and 64 Simulator native
support cases. Its iPhone 16e Debug/UAT build `com.hushh.app` 1.4.0 (69),
executable SHA-256 `af66a025a3265d3eecef48c2aaade23491d041690203537b1f173960dd20228c`,
passes the separate normal unlock and nine Profile destinations, including
nested settings and native Back. This does not replace the integrated gate:
the subsequent warm Chat run fails its first History opening despite an
accessible, hittable opener. The finite choice diagnostic now distinguishes
native emission, local refusal and confirmation without logging identities,
editor content or raw errors; it does not relax fences or replay a tap.

The same committed follow-up is installed on S24 Ultra as production-pointing
`com.hussh.app` 1.3.9 (2), APK SHA-256
`40c90ecf06c21afd4912324430e671deaca9886f84abb558de730ef4c2027d5b`.
Normal passphrase unlock and the nine-destination Profile journey pass, with
ten visible rows checked against the shared geometry. Owner, document, process
and draft survive; no provider operation or account change occurs. The harness
uses active stack state, not existence of intentionally retained inactive
screens, and waits for hit admission before one touch rather than retrying an
uncertain action. These are functional/geometry receipts, not visual or
accessibility acceptance of every route.

Native export preparation must serialize with same-worktree web compilation.
In the locked Next.js version, a custom `distDir` selects static-export output
but the build resets its compiler directory to `.next`. It is not an isolated
cache. The canonical cache-clear plus fresh packaged-CSS check caught and
corrected missing Profile selectors before installation; do not bypass that
check or run simultaneous exports/dev builds in this worktree.

The first diagnostic Debug/UAT candidate was `com.hushh.app` 1.4.0 (69),
executable SHA-256 `80de429b8469eba4ddc2e0f3c6290d226a14a0329192938ca2a4fe61c27574bf`.
Signature, packaged assets and installation pass. Credential-free XCTest admission
and a separate normal passphrase unlock pass without sign-out or reset; credential
diagnostics were removed. The integrated warm journey reaches native History,
Profile and Preferences but fails detail Back admission before completing a cycle.
The earlier Profile-row lookup failure used a wrong display label; the harness now
uses the authored opaque row identifier. Neither failed run is acceptance.

The detail handoff has a reproduced focus race: Radix's initial autofocus captures
the temporary DOM Back, which deliberately prevents native admission. The bounded
feature page now focuses its heading instead and leaves return focus to the native
menu. The nearest regression fails without that fix and passes with it; 158 focused
JavaScript cases pass. That change alone did not fix physical admission.
Initial modal focus must never pin a native-bound fallback control to the web.

The opt-in, privacy-fenced native reader then measured the real destination Back:
44 by 44 points, not focused or inert, but its top was -172 points. Packaged CSS
confirmed production optimization dropped the feature page's `translate: none`
override while Dialog's negative centering utilities remained. The page now
overrides those utilities on the element with `translate-x-0 translate-y-0`.
The nearest browser layout regression renders the real feature page/Dialog with
production-optimized CSS; portrait/landscape checks and a broken-centering negative
control pass in Chromium and WebKit (12 focused layout cases). The corrected
Debug/UAT executable `dc0b1ef9147a1de26831f54db9f96f507f48afc0c3c27e6f9ca54d232445a6f2`
is signed, asset-verified and installed. Its attach-only product journey reaches
History, Profile, Preferences and the native Back return, then fails at Puppy
entry before completing the first cycle. This is not a ten-cycle acceptance.

The test had assumed selecting Puppy immediately supplied a conversation port;
the actual product requires its authored `Start a Puppy chat` entry when none
exists. Qualification now takes that process-only entry once, submits no turn,
and waits for both the selected agent and the applied editor's authored public
label. NativeDock v1 accepts optional `Message One` / `Message Puppy` accessibility
metadata without deriving meaning from a private context or replacing the editor.
The retained-editor regression and all 62 native support cases pass on Simulator.
On the committed source candidate, the actual integrated product journey now
passes all ten warm cycles through History (including cancelled closing drags),
Profile, Preferences, native Back and One/Puppy. A separate keyboard check passes:
History remains usable while editing; opening it resigns editing without losing
the draft, and closing it does not summon the keyboard. One WebView and one
interactive native composer are asserted; no turn is submitted or account reset.

That attach-only receipt is 1 passed, 0 failed, 0 skipped on iPhone 16e. The signed
Debug/UAT product is `com.hushh.app` 1.4.0 (69), executable SHA-256
`5d5cb0b499bfd339989696878d6d7dd92c12705f165952124f3d9844dd015080`;
test executable SHA-256
`f4deda64c963062fd5571165315e5814d2f72fd822231222ceafe793472ff7da`.
Packaged product assets and production-optimized native CSS pass verification.
Credential-free automation admission and the separate normal reviewer unlock
each pass; private credential-run and warm-run diagnostics are removed. These
are functional receipts, not transition-frame, accessibility or Release hitch
acceptance, and they do not qualify first-reveal or aggregate failure fallback.

Canonical core at `57b9e39ecb` stops in protocol: 9,804 passed, 98 skipped, one
mocked Drive worker rollback subprocess exceeds its existing 20-second deadline.
The same focused 15-case release/rollback suite passes separately; the missing-log
case takes 13.21 seconds. Preserve the failed core result while investigating
fixture startup cost; do not raise the deadline or count the focused pass as core.
The test-only timestamp parser now avoids `strptime`'s repeated import path while
retaining quoting and exact timestamp round-trip checks. All 18 focused cases
pass, including malformed timestamp negatives and an explicit 55-read count for
each missing/wrong-URL case. Production retry and deadline logic are unchanged.
Timing under the concurrent host load does not yet prove sufficient core margin.
The redundant exhaustive RCA run was cancelled after discovering concurrent
core work in other worktrees. Those runs and unrelated applications are untouched.

React edge-opening gestures are disabled only for the coherent native family,
not for every iOS wrapper. The established recovery/older-wrapper gestures remain
available; both focused gesture suites and competing-renderer negative controls
pass (20 cases). These are behavior contracts, not native visual acceptance.

The opt-in native admission reader samples only authored Back presence, geometry,
focus/inert flags and whitelisted stage/refusal enums. It reads no protected body,
account, draft, URL or operation payload and is unavailable outside Debug. Its
sampling configuration is diagnostic, not a physical Release performance receipt.

The authored overlay audit confirms that Chat's Connectors destination already
reuses Profile query/Back ownership. The follow-up candidate below gives pending/
sent attachment editors and the existing Drive activity/detail owner bounded
full-page envelopes. Native History does not auto-prepare a new Drive review
merely to implement its footer. Profile root photo and the existing
development-gated tools entry remain separate parity gaps.

Native Dock withdrawal also records a revision tombstone before its first apply;
delayed admission cannot resurrect a cancelled replica or detach its successor.
This closes a source-confirmed cancellation gap, not aggregate shell recovery.

The independent native architecture review identifies the bounded missing
composition gate: one ledger in `NativePresentationContainer`, sealing Chat's
History opener, One/Puppy selector, Dock, bottom navigation and closed prepared
History/Profile controllers against the same document, opaque owner, privacy,
generation and viewport. Native plugins must record actual layout/installation
before one main-actor reveal; forwarding family receipts is not readiness.
Aggregate retirement must withdraw all registered slots, drawers and owned
popups before restoring the coherent React family. This extension is **not yet
implemented**; independent family recovery must not be promoted as that contract.

Branch governance also needs reconciliation before push: its package lacks
`ui:doctor`, `build:ui-contracts`, `verify:ui-contracts`, the contributor scaffold
and `backVerification`. Use the actual route/voice generators and behavioral
checks for source validation; do not invent aliases or describe them as resolving
the missing canonical governance. No merge, UAT dispatch or distribution is
authorized by these local receipts.

### Route retirement and History follow-up — 2026-10-12

Source `6e77827fe6` includes the independently reversible handoff fix
`7b83af7ce1`. Covered mounted controls retain their native hosts; an ineligible
route or actual React unmount now retires its exact installation. The former
suspend path intentionally withdrew touch/accessibility without removing visible
pixels, explaining Chat's History and One/Puppy controls leaking onto other routes.
Suspension is not route-owner retirement.

The same bounded feature-page adapter now owns attachment and Drive envelopes.
Each feature authors its interaction layer and Back callback. No native action
is inferred from DOM or private content. Drive retains its existing loading,
owner fencing and review callback; detail Back returns to activity before History.
Attachment resend awaits guarded submission admission, preserves refused edits,
deduplicates pending actions and rejects stale completions after reopen/owner
changes. Normal web/Android/unqualified presentations are unchanged.

Physical source `81f7f6a09a` reproduces and fixes a 17-point Close displacement:
the authored header reserve was 64 points while UIKit's top safe area was 47.
History now obtains the installed hamburger's frame from its existing container,
not a guessed device offset. The physical warm test measures both controls at
(16, 72), with 44-point hit regions, and passes ten cycles, keyboard continuity,
More edge taps and the route-retirement ledger (1 passed, 0 failed, 0 skipped).
This receipt predates the new system More menu and does not qualify that menu.

History's leading circular Close shares the hamburger's actual 44-point seat.
Its List buttons explicitly use independent borderless action ownership, including
the 44-point More label hit area. Chat ages use a quiet single-line secondary
caption rather than a wide trailing column; compact insets apply only to History.
Search uses standard native editing inside one regular glass capsule on iOS 26+,
with the existing material fallback on older versions. Profile row insets remain
unchanged.

Typecheck, 194 focused JavaScript tests, static/plugin contracts, design/render
source checks, production mobile export, signed native build and packaged assets
pass. The attach-only test exercises edge taps on More without saving or
deleting a chat, leading-seat alignment and Chat → One/Connect/Feed → Chat. It
checks the native install/removal ledger as well as AX withdrawal: the broken
suspend path would pass an AX-only absence check.

The follow-up native More trigger is a standard UIButton/UIMenu embedded in the
SwiftUI row. Rename/Delete use icons and an anchored system presentation; the
existing confirmed operation callbacks remain authoritative. Retirement waits
for UIKit's menu disappearance completion before detaching the drawer or releasing
its privacy-retirement token. Expired projection choices cannot open a replacement
editor. All 63 native support tests pass, including a pending-menu negative control.

The physical menu-delivery regression is distinct from popup retirement. UIKit's
menu was visible, its covered Close was correctly noninteractive, and selecting
Rename finished dismissal but failed the exact update-sequence fence. A temporary
enum-only Debug probe measured that rejection and was then removed. The
representable child held the model as an unobserved reference, allowing unchanged
rows to retain UIAction closures from an earlier applied projection. Source
`6e77827fe6` observes the retained model so bindings refresh; the stale-choice fence
is unchanged. The existing warm test uses the menu's actual accessibility label
across roles, selects Rename and cancels without mutating a chat. Its physical
rerun passes: ten warm History/Profile/Preferences/One-Puppy cycles, held/cancelled
drawer closing drags, actual Rename-to-Cancel delivery, keyboard continuity and
Chat-only host retirement on One/Connect/Feed. Both the native installation ledger
and AX eligibility are checked; drafts and one WebView/editor survive. The receipt
is 1 passed, 0 failed, 0 skipped with no turn submission, sign-out or reset.

That exact installed source `6e77827fe6` remains Debug/UAT `com.hushh.app`
1.4.0 (69), executable SHA-256
`1e7dc70ab028b20bc113e4c00ac9ea1d14bd84dd6af9e990acb270318203c48c`;
runner SHA-256 `6ea3f3ac8338536eac23034d7c8ddcc9f336574393149a6460a130f87b689227`.
Its packaged index and UAT runtime-contract hashes are unchanged from the Profile
batch below. Signature and actual packaged assets pass. Installation/preparation
and normal passphrase unlock are separate from the attach-only journey; diagnostic
artifacts are removed. This proves functional continuity, not complete rendered
transition, accessibility or physical Release performance acceptance.

Profile's shared full-page envelope declares its scroll owner. The existing stack
retains nested screens and restores their own position rather than consulting a
global, possibly exiting pane. Its regression verifies that neither background
Chat nor a retained web pane receives those scroll writes. The physical harness
batches the nine authored menu destinations plus Gemini, Voice and Vault methods;
it does not assume legacy Account access is a reachable Security row. WebView count
is checked while detail content owns accessibility, not while the native menu
correctly hides the covered WebView. A native-menu AX absence is not host teardown.

On source `400ee3e8ae`, the installed Debug/UAT iPhone candidate passes that
attach-only Profile batch: nine destinations, all three nested paths, native Back
and return to the original Chat draft (1 passed, 0 failed, 0 skipped). It submits
no setting, support, connector or vault operation. The exact installed product is
`com.hushh.app` 1.4.0 (69), executable SHA-256
`696d6778ef22231c03174a4f069b5a304a2b90af2ddf8017ca64c9aea5e1959d`;
runner SHA-256 `7e8a15c65d5cbc99573ed02712a663522108ad04e197e7f9c33586e228f6a349`;
packaged index SHA-256 `3e0a706d3ddb5c1e9768b82e00ddda36c053a4871e80d1593da3d465c6e70954`.
The existing runtime contract remains UAT, SHA-256
`aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69`.
Signed build, packaged assets and normal passphrase unlock pass separately.
Credential and warm-run diagnostics are removed. This is functional/Back evidence,
not a claim of complete visual, accessibility or Release performance acceptance.

Cross-platform app feedback uses additive HushhSettings capability/feedback methods.
NativeChrome v2 remains the iOS compatibility entrypoint, sharing one deduplication
ledger. Each cue is document/privacy-bound, expires after 250ms, and never retries
an uncertain result. JavaScript captures lifecycle admission before discovery;
interrupted discovery cannot vibrate in a newly resumed session. Shared finite
controls and switches cue changed user choices only; navigation emits from the
accepted intent, with the DOM navbar opted out to avoid duplication. Explicit
disabled preferences win once during migration on both platforms; subsequent
native Settings is authoritative. System feedback is not an app preference.
Android's six focused admission/migration tests pass, as do the nearest JavaScript
privacy, control and navigation contracts. Physical tactile acceptance is separate.

S24 Ultra wireless ADB and its existing pre-install warm continuity harness pass
without restarting the app. The subsequent isolated production export at source
`400ee3e8ae` builds and installs `com.hussh.app` with one preserving `install -r`
and one preparation launch. APK SHA-256:
`dbfdc5071dda4ba2d247a6f7713cfad18aa271f0c495095b2b048726ae71ba40`.
Installed signer/hash, production backend/Firebase and unchanged signed-in owner
are verified; Settings reports `interactionFeedback: true`. Android preparation
cannot copy iPhone UAT assets. Its current owner differs from the canonical
reviewer; the user separately authorized normal passphrase unlock of that existing
device account. One normal passphrase submission reaches protected Chat with full
input delivery, the same owner and app process preserved. The canonical reviewer
match remains false. The subsequent warm comparison stops at a Profile harness
locator; correcting that split-row assumption completes 18 functional checks
without another install or unlock. Profile Preferences/Voice/Back/Close, restored
theme and switch values, disabled-toggle blocking, response shapes and warm
owner/document/process continuity pass. Feedback parity does not: four no-feedback
checks match, eight expected feedback checks do not, and no UI feedback request
reaches the bridge. Tactile and duplicate-system acceptance remain unqualified.
Preferences and Chat are restored; observers and owned ADB forwards are removed.
No reviewer fixture, identity or stored credential is changed to make it pass.

Source `a81acbc7f6` fixes a shared observation gap: a checked native privacy-release
result previously returned without updating the feedback admission cache. Neither
native host requires a release listener event. The bridge now observes the confirmed
result only in its unchanged lifecycle epoch and advances that epoch to reject
earlier reads. It neither validates an account nor releases a native cover itself.
The old code fails both platform regressions; 52 focused privacy/auth/control/
navigation cases pass with the correction, including a late completion that must
not overwrite a newer inactive event. Typecheck, focused lint and native plugin/
static contracts pass. The isolated production Android export and APK build pass;
the exact replacement APK SHA-256 is
`1fa9dd2467ef6a6425252e93c7535bf597d6537fa1db28b4d8722bee8d342e92`.
Parent readback independently matches the installed device `base.apk`. Preparation
uses one preserving install, one launch and one normal passphrase unlock; the
existing account matches in memory and the canonical reviewer match remains false.
The separate warm comparison uses no install, launch or unlock: 36 assertions and
21 feedback-count checks pass. Fifteen authored UI requests produce thirteen
native acceptances and two expected haptics-off refusals. Changed choices cue once;
unchanged/disabled choices do not, and native duplicate/stale/document/privacy
negatives pass. Settings and Chat are restored, helpers exit and owned observers/
forwards are removed. Other sessions' Chrome forwards remain untouched. This
proves functional feedback admission, not tactile feel or duplicate system cues.

Local core at `9e9eea6385` is not green: its backend manifest ends with 9,805
passed, 98 skipped and three failures. Two Drive rollback cases exceed the existing
20-second subprocess bound; the unchanged focused Drive/lifecycle batch passes
25 cases in 84.31 seconds. This does not waive the full-core failure. The third
failure is a lifecycle fixture reading a card after a fixed 300ms sleep. Source
`013cab65b3` waits for actual frame delivery with a bounded event and adds delayed
authentication to the existing reset case. The original synchronization fails
that negative control; the corrected eight lifecycle cases pass twice. Production
reset/deletion authority, scheduler retries, rollback assertions and timeouts are
unchanged. No exact-head core/CI or release qualification is established.

Native release also requires resolving the pinned Capacitor 8.3.1 dependency's
critical [navigation advisory](https://github.com/ionic-team/capacitor/security/advisories/GHSA-rvm3-566m-v7fv).
The affected internal proxy can load remote content with the app origin's trust;
disabling CapacitorHttp alone is not a mitigation. A patched dependency requires
new builds and qualification. Functional UI receipts are not security approval.

The existing parity-report validator still fails: the committed iOS report has
13 result rows for 102 native-required inventory entries, a failed route and
inconsistent summary totals. Android coverage is also incomplete. Do not inflate
coverage, infer route acceptance from this focused journey, or weaken the report
gate. Normal custom-native admission and release qualification remain disabled.

### History leading slot and native selector study — 2026-10-11

Chat and the portalled React History now share root-owned header row, safe-area
and leading-gutter tokens. Open and Close use the same circular 44px shared
surface and glyph family; Close stays inside the translating drawer. Ages flow
beside chat titles instead of reserving a second trailing column. Full-height
motion, scrim, focus return and operation owners are unchanged.

The native History header also has a leading circular Close. The isolated
public native study reuses the product One/Puppy selector and retained Dock;
synthetic selections have no routing or submission authority. Its fixture is
not product Chat acceptance. Custom native product controls remain disabled:
the unchanged React Profile cannot paint above foreground native Chat controls
inside the same WebView. Host retention alone does not solve this overlap.

Focused behavior (161 tests), typecheck, lint, design/performance-source, plugin
parity, generated gateway/Siri/route-index/surface-map checks and the signed
Debug iPhone build pass. All 28 focused Chromium/WebKit checks cover the actual
Open/Close controls, full-panel motion, compact ages and safe-area geometry. A negative
control using `759ae0cfd8` fails leading-slot alignment by 266 CSS px. The
abandoned stationary-header test assumptions were corrected to require the
header to move with the entire panel; no gesture or isolation gate was removed.

This branch lacks `ui:doctor`, `build:ui-contracts` and `verify:ui-contracts`.
Their failed invocation is a release-governance gap, not a green check. The
available authored action/route projections pass without changing operations.
The installed iPhone product includes `a6aec50e7e`, `852e263929` and
`c05437b746`, bundled UAT as `com.hushh.app` 1.4.0 (69). Executable SHA-256:
`064bd0f38c5ccb7e754883c7672ebddc4986c47c0e1d4e0a796d50b888c2f921`.
The runtime contract remains
`aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69`.
Authenticated Wi-Fi transport, installation and signature/assets verification
pass on iPhone 16e / iOS 27.2. Four exported **public-only** appearance captures
show readable circular chrome, the actual icon-only native selector and one
content-backed glass Dock in Light/Blue, Light/Gold, Dark/Blue and Dark/Gold.
These are settled-frame visual checks, not complete transition acceptance.

The combined public composition case failed with a generic retained diagnostic;
its exact assertion was not preserved. The appearance-only run was stopped after
12 minutes without visible theme progression. Neither result qualifies a family.
`3b3a3c00b5` separates ten selector cycles from ten drawer cycles, scopes public
queries to the owned fixture and reuses the same attach-only admission helper.
No timeout, cycle count, isolation assertion or performance gate is loosened.
The separated selector run progressed through only one cycle before cancellation
at 14 minutes; preserve that outcome as incomplete, not an authorization failure.

The opaque public study now uses owned `.fullScreen` presentation rather than
`.overFullScreen`. Its material backdrop is wholly native; it does not need the
covered WK views. UIKit documents that fullscreen removes covered views after
presentation, whereas over-fullscreen retains them ([Apple fullscreen contract](https://developer.apple.com/documentation/uikit/uimodalpresentationstyle/fullscreen),
[over-fullscreen contract](https://developer.apple.com/documentation/uikit/uimodalpresentationstyle/overfullscreen)).
The app controller/document remains retained. This is fixture isolation, not a
solution to product Chat's foreground-native/React-Profile overlap.

Physical, attach-only public qualification after that change:

| Case | Evidence | Limit |
| --- | --- | --- |
| One/Puppy selector | Ten change/return pairs pass; one native editor and Unicode draft retained; Send remains read-only | Executable `3dc462…`, before the public Reset action additionally resigned the keyboard; no product routing/submission authority |
| History composition | Ten cycles pass, including edge/held drags; leading Open/Close geometry within 1pt; retained dock/editor, multiline cap and keyboard return | Final executable above; public composition only |
| Appearance | Four light/dark/accent states pass; four public-only PNGs reviewed | Final executable above; VoiceOver, Dynamic Type, rotation and reduced-transparency coverage were not run |

The last two cases pass together on the final executable (2 passed, 0 failed,
0 skipped); the selector case separately passes (1 passed, 0 failed, 0 skipped).
The composition records 485 display-link callbacks over 7,771.7ms, maximum
interval 19.82ms and zero intervals over 50ms. This measures callback cadence,
**not rendered hitch ratio** or the required three physical Release runs.
The fullscreen isolation improvement is verified; the earlier delay's complete
RCA is not, because the original presentation was not rerun under identical
preparation conditions as a negative control.

The phone was returned to normal product configuration after the public study.
Credential-free XCTest admission passed; a separate normal passphrase unlock
passed with process-only reviewer credentials and no account reset/sign-out.
The final executable then passed ten warm **shared React Chat** cycles through
One/Puppy selection, Profile edge taps/open/close, software-keyboard layout,
draft preservation and One/Chat mode return (1 passed, 0 failed, 0 skipped; no
turn submitted). The existing WebView frame and single-composer contract hold.
A local wrapper flag initially selected the broader recovery batch instead;
that run was canceled, its temporary diagnostics removed, and its selection
precedence corrected before the requested named case passed. It is not counted
as a completed batch or native-glass proof. The phone remains on normal Chat.

Product custom-glass policy and release promotion remain off. Native Profile's
whole overlapping presentation, physical accessibility/performance acceptance,
canonical core at the new head and exact-head CI are still required. The prior
core receipt below belongs only to its recorded historical SHA.

### Shared Chat control recovery — 2026-10-11

The shell now retains the composer seat independently of the selected command
or Live voice owner. Cloud and local Puppy project their existing, separate drafts and
send callbacks into that one Agent Bar. Remote Puppy retains its admitted-pod
composer and suppresses the cloud launcher; no transcript, credential or operation
authority is shared. The common finite selector owns the Cloud/Puppy sliding
thumb and 44px targets. Send/Mic keep compact paint inside 44px hit regions;
multiline fields scroll at a bounded height without a second entrance fade.
Native attachment Edit opens the existing attachment editor instead of replacing
the accompanying message. Puppy cannot submit unfinished IME composition.
Inactive or drawer-covered Puppy editors reject queued submission. Authored
Send/Stop roles share compact accent paint; Mic retains the same 44px target.
The keyboard lift starts only in actual keyboard state: shell admission's
temporary zero navigation height no longer starts a spurious lift animation.

The custom native Dock/header/selector policy remains disabled. A foreground
native Chat family cannot remain visibly behind a full-height React Profile
without another coherent overlap implementation. Conceal/reveal or per-frame
bridge clipping is not accepted as continuity. Native bottom navigation and
the independent Debug native History qualification remain unchanged.

Focused behavior, typecheck, design/performance-source and generated gateway,
Siri, route-index and surface-map checks pass. The retained-seat negative control
fails on the previous voice-owner replacement. The existing layout regression
also failed on the unguarded lift; after correction, three runs in each of
WebKit and Chromium retain the same frame within 0.5 CSS px at 320/393/768px,
with bounded multiline editing, 16px icons, 44px targets and keyboard return.
Canonical core passes at `0d5e472e6c`, including the packed MCP smoke, without
changing timeouts or weakening gates. The signed Debug iPhone and simulator
builds compile the new warm-session Chat continuity test. The iPhone 16e has
the `90936adc0f` product/runner installed in place as `com.hushh.app` 1.4.0 (69),
bundled UAT; the later commit changes layout tests only. Executable SHA-256:
`d05aa1c2ff2815f1f422853df6b8e5f67b0700218a5fb31aab65d2e9e313f461`.
The runtime contract remains
`aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69`.

Installation, signature/assets verification and authenticated wireless transport
pass. Earlier attach-only attempts stopped before execution with automation/runner
timeouts. The 2026-10-11 retry now enters XCTest over Wi-Fi. Admission exposed a
harness ordering error: an owned modal legitimately excludes the WebView from
accessibility. Authored dismissal must precede the single-host assertion; no
privacy, unlock or single-WebView assertion is removed. The corrected admission
passes on the already-unlocked Chat without credentials, reset or sign-out.

The installed `90936adc0f` product with rebuilt admission runner (SHA-256
`34e69b48bbdb11f398eb30d4719974484eada05d5b50d178df770fbdba3b5bf9`)
passes ten physical warm-session shared Chat cycles: Cloud/Puppy, Profile
open/close, actual software keyboard, draft return and One/Chat mode continuity.
No turn is submitted. This verifies the **shared React dock**, not custom native
glass. The combined qualification batch separately fails after two native
History cycles: Close does not restore Chat; subsequent navigation/dock checks
cannot reach their base. A separate authored recovery restores the same unlocked
session. Preserve that failure independently of the successful isolated Chat
test. The corrected terminal content-refresh race and installed functional retry
are recorded below.

Simulator guest admission and canonical UAT reviewer preflight are not substitutes
for authenticated physical acceptance. Earlier evidence below applies only to
its recorded candidate. Full visual/accessibility/performance acceptance,
exact-head CI and native-family qualification remain unproven.

### Whole native drawer migration boundary — 2026-10-11

The selected direction is now complete native History and Profile presentations
on supported iPhones, including their moving headers, bodies, scrims and nested
interaction layers. React retains routing, settings, security and operation
authority. This replaces the earlier restriction to a synthetic History study;
it does **not** establish product admission or device acceptance.

The first reversible boundary is implemented on top of `e5ad899659`:

| Boundary | Current source | Acceptance |
| --- | --- | --- |
| Private presentation | Separate `HushhNativeDrawers` v1; bounded in-memory row projections, opaque action handles and one shared auth/vault owner generation | Bridge contract and host tests; no credentials or protected bodies in public NativeChrome metadata |
| Whole drawer owner | Retained UIKit/SwiftUI child, native scrim, cancellation/regrab and local settlement | No React frame-pose or clipping messages; closed preparation does not intercept the page |
| Covered base controls | Remain mounted/materially visible; touch and accessibility isolated locally | Pending Chrome/Dock/Nav choices are invalidated across isolation cycles, including every post-await dispatch; uncover requests fresh same-host admission |
| Failure/privacy retirement | Immediate targeted withdrawal, cancelled-admission tombstones and confirmed absence | Private snapshots/callbacks clear; listener cleanup cannot delay withdrawal; uncertain operations never replay; public-only isolation observer survives uncertain withdrawal until document retirement |
| Product authority identity | Existing validated Auth owner and vault epoch; opaque shared owner ID and monotonically increasing family leases | No account ID, token, key or route-derived authority is sent as owner metadata |
| Actual History port | Existing workspace callbacks, owner-bound rows, activity grouping, search, inline rename and deletion confirmation | Ten warm native-renderer cycles pass on the physical iPhone at `2d876c42c2`; Debug qualification only; Drive nested review, footer handoff and closed-body opening gesture remain parity gaps |
| Actual Profile port | Not connected yet | Settings/forms and protected nested layers remain in the coherent React pane |

The new boundary is **qualification-only**, using a separate Debug composition
switch. Normal builds keep the stable recovery; old experimental custom-control
flags remain rejected. The new switch must not be treated as complete product
parity: it currently prepares action rows, not the entire Profile feature set.
Installation and physical qualification are recorded separately below; this
source boundary alone changes no installed product. iPad remains unqualified.

History handles are stable across activity reordering and scoped by agent surface.
Admission compares the validated auth UID with the feature owner; loaded rows
retain their originating auth/vault epoch. Unchanged semantic projections refresh
callbacks in memory without replacing hosts or invalidating a confirmed action.
Row operations settle explicitly by confirmed sequence and privacy generation;
refreshing a label is not completion. Failed renames preserve their draft, stale
settlements cannot clear a newer editor, and no operation is automatically retried.
Deletion retains unsent text/attachments until server commitment; empty chats
still switch immediately. Completion signals and row changes remain owner-fenced.

The 2026-10-11 correction negotiates `terminalRefreshes` without changing the
private contract version. Only emitted Open/Close intents survive uninterrupted
content/theme updates with the same identity, privacy, enabled and authored open
state. Their native pose and original five-second deadline remain intact. Row/Back
and older wrappers stay strictly update-bound. Exact emitted tokens, interaction
generations and one-shot consumption remain mandatory; an open/closed/reopened
boundary invalidates the older intent. Late positive or negative acknowledgements
cannot retire the superseding drawer. No operation is replayed.

The pre-fix JavaScript regression fails on the dropped Close. After correction,
137 bridge tests, 61 simulator native support tests, full lint and typecheck pass.
The native regression keeps the same host and restores WebView touch/accessibility
only after authored closed-state acknowledgement; privacy, owner, drag and
close/reopen negative cases reject the old token.

The corrected `2d876c42c2` bundled-UAT Debug product is installed in place on the
iPhone 16e as `com.hushh.app` 1.4.0 (69), iOS 27.2. Executable SHA-256:
`8b35953167ce916ce48ca49c75c479e4209608851dc4679e7de7ca83cc4358ba`.
The physical batch uses runner SHA-256
`31f7ba2c6dfca8ceec8749e4121e39a11f30945f483b894173fef5ebfda4bc14`.
Authenticated `localNetwork` transport and actual XCTest entry pass. After
installation, normal passphrase Unlock completes once and protected Chat is
admitted; no account reset or sign-out is performed. The subsequent attach-only
batch passes all three tests with zero failures/skips: ten actual native History
cycles including edge taps and partial held drags, native navigation including
Search/overlay isolation, and ten shared Chat/Profile/Cloud-Puppy cycles including
the real keyboard, an unsent draft and One/Chat return. No turn is submitted.
History restores its base and remains full-height; one identified WebView and
the draft survive. Preserve the earlier failed batch as regression evidence.

Credential-free secure-field characterization also exposes intermittent bulk
input delivery (six of eight public sample characters), including application-
level typing. This is not a rejected credential. The explicit existing software-
key mode acknowledges the full entry and submits the normal cryptographic
Unlock once; no mode fallback or operation replay occurs inside that run.
Credentials remain process-only and result bundles are removed. Field-directed
private typing remains the default; application-level typing is confined to the
public diagnostic. Keyboard/empty-field admission, current reviewer and privacy
are rechecked without exposing values. Do not relock the warm session merely to
repeat this characterization.

The final safety-reviewed runner compiles and is installed with SHA-256
`38a39d51906d3913f270fa8254bc620036cfe9c022f417abb661798bab6714cc`.
Its credential-free attach-only admission passes (one test, zero failures/skips)
with protected Chat still unlocked. Private targets are scoped to the unique
identified WebView, and the current account label must be hittable before entry
and submission. These final guard additions have static-review/build evidence;
the warm session was deliberately not relocked to exercise private entry again.
Founder Wiki freshness was not established in this retry; no Wiki update was made.

These are installed functional/continuity results, not visual frame, VoiceOver,
Dynamic Type, material or physical Release performance acceptance. Custom native
Dock/header/selector policy stays disabled; the successful Chat dock remains
React. Native History remains Debug qualification-only, and iPad is unqualified.
No push, merge, UAT deployment or distribution is established by this retry.

The wrapper installs public qualification metadata at document start using
Capacitor's supported `webView(with:configuration:)` hook. Normal/older wrappers choose
React before discovery, rather than briefly withholding the web History while
waiting for an unsupported capability receipt. This metadata is only renderer
selection; native capability, owner, lease and privacy checks remain mandatory.

The real-app test initially rejected the candidate at `22d806fb75`: History was
React, not native. The installed Capacitor source replaces `userContentController`
after `webViewConfiguration`, discarding scripts registered there. The bootstrap
now targets the final controller before WKWebView creation. The nearest host
regression fails on the old hook and passes on the corrected hook; the physical
native-renderer test then passes. A mocked eligibility check alone missed this.

Focused verification: 171 bridge/navigation/sidebar tests, two plugin-checker
tests, 60 host-native support tests, typecheck, Debug test compilation, signed
physical Release study build, native plugin/static
parity and design-system/performance-source checks pass. These are
functional/contract checks, not physical glass, transition, accessibility or
frame-performance acceptance. Further source changes require refreshed evidence.

The private contract rejects undeclared fields on both sides. Capability catch-up
is bounded at the observer owner, and no body is published before all listeners
are ready. Old confirmation/activation failures cannot withdraw newer bindings or
reverse confirmed retirement. The coherent composition does not advertise or call
the superseded reserved-region protocol. NativeChrome remains version 2.

Product integration must publish real rows while closed, retain existing feature
owners and revalidate current auth/vault/readiness after every awaited choice.
Withdraw private native replicas independently of retained React descendants on
owner, lock or verification transitions. Bind loaded rows to their originating
owner/epoch; do not relabel an old asynchronous history result with a new owner.
Geometry, icons, keyboard/IME transitions and every nested layer require explicit
parity before the complete family is enabled. No per-frame coordination with a
React drawer or DOM-inferred action binding is permitted.

The ADK copy lacks the newer `ui:doctor` package entry. Running the canonical
current validator against this worktree exposed pre-existing Back/Search authoring
drift and missing validator mutation-test sources. Surface map, action gateway,
Siri and route-orchestration checks pass. Resolve that branch/tooling gap without
weakening the gate before release. Canonical core passes at `1ec4e93d67` using
its supported serial setting, with unchanged test timeouts. Exact-head CI, Admin
SOP, deployment and distribution remain separate, unproven transitions.

### Installed native History qualification — 2026-10-11

The physical iPhone 16e/iOS 27.2 runs Debug `com.hushh.app` 1.4.0 (69), bundled
UAT, with the explicit product-drawers qualification switch. Native source:
`1ec4e93d67`; exported web and runner build: `1ec4e93d67`; UI test body:
`3bba249eea`. Executable:
`1bef59cd4991b3fadde350ea53be68a624b9941f3b03301aa3fd756025156a21`;
packaged index: `4990c0095c31afe7d661101f5a7b118f6cb0557e79c70ee26cc68e6154040e0d`;
runtime contract: `aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69`.
Installation/signature/assets verification and attach-only testing were separate.
XCTest ran over authenticated Wi-Fi; no account reset or sign-out was used.
Normal owner-checked passphrase unlock passed using the explicit software-key
path. Whole-value XCTest entry lacked an insertion receipt and was never
submitted; this candidate does not qualify that input path. Preparation selected
passphrase without reset or automatic sign-in. Credential-run bundles were erased.

`testLocalSessionNativeProductHistoryKeepsOwnerAndSingleHost` completed ten warm
cycles with zero failures/skips on both `e396057bd9` and the final installed
`1ec4e93d67`. It requires the native drawer and search field,
rejects an interactive React duplicate, tests edge taps and held partial closing
drags, and checks full-height geometry, one identified WebView, unchanged host
frame, draft preservation and continued vault admission. These are functional and
sampled-geometry checks, not exact JavaScript/editor object identity or a rendered
transition recording. No rename/deletion or other fixture mutation was inferred.

The final installed candidate also passed the warm Mail pager/software-keyboard,
native bottom-tab/overlay and seven-screen nested Profile Back journeys. Profile
coverage includes Account, Preferences, Vault methods, Trusted devices, Connectors,
Referrals and Support; the three Support choices returned to their original state
without submitting a report. A final credential-free admission check returned to
unlocked Chat. These are real React/native parity journeys, not a native Profile
port. Private result bundles were erased; the phone was left in its warm session.
Capacitor bridge logging is disabled in both source and packaged configuration,
including Debug, so private titles and edit choices are not console diagnostics.

The separate public Release study at `ddded99038` (runner `3bba249eea`) passed
composition/editor and four-state appearance/accessibility checks on this phone.
Its executable was `cc30d9066c2655a16f34f518c26ed168d7c1a6c78f0fbb94a331b2e7d5b76fde`.
Public Light/Blue and Dark/Gold captures show readable glass sampling the colored
backdrop, not painted black controls. A display-link sample recorded 184 callbacks,
maximum interval 19.525 ms and none above 50 ms. Three XCTest iterations returned
zero hitches but also zero rendered-frame counts despite positive frame rates;
those metrics do **not** establish the rendered performance gate. The study does
not qualify product Dock/Header/Profile, VoiceOver navigation, IME/attachments,
system transparency settings, iPad, or release distribution.

**Enablement:** native History remains an explicit Debug qualification. The
normal product keeps its stable React custom controls and native bottom bar.
Complete overlapping-family parity and physical visual/performance acceptance
before enabling additional native controls; no historical clipping flag is reopened.

### Recovery default — 2026-10-09

Recovery baseline: `09d51746465e552c622b51cf3f7ec467d976f4f9`.
This section supersedes the experimental adoption claims below. Those sections
are historical evidence and rollback context, not current renderer acceptance.

`native-presentation-policy.ts` selects shared React custom controls before
discovery/first paint. `HushhNativePresentationPolicy` independently rejects old
Debug admission flags in the wrapper. Both boundaries are deliberately closed:
an older wrapper cannot turn the recovery web bundle into the experimental UI,
and an older web bundle cannot activate custom controls in the recovery wrapper.
Reservations, apertures, panel observers and bridge pose streaming are disabled
together. Existing contracts and owner/privacy/stale-choice safeguards remain
available for bounded qualification; NativeChrome stays version 2 and NativeDock
stays a separate version-1 private-editor contract.

| Shared family / reachable states | Recovery renderer and operation owner | Overlap / fallback / rollback |
| --- | --- | --- |
| Five bottom destinations and Search | Standard UITabBar; existing React navigation | Existing modal/keyboard/privacy isolation; web on unsupported wrappers; independent of custom policy |
| Shell Back, History opener, More and utility triggers | Shared React; authored action/Back owners | Profile, History, Search and dialogs; no temporary native replacement |
| Agent Bar, Chat editor, voice/text, expanded editing and attachments | Shared React; existing dock, draft, guarded submission and voice owners | Keyboard and all modal layers; one composer, no native replica |
| Profile, its nested panels, Preferences and photo preview | Full-height React; existing pane/gesture and feature owners | Entire panel including moving header; no stationary portal or native clipping |
| History, search, row menus and confirmations | Full-height React; existing history/gesture and operation owners | Entire moving presentation and scrim; no bridge round-trip in drag path |
| Cloud/Puppy, Appearance and Accent | Shared React; existing controlled value owners | No per-click renderer changes; native selection presentations require independent qualification |
| Independent bounded menus, dates and durations | Existing React unless separately qualified owned system presentation | Dismissal completion, choice/privacy fences and full overlap parity required |
| Connect/Memory/Mail/Finance pagers, rich cards, protected forms and complex multiselects | Shared React; existing feature owners | Inactive panes inert; no native primitive substitution |

Coverage uses `native-route-inventory.json` and the route-layout contract, not a
second route registry: 126 route entries, 102 native-required at this baseline.
Query tabs, Profile panel/detail queries, overlays and legacy/callback boundaries
must be accounted for by the families above. Source coverage is not device proof.
iPad, Android, web and older iOS retain their established fallbacks.
The current join accounts for all 126 inventory entries and 19 additional layout
boundaries (dynamic paths, redirects, callbacks and guarded entry states). Calendar
is explicitly recorded as a parity gap, not permanently web-only; its existing
native Google authorization does not establish a complete workspace rehearsal.

**Qualification boundary:** first install and review the recovery candidate.
Only then prototype a synthetic complete native History body/scrim/gesture plus
dock/header in one hierarchy, retaining React routing and operations. A successful
History prototype does not qualify Profile or rich product screens. No visible
motion may depend on per-frame React/native clipping. Custom native families stay
disabled until visual, interaction, accessibility and performance evidence pass
independently. Re-enable only an admitted whole family, not the historical flags.

Focused recovery verification: 185 cases across lifecycle, navigation, plugin
contracts, Profile navigation and owner-scoped draft continuity pass, as does
typecheck. Restoring the old pre-discovery concealment makes the recovery test
fail; the guard was restored. Design, static performance and native-contract
checks, 51 host-native support cases and the canonical core at `b912ddcf0f`
pass. Later harness/documentation changes require their own final-head core;
these results are not exact-head CI or release acceptance.

### Historical installed recovery — 2026-10-10

The exact replacement product was installed separately from its runner and public
study. Native source is `4524868f66` (compiled from that identical source tree
before its commit), exported web source is `b5fc73b5c6`, Debug 1.4.0 (69),
bundled UAT runtime, iPhone 16e/iOS 27.2. Executable:
`5714db7993da2ec4c69a3e767fdf3a36924377ba414813b8211f8917a322bf99`;
packaged index: `9f1bd2a52f41cc0f4366365b201700c94291ed34bac95e30603936007341da5c`;
runtime contract: `aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69`.
No experimental native-family flags, reviewer bootstrap, reset or cold test route
were enabled. Normal passphrase unlock succeeded once; its credential-run artifacts
were destroyed. Subsequent tests carried no credential and retained the warm session.

The four-case recovery batch passed with zero failures or skips: ten Profile and ten
History cycles, bidirectional gestures, fixed WebView frame, single composer,
keyboard restoration, native tab/Search isolation, seven nested Profile families
and in-memory status/header canvas matching. Viewing Vault methods and Support did
not modify a method or send a report. These are functional and sampled-geometry
receipts, not rendered frame-performance or exact JavaScript object-identity proof.
The subsequent theme test passed all sixteen Light/Dark × Blue/Molten Gold ×
Chat/One/Connect/Feed combinations with zero failures or skips, then restored
the original preferences and unlocked Chat. All private-run diagnostics were
destroyed; no private screenshots, credentials or content were retained.
The final attach-only admission test passed: experimental native editor and
History/Profile controls were absent, the React composer was present, no privacy
cover or vault gate remained, and unlocked Chat was left visible.

### Historical installed recovery checkpoint — 2026-10-10

At this earlier checkpoint, the iPhone 16e ran recovery implementation `b5e8e9783f`,
`com.hushh.app` 1.4.0 (69), Debug configuration, iOS 27.2, UAT backend.
Product installation and runner-only preparation were separate. Subsequent
runner builds then relinked a local application product; they did **not** reinstall
that product or change the installed-candidate identity below.

| Installed artifact | SHA-256 |
| --- | --- |
| Application executable | `1a8da7d7b521bdf35b531b87cfa57046584defc334e4c99298259c544571fb22` |
| Packaged index | `0d87c623955d1d41a553944ed344e4e2889bf1469c803cf6075121313f94bf43` |
| Runtime contract | `aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69` |

Attach-only functional results on the unlocked session:

| Shared family | Observed result / qualification limit |
| --- | --- |
| Bottom destinations and Search | Chat/One/Connect/Feed/Chat, Search and History isolation passed; standard native navigation positively required |
| Profile nested panels | Existing seven-family settings journey passed, including view-only Vault methods and unsent support-type selection; no method or report submission |
| History and Profile | Initial batch: three passed, one failed at Profile admission after closing History. Targeted rerun passed ten cycles each after requiring actual React modal retirement, not only native navigation readiness |
| Drawer gesture and keyboard | Bidirectional History opening/closing, stationary WebView frame, composer restoration, one composer and navigation restoration passed |
| Status/header canvas | In-memory pixel comparison matched; no private screenshot or hierarchy retained |
| Appearance and Accent | Light/Dark × Blue/Molten Gold × Chat/One/Connect/Feed passed all 16 route combinations; actual Accent options acknowledged, navigation present, original preferences and unlocked Chat restored |
| Recovery admission | Final runner asserted native editor, History opener/Close and Profile Close absent; React composer present, privacy cover retired and normal unlocked Chat retained |

The appearance runner executable SHA-256 is
`cb8652e8731137c754b7b6d9d6b35eaac5e39523e7a69c599f8196473643351b`.
The native Back/material audit remains a separate opted-in native-candidate
branch of the existing test; the recovery appearance path does not certify it.

The first failed batch remains part of the result, not replaced with a blanket
green batch claim. These receipts verify functional interactions and sampled
geometry, not exact document/editor object identity, uninterrupted material
pixels or three physical Release performance runs. iPad remains unqualified.
No transition-frame, accessibility or Release performance acceptance is inferred
from functional receipts. The black-material cause remains unverified; recovery
avoids the failing custom composition rather than declaring it fixed. The native
History rebuild and broader adoption remain qualification-only work after the
recovery visual gate, not enabled product behavior.

Older experimental wrappers requiring regions/apertures select their existing web
navigation fallback, rather than reserving an unready native bar. The recovery
wrapper retains standard native navigation and its safe modal/keyboard hiding;
that behavior is not represented as glass continuity beneath a React drawer.

### Bounded native History composition study — 2026-10-10

The owner confirmed the installed recovery controls look stable. Recovery remains
the default; this checkpoint does not qualify new native controls.

`NativeHistoryQualification.swift` provides an iOS 26+ iPhone public fixture in
Debug or an explicitly compiled `HUSHH_NATIVE_HISTORY_STUDY` Release qualification
build, under the `--hushh-native-history-qualification` argument.
It does not imply `-UITestMode`, reviewer login, reset or a cold route. Ordinary
Debug and Release launches retain recovery. The historical custom-native flags
remain disabled and NativeChrome v2 / NativeDock v1 are unchanged.

One owned UIKit presentation retains native base and History hosting controllers,
the local pan and scrim. Public content continues behind the existing native
editor in one regular-glass dock. History moves as a full-height native panel; no React pose/clipping bridge
is involved. Theme/accent fixture choices retain those hosts; interrupted settles,
cancellation and retirement are generation-fenced. UIKit modal isolation, not a
captured restoration of WK eligibility, owns the temporary input boundary. Privacy
retirement waits for presentation completion and actual owned-child detachment;
the fixture never releases the product privacy cover.

The study reuses `NativeAgentDockView`, its retained `UITextView`, and shared
44-point `NativeChromeButton`; it does not add another editor implementation.
Its local sample model has no emission or submission authority. Rows, text and
backdrop are public samples, with no real history identifiers, provider calls,
routing decisions, credential replicas or persistence. Retirement clears the
sample editor. A public landing remains over the WebView after fixture retirement
so recording cannot expose the private product session. Explicit re-entry after
runner preparation respects existing privacy admission. The two
fixture appearance/accents exercise material only, not product theme authority.
This native-on-native composition cannot certify a native overlay on React content,
product draft/IME/attachment/voice continuity or Profile parity. Those retain
their coherent recovery implementation; study acceptance cannot enable them.

The closing-animation input boundary is completion-based. Applying the target
transform immediately does not make the still-visible drawer retired. The nearest
support test fails on both touch and accessibility admission with the old
progress-only rule; the completion-fenced rule passes. The study owns its status
bar style through Light/Dark changes without altering the product status owner.

#### Physical Release study evidence — 2026-10-10

Native source: `4524868f66` (identical pre-commit source compiled for this study);
exported web source: `b5fc73b5c6`.
Packaged web index: `9f1bd2a52f41cc0f4366365b201700c94291ed34bac95e30603936007341da5c`.
Runtime contract: `aa822769e2547459e63e38784b039f3b80ed905c1d426cb7834606fab1fc3f69`.
The iPhone 16e ran the signed, optimized Release study on iOS 27.2 over an
authenticated CoreDevice `localNetwork` connection. Preparation/install and
attach-only execution were separate; no sign-out, fixture reset or vault erasure.

| Evidence | Result and boundary |
| --- | --- |
| Whole native composition | Ten warm Open/Close cycles with alternating control-edge taps, held partial closing drags, spring-back, base input isolation and rest alignment within one point completed. A subsequent measured run completed another twelve short cycles, including its warm-up. This does not prove an uninterrupted reversed drag or rendered transition-frame continuity. |
| Retained shared editor | One real native text view accepted multiline Unicode in one insertion, preserved it across Talk/Message and drawer changes, stayed capped at 144 points and above the software keyboard. No product submission, attachment, IME or voice parity is inferred from this public sample. |
| Appearance/accessibility | The final focused test passed all four Light/Dark × Blue/Molten Gold states, with contrast, hit-region, description, trait, clipping and Dynamic Type audits. Initial audits caught two public-label contrast failures; both were repaired with semantic foregrounds, not waived. Public captures were visually inspected. Actual VoiceOver navigation and system reduced-transparency acceptance are separate from this automated audit. |
| Closing regression | Restoring the old progress-only isolation rule failed two touch/accessibility assertions. The completion-fenced repair passes; all 54 nearest native support cases passed. |
| Frame cadence | A Release run recorded 184 positive display callbacks, maximum interval 19.672 ms and no interval above 50 ms. Another recorded 485 callbacks, maximum 19.555 ms and none above 50 ms. These are callback cadence, not rendered hitch measurements. |
| Rendered performance | XCTest returned zero frame counts together with positive frame rates. Its zero hitch values are therefore unusable for acceptance. Instruments could not attach to the positively identified, still-running debuggable process; device screen recording explicitly reported unsupported. No three-run rendered-hitch qualification or transition-video claim is made. |
| Normal Release boundary | The normal signed Release build passes without the study flag; neither study symbols nor its launch argument occur in its executable (`22a93ae5e0adcdd80f9e74a80fe1fb391ac0f3ea7057f7e40cc29159220fc8a1`). |

Final study executable: `ba40f99f3c3f810182682849af0f2039a7d8514daf0802c9f74cd074f181f295`.
Authoritative local result bundles are `hushh-native-composition-release-qualified-4.xcresult`
(functional/editor completion followed by a real contrast failure) and
`hushh-native-composition-release-appearance.xcresult` (final four-state audit passed).
An earlier long run lost XCTest accessibility service after 36 cycles while the
app stayed alive; it is not counted as a completed acceptance run.

**Disposition:** keep all custom product-native families disabled. The study
demonstrates the coherent native hierarchy and catches concrete regressions; it
does not supply the missing rendered-motion evidence or a private History port.
Product History requires a separately typed, owner/document/revision/privacy-bound
memory-only projection and React-owned search/rename/delete/navigation operations;
public NativeChrome must never carry private titles or identifiers. Profile and
rich families retain the coherent React implementation. Physical iPad remains
unqualified. No product family is enabled by a study receipt.

Focused typecheck, native plugin parity, design-system/static-performance checks,
fresh Capacitor web export/sync and signed native builds pass. The canonical core
mirror passed this candidate in 399 seconds (including 9,794 protocol, 201
shared-database and 377 PKM upgrade cases); final documentation checks are
independent. Existing environment-dependent skips are not physical acceptance.
Core reports 36 existing Dependabot alerts, including critical Capacitor findings;
the lane's nonblocking advisory is not release security clearance.
Release integration
is a separate recorded boundary: the existing feature PR is at an older remote
head, and a read-only merge of current `main` reported 50 conflicts. This native
repair does not silently overwrite those unrelated product/protocol changes.

## Historical experiments (not current renderer qualification)

### Drawer admission regression repair — 2026-10-09

Source baseline: `a4a7610a6751`. The attach-only iPhone material journey
reproduced dock retirement at layout admission, before native dock application.
The rejected initial Profile frame started 116 CSS pixels below the viewport
and ended 149 pixels above its bottom. The shared reserved-region selector had
higher specificity than the full-height override. The override now matches its
specificity; owner/privacy validation remains unchanged. A computed-layout
regression covers Profile, its opening preview and History before coverage
acknowledgment, plus old-wrapper/web fallbacks. Restoring the broken selector
reproduces the 116-pixel displacement. Chromium and WebKit both exercise it.

Region and pose freshness are independent. Superseded layout failures cannot
retire a current dock. When an ordinary pose overtakes a compatible region's
initial pose, native retains newer geometry only for the same document, drawer,
owner, generation and privacy. Its receipt distinguishes retained geometry from
application of the requested initial pose. Malformed geometry and current
failures remain rejected; no choice, navigation or submission is replayed.
Nearest web/native tests include wrong-owner/malformed-offset rejection and
negative controls for the actual ordering regressions.

The software-keyboard journey exposed a second real admission failure:
WebKit's transformed full-width rectangle measured 390.000030517578 CSS pixels.
Native containment now admits at most two Float32 representable steps at the
viewport scale, not a CSS-pixel margin. The nearest native regression rejects
even a 0.01-pixel out-of-bounds rectangle and retains all owner/privacy fences.
The keyboard harness also previously skipped the Profile interruption using a
stale hidden-keyboard sample. It now always exercises that interruption after
typing and requires fresh post-close CSS/UIKit geometry. The speculative extra
focus cancellation was removed; existing focus and draft owners are retained.

| Family | Renderer / operation owner | Qualification boundary |
| --- | --- | --- |
| Stationary History opener and Cloud/Puppy | Retained NativeChrome / existing React actions | Debug iPhone candidate; transition evidence required |
| Agent Dock / chat input | One retained native editor / existing React draft, submission and voice owners | Keyboard, IME, attachments and privacy acceptance remain separate |
| Profile / History panels, moving Close and Preferences | Full-height React / existing gesture and feature owners | No stationary header portal or second drawer engine |
| Bottom navigation | Retained standard UITabBar / existing React navigation owner | Native label fallback in XCUI stays scoped to that bar |
| Other routes, older wrappers, Android and iPad | Existing qualified renderer / existing owner | No broader adoption or iPad enablement from this repair |

The material pilot still clips native chrome using asynchronous React poses.
This repair is not proof of first-touch pixel continuity, uniformly dimmed
scrims or the one-display-interval pose target. Release performance, accessibility
and exact-candidate physical qualification remain required before promotion.
Debug diagnostics contain only fixed refusal/stage codes and bounded public
geometry; they conceal on privacy transitions and never include editor contents,
account/lease identities or provider error bodies.

Physical Debug functional proof on the installed 1.4.0 (69) UAT-backed candidate:
the held partial Profile drag had four observed samples and zero missing native
plane samples; ten Profile, ten History and ten Cloud/Puppy cycles completed.
Profile and History measured top 0/bottom 844 CSS pixels, retained their native
base and returned to the native dock without an interactive web duplicate. This
is geometry/interaction admission evidence, not first-frame or hitch acceptance.
The same attach-only batch passed ten Chat ↔ One cycles with the Unicode/multiline
draft preserved, software-keyboard clearance and one WebView/editor. Both cases
completed with zero failures or skips; the synthetic draft was cleared through
its existing editor owner. The same-source executable SHA-256 is
`ba0bf116fcd647e482437caf3013c803bbb846630c323ebfc57e865a8066862d`;
packaged index SHA-256 is
`5e128f8bc0bc6e6ff57fe984c4f11b992720501da79ed76d861b0d70c1f91bcb`.

### Keyboard retention and atomic first coverage — 2026-10-09

Baseline: `9f8705948f36`. This bounded correction retains the existing Debug
iPhone qualification flags; it is not release or device visual acceptance.

Keyboard notifications no longer destroy NativeChrome hosts or emit destructive
invalidation. Presentation preparation/appearance updates remain privacy-fenced;
actions, accessibility focus and popup choices remain keyboard-fenced. Explicit
keyboard focus cancellation retains the installation; uncertain focus still uses
retirement recovery. Ordered admission-only echoes refresh region receipts without
replacing an unchanged SwiftUI root. Navigation waits for current DidHide rather
than reappearing during WillHide.

NativeDock now separates visible presentation from interaction eligibility. A
temporary disabled echo retains editor focus; actual modal, privacy and ownership
transitions retain their explicit focus/concealment policies. Native-owned DOM
seats no longer apply a second CSS keyboard translation. Delayed layout/apply
receipts and failures cannot admit or retire a superseded editor update. Normal
web forms retain keyboard avoidance, with deferred scrolling cancelled on hide,
focus loss, detached/inert targets and teardown.

`atomicDrawerCoverage` negotiates an optional authored `initialDrawerPose` on the
existing version-2 region operation. The container stages region/pose validation,
then commits both with one visibility reconciliation. Dormant source registration
does not grant interaction or change drawer decisions. Missing sources retain the
old fail-closed path; wrong owner/generation/privacy cannot partially advance the
region. Initial admission and normal pose sampling share one ordered sequence.

This removes a specific first-coverage gap, **not** the structural asynchronous
WK/UIKit motion boundary. Native controls are still outside the internal React
scrim. Neither bridge acknowledgements nor host counters prove pixel continuity.
The fluidity standard is one presentation owner for surfaces moving together and
no bridge round-trip in the finger/keyboard animation path. If measured drawer
composition fails that standard, qualify a bounded native History presentation
before expanding; do not wrap DOM content and call it a native layering fix.

The current renderer/owner/fallback table below remains authoritative. Broad
native adoption, iPad qualification and release performance acceptance remain
blocked until their exact-candidate transition evidence passes.

Checkpoint verification: 160 focused web cases, 51 simulator native support
cases, typecheck/lint, plugin parity, design/geometry/accent/static-native gates
and skill lint/smokes pass. The stale-apply-failure negative control retires the
newer editor when its generation guard is removed; the guard was restored.
Simulator results do not qualify physical fluidity or material rendering.

### Partial-drawer exposure prototype — 2026-10-09

At `0806bb293652`, the held partial Profile drag hides the entire native base
plane because `fullWindowCovered` conceals its ancestor. Host retention does not
meet visible continuity. The owner explicitly rejected that behavior; the
retained-coverage candidate below is historical, not acceptance of partial drags.

The bounded replacement is Debug-iPhone-only, negotiated with `drawerClipping`
and the explicit `--hushh-native-drawer-clip` qualification flag. One clear,
alpha-1 rectangular UIKit viewport clips the retained full-size native base to
the exposed part of Chat. Its compensated origin preserves existing child and
keyboard coordinates. No ancestor mask, material alpha, snapshot, additional
WebView, composer, route owner or gesture engine is introduced. Apple documents
[rectangular clipping](https://developer.apple.com/documentation/uikit/uiview/clipstobounds)
separately from the unsupported ancestor-mask/alpha patterns in
[effect views](https://developer.apple.com/documentation/uikit/uivisualeffectview).
Neither document establishes this hybrid candidate's visual acceptance.

The existing overlay registry names the authored drawer; ambiguous simultaneous
drawers expose no base pixels. The existing latest-wins pose transport covers the
opening Profile preview as well as the actual Profile and History panels. Poses
must match document, owner, generation, ordered sequence, privacy and current
region revision. Unsupported geometry or unconfirmed initial coverage remains
clipped; old region receipts do not re-admit actions. Exposed base controls stay
touch-inactive and accessibility-hidden. Privacy concealment remains independent.

The shared `NativeChatChrome`/NativeChrome family map remains the renderer gate,
not a global DOM-button substitution. Profile Back/Close use `ShellActionSurface`
for coherent React fallback geometry, material tokens and ripple. They are not
native glass in this candidate. A Profile-owned moving native Close requires a
separate qualified presentation group, current-pose action fencing and one
renderer before reveal; never enable every Close as an overlay-blocking exception.

Qualification must include a real partial opening held before release, not only
settled open/close cycles. The existing privacy-fenced public geometry probe records
bounded numeric held-pose/absent-plane counts without text, editor contents or
account identity. Missing initial acknowledgments, asynchronous pose age and
native glass sitting above the internal web scrim remain explicit limitations.
A passing held-pose check alone does not establish uninterrupted transition
pixels, uniformly dimmed scrims, frame pacing or native Close acceptance.

Older wrappers and Release retain their existing paths. Do not expand native
adoption or deploy from this prototype until the architecture/material gate passes.

### Full-height retained-coverage candidate — 2026-10-09

The owner selected full-height Profile/History drawers rather than the shorter
reserved central area. This replaces that geometry on negotiated iPhone wrappers;
older wrappers keep their existing contract. Source baseline: `cc93c35bea`.

The existing overlay registry owns coverage across preview, modal and exit.
NativeChrome's ordered region receipt adds optional `covered` and
`privacyGeneration`; its existing revision is also the admission fence for
Chrome, Navigation and Dock. No second cover-generation counter is introduced.
Full-height modal paint/focus waits for acknowledged coverage. History holds its
token through actual exit animations; cancelled/reopened exits cannot release it.
Moving headers, Close, Back and Preferences remain React, including safe areas.

The retained native plane is concealed while these drawers cover it, and the
old strip interceptor releases edge touches to WK. Hosts/editor remain mounted;
ordinary coverage release neither restores old actions nor clears privacy.
Queued Navigation work rechecks its owner at execution. Superseded native
presentation requests return `presentationApplied=false` without mutating a
newer presentation or triggering an operation retry or renderer fallback.

The stationary One/Puppy selector now shares one capability/preparation policy
with the other stationary Chat controls. Its prior flat rendering was an explicit
content-backed capability exclusion, not a missing React value or missing flag.

The focused web contracts pass 146 cases. Two negative controls demonstrate
failures when ordered cover fencing or History's exit retention is removed;
both fixes were restored. Three targeted WebKit cases pass whole-panel motion,
shared gutters/full-height geometry and repeated Accent reopen behavior.
Typecheck, changed-file lint, design, native/plugin, documentation and governance
checks pass. Native build and exact-candidate physical evidence remain separate.

The newer root Back/Search generator instructions are not implemented as npm
scripts on this branch. Existing action reachability remains unchanged and the
owning surface/Siri/plugin checks pass; that is not a substitute for the missing
generator gates. Resolve branch/tooling freshness before any release transition.

This is **retained concealment/recovery**, not proof that partially exposed glass
remains visible beneath a moving React drawer. Transition pixels and physical
performance remain release gates. Do not promote this capability beyond Debug
iPhone rehearsal solely because ordering, layout or installed-app checks pass.

The obsolete `com.hushh.app.scopecommerce.sandbox` and its matching XCUI runner
were removed from the iPhone after explicit confirmation. `com.hushh.app` and its
session were kept; backend/Firebase accounts were not erased.

### Historical reserved-region candidate — 2026-10-09

This supersedes the foreground overlay-concealment pilot below. Baseline:
`2f0ce572d6` on `feat/adk-orchestration-runtime`; implementation commit
`d1504db62f`, followed by ordered-receipt reconciliation, shared selectors and
owner-fenced draft continuity and shared-family admission through candidate
`cc93c35bea1a940ef953ac989daa28d8f94c7e11`. New families remain
opt-in Debug/iPhone, not Release or iPad.

One content-backed native plane sits above the existing WKWebView. The shared
top/bottom shell owners reserve stationary regions; the central region contains
React drawers, their scrims and shared web dialogs/sheets. Popover collision
padding uses the same acknowledged geometry. Moving Profile/History headers,
Close, Back and Preferences stay React for their full lifetime. No native view
is interleaved between internal WK page/scrim/drawer layers.

`reservedPresentationRegions` is negotiated without changing NativeChrome or
NativeNavigation version 2, or NativeDock version 1. Public region receipts bind
document, ordered revision, viewport and bounded insets. They carry no private
editor payload. Stale receipts cannot restore layout or action authority.
Covered native seats remain mounted and visible, but become touch/AX-ineligible;
reserved strips intercept touches rather than falling through to covered DOM.
Region dismissal alone does not readmit an obsolete action. Privacy still covers
the complete application window and conceals the editor immediately.

| Family | Renderer / operation owner | Candidate evidence | Fallback / rollback |
|---|---|---|---|
| Stationary shell Back | Native / authored React Back | Ordered lease/update contracts; physical unqualified | Unsupported wrapper uses React; remove Debug qualification flag |
| History opener | Native / existing History owner | Ten exact-candidate warm drawer cycles; transition pixels unqualified | Existing React opener on unsupported wrappers |
| Profile/History moving controls | React / existing drawer and Back owners | No native Close relocation; drag visibility regression test | Existing web renderer retained |
| Bottom navigation | Standard UITabBar / React navigation | Reserved wrappers retain visible material and revoke actions; older pilot still hides safely | Older iOS/web/Android keep established path |
| Agent Dock | One native host/editor / existing One session draft, Send and voice owners | Ten exact-candidate warm routes retain Unicode/multiline draft; ordered private contract | Confirm retirement before restoring web composer |
| Stationary More/bounded picker | Native eligible / authored React operation | Capability and region admission only; physical unqualified | Retain React unless slot is eligible |
| Appearance/Accent in Profile | React trigger / Settings owner | Moving triggers deliberately retained | Existing menus; no delayed renderer swap |
| Rich/scrolling controls, protected forms, complex multiselects | React / feature owner | Deliberately retained, not native adoption | Unchanged |

History's closed invisible panel becomes visible only during its owned opening
drag; cancellation, settlement and teardown remove the temporary visibility.
Motion, selection and routing authority remain with the existing gesture owners.
Native pose mirroring is not used for these moving React controls. The historical
underlay experiment remains reversible and is not qualification evidence here.

The qualified region removes duplicate safe-area padding on moving panels;
leading/trailing edge placement and whole-panel motion remain authored React.
The native-owned voice seat retains its geometry but has no web pill material,
touch or accessibility admission. A newer acknowledged shell layout reconciles
the retained dock/navigation instead of stranding a superseded preparation.

### App-wide coverage ledger — 2026-10-09

Inventory coverage is not runtime acceptance. The authored layout contract has
145 route keys (75 standard, 47 redirect, 17 hidden, six flow); the native audit
inventory has 126 entries (102 required, 24 excluded). Redirects, aliases and
guarded flows are not 145 independent interactive screens. Reuse those inventories
rather than maintaining another route catalog here.

| Surface family | Source/control review | Latest warm iPhone evidence | Remaining qualification |
|---|---|---|---|
| Chat / One / Agent Dock | One editor, guarded React submission, listener admission, retained History attention badge | Ten Chat/One cycles, Unicode/multiline draft, software keyboard and one WebView passed | IME, attachments/refusal, voice completion, transition pixels and Release timing |
| Profile / nested settings | Account, Preferences, Security/Vault, Connectors, Support, referrals and Legal; moving controls remain React | Account/Preferences/Security/Vault/Support passed; remaining-only Trusted devices/Connectors/Invite friends/Support passed, including all three Support choices with the original restored and no submission | Fixture-specific rich details, nested overlays and full accessibility |
| Appearance / Accent | Shared finite-radio semantics, authored icons, 44px admission, complete Blue/Molten Gold React menu | Light and Dark Chat/One/Connect/Feed canvas matching and Wallet Back passed; the audit fails in both themes on an unidentified hit-region element | Attribute/fix the accessibility failure; System, both accents and system accessibility settings on device |
| Mail / Calendar / Email | Authored route/connector and pager owners inspected | Mail Overview/KYC/Receipts taps/swipes, keyboard and draft continuity passed | Calendar/Email provider fixture journeys, loading/late-response states |
| Memory / Marketplace | Existing pager, scope and protected-information owners retained | Saved → Add → Sharing and return passed | Actual save/review, rich dialogs and conditional Marketplace fixture |
| Connect / people / circles / messages | Existing route tabs, person boundaries and gesture owners retained | Connections/Circles and return to Chat passed | Person/Circle detail and invitation fixtures; background notification journeys |
| Finance / Wallet / Consent / Feed | Existing query tabs, bounded choices, rich tables/cards and owner guards | Finance Portfolio/Analysis/Market, Wallet Cards/Add/Sharing, Consent Active/History/Connections/Requests passed; draft retained | Rich details, secure forms, consent decisions and conditional holdings fixtures |
| Location / Connected Systems / Puppy / Career | Source inventory and existing contracts; bounded controls distinguished from route pagers | Not physically accepted in this batch | Fixture-specific native capability, selector and consent journeys |
| Public / authentication / setup / RIA / callbacks | Route/redirect/flow inventory reviewed; canonical Profile deep-link projection tested | Not counted as warm signed-in passes | Separate anonymous/cold/recovery and qualified identity fixtures; no reset to inflate warm coverage |

Candidate: Debug iPhone 1.4.0 (69), UAT runtime, source `cc93c35bea1a940ef953ac989daa28d8f94c7e11`.
Executable SHA-256 `88a0ef7a56194152ca8d8eec857c9968e38bf5fc3c2e7e7eab3ced9336c6e1d1`;
packaged index `8320446f93933e0a5f63be9eee895776d373d1813471cd164c95d87a8df0a2ed`.
Install/unlock were preparation, not warm-navigation proof. Runner-only harness
updates retain this product executable identity.

- 175 focused web tests, typecheck, lint and design/brand/performance contracts
  passed. Admission/badge negative controls failed on the deliberately broken
  implementation and passed after restoration. Six existing synthetic WebKit
  Wallet layout cases passed; they do not qualify all Wallet interactions.
- Canonical core passed at the exact implementation SHA in 238 seconds. No
  exact-head GitHub CI, push, merge or deployment is inferred from that receipt.
- The six-family attach-only physical batch finished four passed, two failed,
  zero skipped. A remaining-only Profile rerun subsequently passed. Its original
  missing-Back failure was a harness tap near a covered native strip: WebKit AX
  hittability alone did not prove compositor touch admission, and a whole-WebView
  swipe could start outside the pane. The corrected in-region gesture moved
  Support from y=665 to y=315, admitted its Back and retained the warm session.
  Do not describe that harness correction as a product Back implementation fix.
- The remaining-only theme run completed both Light and Dark canvas/Back journeys
  but still failed accessibility in each. An unidentified `Other` element with a
  390×10pt frame at the top does not overlap Back and is not an attributed status
  probe. Coordinates alone do not authorize a waiver. The test collects both
  themes without converting an audit failure into a passing receipt.
- The Profile layout harness still described the superseded stationary header
  and Preferences portal. It now uses the real whole-panel owner and checks
  header/control/body translation, cancelled settlement and no entrance replay.
  All 17 functional WebKit Profile cases passed. The gutter case also passed
  with synthetic acknowledged top/bottom reservations and internally scrolling
  nested content. Four optional screenshot-export cases were not enabled.
- Source gaps remain separately owned: disabled duration variants, route-absence
  retirement versus temporary suspension, unbounded navigation capability/state
  acknowledgements, and special Profile compatibility routes outside the canonical
  pane resolver. They are not physical passes or permission to bypass auth flows.
- More/date/bounded-selection bridge capabilities do not establish production
  adoption without an authored caller and its evidence. Moving/scrolling controls
  and complex multiselects deliberately remain React.

### Earlier reserved-region receipts and remaining gates

- Candidate: iPhone Debug 1.4.0 (69), UAT runtime, source `020c50ddac`.
  Executable SHA-256 `dd818bd3d8b008fe945b5f6e38a08d9b788f7d501bf4c08a7d5f441b557a0f5d`;
  packaged index `4e4b21edd6f21ea6af0554f10f1b6912ac8dae0a37fe09d2391870f90c8ae711`.
  Installation and normal passphrase unlock succeeded separately from warm proof.
- 141 focused web tests, typecheck, native/plugin contracts, static export,
  device build and strict signature verification passed. The foundation's earlier
  simulator run passed 49 native support tests; not a latest-candidate visual pass.
- The exact installed candidate passed ten Profile plus ten History cycles:
  navigation remained visible and covered native interaction/AX was revoked.
  Ten warm Chat/One route cycles retained the synthetic Unicode/multiline draft
  with one WebView and no interactive DOM composer. These interaction/metadata
  receipts do not prove transition pixels or qualify the material for release.
- Dock keyboard/draft proof previously failed at keyboard dismissal. Direct
  selector unit coverage did not prove physical key delivery. The current editor
  explicitly prioritizes Command-Return and idle Escape over UIKit text/focus;
  marked text retains its guard. Physical delivery remains an acceptance gate.
- The software-keyboard journey subsequently passed dismissal through Profile,
  then failed `NATIVE_DOCK_ROUTE_RETURN_LOST_DRAFT`. Chat's local draft and editor
  context were recreated on route remount. The candidate now retains the draft,
  attachment and expansion in the existing memory-only One session authority;
  owner/context guards reject late edits, and vault lock clears the draft even
  while Chat is unmounted. Exact-candidate route proof now passes; pre-vault intro
  editing remains local and never admits a protected native editor.
- The subsequent drawer run entered with a visible software keyboard, explaining
  why its combined initial admission assertion was not material acceptance.
  The harness now checks that prerequisite through the normal Profile owner;
  all twenty drawer cycles pass without weakening visibility or isolation checks.
- A prior core run passed; an overlapping export caused the subsequent core run
  to fail on Next's build lock. A later run caught a missing draft-setter callback
  dependency, corrected in `835d06ae47`. Serialize every frozen-head rerun after
  export and require the canonical core gate; do not relax it.
- Outstanding: exact-candidate transition/alignment, IME/attachments/refusal,
  full accessibility/material settings, three physical Release performance runs,
  iPad qualification and exact-head CI. No push or release promotion is implied.
- Root Back/Search generator instructions reference scripts absent from this
  branch's package. No new actions/routes were authored here. Reconcile that
  instruction drift through existing frontend contract governance before landing.
  The separately invoked native route-matcher test also retains obsolete Finance
  literal expectations while the runner now uses generated actions; not waived.

### Shared-family mapping

Consolidate anatomy and semantics at existing primitive boundaries, not by
replacing every tab-looking control with one new routing component.

| Interaction family | Shared implementation | Authority and adoption boundary |
|---|---|---|
| Bounded radio choice: One/Puppy, Appearance, Support type, portfolio source, Wallet contact and Nearby filters | Morphy `SegmentedControl`; one SwiftUI `NativeFiniteSegmentedPicker` for eligible stationary hosts | React owns value and validation; shared roving focus, authored icons, disabled admission and no-op repeated choices. Appearance's sliding web thumb preserves its track geometry with 44px hit regions; Wallet retains its two-column phone layout. |
| Route/query tabs: Connect, Memory, Mail, Finance | `TopShellTabs` and existing tab registry / `SwipeViews` | Existing route/pager owns taps, swipes and URL. Continuous moving indicators remain React. |
| Local content tabs | Existing `SegmentedTabs` / feature pager | Feature owns panel selection, accessibility associations and swipe reconciliation. |
| Bottom navigation | Standard native `UITabBar`; existing web navigation | React navigation authority remains; no new router or selector draft. |
| Rich/searchable multiselect and protected fields | Existing React controls | Deliberately retained. Native bounded presentations require authored metadata and explicit owner validation, not DOM inference. |

The finite native renderer shares layout, tint and choice validation without
adding a selection store or changing public bridge version 2. Consolidation does
not qualify moving controls for native replacement or establish visual acceptance.

Apple documents the [keyboard-command delivery order](https://developer.apple.com/documentation/uikit/uikeycommand/wantspriorityoversystembehavior).
XCUI command-key injection and real event delivery must be distinguished from
calling a handler directly; neither is a reason to record an unobserved pass.

### Presentation qualification rules

1. Establish feasible layer composition before implementation. One WKWebView
   cannot place UIKit controls between its internal DOM layers. Never substitute
   hidden controls, snapshots or a second WebView for continuity.
2. Choose one renderer per eligible control lifetime before reveal. Reserve
   geometry during capability/layout preparation; unsupported wrappers choose
   their fallback, and uncertain retirement never admits a duplicate.
3. Test visual presentation, touch admission, accessibility isolation and privacy
   separately. A retained host or acknowledged layout is not visible-pixel proof.
4. Cover shared families across authored routes, rapid reopen, edge presses and
   interrupted drags. Inspect transition frames on synthetic/public surfaces;
   private journeys produce only sanitized metadata.
5. Diagnose device transport, XCTest authorization and vault unlock separately.
   Install the exact candidate in preparation, then use attach-only warm tests;
   no repeated reset/sign-out or injected route stands in for continuity.
6. Physical qualification requires the same WebView/editor/session, one interactive
   composer, one-CSS-pixel alignment, both themes/accents, accessibility and three
   Release performance runs. Simulator/Debug receipts cannot close those gates.
7. Native navigation projects the existing owner's actual Back destination,
   including preserved origins and in-place replacements. A static URL hierarchy
   or history depth alone cannot prove that an intermediate page was visited.
   Unknown ancestry keeps the coherent fallback before reveal; verify entry and
   return together, not only the settled destination.
8. A full-page content layer using Dialog for focus/Back ownership does not
   inherit Dialog's modal z-index. Use the shared feature-page tier below nested
   sheets/dialogs. Verify actual topmost hit targets using optimized product CSS
   before device packaging; element existence or covered-header diagnostics do
   not prove which layer intercepts a tap. Keep a negative control at the broken
   tier and preserve modal isolation.

Material inspection follows Apple's [effect-view restrictions](https://developer.apple.com/documentation/uikit/uivisualeffectview)
and [Liquid Glass guidance](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views):
inspect backdrop, traits and ancestors independently; use one regular dock glass
surface, semantic colors and plain child actions. Do not force white/black fills.

## Historical experiments and evidence

The following sections describe earlier candidates. Their receipts do not qualify
the current reserved-region composition.

### Material foundation pilot — 2026-10-09

The source baseline is `44eff92efd` on `feat/adk-orchestration-runtime`.
The requested visual baseline preserves Hussh's web geometry and icons while
native glass samples actual page content. The underlay experiment below cannot
provide that backdrop: its canvas is beneath the WebView. Interaction receipts
from that experiment are not material or visual acceptance.

The additional Debug/iPhone flag `--hushh-native-content-backed`, together with
`--hushh-native-compositor`, selects the bounded foreground base plane. The
same WebView, bridge and Maps hit path remain. Chrome/navigation stay version 2;
NativeDock stays version 1. All negotiate `contentBackedPresentation`; this mode
denies underlay apertures and keeps existing DOM geometry reservations. Canvas
appearance and the committed light/dark trait travel in one ordered receipt.
The dock has one regular glass surface, with plain child actions, not nested
glass. Standard UITabBar and the existing navigation artwork remain.

This pilot admits the dock, bottom navigation and stationary History opener
only. Other Chrome families and native panel-pose presentations are denied in
this mode. React Profile and History remain unchanged. Covered foreground
controls are concealed, noninteractive and accessibility-hidden; retained hosts
receive fresh owner-fenced admission after dismissal. **This is temporary
containment, not successful drawer continuity.** UIKit siblings cannot sit
between page, scrim and drawer content inside one WebView. No second scrim,
snapshot, WebView or native drawer content bridge is introduced.

The iPhone baseline admission reached unlocked Chat on 1.4.0 (69), iOS 27.2
(24B5089g), before candidate preparation. The signed candidate builds locally,
but the device subsequently became unavailable before tests entered; its native
test attempt exits with a destination failure, not a vault rejection. Installation,
physical visual/accessibility/performance acceptance and warm candidate journeys
remain unverified. The observed earlier drawer timing failure remains a release
blocker. Broader adoption, Release, iPad and deployment are not enabled.

Focused frontend contracts cover ordered canvas/trait updates, no foreground
aperture and stale/covered navigation actions. Native support adds foreground
paint/hit isolation and extends the isolated synthetic-window capture to all
three materials, light/dark, Blue/Molten Gold and text/voice. Only public synthetic
window images may be retained; reviewer journey results are discarded. The
dedicated warm material test checks twenty React-overlay containment cycles;
it intentionally does not replace or weaken the existing drawer-continuity gate.
Rollback removes the content-backed Debug argument and retains the legacy path.

Verification for this source change: canonical local core passed; typecheck,
104 focused bridge tests, 42 native contract checks, 49 simulator native support
tests, device/simulator build-for-testing and Android unit build passed. The
synthetic capture test passed separately and produced eight public images on an
iPhone 16e simulator running iOS 26.5. All eight were inspected: page color is
visible through the dock and navigation, the hamburger follows the committed
appearance, and both accents are reflected. The deliberately overlapping page
text also shows interference beneath the editor; these images prove backdrop
composition, **not legibility or full-app geometry acceptance**. They do not
replace the web/native same-viewport comparison, System/accessibility material
settings, physical transition frames, editor identity journeys or performance
measurements. No candidate installation, push or deployment is claimed.

### Current candidate: retained controls and private dock

This candidate extends NativeChrome **version 2** with capability-negotiated
`retainedControls`. In the legacy host, a suspended control is hidden. In the
legacy underlay compositor it remains visible but noninteractive and unavailable to
accessibility; its owned popup must complete dismissal before suspension is
acknowledged. Reopening can reuse its hosting controller only with the same
document, opaque owner epoch, family, immutable configuration and exact frame/
viewport. It always receives a new action revision. Ownership, geometry or schema
replacement and privacy invalidation retain strict retirement. The public Chrome
keyboard fence does not conceal the separate private dock. Uncertain
retirement never exposes an interactive web duplicate. Older wrappers retain their
existing path.

Cold eligible slots are reserved before capability discovery settles; unsupported
wrappers restore their authored fallback without creating an installation.
Native preparation/activation still owns interaction transfer. This avoids a
brief interactive DOM control before the first native admission; it is not a
claim that native geometry exists before React lays out the owning surface.

[NativeDock](../lib/capacitor/native-dock.ts) is a separate private editor contract,
not an extension of the public chrome payload. The dedicated
[plugin](../ios/App/App/Plugins/HushhNativeDockPlugin.swift) retains one SwiftUI
glass container and `UITextView`. [The adapter](../components/agent/native-agent-dock.tsx)
connects it to the existing Chat, command-capture and Live feature owners. React
owns drafts, attachments, guarded submission, routing and voice operations. No
native persistence, provider call, new microphone engine or second WebView exists.
Return inserts a newline; Command-Return requests the existing guarded Send.
The retained host follows UIKit keyboard-guide constraints without requiring
another JavaScript apply. Ordered, owner/update/privacy-fenced frame receipts
include equal-height keyboard movement; the existing transcript layout owner
uses them for local clearance and reveal. Position-only receipts do not rerender
the feature tree or introduce a second keyboard offset.

The 2026-10-08 physical candidate produced a UIKit main-thread run-loop hang
inside dock apply/layout. The report's app UUID matched the installed binary.
Host layout re-entered dock placement, which unconditionally requested another
parent layout. Placement now reports only actual constraint changes; an unchanged
host pass cannot schedule itself again. The nearest keyboard-placement contract
also checks repeated settled updates. Physical rerun remains required; this is not
a claim that every observed admission failure had the same cause.

Native input is document/owner/conversation/editing-purpose/revision-bound. Send
consumes one confirmed snapshot; its editor is held noneditable until owner
settlement. An uncertain consumption retires the replica before restoring the
unsent owner projection and never dispatches or retries Send. Feature-directed
text/purpose replacement is atomic; old-purpose events cannot overwrite it.
Privacy-cover release cannot revive the editor: a fresh active, unshielded
generation must be admitted. Private editor content stays in process memory and
is excluded from diagnostics and public chrome.

Accent has a complete swatch/name/chevron trigger and an owned Blue/Molten Gold
chooser with accessible selection and explicit Done/Cancel. Stored values remain
`blue`/`gold`; colors come from the existing app tokens. Cloud/Puppy retains its
icon-based segmented selection. Existing friendly Vault method rows, owner
authorization and recovery safeguards remain unchanged.

**Enablement and evidence:** all added families remain iPhone/iOS 26 Debug-only.
The dock additionally requires `--hushh-native-agent-dock`. Focused contracts cover
suspension/retirement, stale choices, editing-purpose fencing, one-shot draft
consumption and actual host editor/selection retention. These source/simulator
checks do not establish physical visual, speech or performance acceptance.

Profile and History translate their whole panels, including headers and
Preferences, through their existing dialog and gesture owners. The stationary
Preferences portal and split-body presentation have been removed. The opt-in
`--hushh-native-compositor` container retains the same WebView and bridge. Base
controls/dock use acknowledged apertures beneath it; drawer controls use bounded,
clipped native groups above it. Pose transport is latest-wins with one in-flight
and one pending value, sampled at most once per animation frame and only while
presentation changes. Document, owner epoch, generation, sequence and privacy
bind pose admission. Closing revokes interaction immediately but retains the
presentation generation through the exit animation. Popup choices bind the exact
pose at opening; movement dismisses the owned popup. No route or gesture decision
is made by the native group.

App haptics uses the existing iOS native preference. Its one-time migration lets
an explicit disabled native or legacy JSON value win; subsequent reads use the
native value. The Settings service serializes writes and leaves unrelated
preferences alone. Feedback is requested by authored, accepted interactions,
not a route observer; expired, duplicate, inactive and privacy-stale requests
do not play. Native tab feedback is not duplicated by React. This source work
does not qualify tactile behavior on a device.

**Remaining:** physical whole-panel composition and Preferences acceptance. Complete dock
IME/paste/attachment/refusal and keyboard geometry journeys, ten warm cycles per
family, VoiceOver/Dynamic Type/rotation/transparency, and three physical Release
performance runs remain required. The current route inventory continues below;
historic receipts do not qualify this candidate. iPad is unqualified. Complex
multiselects, protected forms, scrolling controls and rich approval cards remain
React deliberately. Rollback is capability denial/removal of the Debug arguments;
fallback and strict retirement must still be verified before any family promotion.

### Bottom navigation overlay admission repair — 2026-10-09

At source baseline `64c2739df3`, Profile/History isolation projected
`visible: false` into NativeNavigation, and UIKit used the same predicate for
paint, touch and accessibility. Closing showed the retained bar again. The
repair keeps contract version 2 and negotiates `interactionIsolation` separately:
an overlay retains presentation while disabling touch and accessibility.
Interaction epochs fence delayed confirmations across closing/reopening. Older
wrappers retain their safe hide behavior; lock, privacy, keyboard and genuinely
hidden route chrome still conceal navigation. The owning React shell remains
the routing authority.

The local signed iPhone candidate is UAT-targeted, derived from that baseline
plus this repair. Its installed executable fingerprint is
`dd38fcc471b9e5d3bb4f55baa092754e2ff2808ababc6cb3322f6ad2eb24ba20`.
Native assets/export/sync, typecheck, static/plugin/design checks, 26 focused
frontend contracts and 48 native-support tests pass. Canonical reviewer
admission and one normal passphrase unlock pass. An attach-only physical iPhone
batch passes ten Profile and ten History open/close cycles on the ordinary
wrapper path, checking retained visible navigation, revoked covered interaction
and accessibility, frame differences at most one logical point, and restored
admission after Close. No account reset or relaunch occurs within that batch.
Private runner results are discarded; only sanitized receipts are retained.

These are native state/frame assertions, not a rendered transition-film or
pixel-perfect visual acceptance. The bar remains a direct native host child;
drawer scrim/material stacking still needs rendered qualification. The opt-in
whole-panel compositor and its previously failed motion/focus-return gates
below are not qualified by this ordinary-wrapper navigation pass. Release
performance/accessibility acceptance, a fresh combined core run and exact-head
CI remain outstanding. The repository-root Search contract instructions also
reference `build:search-contracts`/`verify:search-contracts`, absent from this
branch's package scripts; reconcile that owning workflow before promotion.
This is a local candidate installation, not a UAT service deployment or native
distribution receipt.

### Retained underlay and admission-bound focus repair — 2026-10-09

The next local Debug candidate is built from `df90c69dee` plus the bounded
navigation/focus/pose repair in this change. Its installed executable fingerprint
is `e917fb52c1290f55e85f097da7ac234b2215c2a3b2f212e46243855144384e9e`.
It targets UAT; installation is not a service deployment or distribution receipt.
The ordinary wrapper remains unchanged. In the explicitly enabled compositor,
navigation now belongs to the retained native underlay beneath WK paint, rather
than a direct host child above drawer scrims. Current document/revision layout
receipts reserve its base aperture; stale receipts cannot move the aperture or
overwrite its height. Rotation publishes changed frames even at equal height.
Covered navigation remains mounted, noninteractive and accessibility-hidden.

History focus return can wait for its exact current reserved admission rather
than retiring a lease still being prepared/activated. A covered return cannot
retire anything. Waiting does not grant focus or action authority: confirmed
layout, activation, update and current-owner checks still apply. Delayed pose
delivery resamples geometry and its timestamp together through the existing RAF
owner, not by retimestamping an old pending transform.

Typecheck/export/sync, signed product assets, static/plugin/design checks,
102 focused frontend contracts and 48 native-support tests pass. One normal
canonical-reviewer passphrase unlock admits protected Chat. A physical iPhone
attach-only batch passes ten Profile and ten History cycles, retaining the
navigation frame within one logical point, confirming underlay paint ownership,
rejecting covered interaction/accessibility and restoring admission after Close.
The first compositor batch stopped after four completed Profile cycles with
`NATIVE_PANEL_CLOSE_NOT_ADMITTED`. The harness previously waited for existence
before reading hittability; a retained control can exist during noninteractive
movement. Readiness now waits on exists/hittable/enabled within the same
ten-second action bound. This does not prove the original failure's cause,
change the separate pose-age gate or qualify rendered motion.

Credential-free Debug lifecycle probes now cover authored History and Profile
Close slots as well as the selector. They expose allowlisted stages/codes,
booleans and bounded geometry only; no identity, content or provider errors.
Private runner results are discarded. No resets, sign-outs or route injection
occur within the warm batches. Whole-panel timing, rendered alignment,
accessibility and Release performance remain unqualified until their separate
acceptance receipts pass. No new family or Release host is enabled here.

The separate compositor batch completes ten Profile and ten History edge-tap
cycles, retaining a single WebView/editor, rejecting interactive DOM Close
duplicates and returning to current native controls. Its final architecture
assertion **fails**: 564 observed motion samples, 564 stale samples, zero invalid
samples, maximum target-frame pose age 46.6174 ms / 2.7957 display intervals.
Completed interactions are not a passing compositor test. Resampling has not
qualified timing. The estimate's next-callback phase and uncalibrated wall-clock
pair do not establish rendered-pixel lag; neither permits subtracting a frame,
changing the threshold or declaring this environmental. Next evidence must
correlate bounded native acceptance/presentation timing and actual alignment
through `mobile-parity-check` before expanding or promoting the compositor.
The iPhone remains on the installed, unlocked Debug candidate at Chat; iPad,
Release performance, full accessibility, combined core and exact-head CI remain
outstanding. No merge, push, UAT deployment or native distribution is performed.

### Whole-panel compositor qualification — 2026-10-09

The candidate is derived from `fe58d0e56e` on
`feat/adk-orchestration-runtime`; it is an opt-in implementation, not a promoted
native family. Profile and History translate their complete existing panel,
including headers and Preferences. Their existing gesture writers remain the
decision owners. Covered base controls retain presentation while admission and
accessibility are revoked. This is distinct from privacy concealment.

Local verification passes the canonical core mirror (2,015 seconds), 169 nearest
frontend contracts, typecheck, static/plugin/design checks, final native export
and sync, 48 native-support tests, and Android Debug unit tests. The signed iPhone build and its actual
bundle assets pass. The installed App executable fingerprint is
`6500502210f44c20c9968bed80eeaadc88ae573ac1028db6f4f8a4d9d6709630`;
the packaged runtime is UAT, not production. Later test-runner-only diagnostics
are not a second product-installation receipt. Exact-head CI is outstanding.

The first installed composition exported one native editor at its expected
frame, with no web editor, but neither editor nor dock was hittable. Its
compositor journey stopped at `NATIVE_COMPOSITOR_REQUIRES_UNLOCKED_NATIVE_EDITOR`.
DOM paint apertures do not establish UIKit accessibility ordering. The bounded
container now traverses the native underlay after WK while keeping its
[layer paint order](https://developer.apple.com/documentation/quartzcore/calayer/zposition)
below WK. Explicit touch/admission routing remains unchanged. The nearest native
contract rejects the earlier ordering and preserves the paint and stale-hit
boundaries; all 48 tests pass after this change.

On the separately installed corrected candidate, canonical reviewer admission
and one normal whole-value passphrase unlock pass, including protected native
Chat interaction. This supports the hierarchy correction; it does not qualify
drawer motion. No reviewer reset, alternate account, forced privacy-uncover or
repeated credential submission within that cold-preparation session is used.
The first twenty-cycle batch exceeded its outer three-minute harness deadline
without returning an assertion receipt. The revised runner sizes only that
macro deadline for twenty interactions and emits bounded cycle counts. Individual
action waits and pose-age limits are unchanged; the interrupted batch is not a
motion pass.

The completed follow-up receipts identify the failing seam: ten Profile cycles
and nine History cycles return successfully; the final History close fails
`NATIVE_PANEL_WARM_RETURN_UNCONFIRMED`. Credential-free inspection afterward
finds an interactive native dock editor but no native History toggle or Close.
The existing focus-return code contains a retirement/DOM-focus fallback path;
its causal role in this failed return is **not yet proved**. A settled screenshot
or a new installation cannot qualify this reopen race.

The same inspection reports 553 motion samples, 553 stale samples, zero invalid
clock samples, maximum target-frame pose age 37.9736 ms and maximum age 2.2778
display intervals. Thus the current RAF/bridge mirroring has **not met** the
one-display-interval architecture gate. These target-frame estimates do not
establish actual detached-pixel distance or Release hitch ratio, but they cannot
be called a timing pass. Require a corrected, revision-bound presentation and
focus handoff, then rerun the same unchanged acceptance limits. Do not expand
families, hide controls, substitute React to pass, or promote this candidate.

The opt-in numeric timing probe compares a pose's JavaScript epoch timestamp with
the native target display interval, retaining only the latest pending sample
per group. It records neither information nor actions and cannot admit a choice.
Its clock precision and target-frame estimate do not prove visual alignment or
absence of detachment. The unchanged gate requires zero stale/invalid samples
and pose age at most one display interval. It has **not** passed on device.

Expansion and release remain blocked by whole-panel composition
(including nested-overlay paint occlusion), one-CSS-pixel
rest alignment, interrupted drags, ten warm cycles per family, accessibility/
theme/keyboard acceptance and three physical Release performance runs. iPad
remains unqualified. Synthetic unit/layout results cannot replace these receipts.

### Historical warm handoff corrections — 2026-10-08

Compatible active History/Profile Back handoffs now take the existing replacement
contract before suspension; they keep their native presentation while fresh action
authority is acknowledged. Reopening an actually suspended compatible control
retains its identical SwiftUI root as well as its host. Privacy and overlay
suspension still hide controls and complete owned-popup dismissal.

Profile interruption handling now preserves the rendered position when Close
interrupts spring-back or an opening preview is re-grabbed. Location-only stack
changes retain outer animation suppression. Preferences uses compact, title-only
rows; Accent fills its reserved trigger width, keeps swatch contrast, and preserves
label/color coherence when browser persistence is denied. Its native trigger uses
the existing assistive-focus acknowledgement contract.

Focused regression tests and a signed native build verify these source paths.
Ten repeated Accent/Profile cycles passed in a synthetic WebKit fixture; synthetic
phone light/dark, tablet and desktop renders were reviewed separately.

The physical iPhone candidate from `7a3921c43` (installed binary SHA-256
`ee23d1633252f1c5181baaf6dde672f918342e3e867242ab6532e428bf7a6ed1`)
uses the bundled UAT export, not a remote WebView override. Credential-free XCUI
admission and one identity-checked normal passphrase unlock passed. Subsequent
warm checks passed Appearance/Accent selection and cancellation, ten Profile
edge-close/reopen cycles, History/Profile edge presses, keyboard isolation and
overlay restoration. The Account/Preferences/Security/Vault/Support stack passed
with unchanged native Back host/root counters and no additional missing sampled
frames during its measured handoff. Native retirement, preserved Accent, no web
Close duplicate and unchanged host count/frame were asserted on each reopen.

The first Chat-family run failed an existence-plus-immediate-hittability assertion
for Profile Close. The nearest test now awaits joint native readiness within the
same ten-second boundary; its subsequent run passed. That result does not alone
establish the timing cause of the earlier failure. The strengthened runner was
installed separately without reinstalling the product, resetting the account or
repeating credentials. Failure-gated teardown does not replay uncertain actions.
Private-run result bundles were destroyed.

This evidence does not qualify native editor adoption, all-route visuals,
VoiceOver/Dynamic Type, Release frame pacing or iPad. The existing complete parity
report gate remains failed for incomplete/stale route evidence; no additional
release or iPad family is enabled.

### Historical composition gap — Profile exit, 2026-10-08

The observations below describe the pre-compositor source. The current candidate
implements the bounded seam above but has not passed physical composition
acceptance. These historical receipts must not qualify the new composition.

Retaining a hosting controller does **not** retain its visible presentation behind
a React sheet. Profile's overlay/content refs keep the shared native isolation
lease until their animated DOM nodes detach. NativeChrome suspension hides the
underlying Chat controls; fresh preparation/activation reveals them afterward.
The native dock follows the same overlay isolation owner. Passing settled tap,
retirement and reopen assertions does not prove continuous pixels during exit.

The source places native hosts above WebView content. Capacitor's current bridge
root is the WebView itself (`CAPBridgeViewController.loadView`); CSS z-index cannot
interleave its DOM Profile/scrim with those native subviews. Profile's semantic
frame also remains stationary and fades while its body slides. Finger offset
alone is therefore not a correct clipping boundary. Removing `isHidden`, releasing
isolation at `open=false`, or adding an arbitrary early-resume timer would either
paint native controls over Profile or restore interaction before isolation ends.
None of those shortcuts is implemented.

A live-underlay solution needs an explicit compositor boundary, not another React
state refresh. First qualify a public, uniform-header family: authored transparent
apertures in the base canvas, retained bounded native controls beneath web content,
and bounded UIKit hit routing only for acknowledged active slots. React keeps
Profile, its scrim and gesture authority; its portals must remain above those
apertures. Confirm the actual host containment before changing opacity or ordering,
arbitrate existing Maps transparency, and retain the window-wide privacy cover.
Suspended underlay pixels must remain noninteractive and accessibility-hidden;
fresh document/owner/revision/geometry/privacy admission is still required on return.
Failure/uncertain retirement must preserve the existing noninteractive fallback.

This is a proposed bounded architectural seam, **not implemented or qualified**.
It initially addresses uniform header backing, not live sampling of scrolling Chat
content or the private editor. Native glass can sample its backdrop: a screenshot
of a nominally public control can contain private pixels. Do not export control,
dock or WebView bitmaps through public chrome as a transition stand-in. Require
transition-time physical evidence, rather than settled screenshots, before closing
this finding. The latest separate body-drawer run ended with XCUI exit 70 and no
observed test-body receipt; it is not gesture acceptance or a vault failure.

### Agent Dock geometry correction — 2026-10-08

The web geometry remains the reference: 52-point compact bar, 24-point outer
radius, 16-point glyphs and 44-point action hit regions. The previous native
implementation measured 62 points in the nearest host regression test because
its visible 44-point labels acquired glass-button sizing. The corrected candidate
uses scaled 16-point glyphs, compact 32-point interactive glass surfaces and full
44-point hit regions, with symmetric four-point vertical padding. Dynamic Type
can legitimately increase the height; multiline editor growth remains bounded.
The implementation uses Apple's own interactive glass effect, not an imitation.

The empty label now belongs to the retained UITextView and shares its font and
text-container insets. Direct draft consumption refreshes it synchronously;
appearance and mode updates preserve selection and marked-text guards. The source
change does not itself prove visual acceptance or install a new device candidate.
The nearest native support suite passed 45 tests; the old compiled implementation
failed the new compact-height assertion at 62 points. The corrected implementation
passed height, placeholder/caret alignment and retained-editor checks. Synthetic
attached-host light/dark text/voice images were inspected for geometry only; their
captured material/backdrop appearance is not live-glass or physical acceptance.
Their diagnostic capture is explicit opt-in and restricted to an opaque synthetic
window containing no WebView or account content. The first detached-window capture
was blank and rejected as evidence. Disposable failed-run diagnostics were removed;
subsequent synthetic runs disabled verbose failure collection.
The updated signed iPhone Debug build compiled successfully. This build is still
separate from the previously installed and tested `7a3921c43` physical candidate;
it has not yet received physical visual, keyboard or accessibility acceptance.

- [HushhNativeNavigationPlugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift)
  presents a standard UIKit `UITabBar` on iOS 26+. It does not use SwiftUI `TabView`
  or `UITabBarController`; controller-only Search, minimization and accessory
  behaviors are not implemented by this standalone bar.
  Bottom glyphs and selected weights are authored once in
  [the shared icon descriptor](../components/icons/bottom-navigation-icons.json).
  Web/Android render through the icon registry; `build:brand-assets` projects
  the same official Phosphor paths into native 1x/2x/3x template images.
  The full viewBox and duotone alpha remain intact. UIKit still owns the standard
  tab material and app-projected tint; no SF Symbol substitutes remain in this
  bar. Incomplete native artwork declines admission and keeps DOM navigation.
  `verify:brand-assets` checks generation; the focused Navbar parity contract
  compares actual web geometry with the native projection, while native support
  tests require every bundled state and reject a missing-image negative control.
- [The bridge](../lib/capacitor/native-navigation.ts) passes bounded presentation
  metadata. [Navbar](../components/navbar.tsx) retains destination/action authority;
  [AppBottomShell](../components/app-ui/app-bottom-shell.tsx) reserves measured
  native geometry and retains the existing voice control. Web, Android, older iOS
  and unsupported wrappers keep the DOM navigation path.
- Document, revision, interaction, privacy and tap-sequence checks reject stale
  native requests. Keyboard, app privacy and registered web overlays isolate the
  bar and admitted native chrome. Named owning layers admit only their own Close;
  nested or anonymous overlays still block it. This is not a universal manager
  for provider SDK presentations.
- [ProfileAvatarEditor](../components/profile/profile-avatar-editor.tsx) opens an
  in-place DOM photo preview with close and existing Photo options. The preview
  itself neither writes a photo nor opens a picker.
  Both Chat and the ordinary top-shell Profile action use the shared
  `ShellActionSurface` avatar variant: a 32-point photo inside a 44-point touch
  target. Increasing its hit area does not enlarge the image or replace Profile
  with another native content container. Physical acceptance checks both entry
  points; source-derived Chromium/WebKit fixtures independently measure the
  target and photo across 360–1280px widths.
- App-wide Search is disabled and [archived](../../archive/app-wide-search/README.md).
  Navigation capability version 3 exposes Chat, One, Connect, Feed. Older native
  wrappers retain the four-tab DOM fallback; there is no global palette receiver.
- [HushhNativeChrome](../ios/App/App/Plugins/HushhNativeChromePlugin.swift) and its
  [typed bridge](../lib/capacitor/native-chrome.ts) implement a **Debug-only iPhone
  Back pilot** on iOS 26+. [NativeShellBack](../components/app-ui/native-shell-back.tsx)
  retains the shared 44px layout slot and invokes the existing Back handler.
  Release builds, iPad, older wrappers, web and Android keep the web control.
  Capability admission—not installation of a plugin—is the enablement boundary.
- [NativeChatChrome](../components/app-ui/native-chat-chrome.tsx) adds independent
  History and Cloud/Puppy presentation leases. The History button uses SwiftUI's
  standard glass button; the two-value selector uses a standard segmented
  `Picker`, not a custom imitation. They require the explicit
  `--hushh-native-chat-chrome` Debug iPhone rehearsal argument. Release and iPad
  remain on the accepted DOM controls until physical acceptance is complete.
  Pending History review badges retain DOM presentation. Choices invoke the
  existing drawer and agent-surface handlers, never a native router.
  The shared Profile stack now has its own `profile-back` lease, separate from
  shell Back and Profile Close. Every nested Profile pane invokes the existing
  `popProfilePaneLocation` action; entry, dragging, overlays and focus still use
  the Profile owner. Older wrappers do not advertise the additive family and
  retain the authored Back. Contract version 2 is unchanged.
  The selector uses cloud/machine symbols with spoken names, not repeated text
  labels. Wrapper capabilities are discovered once per document and prewarmed
  independently of route/auth readiness. Only that immutable metadata is cached;
  owner, permission, layout and privacy admission are still checked per lease.
  Eligible warm slots remain concealed across retirement/preparation, avoiding
  a briefly interactive web replacement. Failed listener installation restores
  fallback only after confirmed retirement; uncertain removal stays quarantined.
  The candidate now hands History to a native Close at the drawer's authored
  trailing slot, retiring the underlying header lease before installing the
  relocated control. Pending review badges retain DOM presentation. This is a
  Debug candidate, not physical or release acceptance of the Close handoff.
- [The owned presenter](../ios/App/App/Plugins/HushhNativeChromePresenter.swift)
  adds a controlled UIKit short action sheet and bounded SwiftUI wheel sheets
  with Done/Cancel. Native draft selections are transient; React remains the
  validator and operation owner. People's Add menu belongs to a scrolling search
  row, so it retains its authored React trigger and sheet. More, generic date
  and finite-selection adapters are implemented but have no eligible production
  consumer in this candidate. They are not claimed as adopted; complex/rich
  menus also retain their DOM path.
- Supported iOS 26+ wrappers advertise Profile Appearance and Accent with
  independent `profile-appearance` and `profile-accent` IDs. Appearance uses an
  icon segmented SwiftUI Picker for Light/Dark/System; System remains the selected
  preference even when its resolved canvas is light or dark. Accent uses the
  owned SwiftUI chooser for the existing Blue/Molten Gold values. Choices invoke
  `setTheme`/`writeAccent`; no native preference store is introduced. The owning
  Profile pane must be open and its controls stationary. Clipped geometry,
  inactive retained panes and nested overlays retire admission; native restoration
  waits for settlement and acknowledged layout. Public preference controls retain
  the iOS 17+ renderer independently of the Debug-only chat controls. The Accent
  trigger carries its retained palette into the bounded chooser. Unsupported
  wrappers retain authored controls. Physical visual, accessibility and Release
  performance acceptance remain separate gates.

  Opt-in Debug continuity counters retain fresh frame/gap deltas past 100,000
  frames; the earlier saturation could stop an otherwise warm rehearsal.
  The existing public layout probe also reports Chat focus, inert/disabled state
  and hit geometry as booleans/numbers. It never reads draft values or transcript
  content, changes focus, or submits an operation. These diagnostics distinguish
  keyboard admission from native retirement; they are not visual acceptance.

  Other bounded public candidates include Location link duration, RIA tier
  filter and rows-per-page. Location's activity-range control is currently
  disabled, not a reachable adoption target. These controls are assessed, not
  adopted: scrolling stationarity, simultaneous selector identities and their
  authored bounds must be resolved first. Record-derived
  statement pickers, vault method handles and complex multiselect stay React;
  the single-value presentation contract is not an array-value multiselect.
- [AgentDock](../components/agent/agent-dock.tsx) retains one material Agent Bar
  across route changes. Canonical Chat projects its existing form into that bar;
  microphone providers and the voice control remain mounted. Drafts and sends
  stay in Chat, with no duplicate shell draft store. Switching to active voice
  hides, rather than remounts, the same text field. Keyboard clearance separates
  navigation from the shared composer. Embedded workspaces retain their local
  form. Transcript reservation and reveal use the full retained dock, including
  the visible voice panel, never the hidden form's zero rectangle. The voice
  adapter's alternate text field is not presented alongside canonical Chat;
  its own unsent draft remains with that adapter. Reduced motion removes the
  short content transition.
  The portalled field carries its own bounded corners and six-line ceiling,
  with internal scrolling and 44-point Send/microphone targets; these styles
  do not depend on a Chat-route ancestor. Chromium/WebKit checks cover narrow
  widths, long unbroken drafts, multiline growth, shrink-back and input identity.
  Physical appearance acceptance remains separate from those layout contracts.
  Voice and the empty composer share a 52px resting frame and the same material
  and corner radius. Route handoff changes content opacity only; multiline
  writing still grows within its existing ceiling.
- [ProfilePaneDrag](../components/app-ui/profile-pane-drag.tsx) tracks a rightward
  pull of the open Profile sheet and its scrim without moving the app body.
  The controlled Sheet remains the dismissal, focus and modal authority. Short
  pulls restore the open pane; fields, controls, vertical scroll, horizontal
  rails, nested overlays and the keyboard retain their interaction ownership.
  This is a React presentation adapter, not native Liquid Glass.

Apple recommends standard system controls and reserves Liquid Glass primarily for
the interactive layer above content. Native material is not equivalent to adding
CSS backdrop blur to a web card. Author new eligible controls in SwiftUI, integrate
through the existing UIKit/Capacitor host, and retain React product content and
routing. Keep working UIKit controls, including the standalone bottom bar.
SwiftUI is not a promise of no deprecations or a reason to rewrite the app root.
See [Apple's UIKit guidance](https://developer.apple.com/videos/play/wwdc2025/284/),
[SwiftUI guidance](https://developer.apple.com/videos/play/wwdc2025/323/), and
[UIHostingController containment](https://developer.apple.com/documentation/swiftui/uihostingcontroller).

### Native Chrome Contract

The Back pilot has a bounded `UIHostingController` child, not a full-screen
transparent touch surface. Preparation acknowledges both SwiftUI geometry and
UIKit layout while hidden and noninteractive. React then hides/disables its DOM
control before activation. The original layout reservation remains unchanged.
Late activation/update failure recovery rechecks document, owner and installation
occupancy after targeted retirement. A no-op retirement that preserves a newer
mount does not authorize revealing or focusing the displaced web fallback.
Retirement is acknowledged only after touch, accessibility, child containment and
any owned presented controller are removed. Popup retirement waits for actual
UIKit dismissal completion. An uncertain acknowledgement quarantines the control until removal
is confirmed; it never retries a navigation action.

Focus-return attempts have a separate generation fence. The additive version-2
`focusReturn` capability preserves native History on an authored native/gesture
return. Its ordered acknowledgement binds the active control and applied update;
assistive return waits for an actual UIKit focused-element event belonging to the
hosting view. Unknown accessibility containers fail closed. DOM keyboard return
still holds the web fallback until blur. History retains its React slot while
open and has one return-focus owner, rather than independent drawer and workspace
restorations. Profile enters on its named heading and returns to its explicit,
current-owner opener only when no newer overlay or vault gate owns interaction.
Failed retirement never
focuses a duplicate DOM control, and it cannot latch a hold for focus that was
not transferred or clear a newer attempt. Native focus failure restores web focus
only after confirmed retirement; it never retries an action. Chat chrome's authority context includes
the existing vault-session epoch. Selector value changes use ordered updates
rather than becoming a new lease identity; History still follows its owning
agent surface. Device admission starts only after the public fallback loses
focus, independently of software-keyboard visibility. SwiftUI preparation now
measures the reserved frame with Apple's `onGeometryChange`; the earlier segmented
Picker preference reported zero on iPhone while UIKit had the correct 88×44 host.
A real hidden-host regression fails with that old preference and passes with the
geometry observer. This corrects measurement without relaxing the layout gate.

Each choice binds to the document, opaque owner epoch, presentation revision,
current route context, applied update sequence, privacy generation and choice
sequence. Capability-negotiated appearance, enabled state and finite-value
updates retain the hosting controller and lease; ordered acknowledgements fence
choices while an update is pending. Geometry, family, option-set and ownership
changes retire the lease. Owner information and
routes stay in React; neither credentials nor protected content enter the bridge.
Existing session suppression, registered overlay blockers and authored interaction
layers bound admission. Keyboard, geometry changes and native privacy transitions
retire this pilot synchronously. Delayed recovery can retire only its own revision,
not a replacement. Duplicate choices cannot replay; a new intentional tap remains
available if the owning navigation operation is cancelled.

Presentation contract version 2 projects the existing app light/dark class and
resolved accent/foreground CSS tokens into both the UIKit tabs and SwiftUI Back.
There is no separate native theme preference or palette. Back uses the text/icon
accent token, including the darker gold foreground, and a controller-local
appearance override; the application window is not restyled. A theme change
updates an in-place-capable lease and invalidates its old choices; legacy capable
wrappers retire/reprepare it. The final action check
also reads committed CSS, closing the interval before React publishes a changed
projection. Theme-only tab updates do not invalidate intentional tab selections.
Wrappers lacking version 2 retain DOM controls rather than ignore appearance.

Color roles are projected from the existing CSS authority, not chosen per feature:

| Eligible control | Glass/accent treatment | Enablement |
| --- | --- | --- |
| Stationary Back | Standard glass, app accent tint and readable accent-deep glyph | Existing Debug iPhone pilot; release acceptance remains incomplete. |
| History utility trigger / owned Close | Standard glass with the shared secondary-label glyph, preserving light OKLCH and dark RGBA opacity | Debug-only handoff; repeated physical interaction passed. Visual/accessibility/performance qualification remains open. |
| Cloud/Puppy selector and destination tabs | Standard segmented Picker / UIKit tab bar, app accent tint and system labels | Existing selector rehearsal / admitted tab bar; no invented foreground palette. |
| Future primary toolbar action | Standard prominent glass with app accent; retain authored disabled/busy behavior | Not implemented or admitted. Ordinary form, Connect and Send controls remain React. |
| Destructive or moving/keyboard-coupled actions | Retain semantic role and existing owner; never recolor destructive actions as brand accents | No global native replacement. |

Unresolved utility colors retain DOM presentation. A changed color invalidates an
old native choice before observer publication, as do existing theme/owner checks.

The candidate owns only its explicit native action sheet and bounded wheel sheets.
The privacy shield covers the actual application window and retains the cover
until all owned-popup dismissal completions and session validation finish.
Removing a hosting view alone does not acknowledge retirement. Provider SDK
presentations still retain their separate owners. Popup/device acceptance remains
required before release capability admission.

The iPhone reviewer input rehearsal uses the existing attach-only UITest, never
an authentication bypass. On this device, public mixed-character input proved
that bulk `typeText` dropped characters while its secure accessibility mask
reported the actual partial value. An explicitly selected
`HUSHH_UI_TEST_SOFTWARE_KEY_ENTRY=true` runner path uses the visible keyboard and
acknowledges every insertion before one normal Unlock. The public synthetic
probe and normal protected-Chat unlock passed; temporary probe code was removed.
Credentials remain process-memory-only. No partial input is submitted, mode is
never switched automatically after failure, and this input proof does not qualify
native controls, visual appearance or session continuity after installation.

## Shared Component Inventory

### Current Candidate and Rollback

The route inventory remains the generated [frontend/native surface map](../../docs/reference/architecture/frontend-native-surface-map.md)
and its [parity audit](../../docs/reference/mobile/capacitor-parity-audit-report.md);
this family inventory joins it without becoming another route authority. Chat,
Back and presenter pilot families remain iPhone iOS 26 Debug candidates,
explicitly rehearsed with `--hushh-native-chat-chrome`. Appearance and Accent are
public preference capabilities on supported iOS 17+ iPhone and iPad wrappers; React retains
operation authority and all owner, document, privacy and geometry fences.
Older or unsupported wrappers, Android and web retain authored controls.
Compilation does not establish physical-device acceptance.

Physical iPhone evidence at `91b4d6187` (2026-10-06): attach-only navigation,
Search, native Back/overlay retirement/background-resume, Profile photo preview
and pull-to-close, bidirectional History dragging, and Mail paging with the
software keyboard passed after normal reviewer unlock. These checks retained
one identified Capacitor host and the unlocked session; they do not establish
literal document identity, visual acceptance or frame pacing. The native
Cloud/Puppy selector was not admitted during its dedicated check; the accessible
DOM fallback remained. History was observed natively, but its complete native
Open/Close handoff remains unqualified because that journey stopped at selector
admission. No new Release or iPad family was enabled.

The same head passed canonical core and both native CI builds. Exact-head CI's
browser pack exposed one Mail selection-order regression (449 other cases
passed). Its correction uses Embla's incoming target only when captured bounds
are stale; settlement still uses rendered position. The nearest unit fails on
the old code, and the unchanged WebKit drag contract passes with the correction.
The corrected combined head requires its own core and exact-head CI proof.

At `27b7edc0c`, canonical core passed. The separately built and installed iPhone
candidate passed normal vault unlock and the same warm navigation, Back,
Profile/photo, drawer and Mail/software-keyboard journeys. Its dedicated
History/selector check still found the retained DOM controls instead of the
expected native families; native-family admission remains incomplete. Exact-head
CI passed the corrected Mail drag contract but rejected the Profile Connectors
geometry test, whose measure calculation assumed `rem` for a `px` token. The
test now resolves the authored CSS width without changing its centering, width
or overflow assertions. This test/documentation correction does not change the
installed product bundle. Full-head CI, visual/accessibility qualification and
three Release performance runs remain required before native-family promotion.

The `2335e69f0` production-targeted Debug iPhone candidate passed normal
reviewer unlock using verified software-keyboard entry. Its dedicated native
check admitted both system selector segments (44 by 49 points), opened History,
returned its native opener without another blur, and retained native Profile
Close over two consecutive openings. WebKit omitted the named dialog container
from its accessibility projection even though the public Chats heading and owned
native Close were present. The check now uses those actual interaction targets
and independently checks for duplicate web Close controls. A reviewer with no
Puppy conversation is tested through its authored empty state; the chrome check
does not create a conversation. Full selector/keyboard completion and current
combined-head device acceptance remain separate gates.

That full physical sequence subsequently passed History/Profile reopening and
Cloud/Puppy value projection, then failed native return after keyboard dismissal.
The keyboard fence previously released at `keyboardWillHide`, before animation
and web geometry completed. Chrome now remains retired until UIKit's
[keyboard dismissal completion](https://developer.apple.com/documentation/uikit/uiresponder/keyboarddidhidenotification),
with an interrupted-dismissal guard. The actual notification regression fails
on the old release point; all 35 native-support simulator checks pass with the
correction. The `5f56359fe` Debug iPhone candidate subsequently passed the full
native journey twice: History Open/Close/return, two consecutive Profile Close
cycles, Cloud/Puppy value projection, overlay isolation and native restoration
after keyboard dismissal. Warm tabs/Search, Back/background-resume, photo
preview/pull-to-close, History dragging and Mail/software-keyboard also passed.
Its canonical core and exact-head CI passed, as did a separate unsigned Release
compile. These are interaction and build checks, not Release-family acceptance.

The tightened appearance audit still fails on an unidentified 390-by-10-point
hit region outside Back. It remains a failure, not an ignored issue. The current
run proved Light canvas matching on four routes and restored the original
preference; it did not reach Dark. Stock Calculator's public mode locator also
requires characterization before claiming a physical comparison. VoiceOver,
Dynamic Type, reduced transparency, rotation, literal WebView/document identity
and three physical Release performance runs remain open. New families stay
Debug-only, and iPad is not qualified. Exact runtime details remain in the
ignored verification handoff; subsequent source combinations need their own
head-bound gates rather than inheriting this SHA's acceptance.

The combined branch also repairs early tab reversal at the shared pager: a
rounded visible pane no longer hides its different pending destination. Both
tap and controlled-route regressions fail on the old admission check. The
unchanged Wallet browser journey then exposed native focus scrolling of its
hidden-overflow viewport during travel, independent of Embla's correct target.
The shared viewport uses non-scrolling CSS clipping where supported, retaining
hidden-overflow compatibility on older engines. The unchanged draft/return
journey passes three Chromium and three WebKit runs; the WebKit page-scroll,
swipe and reduced-motion checks also pass. Temporary numeric probes were
removed. These browser results do not replace physical gesture/frame evidence.

At `6f8663c9b`, canonical core passed in 787 seconds and the separately installed
iPhone candidate passed normal unlock plus all five warm regression journeys.
The dedicated check admitted native History after releasing authored fallback
focus; Cloud/Puppy still remained on React. No selector-specific cause is yet
confirmed. An explicit `--hushh-native-chrome-diagnostics` argument now enables
a Debug-only memory-resident selector probe: admission/focus booleans, bounded
public dimensions, presentation stage and allowlisted failure codes only. It
does not project identities, context, credentials, protected content or raw
provider errors. Ordinary Debug and all Release wrappers omit the marker.

The subsequent normal merge retains `main`'s Wallet/referral changes through
`8ddcebc03`. Controlled tab taps now notify the existing pager before publishing
local selection, preserving one indicator writer without adding route navigation.
The nearest ordering regression fails on the incoming early-return path; the
combined pager/Wallet contracts pass with the correction. A temporary frame
probe did not reproduce the reviewed Wallet clipping risk in its existing WebKit
fixture and was removed; tall-content/re-grab device acceptance remains open.
Earlier core/device results do not certify this newly combined candidate.

| Family | State / operation owner | Candidate and retained behavior | Evidence and rollback |
| --- | --- | --- | --- |
| Back | Shared shell's authored Back handler | Existing bounded SwiftUI button; in-place appearance/enabled updates | Current device interaction, overlay and resume checks passed; visual/accessibility/performance admission remains incomplete. Disable capability to retain `NativeShellBack` DOM control. |
| History Open/Close | Chat workspace + existing drawer owner | One identity; geometry change retires Open and installs Close in the drawer slot. List, drafts and transcript remain React. | Repeated native Open/Close/return and keyboard restoration passed on the Debug iPhone candidate above; visual/accessibility/performance qualification remains open. Disable family capability; same authored DOM actions remain. |
| Profile Close | Controlled `ProfilePane` + Sheet | Named-layer Close after entry settlement; retires during drag/nested overlays. URL stack and photos remain React. | Two native Close cycles, photo preview and pull-to-close passed on that candidate; visual/accessibility/performance qualification remains open. Disable `close` capability. |
| Profile Back | Existing URL-backed `popProfilePaneLocation` | Independent named-layer lease throughout the nested Profile stack; no second router | Focused stale-choice/overlay regression passes and fails when the separate identity is removed. The new Debug iPhone candidate passed account/preferences/security/vault/support Back and return with one accessible 44-point control and one identified host. Visual/accessibility/performance promotion remains open. Disable `profile-back` capability; same DOM action remains. |
| More / public short menus | Explicit `ActionMenu` callbacks | SwiftUI trigger and owned UIKit action-sheet adapter; no eligible product consumer yet. Scrolling People's Add, rich labels, desktop dropdown and unauthored menus retain React. | Compiled adapter, not adoption; popup privacy/dismissal device proof outstanding. Capabilities remain Debug-only. |
| Cloud/Puppy | Chat's existing agent-surface handler | Existing finite segmented Picker, ordered current-value updates | Native choice and value-return checks passed on that candidate, with 44-by-49-point accessibility frames; full visual/accessibility/performance qualification remains open. Disable `agent-surface` capability. |
| Appearance / Accent | Existing `setTheme` / `writeAccent` | Public icon Picker / owned short menu on supported iOS 17+ iPhone and iPad wrappers, independent IDs; one Accent value/opener control; scroll and animation retirement | Focused public-value, geometry and lifecycle contracts plus simulator UIKit tests pass. System styling before iOS 26; glass where supported. Physical visual/accessibility and Release-performance qualification remain open. Unsupported wrappers retain the authored fallback. Disable the two capabilities to retain authored operations. |
| Finite/date wheel sheets | Caller validates and commits value | Bounded adapter with transient draft, Done/Cancel; no production consumer yet. Duration rails, forms and complex multiselect remain React. | Native compile and ordered-choice contracts, not adoption proof. Capabilities stay Debug-only; no product operation depends on them. |
| Drawer/pager motion | Existing Profile, History, `SwipeViews` owners | Finger-driven panels/scrims; cancellation, re-grab, single resize reconciliation; inactive panes inert | Focused cancellation/reopen/resize contracts with a resize negative control. Revert bounded shared-owner commits; no route or persistence migration. |
| Vault methods | Existing owner-authorized `VaultService` operations | Compact method rows + details/default selector. No credential suffixes; acknowledged change remains successful if refresh fails. | Profile contracts and owner/request fences; controlled server/device mutation acceptance outstanding. Revert presentation/mutation-handling commit; no store/schema migration. |

Every existing feature consumer inherits a shared family below; no page-level
native router or global primitive replacement is introduced. New adoption must
add its explicit owner, public projection, evidence and rollback here.

### Route Coverage and Device Admission

#### Complete screen accounting and batch order — 2026-10-07

The existing [generated surface map](../frontend-native-surface-map.generated.json)
accounts for **145 route entries / 144 physical pages**: 75 standard, 47 redirect,
17 hidden and 6 flow layouts. `/agent` is a virtual compatibility entry. There are
98 nonredirect physical pages, not 145 distinct native screens. The authored
[native inventory](../native-route-inventory.json) has 126 rows: 99 functional,
3 callback and 24 excluded; 20 required rows are explicitly legacy inputs.
These counts describe source obligations, not passing device journeys.

The metadata-only runtime topology projection now includes Connect's two query
views and Mail's two admitted deep links. Mail Overview is the physical route's
local default, not an invented `workspace=overview` contract. Location Inbox is
not a canonical view. Memory Saved/Add/Sharing remains local state. Query views,
local tabs, owned overlays and physical routes must all be recorded separately.
Five stale native expectations now target actual source destinations: `/ria`
resolves to Advisor Profile; Connect settings resolves to Gemini preferences;
the three legacy Profile Gmail entrypoints resolve to Mail with its existing
canonical loaded/empty/unavailable states. No route or action authority changed.

| Batch | Required interaction coverage | Current physical evidence / remaining gate |
| --- | --- | --- |
| Shell and Chat | Five bottom destinations, Search, History open/close/reopen, keyboard, dock, voice | iPhone navigation, native History/reopen and keyboard passed; complete speech/echo and Release performance remain open. |
| Profile and vault | Account, preferences, security, methods, support, photo; nested Back/Close | iPhone stack/photo and appearance/accent return passed; all nested settings and accessibility states still need acceptance. Vault operations remain separate authorized tests. |
| Connect and Consent | Connections/Circles, all four Consent tabs, person and request details | Connect and isolated Consent tab/return checks passed; record-level fixtures and complete native presentation coverage remain open. |
| Memory | Saved → Add → Sharing; immediate return tap; detail/save/share | The latest combined iPhone batch passed both swipes and immediate Saved return after the shared edge-target fix. Detail/save/share remains separately unverified. |
| Mail, Calendar and Drive | Mail's three panes and keyboard, provider connection return, read/detail | Mail pager/keyboard passed; authenticated provider calls and return paths require separate current evidence. |
| Finance, Wallet and RIA | Workspace taps/swipes, holdings detail, Wallet Back, authorized advisor/client details | Wallet Back/return passed independently. The latest Finance test observed its introductory setup screen, not a completed workspace. Authorized Finance-complete and RIA detail fixtures remain unavailable. |
| Public, auth and setup | Welcome/claim, login/back, invites, callback return, recovery | Source/fixture coverage exists; cold flows must not replace or reset the warm device session. |

The following **19 map entries have no native-inventory row**. Together with
the 126 classified rows, this accounts for every map entry without hiding gaps:

| Entries | Accounting and required proof |
| --- | --- |
| `/agent`, `/connected-systems/[systemId]`, `/kai/funding-trade`, `/kai/investments`, `/one/kai/funding-trade`, `/one/kai/investments`, `/one/setup/[capability]`, `/profile/google/oauth/return`, `/r/[slug]` | Nine compatibility inputs, not new destination screens. Validate actual targets and valid callback/slug conditions; redirect source alone is not an exercised return flow. |
| `/one/profile/connectors/oauth/return` | Functional OAuth callback despite its redirect layout: it completes provider authentication or saves custom OAuth configuration before returning. Native classification and authorized callback proof remain missing. |
| `/c/[token]`, `/one/location/invite/[token]`, `/one/location/request/[token]`, `/one/location/view/[token]` | Four hidden token flows; authorized live fixtures required. Never invent or persist private tokens for coverage. |
| `/products/hushh-tech/launch` | Hidden external-authorization flow; requires its owning launch prerequisites. |
| `/one/connected-systems/[systemId]` | Localhost-only CRM detail; Capacitor export rejects it. Web proof, not a native acceptance obligation. |
| `/ria/clients/[userId]`, `/ria/clients/[userId]/accounts/[accountId]`, `/ria/clients/[userId]/requests/[requestId]` | Three functional role-bound detail templates; authorized RIA/client fixtures required before accepted device journeys. |

`/one/messages` is now classified in the native inventory. Current-owner
selection and an authorized conversation fixture remain required for device proof.

Use one combined source candidate, nearest family contracts, core, export/sync,
packaged-runtime verification and installation. Installation is preparation, not
continuity evidence. Then attach once per device for warm family batches, serial
within a device and parallel across independent devices. Check actual entry and
destination before expecting content. A blocked family does not hide later
journeys: record them as not reached, restore through authored Back/Chat, verify
admission, and exercise those isolated paths. Preserve the original failure.
Rebuild only the runner for harness changes. Record final source/binary identities
and do not redeploy or enable new families from a partial batch.

The latest combined physical iPhone run used product `b1a7b7189` and test runner
`4b55595c2` (the intervening change was harness-only): **7 passed, 1 failed,
0 skipped**. Memory's immediate-return case now passes. Connect selection/return
passed inside the failed workspace-family test; Finance then explicitly stopped
at `WORKSPACE_FINANCE_SETUP_REQUIRED`. Consent and Wallet were not reached in
that test; their earlier independent passes are historical evidence, not new
combined-head acceptance. Never invent production preferences or RIA roles to
complete a coverage row. The iPad's public vault layout passed at rest/focus,
rotation and resume with idle passive receipt counters. It exposed no software
keyboard and has not admitted protected Chat; the earlier unlock outcome is
still unobserved. Receipt counters never read input values or event details and
do not prove handler entry or visible React settlement.

The subsequent native-render RCA found two avoidable source transitions:
unchanged resize notifications rebuilt layout-confirmed controls, and Profile
Close reapplied the outer sheet's settlement on every inner-stack change. Exact
frame/viewport comparison now preserves unchanged leases only while still
admitted; inert/clipped ancestors and real movement still invalidate. Profile
Close uses the outer pane's settled identity. Profile Back now shares that
fixed-header admission while retaining its stack-bound action context; content
controls still wait for inner-stack settlement. Identical active acknowledged updates no longer advance
the update fence; pending changes/reverts remain ordered. Four nearest regressions
failed the prior source; current focused tests pass, including owner replacement
and clipping negative controls. These changes do **not** eliminate deliberate
cross-route retirement or prove flicker-free native pixels. Physical observation,
frame pacing and accessibility acceptance remain release gates.

Retain completed journey receipts with their source/product identity. Re-run the
families affected by a shared change and previously unreached, admitted routes;
do not repeat the full sequential batch merely because the runner changed.
Independent synthetic layout/contract packs run concurrently with bounded
workers; interactions on the same physical device remain serial.

On the `77dffc907` production-targeted Debug product, the eight-test iPhone
batch passed six tests and failed two. Independent Consent (four tabs) and Wallet
Back/return then passed after authored Chat recovery and admission verification.
The iPad's complete mask-length acknowledgement did not reach protected Chat;
its outcome remains unobserved, not a proven wrong passphrase or missed tap.
The harness now requires a unique enabled/hittable Unlock before a single tap;
this closes an admission gap, but does not retrospectively explain that failure.
The shared detail Close was 40px. Six actual-component Chromium/WebKit checks
failed on that source, then passed with a 44px target and matching title clearance.
New SwiftUI families remain unqualified on iPad and disabled for Release.

Warm XCUI now includes the Profile account/preferences/security/vault/support
stack, Connect/Finance/Consent/Wallet tab and Back selection, Memory's Saved → Add
→ Sharing sequence and the existing Mail/software-keyboard check. These attach
to the normal session through visible navigation without sign-out, reset or
cold-route substitution. Vault methods are viewed, not changed. Counts and
whitelisted stage markers are the only retained diagnostics. A single identified
host and unchanged draft do not by themselves prove literal document identity.

On 2026-10-06 the physical iPad recovered normal pairing, accepted the signed
product/runner and passed credential-free XCTest admission. Its normal reviewer
unlock and protected warm journeys are not yet verified. All new SwiftUI families
remain excluded there; installation and runner admission do not qualify them.
The iPhone candidate passed the Profile stack and Connect selection/return. Its
Finance journey stopped before the expected tabs. The initial cleanup could not
return from that flow; the harness now uses authored Back/Chat recovery rather
than assuming the dock remains present. Independent warm Consent (all four tabs),
Wallet Back/return, Memory Saved → Add → Sharing, and Mail/software-keyboard
journeys subsequently passed on the `2dfcb5fe4` candidate. They preserve the
draft and single identified host; the Finance failure is not reclassified as a pass.
On iPad, whole-value entry reached the expected mask length
but protected Chat was not admitted. No rejected credential is retried to turn
that result green. The iPad fallback still requires protected route-family proof.

The 2026-10-06 tablet vault investigation reproduced an older installed
runtime's unreachable Recovery key/Sign out controls even though their native
frames lay inside the window. That runtime did not expose simultaneous CSS
bounds, so its cause is unconfirmed. A freshly prepared production-targeted
Debug product from `49e0807f6` plus the reviewed layout-probe working changes
passed attach-only rest/focus, portrait/landscape and background/resume checks.
Recovery and Sign out were DOM-hit-testable and accessibility-hittable after
each transition. Installation is cold preparation, not session-continuity
proof or evidence of a vault-layout fix; no product CSS or keyboard producer
was changed in this investigation. The physical tablet did not expose a
software keyboard, so that keyboard state remains unqualified.

The nearest boot-layout fixture now mounts the actual VaultUnlockDialog and
VaultFlow, replacing only synthetic information/operation boundaries. Six
focused Chromium/WebKit checks passed, covering handoff and both tablet
orientations with enlarged rem-based supporting copy and a 320px keyboard inset. The landscape case
must overflow and permit real wheel scrolling before Recovery can be clicked;
an overflow-hidden negative control must not scroll. Two paint frames after
the fixture's deliberate style restoration synchronize that control in WebKit.
Synthetic inset proof does not establish physical software-keyboard behavior.

The same dialog now remains mounted through 507px split-window sizing and
639/640px responsive-inset transitions, then returns to its original tablet
viewport. Six Chromium/WebKit checks pass with measured supporting-text growth
and keyboard inset 0 → 320 → 0 at each size. Pixel-sized headings do not grow
in this fixture; this is not complete Dynamic Type acceptance.

An independently characterized keyboard-producer defect treated a shorter iOS
window as keyboard absorption. With a stale 1194px baseline, an 834px window and
320px plugin overlap, it incorrectly published zero inset. The shared manager
now subtracts viewport absorption only on Android and preserves the existing
iOS plugin-reported overlap under `resize:"none"`. Both pre-resize orientation
and scene-resize regressions fail on the old calculation; all seven manager
checks pass, retaining Android full/partial absorption. Vault CSS, native
scrolling and privacy authority are unchanged. This corrects a demonstrated
under-avoidance defect, not the unconfirmed cause of the older physical clipping.
The iPad plugin's own overlap reporting and physical software-keyboard states
still require device verification.

The production-targeted Debug product built at `a0ff9c9ba` subsequently passed
the credential-free, attach-only iPad vault check at rest/focus, both orientations
and background/resume. Unlock, Recovery key and Sign out remained reachable.
No software keyboard appeared, so this does not qualify its physical overlap
or protected route/session continuity.

Broader source-derived fixtures also exercise Profile's shared nested gutter,
Connect at tablet width in both themes, Mail receipt actions, Memory detail/save
surfaces and shared dock clearance. Connect's fixture retains the real in-memory
voice metadata projection and now observes URL-backed tab choices; its Circle
card is checked on Circles, not Connections. Synthetic identity/network values
make these layout checks independent of reviewer credentials. They do not
qualify protected access, new native families or the complete route inventory.

Actual vault input targets, rather than their 56px decorative field shells,
are now measured. The former input and visibility button both failed the 44px
minimum in WebKit. The shared creation/confirmation/unlock recipe now fills
the field height and reserves a transparent 44px visibility target, retaining
the small glyph, masking and normal authentication handlers. Six focused
Chromium/WebKit checks pass, including upper-edge taps with empty input,
phone handoff, split-window resizing and enlarged supporting text. The physical
vault check also asserts those native-accessibility target dimensions.
The production-targeted Debug product built and installed at `77dffc907` passed
that attach-only iPad check: the actual input was 54 points high, the visibility
control met the 44-point minimum, and Unlock, Recovery key and Sign out remained
reachable through rest/focus, portrait/landscape and background/resume. Recovery
was independently DOM-hit-testable after each transition. No credential was read
or submitted and no account operation was invoked. The software keyboard did
not appear; physical keyboard overlap, real split-window interaction, visual
acceptance and protected route continuity remain unqualified. This current
reachability result does not establish the original older runtime's clipping
cause or authorize new native families on iPad.

Opt-in Debug-only `--hushh-vault-layout-diagnostics` provides bounded numeric
geometry and boolean hit results through `native-vault-layout`. It admits no
reviewer bootstrap, account reset, credential read, authentication bypass or
persistent report. The probe is inactive outside the foreground and absent in
Release. Current source inventory and these vault checks do not qualify new
SwiftUI families on iPad or prove the complete protected route inventory.
Retire the probe flag for ordinary runs; revert the bounded verification
commit independently without changing vault or routing authority.

The physical vault check uses actual scrollport containment and Recovery's DOM
hit result before relying on Sign out's accessibility hittability. When needed,
it reveals the escape row inside that scroller while the observed keyboard is
still present, then rechecks after rotation and resume. Unknown coordinate
geometry fails before a drag. iPad retains both supported orientations; iPhone
is checked in its authored portrait-only orientation. An absent software keyboard
remains an unexercised condition, not keyboard acceptance.

Four functional source-map entries have no complete native-inventory fixture:
selected-query `/one/messages` and the three `/ria/clients/[userId]` detail
templates. Their owning `frontend-native-surface-map` workflow must establish
current-selection readiness for Messages and build-selected, role-authorized
RIA fixtures before adding accepted journeys. A template, arbitrary identifier
or mock conversation is not a working device fixture. Messages now publishes
owner/selection-bound readiness and invalidates unfinished reads on sign-out.
Its first server-returned message remains visible during conversation-route
handoff. A failed foreground read cannot count as valid empty information.
The three RIA detail beacons now report errors ahead of retained entities and
omit provider error bodies. Focused regressions cover all four surfaces; removing
Messages' cancellation fails the owner-bound negative control. These source
repairs do not supply the missing authorized device fixtures. Token and
callback entries likewise do not become native destinations by inference.

The subsequent `main` Messages-actions sync preserves the owner-bound read and
first-send handoff. Edit/reaction/delete calls now share its operation-generation
fence; scope changes retire their selections, focus callbacks and notifications.
Acknowledgements must match the requested deletion scope and record identity.
Five old-source regressions failed; 22 focused frontend contracts and 19 backend
route/service/migration checks pass on the combined working candidate. Those are
synthetic contract checks, not deployed migration or device-action acceptance.

### Shared Geometry and Motion

Rendered geometry remains authoritative: `--app-shell-reading` and
`APP_MEASURE_STYLES.reading` now agree with the existing 720px reading canvas;
the Agent canvas remains 880px. Existing responsive 16/20/24/28px gutters, header
slots, row inset/icon columns, and measured dock clearance remain unchanged.
The former 54rem reference disagreed with the rendered canvas; this correction
is not a new global width design. Native targets reserve at least 44 points;
Dynamic Type may increase their height.

Route transitions keep their 60/90ms tier; sheets retain 300/200ms. Drawers and
finite selections settle with the shared 150ms tier. Keyboard movement retains
system timing. A re-grab samples the current rendered transform once; move
frames only change panel transforms and scrim opacity, never the app layout.
Owner/route changes cancel the presentation generation. Width reconciliation
waits for pager settlement; height-only streaming/keyboard changes do not
reinitialize a horizontally active pager. Current phone/tablet/desktop pixel
alignment and three Release performance runs remain required acceptance, not
inferred from these source constants.

Vault rows derive friendly known platform labels only. Local biometric methods
are labelled Face ID/Touch ID only when the wrapper matches capability detection;
ordinary passkeys are not relabelled as Face ID. Opaque method identifiers remain
operation inputs, never consumer labels or confirmation suffixes. Completed writes
apply their known state before refresh; stale owner/session responses cannot
replace state, clear a newer busy action or publish an older success toast.

Priority is a recommendation based on the existing authority seam, not delivery
status. **Next** means a small control-level candidate; **conditional** means a
separate interaction contract and proof are needed; **retain** means no glass
conversion is recommended. Feature instances should reuse these owners rather
than acquire separate native implementations.

| Component family and source owner | Current presentation | Native fit / recommendation |
| --- | --- | --- |
| Bottom navigation — [Navbar](../components/navbar.tsx), [native plugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift) | UIKit on supported iOS; DOM fallback | Uses the validated shared shell column and a 64-point content height, adding UIKit's safe area once. Visibility and tap admission revalidate geometry after resizing. React retains selection authority; unsupported wrappers retain DOM navigation. |
| Top bar, back, Profile — [TopAppBar](../components/app-ui/top-app-bar.tsx), [ShellActionSurface](../components/app-ui/shell-action-surface.tsx) | SwiftUI Back Debug pilot; otherwise DOM | Back interaction verified on iPhone; visual/accessibility promotion remains incomplete. Close/More/utility buttons follow only after full Back acceptance. Retain Profile photos and rich labels. No whole native bar. |
| Shell option menus — [TopShellDropdown](../components/app-ui/top-shell-dropdown.tsx) | DOM anchored menu/popover | Unused candidate, not shipped reuse: the dropdown has no production caller, and the popover's AgentSectionDropdown caller is itself unreferenced. Do not add a native family solely for this abstraction. |
| Section action menus — [ActionMenu](../components/app-ui/action-menu.tsx) | Mobile Sheet; desktop dropdown | Retain scrolling People's Add actions in LocationRedesignHub. A future stationary public trigger needs serializable item IDs/labels, disabled/busy state and separate destructive confirmation. Rich labels stay DOM. The named-circle-flows instance is not current adoption evidence because its enclosing CirclesSection has no production caller. |
| Agent/voice controls — [AgentBar](../components/agent/agent-bar.tsx), [OneVoiceControl](../components/one-voice/one-voice-control.tsx) | DOM controls over existing runtime providers | Conditional: launcher/cancel chrome only. Keep tap/hold, slide-to-cancel, recording, readiness and task state with existing owners; retain transcript/waveform content. |
| Chat history and connectors — [AgentHistorySidebar](../components/agent/agent-history-sidebar.tsx), [AgentConnectionsDrawer](../components/agent/agent-connections-drawer.tsx) | DOM panels and shared overlays | Conditional: header/close/action controls first. Keep chat list, connector forms, tools and credential handling in existing owners. Do not remount the conversation. |
| Profile and photo preview — [ProfilePane](../components/app-ui/profile-pane.tsx), [ProfileAvatarEditor](../components/profile/profile-avatar-editor.tsx) | DOM Sheet / Dialog | Conditional: header/back/close/options chrome. Retain URL-backed Profile state and photo content; picker authority already has a native adapter. |
| Record detail — [AdaptiveDetailSurface / SettingsDetailPanel](../components/app-ui/settings-ui.tsx) | Responsive DOM Sheet/Drawer/Dialog | Conditional: shared header controls. Arbitrary body/footer, editing and scrolling prevent a mechanical native transport replacement. |
| Sheets, dialogs, drawers — [Sheet](../components/ui/sheet.tsx), [Dialog](../components/ui/dialog.tsx), [Drawer](../components/ui/drawer.tsx) | Radix / Vaul portals | Conditional: opt-in native presentation for one bounded surface, not global primitive substitution. Preserve controlled open state, drag/scroll handoff and dismissal policy. |
| Menus, popovers and selection — [DropdownMenu](../components/ui/dropdown-menu.tsx), [Popover](../components/ui/popover.tsx), [Select](../components/ui/select.tsx), [Combobox](../components/ui/combobox.tsx) | DOM overlays and option lists | Next for short nonsecret action lists; conditional for searchable/edited selection. Modal and nonmodal semantics must remain distinct. |
| Alerts and notifications — [AlertDialog](../components/ui/alert-dialog.tsx), [Alert](../components/ui/alert.tsx), [Sonner](../components/ui/sonner.tsx) | DOM confirmation / inline status / toast | Conditional for simple confirmations. Keep asynchronous acknowledgement and cancellation; retain nonblocking status instead of converting every toast to a modal. |
| Route/local tabs — [TopShellTabs](../components/app-ui/top-shell-tabs.tsx), [WorkspaceTopTabs](../components/app-ui/workspace-top-tabs.tsx), [SegmentedTabs](../lib/morphy-ux/ui/segmented-tabs.tsx), [SwipeViews](../lib/morphy-ux/ui/swipe-views.tsx) | DOM selectors and mounted content pager | Conditional: native segmented selector. Route registry/query or local state remains the selected-value owner. Preserve swipe settlement and mounted panes; no second navigation controller. |
| Buttons, groups and chips — [Button](../components/ui/button.tsx), [ButtonGroup](../components/ui/button-group.tsx), [Morphy button](../lib/morphy-ux/button.tsx) | DOM form/action controls | Selective toolbar candidates only. Retain ordinary form buttons, filters and content actions; no global native button replacement. |
| Fields, input groups, inputs, textareas, checkbox/radio/switch | [Shared UI primitives](../components/ui/) | Retain form semantics. A bounded nonsecret native selector is conditional; glass is not a reason to move secret or arbitrary forms into Swift. |
| Cards, tables, charts, avatars, badges, breadcrumbs, separators and typography | [Shared UI primitives](../components/ui/) and feature bodies | Retain content-first surfaces. Chat responses, holdings, Memory and consent records are not glass panels. |
| Accordion, collapsible, carousel, pagination, sidebar and scroll area | [Shared UI primitives](../components/ui/) | Retain content/navigation semantics unless an individually justified native container is adopted. Do not change scroll ownership with a cosmetic primitive swap. |
| Command, tooltip, keyboard hints, empty/loading/progress/status | [Shared UI primitives](../components/ui/) | Retain existing semantic feedback and keyboard/accessibility behavior; do not add independent native overlays for every state. |

### Next Stationary Family: Close

The source audit identifies two concrete consumers, not a global button rewrite:

- [ProfilePane](../components/app-ui/profile-pane.tsx): its fixed 44-point header
  Close is separate from the scrolling body. Its candidate has a dedicated
  identity and admits only its named, settled Profile layer. Back still rejects
  Profile overlays. Dragging or nested overlays retire Close. The existing
  controlled `onOpenChange` and focus-return contract remain authoritative;
  credential bodies and security operations remain React.
- [LocationImmersiveMap](../components/one-location/location-immersive-map.tsx):
  its stationary 56-point exit invokes the existing `closeMap` owner. It is used
  by Location, its map route and check-in. Close now retains client navigation;
  delayed settlement and unmount cannot trigger a hard reload. Only the owning
  transition's cancellation or rejection permits an explicit retry, never replay.
  Focused regressions cover these boundaries; fresh physical warm-vault proof
  remains required before native admission. Do not bundle Locate:
  that callback can update an already-consented location share.

Profile Close is implemented as a Debug-only candidate; map Close deliberately
remains React. A ResizeObserver alone cannot detect translation of a sliding
pane: candidate Close is admitted after entry settlement and retired during a
drag or newer layer. Restore DOM interaction only after confirmed removal.
Back and each subsequent family's outstanding device/accessibility acceptance
still precede release admission.

### Density And Selection Boundaries

Compact Settings rows reserve at least 48px, with 16px heading spacing and 8px
toolbar spacing; comfortable and person rows retain their existing measures.
Inset icon separators derive their start from the actual row inset and icon
track. Starter suggestions keep equal tracks and 44px targets, with a 4px phone
row gap and 16px desktop column gap, rather than artificial 72/128px heights.
Multi-select option rails remain React: a native toolbar control does not justify
moving a searchable list, protected form or scrolling selection into SwiftUI.
Retain 44px checkbox-label targets and keep search/confirmation outside the
scrolling rail. Refer to Apple's
[Liquid Glass adoption guidance](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
and [segmented controls guidance](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)
for the interactive/content distinction and bounded selection pattern.

### Stock Apple Pattern Mapping

Compare **interaction contracts**, not just pixels or translucency. A stock app's
appearance does not establish whether its implementation uses SwiftUI or UIKit.
Apple's documented patterns inform our adapters; React still owns routes, values
and operation authority. Reference apps below are comparison targets, not a claim
that each one has been inspected on the physical device.

| Our shared family | Apple reference and eligible control | Behavior to preserve |
| --- | --- | --- |
| Shell Back / Close / Done | Hierarchical navigation and sheet dismissal; SwiftUI `Button` with a standard symbol and accessible name | Back returns one step; Close/Cancel dismisses without saving; Done completes the authored task. Do not map all three to the same handler. Retain the expanded-header slot and focus return. |
| More and short action lists | Toolbar menus; Calculator's mode menu is a physical comparison target. SwiftUI `Menu`, or controlled UIKit action sheet for a DOM trigger | Anchor to the trigger; show concise, contextual actions and unavailable state. Dismissal performs no action; destructive choices require the owning confirmation. A popup must retire under privacy/owner changes. |
| Destination tabs | Stock Clock tab bar; retain our standard UIKit `UITabBar` | Selection reflects the settled destination, not a tap promise. Sidebar state does not change the selected tab. Do not introduce `TabView` content containment or assume controller-only Search/minimization behavior exists. |
| Local bounded choices | Apple's segmented-control pattern; SwiftUI `Picker` with segmented style | Closely related, short choices with a visible selected value and consistent segment widths. Do not mix navigation/actions with selection or bypass the existing swipe-settlement owner. Scrolling/collapsing rails remain React. |
| Dates and duration | Standard picker pattern; Calendar date selection and Clock duration selection are comparison targets | Date/calendar values and elapsed duration have different semantics. Preserve bounds, units, cancellation and open-ended duration; use an explicit choice ID, not a formatted display string as authority. |
| Share / photo / bounded sheets | System Share, existing Camera adapter, and Apple's sheet pattern | Keep existing permission/export owners. Do not stack a second competing presentation. Preserve modal isolation, unsaved-change policy and return to the original content; rich content remains React. |
| Prominent and secondary buttons | Apple's standard button styles, roles and press states | Keep at least a 44×44-point hit region on iPhone without making every visible button large. Distinguish priority with style, not inconsistent dimensions. Project app accent/theme; preserve destructive role and disabled/busy state. No added idle bounce. |

Sources: [buttons](https://developer.apple.com/design/human-interface-guidelines/buttons),
[menus](https://developer.apple.com/design/human-interface-guidelines/menus),
[toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars),
[tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars),
[segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls),
[pickers](https://developer.apple.com/design/human-interface-guidelines/pickers),
and [sheets](https://developer.apple.com/design/human-interface-guidelines/sheets).
Apple's [SwiftUI design session](https://developer.apple.com/videos/play/wwdc2025/323/)
also demonstrates toolbar/menu grouping and Calendar, Mail and Health patterns.
Those examples are not permission to add another navigation stack to Capacitor.

Use content-free physical observations: whitelisted control names, geometry and
selection/dismissal only. Do not collect stock-app histories, notes, photos,
alarms or account details. Keep One running and prove return to its warm session.
Visual similarity never substitutes for VoiceOver, Dynamic Type, theme,
privacy, reduced-motion/transparency, rotation or frame-pacing acceptance.
The 2026-10-04 iPhone reference probe observed Clock's four available tabs and
their selected state, then returned to interactive, unlocked Chat. It did not
inspect timers/alarms, establish Apple's implementation framework, or prove
picker/menu parity. Unobserved reference families remain documentation-backed
comparison targets.

### Pickers and OS Presentations

| Existing owner | Current implementation | Recommendation |
| --- | --- | --- |
| [Avatar capture](../lib/profile/avatar-capture.ts) | Capacitor Camera; web file fallback | Already native on iOS. Reuse permissions, cancellation and image normalization; do not create another photo picker. |
| [Share link](../lib/share/share-link.ts), [native download](../lib/utils/native-download.ts), [wallet share](../components/wallet-card/wallet-card-share.ts) | Capacitor Share / system activity controller | Already native. Dismiss any prior native presentation before Share; keep existing export and sharing authority. |
| [Document date range](../components/consent/mobile-document-date-range.tsx) | Custom calendar and HTML month/year selection | Conditional date-picker adapter; preserve calendar dates, two-stage range selection and invalid-end clearing. |
| [Document file request](../components/consent/document-file-request.tsx), [holding editor](../components/kai/modals/edit-holding-modal.tsx) | HTML date input, WebKit-mediated picker | Reuse first. Existing direct user activation is intentional; not evidence of an app-owned `UIDatePicker`. |
| [Location duration](../components/one-location/redesign/duration-wheel-picker.tsx) | Custom hour/minute wheels plus open-ended choice | Conditional native duration selector, not a time-of-day picker. Preserve value units and “Until I stop.” |
| [Portfolio import](../components/kai/views/portfolio-import-view.tsx), [Circle chat](../components/connect/circles/circle-chat.tsx) | HTML file input, WebKit-mediated chooser | Reuse accepted types, cancellation and processing/upload owners before introducing a document-picker bridge. |

Existing picker adapters are source-verified; this navigation lane did not
physically accept every picker or its exact OS appearance.

### Feature Consumers

Consent/document reviews, contact invitations and selection, Circle/location
decisions, portfolio/RIA details, wallet confirmations and model/voice selection
inherit the shared owners above. Model, connection, wallet and consent decisions
are authority-bearing actions, not merely visual menu choices. An adapter must
never convert selecting a row into an unreviewed provider write or information share.

## Graceful Adoption Boundary

1. Prove the stationary shared Back pilot first. Then admit stationary Close,
   More and utility controls by shared owner, not separate feature dispatchers.
2. Evaluate Profile/detail header controls and local segmented selectors next.
   Search, voice controls and full sheet/pane transport require dedicated proofs;
   they are not bundled into a styling change.
3. Use standard SwiftUI controls for new admitted families, hosted through UIKit.
   The pilot uses `Button.buttonStyle(.glass)`, not imitation glass. Bounded,
   stationary, nonsecret segmented/date/duration selections are later candidates;
   their existing value validators remain authoritative. Scrolling, collapsing,
   dragged or swipe-coupled chrome stays React. A bounded Profile presentation
   `NavigationStack` is permitted only when it owns complete native destinations
   inside the retained drawer, projects the existing React route state, and
   delegates Back/operations through the existing fenced callbacks. It must not
   wrap or reparent the existing WebView to imply native transition ownership.
   No `TabView`, second WebView or second application router is introduced.
   Minimum iOS remains 17.0.
4. Each adapter needs capability detection and a DOM fallback. Keep web/Android
   unchanged, preserve unsupported iOS behavior and remove duplicate accessibility
   controls and layout reservation when native presentation is active.
5. Native callbacks must bind to the current document, interaction/presentation
   and privacy state. Revalidate the owning action before execution; cancel stale
   selections after dismissal, owner changes, backgrounding or locking. Never
   pass vault secrets or protected response bodies as presentation metadata.
6. Explicitly isolate sibling native controls when a DOM overlay opens. CSS
   z-index, DOM `inert` and Radix focus traps do not isolate UIKit siblings. Keep
   intentional nonmodal map surfaces nonmodal and restore focus on dismissal.
7. Preserve one active Capacitor document. Do not host arbitrary React content in
   a second WebView or relaunch a route to fake session continuity. A future
   SwiftUI view must remain a bounded presentation child, not a second router.
8. Keep the privacy shield opaque. Vault, credential, passphrase, OTP and
   runtime-secret surfaces are excluded from decorative glass adoption. Preserve
   existing OS-auth and secure-entry boundaries.
9. Do not restore a decorative bottom fade or add default spring/bounce effects
   to DOM controls. Native system motion is a separate OS behavior; respect
   reduced motion and reduced transparency rather than layering custom motion.

## Verification and Promotion

The 2026-10-06 focus-return candidate passes 44 nearest frontend contracts,
typecheck, focused lint and 34 native-support simulator tests. The new History
test fails against the previous DOM-only return implementation; the hidden-host
geometry test fails against the previous preference measurement. These are
regression evidence, not physical VoiceOver, visual or release acceptance.
The attach-only Chat rehearsal now requires native History return without an
unrelated blur tap and two consecutive native Profile Close presentations.

Bounded public single-choice/action menus are candidates for the existing owned
presenter. True multiselect requires an authored array-value/commit contract;
the single-value wheel adapter is not a multiselect implementation. Searchable,
rich, protected-information and scrolling menus deliberately retain React.
Circles Create/Join and fixed Reason/Duration rosters are inventory candidates,
not adopted controls: stationarity, ownership and device popup/privacy evidence
must be established before enabling them.

The 2026-10-04 Back implementation has focused lease/bridge regressions, plugin
contract checks, frontend typecheck, design/performance checks and a signed native
compile. VoiceOver/focus transfer, Dynamic Type, reduced motion/transparency,
rotation, frame pacing and persistent WebView/document identity remain acceptance
gates. CoreDevice reached the running iPhone over Wi-Fi, but
the initial attach-only XCUI attempt timed out enabling automation. That admission
blocker is now resolved: a warm native tabs/Search/overlay test executed and passed
on the previous installed app on 2026-10-04. The old-app Back negative control
reached Wallet and failed specifically at native Back admission, as expected.
The production-targeted Debug candidate was installed and unlocked through the
normal secure-entry flow. Attach-only checks then passed native tabs/Search,
the 44-point Back target and edge tap, Profile-overlay retirement, background/
resume and the existing return handler, plus photo-preview open/close without
mutation. The app process survived this sequence. Installation remains separate
cold preparation, not continuity proof. No sign-out, account reset or reviewer
bootstrap was used. WebKit's accessibility subtree includes the native Back
itself; duplicate exclusion checks its explicit identifier rather than mistaking
its shared label for a second DOM control. Photo proof returns a resumed nested
Profile setting to home through the existing Back controls.
iPad is not admitted.
This is not release-readiness proof.
The subsequent families are Debug rehearsal candidates only. Historical evidence
above does not accept this revised bridge, popup or History/Close handoff.

The 2026-10-05 coherent-controls revision passed the combined 157-test frontend
contract set, the expanded 30-test chrome contract, 33 native support tests,
typecheck, static plugin/design checks and the 16 focused vault/backend tests.
The production-targeted static bundle and signed iPhone test build compiled.
An updated runner then entered a credential-free attach-only test on the running
iPhone and found its single identified WebView; no product installation, unlock,
navigation or protected-content capture was needed for that admission check.
After the main freshness merge, 72 focused Mail tests passed with the live
receipt scanner and account-scoped cache retained. Pager settlement, vault
commit-before-rekey, delayed receipt/disconnect and stale native preparation
negative controls failed on deliberately broken implementations. Rejected native
preparation now preserves the active options and date bounds. These checks do not accept the new
popup/Close interactions, visual geometry, accessibility or Release frame pacing.
Exact committed-candidate core CI and physical interaction acceptance remain
separate gates; the new families are still Debug-only and iPad remains unqualified.

### Reviewer and Attach-Only Unlock

Use the existing canonical `REVIEWER_UID` resolver in
[reviewer-test-identity](../scripts/testing/reviewer-test-identity.mjs), not a
second account fixture. The UID can remain in the ignored backend environment
overlay; the passphrase must remain process-only. For an already-running locked
app, forward the resolved identity, expected account email and passphrase through
`TEST_RUNNER_` environment variables. The Chat-drawer test checks the visible
account before entering anything, targets the authored passphrase field, clears
any previous entry and submits normal Unlock once. Accessibility mask length is
diagnostic, not authentication. Acceptance requires the vault gate to disappear
and the Chat composer to be interactive; rejection does not trigger a retry,
reset or reviewer bootstrap.

An attach-only `.xctestrun` using `UseDestinationArtifacts` must provide
`TestBundleDestinationRelativePath` (for the installed runner's test bundle),
not `TestBundlePath`. Install only the updated test runner after compilation;
do not reinstall the product app to manufacture continuity. Keep test attachments
disabled and destroy credential-run diagnostics. On 2026-10-04, the current
candidate passed the identity-bound normal unlock/Chat-drawer check, followed by
all three existing warm navigation, Back and photo-preview checks without a
session reset. The latest run also exercised a real transcript body pan: the
drawer opened without moving the host/composer or losing vault admission.
A separate in-memory pixel comparison found the Chat status canvas matching its
header; this is not all-route or dark-theme acceptance. This proves those
interactions, not the outstanding visual,
accessibility or release-promotion gates above.

The focused Back device contract in [AppUITests](../ios/App/AppUITests/AppUITests.swift)
checks the 44-point slot, duplicate-control exclusion, complete accessibility
retirement beneath Profile, normal background/resume and the existing return-to-One
handler. It requires an already-running, unlocked app and never cold-launches a
stopped process to make continuity pass. The obsolete public Settings locator
probe was removed after direct product automation became available; no product
acceptance assertion or release gate was removed.

Physical iPhone evidence on 2026-10-03 covers the native Chat/One/Connect/Feed
journey, return to selected Chat, Chat-drawer isolation, Search opening/isolation/
dismissal/restoration, and photo-preview open/close without mutation. Both
attach-only tests in [AppUITests](../ios/App/AppUITests/AppUITests.swift) passed in
the existing unlocked session. The accessibility proof finds one identified
Capacitor host and its nested nodes; it is not a WKWebView pointer-identity proof.

The candidate was locally built and installed with production-targeted assets.
No cloud deployment, TestFlight or App Store acceptance is implied. Native state,
focused frontend contracts, typecheck and package verification passed. Exact
runtime evidence belongs in the ignored verification handoff, not screenshots of
protected content in canonical docs.

Before promoting another family, require the nearest focused contract plus its
negative control, same-session physical interaction proof, focus/VoiceOver and
Dynamic Type checks, light/dark contrast, reduced motion/transparency, keyboard
and safe-area geometry, rotation and iPad adaptation, nested-overlay isolation,
and restoration of the DOM fallback. Native visual appearance and explicit
physical keyboard/accessibility checks remain outstanding for this candidate;
source coverage or a successful build alone is not visual acceptance.

The current [ambient chrome mask](../components/app-ui/ambient-chrome-mask.tsx)
and scroll-edge behavior have existing design contracts. Changing them alongside
a native top bar requires an explicit, independently verified design change, not
an automatic material substitution.

## Native Canvas Appearance

The native backing canvas follows the committed CSS `--background` independently
of Back admission or status-icon contrast. The additive `canvasAppearance`
capability is optional for older wrappers. Strict colors, monotonic revisions and
retired-document fencing reject delayed projections; no window-wide appearance,
WebView opacity or privacy-cover change is made. The cold backing canvas uses
Apple's system background until the document projects its app preference.
Physical all-route/theme acceptance is separate from compilation or a single
Chat-band comparison. Keyboard and privacy-cover theme parity remain separate
verification items.

The 2026-10-04 warm iPhone appearance rehearsal selected Light and Dark through
Profile, verified native tab selection and status/header canvas matching on
Chat, One, Connect and Feed, and exercised the 44-point native Back on Wallet in
each theme. XCTest restored the original known app preference and returned to
unlocked Chat. Pixel samples remained in memory, with no screenshots retained.
This covers those routes and transitions, not every screen, accent, accessibility
setting, keyboard or OS privacy presentation.

Apple's [automated accessibility audit](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/performaccessibilityaudit(for:_:))
covers contrast, hit region, sufficient description and traits in the bounded
Back rehearsal. Review found that its initial filter silently ignored unnamed
elements, so that earlier pass is not admission evidence. The tightened filter
retains unidentified and Back-overlapping issues. It reported a hit-region issue
outside Back on an unnamed element; that finding remains under investigation.
This is not an app-wide audit, VoiceOver focus/reading-order proof, or Dynamic
Type/reduced-transparency acceptance. Those release-admission gates remain open.

### Chat Body Gesture

The existing history drawer owns opening and closing. The transcript supplies
the rightward opening gesture; the open panel and scrim supply the leftward
closing gesture. No window-wide touch handler or inferred button invokes
navigation. Only panel transform and scrim opacity track the finger. Resting CSS
translation is suppressed during the pull so it cannot add a second offset.
The conversation, document and bottom shell do not move or remount. Preview stays
inert; committed open uses existing focus/overlay authority. Native chrome is
isolated while dragging. Vertical scroll, horizontal tables, text selection,
inputs, overlays, keyboard and the 28px edge-back lane keep their own gestures.
Short or cancelled gestures settle to the controlled state; completed drags call
its existing owner once. A horizontal row drag suppresses the trailing pointer
click without suppressing keyboard activation or a subsequent deliberate tap.
Cancelled/unmounted gestures remove temporary compositor hints and inline styles.
Settlement uses the shared 150ms drawer tier and reduced-motion preference. Chromium
and WebKit checks cover finger-position samples and stationary body/bottom-bar
geometry at 390px and 1440px. The latest signed iPhone build also passed a real
opening and closing pan in one unlocked Chat session on 2026-10-04. This is
interaction evidence, not measured frame-pacing or accessibility acceptance.

### Shared Dock, Profile and Connect

The canonical Chat composer is projected into the retained Agent Dock on web,
iOS and Android. Its inner field stays square; the outer material owns rounding.
Growth is bounded, excess lines scroll inside the field, and action targets retain
their own 44px tracks. Profile uses one outer reading-width gutter through its
stack. Connect tab taps and swipes share the existing pager; Circles owns the
Circle discovery card.

The 2026-10-05 production-targeted Debug candidates passed warm iPhone tabs,
Back, photo preview, bidirectional drawer and voice-body cancellation checks.
S24 checks covered root/Account alignment, Circles placement and tab selection,
background/resume, and a 30-line unsent composer probe with an unbroken string:
44px to the 160px ceiling and back, internal scroll, no horizontal clipping or
action overlap, and the original draft restored. Android roster-body Profile
swipe now admits normalized static-export routes (`/one/` and `/one/index.html`)
without admitting Finance's own gestures. Trusted WebView touch verified this
on S24; OS-injected touch-coordinate equivalence is still unverified.

Native Chat History admission was observed after keyboard dismissal; the
SwiftUI agent selector remains unaccepted pending its accessible-control proof.
Voice cancellation is not Live speech-completion or echo-loop acceptance.
Keep those separate from the working shared dock and retained DOM fallback.

### Document Prewarm and Public Preferences — 2026-10-06

The handoff and public-preference candidate passes 41 focused frontend tests,
17 adjacent Profile/stack contracts and 36 native support tests. Reinstating the
old intermediate web handoff fails its focused regression. Typecheck, design and
render-performance checks, cache coherence, plugin/static parity and docs checks
pass. Production-targeted static assets, signed Debug build-for-testing, strict
codesign and actual bundled-asset verification pass; unsigned Release compilation
also passes. These are build/source checks, not physical UX acceptance.

The production-targeted Debug candidate and matching attach-only runner were
installed on the iPhone 16e. Credential-free XCTest admission and normal reviewer
vault unlock passed. The warm preferences journey passed Light/Dark/System, both
accents, two outside-cancellation/reopen cycles, panel retirement/reopening and
return to unlocked Chat with one identified Capacitor host. The original Cancel
failure was a test assumption: iOS 26 anchored action sheets deliberately omit
that button and cancel on an outside tap, as documented in
[Apple's presentation guidance](https://developer.apple.com/videos/play/wwdc2025/284/).
The test now verifies the actual cancellation outcome, unchanged preference and
interactive segment/trigger restoration, not an obsolete button. Warm entry uses
the existing Profile state and authored Back actions; it does not reset the app.
Raw diagnostics and temporary admission tracing were removed. That earlier iPad
run stopped at CoreDevice 4016; the subsequent recovery and protected-session gap
are recorded under Route Coverage and Device Admission. Simulator results do not qualify it.
That rehearsal used opt-in Debug iPhone Appearance/Accent families. The current
source supports these two public preference capabilities on iOS 17+ iPhone and iPad
wrappers in Debug and Release, using system styling before iOS 26 and glass where supported.
Older or unsupported wrappers retain the authored fallback.
It does not promote that historical rehearsal to physical visual,
accessibility or Release-performance acceptance. No merge, deployment or
distribution is implied.

### Native continuity RCA and bounded row coverage — 2026-10-06

At `48d03814d`, the production-backed Debug build, bundled assets, signature,
plugin contracts, surface map, typecheck and design-system checks pass. Canonical
core passes, including packed MCP initialization and integration. Three focused
native support tests pass on the iPhone 16e. Normal reviewer unlock submits once;
three attach-only warm journeys pass: Back/overlay/resume plus actual Consent
query-tab handoffs, History/Cloud-Puppy/keyboard/Profile reopen, and the existing
Account/Preferences/Security/Vault/Support stack. No session reset or new router
is used. These are structural and interaction results, not universal visual proof.

The Back route boundary previously removed its native hosting view before preparing
the next one. Concealing the DOM fallback did not prove that native presentation
remained visible. Additive contract-v2 Back replacement now retains the exact
same-owner/document/frame host while expiring old action authority and requiring
fresh activation. Geometry, owner, overlay, privacy and uncertain acknowledgements
still require confirmed physical removal. Independent review caught revision
allocation before the removal tombstone; construction now follows removal and
the nearest test enforces the native monotonic admission fence.

The opt-in Debug probe records only bounded host/removal/handoff/frame counts.
The strengthened warm test requires a frame after replacement/activation and a
physical-removal negative control under Profile. Both that test and the public
Preferences journey pass on the physical iPhone at `619066d88`, with one host and
the original preferences restored. It does not measure rendered glass appearance
or ancestor occlusion; earlier DOM visibility assertions are not substituted for it.

Stationary public preferences avoid an unconditional 150ms mount delay only when
animation inspection and initial geometry affirm admission. Pre-existing motion,
missing inspection and rejected geometry retain the existing settlement/recovery
path. All 54 nearest native-control tests pass; restoring the unconditional delay
fails the new stationary regression. Actual Finance source and import components
extend the existing uniform-row fixture: eight Chromium/WebKit checks pass at
320/393/834/1440px, including enlarged readable text and full-row hit surfaces.
Neither uniform sizing nor concise copy clips consent details or recovery warnings.

The same candidate's physical iPad vault-layout test passes rest, focus, scroll,
portrait/landscape and resume reachability. That run reports no software keyboard;
it does not qualify docked software-keyboard, split-view or protected-session
continuity. New SwiftUI families remain disabled on iPad and Release. Whole-app
visual/accessibility acceptance, three Release frame-pacing runs and exact-head
CI remain separate gates; this entry does not imply merge, deployment or distribution.
The `619066d88` core run passes protocol but finds a missing `kind` dependency in
the preference effect. The dependency is explicit at `a75090a6a`; its exact-head
core passes. No lint or release gate is relaxed, and later changes still require
their own exact-head proof before push.

The bounded-row audit then extends to the actual active and paused Wallet
management component, not just its Back/navigation entry. Its five Sharing
controls reproduce a 64px sibling-height spread with enlarged text before
adopting the existing uniform group policy. Eight Chromium/WebKit checks pass
afterward across the same phone/tablet/desktop widths, including readable copy,
full-row hit surfaces and all five action identities in both states. QR
continuity, pause, rotation and permanent-removal explanations remain intact;
status/date/count rows retain content sizing. This synthetic, non-private fixture
does not qualify protected Wallet operations or physical-device appearance.

The `d74f95d48` production-backed Debug product passes four attach-only warm
iPhone journeys in one batch: Back/Consent query handoff and overlay retirement,
Chat History/selector/reopen, public Appearance/Accent cancellation and return,
and the Profile Account/Preferences/Security/Vault/Support stack. No tests are
skipped. Normal reviewer unlock passes separately with one accepted submission.
The matching iPad product passes public vault rest/focus/scroll/rotation/resume
reachability, but exposes no software keyboard and does not qualify protected
tablet journeys. These receipts remain bound to that installed product, not to
later source changes. Its exact-head core passes; no native family is promoted.

Freshness integration retains main's `f103bc8bb` Wallet cleanup. Two newly
characterized regressions fail that source: an earlier owner's introduction
write blocks the current owner's Continue, and readiness reports `empty-valid`
while the introduction preference is still loading. The existing Wallet
workspace now fences the cosmetic write by owner and exact operation, including
A → B → A return, and reports loading until that preference settles. Both
negative controls pass after correction, along with the nearest 22 workspace
tests, typecheck, focused lint, cache/analytics contracts, surface-map and
service-boundary checks. No vault authority, encrypted persistence, new store
or automatic retry is introduced. This source proof is not an installed-device
or latest-head release acceptance claim.

A further independent review finds a presentation mechanism the host probe
cannot see: preparation/replacement erased a bare SwiftUI control, while updates
erased a `.disabled(...)`-modified control. Changing the erased type recreates
its hierarchy under [Apple's AnyView contract](https://developer.apple.com/documentation/swiftui/anyview).
All three phases now use the same per-family modifier shape; UIKit still
quarantines interaction and accessibility until fresh activation. An unchanged
snapshot arriving during activation no longer manufactures a native update.
The nearest combined Back replacement/in-place-update and delayed-activation
regressions both fail the prior code. All 54 native-control tests pass after the
correction, preserving genuine changed/reverted updates, exact choice sequences,
owner/overlay retirement and disabled/focus behavior. This identifies and fixes
structural churn; visible glass continuity still requires current-device proof.

The existing warm Wallet workspace case now requires enabled, hittable Cards
admission (continuing the cosmetic introduction once when present), then visits
Cards/Add/Sharing/Cards and asserts each public pane plus inactive Add isolation.
It retains Back, draft and single-host assertions. It requests no card save,
deletion, reveal or grant. A session with no pending Secrets/Chat handoff is a
prerequisite: the selected-Cards guard rejects an already observed Add handoff,
but cannot prevent an automatic reveal that was already pending. No handoff is
cleared to force admission. Public pane bodies use bounded hittability waits,
not a single sample taken before the pager settles.
Its physical result was pending at that source snapshot. The preceding product head
`eaed6d945` passes canonical core in 201s; this harness change does not inherit
an exact-head pass or claim successful sharing-information retrieval.

The installed `6117f25c8` product then passes four native warm journeys, while
Wallet fails the assumption that its two-line Sharing heading is one XCUI static
text. A failure-only public probe confirms the combined locator is absent but
both exact heading fragments and the unique explanatory paragraph are hittable.
The existing case now requires the complete combined heading or both fragments,
plus that paragraph; it never substitutes selected-tab state for body proof.
Diagnostics precede `XCTFail` because the runner stops at the first assertion.
Only fixed public anchor names and existence/hittability booleans are emitted.
The corrected Wallet-only run passes Cards/Add/Sharing/Cards, inactive Add
isolation, Back, draft preservation and one identified host, without reinstalling
the app or resetting the session. This qualifies public pane interaction, not
successful sharing-information retrieval or universal visual acceptance.

The exact `b6b94b3e2` signed production-backed Debug product is installed on
both devices. Its normal iPhone unlock passes with one accepted submission;
the Wallet-only warm journey passes all four public panes, Back, draft and
single-host checks without skips. Its iPad public-layout check passes, still
without software-keyboard or protected-tablet acceptance.

Exact-head PR validation then exposes stale derived metadata and two distinct
test/runtime seams. Canonical regeneration changes only 13 native marker
references across the three route-index copies; action and authority metadata
is unchanged. The Feed fixture changes only three content-sizing attributes.
Profile's redundant exact opening-tag assertion is removed; the independent
group/icon/layout and no-duplicate-workspace/Security contracts remain.

The real Radix close callback can restore Message options focus after Reply's
animation frame. The nearest owner/route regression now forces that ordering
and fails the earlier source. Reply hands focus over at actual menu-close
settlement instead, bound to the current operation and individual menu opening.
Reopening cannot consume the newer Reply intent; ordinary Escape still returns
focus to its trigger. All 14 nearest message tests pass.

History's DOM opener also treated pointer entry as keyboard entry, intentionally
holding a focused web fallback after Close. The existing opener is factored
beside the authored Close family without moving parent route/drawer authority.
Explicit pointer clicks may use acknowledged native focus; keyboard/ambiguous
clicks retain DOM focus until blur. The actual opener/Close component journey
with delayed capability discovery fails the old pointer policy and passes the
correction plus its keyboard negative control. This models parent focus return;
it is not yet physical pointer/assistive-activation or uninterrupted-pixel proof.

Tablet WebKit layout measured footer containment immediately after scrolling
started. The existing recovery test now polls its unchanged complete geometry
predicate after real wheel input and additionally proves the footer remains
uncontained with overflow deliberately hidden. Four Chromium/WebKit checks
pass twice across portrait/landscape and split-width iterations, with enlarged
text and fixed-frame keyboard occlusion. No timeout, pixel tolerance or hit
region is relaxed; this does not simulate native keyboard events.

Verification is selected by the changed seams, not by replaying every accepted
device journey. New source still requires frozen-head core and exact-head CI.
The unidentified Wallet hit-region issue and broader accessibility/Release
performance gates remain open; no family, merge, deployment or distribution is
promoted by these bounded results.

The row audit now covers Voice's finite domain group and Mail's existing Actions
group through small presentation-only leaves; the original preferences and Mail
workspace retain all operation/state ownership. Source-equivalent content sizing
fails the nearest WebKit geometry contract with 19px and 33px sibling spreads at
393px. The shared uniform policy passes all eight Chromium/WebKit cases across
320/393/834/1440px, including actual enlarged copy, one readable description per
row, Voice's switch-only interaction and Mail's connected/reconnect/unavailable/
busy states. Busy connected Sync/Disconnect do not execute. All 25 nearest owner
and row contracts pass; no permission or deletion explanation is removed. Mixed
Appearance/Accent controls and protected record lists deliberately retain their
existing content geometry rather than a global uniform-height override.

Canonical route-index repair also requires dependent topology, capability-graph
and workflow-card regeneration. Semantic action/workflow nodes are unchanged;
mirror equality and repeated generator checks pass. Failed earlier core runs
remain failures, not evidence inherited by the newly combined candidate. The
Wallet accessibility probe now emits only fixed public-copy IDs and unique
frame/label-match booleans; it does not waive the audit or expose unknown text.

The signed production-backed Debug `50464e5d8` product is installed on both
devices, with packaged assets and signature verified. Normal iPhone unlock
passes once; the changed-family batch passes three attach-only warm journeys
with no skips: Back/query handoff, History/selector/keyboard/reopen, and the
Profile Account/Preferences/Security/Vault/Support stack. The same iPad product
passes public vault rest/focus/scroll/rotation/resume reachability, but exposes
no software keyboard and does not qualify protected-tablet operation. The next
iPhone theme audit times out enabling automation before its test body enters;
no vault credential is retried. These action/host receipts do not establish
frame-continuous glass appearance or resolve the unidentified Wallet hit region.

Exact-head CI then exposes one stale source-location assertion in both the
targeted-node job and full Vitest shard 1/3: it looks for Drive's accessible
review label inside the parent after the History opener moved to its leaf.
The parent still owns and passes the scoped count. The existing native test now
renders that actual leaf, proving singular/plural counts, attention without a
visible dot, expanded concealment and zero-count native admission without
forwarding the count. Freezing the accessible label fails the new assertion;
restoring it passes all 69 nearest checks. The parent wiring/singleton/sidebar
activity checks remain. Neither runtime code nor a CI gate is relaxed.

A further rendered check catches a distinction the height contract missed:
uniform siblings still vertically center their differently wrapped text blocks,
moving title starts by 9.5px at 393px WebKit width. The existing fixture now
requires shared relative title starts as well as equal heights. The shared
uniform-row policy stretches the content track and anchors text at its start;
icons and trailing controls keep their centered alignment. All eight existing
Chromium/WebKit cases pass at 320/393/834/1440px with ordinary and enlarged
text, unchanged readable descriptions and actual action/busy-state checks.
Content-sized mixed controls and record lists are unaffected. This CSS/browser
proof does not inherit physical acceptance from the earlier installed product.

Independent review then identifies title-only Profile/Legal rows as a separate
alignment boundary. Rendering the actual `ProfileLegalRows` in the existing
fixture fails title/icon/chevron centering on the unguarded alignment change.
Both alignment classes now require actual supporting copy; title-only rows keep
their original centering. The same eight browser cases additionally require two
real Legal rows, centered titles/icons/chevrons, enlarged computed text and both
authored callbacks. No global description clamp or empty supporting text is
introduced to manufacture symmetry.

History's stationary header still hard-retired its host on an agent-context
change, unlike Back's retained handoff. Contract version 2 now negotiates a
History-only replacement capability through the same state machine. Same
mounted owner/document/family/label/expanded state and exact frame/viewport are
required. The host stays visible, but predecessor choices expire immediately;
fresh activation restores interaction and accessibility. Owner, privacy,
keyboard, overlay, relocation, unconfirmed updates and unmount still require
removal. Older wrappers retain their existing strict-install fallback. New
families remain Debug iPhone opt-in, not Release or iPad qualified.

The nearest pending-choice/uncertainty/unmount/late-failure tests now cover both
Back and History. Same-frame History replacement fails the earlier source.
Independent review catches a separate retirement-wait geometry race: the strict
path remeasures after acknowledgement; a deferred removal with a DOM-only move
fails the stale measurement. SwiftUI's single Button uses an explicit bounded
interaction shape; no duplicate tap recognizer or inferred web action is added.
The signed production-backed Debug `75085fa28` iPhone candidate passes the
guarded center/cardinal edge presses for History, owned Close and Profile Close,
including five Profile reopen cycles. Its One/Puppy/One changes retain the
History host with no sampled missing frames; keyboard retirement and return
also pass without a second blur or account reset. Native Appearance/Accent
selection, cancellation and reopening, plus the Account/Preferences/Security/
Vault methods/Support stack, pass separate warm journeys. Bidirectional body
drawer gestures, Mail with its real software keyboard, Memory's Saved/Add/
Sharing swipes and Connect's Circles/Connections tabs also pass. The explicit Debug
launch opt-in is preparation, not continuity evidence. Host/frame receipts
still cannot establish uninterrupted glass pixels or Release frame pacing.

The same review exposes an independent teardown boundary: an older mounted
control could untargetedly remove a newer installation sharing its control ID.
Back and the generic chrome wrapper now guard unmount removal with the existing
outstanding document, instance epoch and revision. Its own uncertain handoff
still removes either native revision; another installation is untouched. The
actual A/B mounting test fails both older Back and History cleanup paths and
requires the replacement to remain actionable, then retire on its own unmount.
This does not qualify other asynchronous recovery paths or device pixels.

The same A/B case also reproduces inactive reconciliation retiring the newer
mount, both normally and after an owned removal fails late. Back and the generic
chrome wrapper now restrict inactive cleanup and its recovery to the existing
installation-ownership guard; an occupied newer slot keeps the older fallback
concealed. Active strict takeover and uncertain-predecessor cleanup remain
unchanged. The source regression checks and `75085fa28` device receipts are
different evidence: the later inactive-cleanup change needs its own candidate
and exact-head verification.

The same ownership tests additionally reproduce late active-preparation and
listener-setup failure removing another mount's successful installation. Recovery
now removes only its owned uncertain revision, or a vacant slot, and always
releases partially installed listeners. A successful delayed removal also cannot
resume admission over a newer installation: the existing revision fence is
rechecked before minting the next lease. All these negative controls fail the
unguarded paths; they are source evidence, not physical appearance proof.

Normal inner Profile navigation previously delayed Back admission for 300ms
despite its header living outside the sliding content. The optional version-2
`profileBackReplacement` capability now reuses only the same Profile Back host,
document, owner, label and exact geometry; its location-bound authority expires
before fresh activation. Shell Back and Profile Back cannot exchange identities.
Old wrappers use strict retirement; entry/drag, changed geometry, privacy, nested
overlays, uncertainty and unmount still remove the owned presentation. The nearest
Profile and handoff tests cover retained headers, expired choices and failed
replacement recovery. The physical stack test now requires observed host/frame
counters during Security → Vault methods → Security. Identical presentation also
retains the SwiftUI root when its focus request is unused; a previously used
focus object still resets for the new lease's focus sequence. Fresh identity,
noninteractive/AX quarantine and activation remain required. Debug counters
distinguish root rebinding from host retention; neither proves uninterrupted
glass pixels. Until that latest product
passes, the prior `75085fa28` interaction receipts do not prove this change.
Chat/One/Connect still have different authored header controls; this bounded fix
does not establish one continuous native presentation across every route.

Native focus return also hard-retired an already-active stationary History
control before requesting focus. The acknowledged focus path now reuses only
the current document/instance/revision's installed control, with unchanged
geometry and appearance and no pending update or DOM focus hold. The nearest
focus test fails the old source's additional retirement/preparation/activation
cycle; moved geometry, failed preparation, owner changes and resized pending
focus still exercise strict recovery. Independent review identifies another
boundary: a delayed focus response from a displaced installation could expose
its DOM fallback beneath the replacement. The same test reproduces that
outcome and requires stale-slot/document focus to settle false, preserve the
fallback quarantine and leave the replacement actionable without removal.
These source checks do not replace appearance, accessibility or Release
performance evidence. The `75085fa28` theme journey passes light status/header
matching on Chat/One/Connect/Feed, then fails the hit-region audit on Wallet's
source-authored helper copy. Dark-mode steps are not reached and the issue is
not waived. Isolated simulator diagnostics associate the recurring plain-root
appearance warning with the temporary hidden-selector fixture: the geometry
fixture reproduces it, while a state-only comparator does not. Exact teardown
causality and product presenter acceptance remain unverified.

The latest Circle layout from main is normally merged at `97bd81e7`; the four
incoming files leave the native and Wallet fixes unchanged. Its core passes in
232s and all 65 focused Circle tests pass. The subsequent nearest native,
Wallet and continuity contracts pass 105 checks. These results retain their
source identities; later heads still need canonical core and exact-head CI.

### Wallet navigation and current-candidate admission — 2026-10-07

The UAT-backed `b57bd1023` simulator candidate passes ordinary reviewer unlock
and warm native Preferences, but its Wallet admission fails before the tab
journey. Sanitized geometry establishes that Cards is enabled but above the
viewport (`y = -50`), not that the vault input or backend failed. Its CI also
fails Wallet/Location header-position parity. The nearest browser negative
control reproduces the hidden tabs before any locator action can scroll them
back into view.

Wallet now uses the page's existing top position for entry, card selection and
All cards instead of aligning its body above the authored title and tabs.
The Wallet content region uses non-scrollable horizontal clipping: a separate
Chromium negative control measured focus scrolling that region by 16px and
clipping the first tab after All cards. No new scroll, route or gesture owner
is introduced. Card artwork, reveal authority and real card proportions remain.

The corrected source passes 24 focused Chromium/WebKit cases and 34 nearest
Wallet unit tests, plus typecheck and targeted lint. Title/tab visibility stays
strict; the artwork check directly proves exact rectangle containment, fixed
chrome clearance and input hit points, avoiding WebKit's fractional rounded-mask
intersection quantization without a tolerance or expanded product clip boundary.
Actual loaded-artwork pointer clicks, swipes and wheel scrolling remain required.
A stale visible-heading class assertion is removed; panel alignment remains.

These source results are not the corrected installed-candidate result. Fresh
combined-head builds, core, CI and warm Wallet admission are still required.
Both physical devices remain paired but unavailable over Wi-Fi, with no observed
discoverable endpoint or usable tunnel. Cached device metadata and signing
profiles do not prove transport. iPad, accessibility, visual continuity and
Release performance qualification remain open; no native family is promoted.

The subsequent `f5a53530a` candidate passes uncontended canonical core, UAT
package preparation, device/simulator Debug test builds, asset checks and device
signatures. Its simulator passes all 40 native-support checks, ordinary reviewer
unlock and an attach-only warm Wallet tab/draft journey. Installed binary and
configuration match, as do all 1,394 public frontend files. This qualifies that
simulator candidate, not the unavailable physical devices or a later head.

Incoming Wallet Profile artwork from main retains the existing inert iframe and
parent hit surface. Its first profile loader fails two nearest negative controls:
previous-owner artwork remains visible during owner replacement, and an older
refresh overwrites a newer response. The merged projection binds rendering and
both success/failure settlement to the current owner/vault/token visit and latest
request. A locked vault does not initiate the protected profile read. The tests
then pass with all 34 focused Wallet checks. No new profile store is introduced.

The incoming standard-width shell, profile name/QR overlays and simplified Add
copy are retained. Duplicate workspace animation-frame scroll resets are not:
the verified browser-local page-start owner already provides the same behavior.
All 24 focused Chromium/WebKit cases pass, including exact Location header/tab
geometry, pane alignment, artwork/name/QR taps, swipes and bottom-chrome clearance.
This later combined source still requires its own core, native builds and CI.

The `a9dd0b1b9` combined candidate passes canonical core, device/simulator Debug
builds, bundled-asset checks, 40 native-support checks and ordinary reviewer
unlock. Exact-head CI nevertheless fails its WebKit Wallet journey: 1024px
exhausts the unchanged 30-second budget on three attempts; 320px is flaky.
Name/QR pointer cycles are now separated into a short test at each existing
width, preserving loaded-artwork admission and every navigation/Add assertion.
Named steps expose the failing phase. Both focused engine runs pass locally;
Linux exact-head CI remains authoritative. No timeout or layout waiver is added.

The first combined warm simulator batch passes Preferences but fails four other
journeys. Three probes are unavailable because preparation omitted the explicit
Debug diagnostics launch flag. Wallet fails on composer availability, not proven
draft loss; a later admission observes the public session-recovery screen.
Corrected cold preparation reaches the ordinary vault gate and normal unlock
passes once. This is a new preparation, not continuity of the failed session.
Corrected warm acceptance and physical qualification remain separate gates.

Corrected `a9dd0b1b9` preparation subsequently yields four warm passes: Back,
Preferences, the Profile settings stack and Wallet tab/draft continuity. History
reopen/hit-region and Cloud/Puppy handoffs report zero sampled missing frames.
Chat remains failed at keyboard isolation: its History AX element still exists
when the keyboard is observed. Layout-probe evidence was not enabled in that
preparation; neither product causality nor full-batch acceptance is established.

The nearest attach-only keyboard check now requires a fresh public layout packet,
an observed keyboard, both native controls absent and a confirmed History host
removal in one bounded ten-second check. It retains restoration and single-host
assertions; this harness correction does not prove a product fix. Prepare with
all three explicit Debug arguments before normal unlock:
`--hushh-native-chat-chrome --hushh-native-chrome-diagnostics --hushh-vault-layout-diagnostics`.
The earlier four-pass/one-failure result remains recorded until rebuilt acceptance.

The next main refresh (`ae3f73b09`) retains Consent same-state navigation,
independent summary/list availability and responsive date selection, plus
profile artwork on all three illustrative cards. Its Sharing profile-loader
copy fails the locked-read negative control. Sharing now consumes the existing
workspace's current-owner projection instead of starting a second read/cadence;
locked rendering removes its projected name and QR. The workspace's owner and
latest-request fences remain authoritative. Incoming artwork captions are
repaired for encoding, without changing card proportions or native admission.
The deferred date grid also fails a held-scheduler negative control: a day from
the previous year can commit while the selector already shows the new year.
Pending cells are now disabled and their commit handler rejects the stale grid;
selectors stay responsive and current-grid selection remains accepted.

At `736511f9f`, canonical core passes in 204 seconds, both Debug native builds,
bundle/signature checks and all 40 native-support tests pass. Installed simulator
binary/configuration and all 1,394 frontend files match. Normal unlock and warm
Wallet tab/draft return pass. Chat still fails keyboard isolation. Fresh public
measurements report focused input but no keyboard inset; a subsequent stronger
Mail check confirms an offscreen keyboard at y=922 in an 844-point window.

The shared test guard now requires finite positive geometry with visible window
intersection, including settlement and dismissal. Its regression fails
existence-only admission and passes the stronger guard. Failed focus attempts
still blur through the authored header. No native product retirement code changed;
the cause of the missing onscreen keyboard is unconfirmed. Headless simulator
checks do not qualify software-keyboard, physical-device or visual acceptance.

### Debug product metadata compatibility

The App target's Debug configuration opts out of the separate debug dylib.
At `f6a6207e3`, an otherwise successful default Debug build omitted required
App Intents metadata on device and simulator. The unchanged product validator
rejected both bundles. A controlled monolithic Debug build restored the
metadata, with 19 actions and 10 shortcuts observed in the simulator bundle.
The earlier dylib build succeeded, so neither an SDK defect nor a universal
dylib incompatibility is established.

This is an App-target compatibility setting, not a workspace-wide override;
Release, packages and test targets remain unchanged. Apple supports the
[per-target opt-out](https://developer.apple.com/documentation/xcode/understanding-build-product-layout-changes).
It removes modern Previews eligibility for App, while separate framework and
package Previews remain available. No authored App previews were found in
the inspected source. The metadata gate is not relaxed or replaced with copied
output. Require ordinary device and simulator builds without a command-line
override, their actual bundle checks, and independent runtime acceptance.

Ordinary device and simulator builds with the target setting now pass the
unchanged product-bundle validator, and all 40 native-support tests pass on
the simulator product. These are packaging and host-contract results, not
physical-device, Siri discovery, visual or release acceptance.

The subsequent main refresh at `03ab9d8fc` retains the demo collection reset
on Cards activation, the NWS QR removal and the Profile details adjustment.
It does not retain active-tab keys that replace the Cards panel: the nearest
Travel → Add → Cards regression fails that implementation. The existing
owner-bound panel identity and activation reset pass together, preserving the
single page-start owner, inert artwork and owner/vault/request projection.
The corrected merge passes 32 nearest Wallet tests and 24 Chromium/WebKit
layout cases, including Add-draft continuity and long details. These results
do not supersede exact-head core, CI or installed-device acceptance.

### Physical passphrase rehearsal and diagnostic boundaries

The existing Debug `-UITestMode` preference can force the normal passphrase
form even when biometric unlock is the account default. Explicitly pair it
with `-UITestResetAppState false` and `-UITestAutoReviewerLogin false`, with
no injected initial route or credential at app launch. This does not change
the account's primary method or bypass vault cryptography. The configured
memory-only reviewer helper supplies the whole value once through the normal
secure field; secrets never enter launch arguments, artifacts or this document.
Cold preparation is separate from subsequent attach-only warm journeys.

At `3d9974107`, the physical iPhone passes normal passphrase unlock, all eight
warm route cases and Voice Bar body cancellation. The route batch covers Mail
with an onscreen keyboard, Memory Saved/Add/Sharing, native Chat controls and
edge presses, preferences, the nested Profile stack/photo preview, and
Connect/Finance/Consent/Wallet selection with the same host/session/draft.
These results do not qualify Release frame pacing, iPad or whole-app visuals.

Exact-head Linux CI still fails four WebKit Wallet scroll/alignment cases despite
focused macOS passes. The existing synthetic tests now report bounded geometry
without changing viewport requirements or budgets. Physical light status-canvas
checks pass, but an unidentified outside-Back accessibility issue remains after
Wallet readiness is proven; no issue is waived by coordinates or passive copy.
The existing audit reports fixed source-owned candidate comparisons only, never
an unknown label or protected hierarchy. Live speech does not observe the
synthetic input transcript, so completion/echo-loop acceptance remains open;
capture is stopped and the original appearance/session restored after failures.

An attach-only run uses installed destination artifacts. Rebuilding a runner
does not install it: verify its strict signature and install only the updated
XCTest runner before assessing changed test diagnostics. Do not replace or
restart One to update that runner, and do not present the rebuilt App binary
on disk as the installed product without separate installation evidence.
