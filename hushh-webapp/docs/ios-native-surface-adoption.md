# iOS Native Controls and Liquid Glass

This guide describes the native presentation boundary, current evidence and
release gates for One. It is maintained by the frontend/native shell owners.
Earlier candidates and detailed receipts remain in [Git history](#evidence-and-history).

## Visual Context

The [webapp documentation map](./README.md#visual-map) places this guide in the
shared frontend/native shell. One Capacitor host retains the WebView; native
controls present actions owned by React and existing services.

## Resume handoff

**Validated 2026-10-29.** Continue in the current root worktree on
`claude/hushh-infrastructure-analysis-7o991c`. The implementation snapshot is
`a38cf0480ada538ef659a07070e056abba6f2978`. Native integration is partial and
not release-ready. Track the existing
[#7824](https://github.com/hushh-labs/hushh-research/issues/7824); keep this file
as the single maintained handoff and coverage record.

Against fetched `origin/main` at `b889c7fd520540811c2b53392c50728d64c1d344`,
the implementation snapshot is **24 commits behind and 99 ahead**. Main has newer Contact,
Calendar, Drive/document and managed-AI changes. Integrate current main before
preparing another combined candidate; preserve team behavior and resolve files
selectively. Do not switch back to the old ADK worktree or reset this root tree.
Another agent has local `.agents`, documentation, CI/release-script and TypeScript
configuration edits, plus `.build/` work. Refresh `git status --short` before
editing or committing; preserve those files and their processes.

The agreed scope remains native navigation, controls, forms, menus and sheets
across every reachable product journey, with suitable rich content staying in
React. iPhone is the physical acceptance target; iPad layout uses simulator
support unless separately requested. Continue through **Dev-only** delivery.
Keep ordinary-build fallback and the qualification flag unchanged; UAT,
TestFlight and production promotion are outside this continuation.

## Validated work and evidence limits

| Work | Evidence | Limit |
| --- | --- | --- |
| Committed-document authority (`5947b7b89f`) | Three lifecycle tests previously passed on physical iPhone and simulator; document identity gates native actions and forwards Capacitor navigation callbacks | Debug lifecycle evidence, not protected-route acceptance |
| Refused pane cleanup (`0884291101`, `fd6cd9cc87`, `81d2078580`) | Identity-bound retirement readback, failed-acquisition rollback and staged-child cleanup exist; five lifecycle cases previously passed on phone/simulator | Recheck integrated Profile navigation and resume; do not reimplement the existing readback contract |
| Owned presenter dismissal (`0884291101`, evidence `ed439cc275`) | One physical UIKit dismissal test previously passed | Does not qualify the complete routed Profile handoff |
| Standard-host bottom scrolling (`a38cf0480a`) | Previously observed physical run: Chat drawer continuity and three scroll hide/reveal cycles passed; draft, keyboard and single-WebView checks passed. Focused native test passed on phone/simulator; generic iOS Release build passed | The device journey used the ordinary React dock (`native_dock=false`), not the custom SwiftUI dock. Exact installed executable/source provenance and Release frame pacing still need a retained receipt |
| Current lightweight checks | Re-run for this handoff: static Capacitor/Siri checks, plugin parity (25 plugins), all 26 native-navigation JavaScript tests and `git diff --check` pass | These checks do not qualify visuals, accessibility or the complete app |
| Complete route reports | Re-run `verify:capacitor:reports`: **fails**. Current inventory has 147 routes, 119 required. iOS has 13 results (12 pass, 1 fail) while declaring 91 audited; Android has 57 results (45 pass, 12 fail) while declaring 103 audited | Reports are stale/incomplete; query tabs and nested states also need explicit coverage |

Prior device/build results above were observed in the preceding execution,
not rerun for this documentation handoff. Temporary XCTest bundles and logs
were removed after extracting their results. Their summarized outcomes are
not retained visual artifacts. Future combined acceptance needs a compact,
sanitized source/build/environment receipt before temporary cleanup. No push
or deployment of `a38cf0480a` occurred in that execution; live Dev serving
provenance was not checked in this handoff.

The docs verifier passes runtime/link/governance/brand/diagram checks but fails
the shareable-link scan on five existing `tmp/` handoffs with absolute paths.
Coordinate that cleanup with the active documentation lane; do not delete
another agent's handoff or weaken the check. This handoff creates no duplicate
temporary artifact.

**Open visual finding:** an earlier scroll run measured the dock bottom at
852 points against a viewport bottom of 844. The final test replaced the
no-clipping assertion with a 160-point travel bound. Its pass therefore proves
movement and restoration, not an unclipped dock or synchronized transition
frames. Compare the authored web behavior and native candidate before deciding
whether this is intended hiding or a defect; do not mark it visually accepted.

The read-only native review found two further evidence gaps. The scroll test
allows five seconds to reach an endpoint, so it cannot detect transient
React/UIKit separation. The new ordinary-host press observer also lacks direct
press/release/cancel and momentum-selection coverage; the test's claim that
touch tracking already has native unit coverage is unsupported. Follow up in
[the UI test](../ios/App/AppUITests/AppUITests.swift),
[the scroll plugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift)
and [NativeSupportTests](../ios/App/AppTests/NativeSupportTests.swift).
Establish intended clearance, restore the appropriate geometry assertion with
a failing negative case, then verify one selection and resumed scrolling after
press cancellation. These are open validation findings, not newly proven
runtime crashes.

## Continue in this order

1. **Integrate and pin.** Re-read root instructions and the mobile workflow,
   refresh main, preserve concurrent edits, then record the integrated SHA.
   Reuse valid evidence only when its dependencies are unchanged.
2. **Close shared presentation risks.** Review the clipping finding above and
   the recorded listener-installation reconciliation / Back reservation-ordering
   gaps. Exercise failed admission followed by retry, document replacement,
   actual popup dismissal and Control Center/background recovery. Keep coverage
   until the same current owner/document is ready; no operation replay.
3. **Finish the hard Vault and Profile journeys.** The main locked gate still
   uses React `VaultFlow`; existing native Profile password scenes do not replace
   creation/unlock/recovery. Reuse Vault operation owners and typed private scenes.
   Traverse every current Profile entry and nested editor/menu/confirmation,
   including Software Updates, Hosting, providers, photo and Legal paths.
4. **Finish the remaining shared families.** Use the inventory below for
   Chat/History, Memory/World Model/Connect/consent, Mail/Calendar/Drive,
   Finance/Wallet/linked workspaces, and Location/Feed/Search/messages/tasks.
   Route markers establish reachability only. Record actual saves, cancellation,
   failure, destructive fixture outcomes and return paths for each nested state.
5. **Qualify and deliver one combined candidate.** Separate installation from
   warm tests. Check transition frames, touch, keyboard/IME, themes, accessibility
   and three physical Release performance runs. Run canonical core once before
   push, require CI on the exact head, then follow the existing Admin SOP for
   landing and Dev delivery with serving provenance. Do not weaken failed gates.

### Practical resume details

- The iPhone 16e was available/paired at this validation; selected tools are
  Xcode 27.1 (`27A9275`). The earlier physical run reported iOS 27.2. No XCTest
  worker is being kept alive. Recheck transport, device lock, XCTest permission
  and Vault admission independently before a new run.
- Use the existing environment-wired reviewer and process-only credentials.
  The user has authorized candidate installs/restarts with possible draft loss;
  repeated approval requests are unnecessary. Keep real mutations on disposable
  Dev fixtures and financial activity sandboxed; preserve the shared reviewer.
- Foundation owners: [pane retirement](../lib/capacitor/use-native-content-pane.ts),
  [Chrome contract](../lib/capacitor/native-chrome.ts),
  [native presenter](../ios/App/App/Plugins/HushhNativeChromePresenter.swift),
  [drawer owner](../ios/App/App/Plugins/HushhNativeDrawersPlugin.swift),
  [Profile adapters](../components/profile/use-native-profile-features.ts), and
  [hard Vault](../components/vault/vault-flow.tsx).
- Focused scroll cases live in `NativeSupportTests.testNativeBottomScrollMovesTheStandardReleaseTabBarWithoutACompositor`
  and `AppUITests.testLocalSessionNativeBottomChromeFollowsTheSharedScrollOwner`;
  the adjacent warm check is `testLocalSessionChatDrawerDoesNotReplaceThePage`.
  Rebuild only the runner for harness-only changes; avoid repeated whole-app installs.
- Keep results concise here, retain history in Git, and clean only identified
  task-owned artifacts. No new handoff copy, route registry or test framework.

## Shared component inventory

| Surface | Current boundary | Evidence and next step |
| --- | --- | --- |
| Bottom navigation | UIKit `UITabBar`; existing navigation owner retains route selection | On iOS 26+ phones, follows the shared scroll-progress owner in both the standard Capacitor host and the optional native compositor. Keyboard, privacy and overlays still pause movement. Verify the exact Release candidate for visual and physical acceptance. |
| Chat, Agent Dock and History | React owns drafts, voice, actions and routes; the qualification shell supplies retained native presentation | Earlier warm journeys are historical evidence. Complete overlapping drawer and editor qualification before enabling by default. |
| Profile and nested settings | Typed native scenes where admitted; existing React feature owners and fallback elsewhere | Earlier read-only journeys covered several entries, not full-family acceptance. Verify every destination and its nested states on the candidate. |
| Wallet, menus and sheets | Existing feature owners; bounded native presentations where capability and ownership are admitted | Local `fced42dbbc` includes focused Wallet sharing and early workspace-choice regressions. Payment mutations and the combined candidate remain unqualified on device. Rich or unsupported content retains its complete React handoff. |
| Hard Vault | React `VaultFlow` and existing auth/vault services | The locked gate is not a native Profile password sheet. A complete native gate covering creation, unlock, recovery and deletion is not yet implemented or qualified. |
| Memory, World Model, Connect and consent | Existing feature owners with selected native Profile scenes and React content | Complete route and nested-state coverage, including consent actions and return paths, remains unverified. |
| Mail, Calendar, Drive and onboarding | Existing React and provider-authorization owners | Native controls, authorization returns and nested states need current-candidate qualification. |
| Finance, Kai, Marketplace and RIA | Existing workspace and service owners; selected Wallet and referral scenes are native | Route-specific native presentation, real sandbox operations and return paths remain unverified. |
| Location, Feed, Search, messages and tasks | Existing map, search and feature owners | Check shared controls, overlays, tabs and keyboard behavior across each route on the candidate. |
| Hosted documents | Browser handoff for the hosted reader | Native encrypted-byte reading, PDF display, Save/Share cancellation and cleanup are not qualified. |
| Web, Android, older wrappers and iPad | Their established renderer unless a supported qualification path is explicitly selected | Do not infer iPad or Android acceptance from an iPhone result. |

### Route coverage and device admission

The [native route inventory](../native-route-inventory.json) and [generated
surface map](../../docs/reference/architecture/frontend-native-surface-map.md)
are discovery sources, not proof of interaction. The recorded inventory has 147
routes, including 119 marked native-required; query-driven views and nested
states need separate evidence. Use the [parity audit](../../docs/reference/mobile/capacitor-parity-audit-report.md)
and the relevant product UI contract for route-specific behavior.

## Native Chrome contract

Capacitor retains one host, bridge and WebView. UIKit owns complete native
presentations, and SwiftUI supplies eligible controls. React and existing services
remain authoritative for routes, permissions, drafts, validation and operations.
Do not add a second app router, WebView, operation store or DOM-inferred action.

- Use the existing [NativeChrome v2](../lib/capacitor/native-chrome.ts),
  [NativeDock v1](../lib/capacitor/native-dock.ts) and
  [NativeDrawers v1](../lib/capacitor/native-drawers.ts) contracts and capability
  negotiation. Choose a renderer before reveal; keep it for the presentation
  lifetime. Unsupported wrappers use the established fallback before the
  surface appears.
- Keep presentation identity separate from current action bindings, touch and
  accessibility eligibility, and privacy state. Fence updates and choices by
  the applicable document, owner, revision, sequence and privacy generation.
  Stale or uncertain actions must not be replayed.
- A native sheet or menu owns its complete presentation above the dock and
  navigation. DOM stacking, `inert` and focus traps cannot isolate UIKit siblings;
  use the existing overlay owner. Confirm actual dismissal before acknowledging
  retirement or restoring a fallback. Quarantine uncertain retirement, and never
  let stale cleanup remove a newer installation or reveal its fallback. Privacy
  coverage applies to the entire application window.
- Preserve focus return, keyboard/IME composition and the existing feature's
  Back hierarchy. Private editor replicas are transient. Never send vault keys,
  owner tokens or protected bodies through public chrome metadata.

## Graceful adoption boundary

A single WebView cannot interleave native views between its internal DOM layers.
Choose a feasible whole-presentation composition before adopting a family; do not
rely on per-frame bridge synchronization to make two renderers move together.
Moving or scrolling controls, protected forms, rich cards and complex/searchable
multiselects retain their current owners until a complete native presentation
has its own contract and evidence.

Use app-authoritative appearance and accent values, semantic foreground and
system accessibility materials. Use glass for appropriate chrome, not as a
background for every content row or as nested decorative glass. Do not hide a
control or switch renderers during a gesture to manufacture a continuity pass.

The single custom-presentation rollback switch lives in
[NativeDrawerQualificationPolicy.swift](../ios/App/App/Plugins/NativeDrawerQualificationPolicy.swift);
[document bootstrap](../ios/App/App/MyViewController.swift) and the
[React presentation policy](../lib/capacitor/native-presentation-policy.ts)
select the matching renderer. Changing a capability alone is not a release.

### Shared geometry and motion

Use the existing shared shell widths, gutters, header and row columns, and dock
clearance. Preserve 44-point native hit regions; allow Dynamic Type to increase
height. Use the existing route, sheet and drawer motion tokens, and let the
system own keyboard timing. A drawer or scrim moves without shifting the
underlying Chat or navigation layout.

## Verification and promotion

For each adopted family, record its renderer, operation owner, fallback,
overlapping presentations, source/build identity and the actual result. Keep
functional, visual, accessibility, privacy and performance evidence distinct.
A host-presence receipt, a simulator pass or a settled screenshot is not a
physical transition pass.

### Presentation qualification rules

1. Run the nearest contract and native build checks for the changed family.
   Include a negative control for a reproduced defect; do not add duplicate
   test scaffolding.
2. Install the exact candidate separately from attach-only warm testing. Exercise
   edge taps, rapid reopen, interrupted gestures, keyboard, theme/accent changes
   and background/Control Center recovery without resetting the session.
3. Inspect public or synthetic transition frames. Verify retained WebView/session,
   no exposed duplicate or blocked touch, valid hit targets and alignment within
   one CSS pixel. For Chat and overlapping journeys, also verify one interactive
   composer and retained drafts.
4. Check VoiceOver, Dynamic Type, rotation, reduced motion and reduced
   transparency. Qualify iPad separately; simulator results are supporting
   evidence, not physical-device acceptance.
5. Run three physical iPhone Release performance passes against the
   [render-performance charter](../../docs/reference/mobile/render-performance-charter.md):
   target median hitch ratio ≤5 ms/s and no gesture frames over 50 ms. The
   earlier Debug/testability-enabled evidence cannot establish distribution performance.
6. Run canonical core on the completed candidate before pushing, then require
   exact-head CI for the pushed candidate. Merge and delivery follow the Admin SOP.

### Reviewer and attach-only unlock

Use the existing [physical reviewer preflight](../../.agents/skills/mobile-parity-audit/references/physical-reviewer-preflight.md).
It separates device transport, XCTest authorization and Vault entry; binds both
the app and runner to the source; and keeps credentials and private content out
of artifacts. A partial or uncertain secure-field entry is not an unlock result.
The performance runner stops on a rejected or uncertain entry; it does not yet
prove exact private input delivery or interruption cleanup. Do not run private
credential entry until the preflight's delivery and cleanup contract is proven.

## Evidence and history

Earlier candidates and receipts remain in Git, not a duplicate document. A
[pre-consolidation main snapshot](https://github.com/hushh-labs/hushh-research/blob/6b8ec6c63e4d5556b9e44ad2e4836b3927ba22aa/hushh-webapp/docs/ios-native-surface-adoption.md)
is available on GitHub. The complete pre-consolidation record on this branch is:

```bash
git show 895fe02536:hushh-webapp/docs/ios-native-surface-adoption.md
```

Treat older receipts as provenance, not current qualification. Update this
guide when evidence changes the decision, and update an existing board task
when authorized. Do not append a chronological log to this page.
