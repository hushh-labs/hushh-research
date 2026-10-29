# iOS Native Controls and Liquid Glass

This guide describes the native presentation boundary, current evidence and
release gates for One. It is maintained by the frontend/native shell owners.
Earlier candidates and detailed receipts remain in [Git history](#evidence-and-history).

## Visual Context

The [webapp documentation map](./README.md#visual-map) places this guide in the
shared frontend/native shell. One Capacitor host retains the WebView; native
controls present actions owned by React and existing services.

## Current implementation

**Status as of 2026-10-29:** native work is in progress. Ordinary builds use the
established interface for custom controls; the existing iOS bottom navigation
has its own native owner. The custom native shell is available only in a
qualification build or an explicitly opted-in Debug session. Source or
simulator evidence does not qualify a family for release. The current task
targets Dev only.

The current document-authority candidate was built from `5947b7b89f` with the
Dev runtime profile and `ENABLE_TESTABILITY=YES`. Three focused lifecycle tests
passed on both the physical iPhone 16e and the iPhone 16e simulator. The
physical Debug Dev app was installed and launched. These checks verify document
replacement, restart invalidation, fail-closed identity matching and Capacitor
navigation-delegate forwarding; they do not qualify product routes, visual
transitions or Release performance.

The follow-up at `fd6cd9cc87` fixes a refused Profile-pane preparation leaving a
new, unacknowledged pane lifetime fenced in native state. Rollback is limited to
that exact acquisition; acknowledged or retired lifetimes remain fenced. Five
focused lifecycle tests passed on the iPhone 16e and simulator in Debug. This
verifies retry and document-authority contracts, not Profile route behavior,
visual transitions or Release performance.

The 2026-10-29 integration follow-up also retires native child controls staged
for a refused, unacknowledged pane before confirming rollback. A stale rollback
cannot remove a replacement pane. The five-case lifecycle suite passed on the
physical iPhone 16e and the iPhone 16e simulator in Debug (iOS 27.1 SDK); the
Finance Back regression passed 10/10, and the combined UI-contract gate passed.
These results verify the current rollback and route contracts only. They do not
qualify all Profile destinations, visual transitions or Release performance.
The tested source snapshot is `81d2078580`; the later main sync at
`214808d067` changes phone-restoration workflows, not iOS sources.
The owned-presenter dismissal test also passed on the physical iPhone 16e
(1/1), confirming UIKit retains an alert or sheet owner until dismissal. This
does not exercise the complete routed Profile handoff.

Every main-frame document receives a random identity at document start. Native
presentation and privacy actions stay disabled while navigation is pending,
then require WebKit readback of the exact identity after commit. A new committed
document retires the previous one. The navigation observer forwards optional
callbacks to Capacitor's existing delegate without retaining it. Restart clears
committed identity until the replacement document commits. Focused tests cover
these boundaries on simulator and physical device.

Native Chrome lifecycle notifications now identify their document and affected
control revisions when the wrapper advertises that capability. Older wrappers
retain the previous behavior. This prevents a delayed notification from
invalidating a replacement control; it does not prove presenter dismissal.
An invalidation during listener installation still requires an acknowledged
state reconciliation before a retained host can be trusted.
An existing Back lease now retires only its own installation; the no-lease
remount path still needs reservation-ordering proof for concurrent mounts.

Other known gaps include the native hard Vault, complete AI-provider ownership,
full route and nested-state coverage, and physical visual, accessibility and
Release performance acceptance. The focused run is not whole-app UI automation.
Listener-installation reconciliation, Back reservation ordering, cross-device
phone-claim ordering and uncertain deletion/claim outcomes still need separate
evidence. The tracked work is [#7824 Complete and qualify the native iPhone
experience](https://github.com/hushh-labs/hushh-research/issues/7824).

## Shared component inventory

| Surface | Current boundary | Evidence and next step |
| --- | --- | --- |
| Bottom navigation | UIKit `UITabBar`; existing navigation owner retains route selection | Native on supported iOS. Verify scroll, keyboard and overlay behavior on the exact candidate. |
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
   testability-enabled candidate above cannot establish distribution performance.
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
