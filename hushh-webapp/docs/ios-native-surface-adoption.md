# iOS Native Controls and Liquid Glass

Implementation owner: frontend/native shell. Reviewed against source on 2026-10-06.
This is a component inventory and bounded adoption reference, not a claim that every
candidate is implemented or released.

## Visual Context

The package [docs index](README.md#visual-map) owns the overview. Native controls
remain presentation adapters below the existing React action and routing owners.
One Capacitor host retains the active document; adopting a control does not create
another navigation stack, WebView, session, or information store.

## Current Implementation

- [HushhNativeNavigationPlugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift)
  presents a standard UIKit `UITabBar` on iOS 26+. It does not use SwiftUI `TabView`
  or `UITabBarController`; controller-only Search, minimization and accessory
  behaviors are not implemented by this standalone bar.
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
- [The global Search host](../components/kai/kai-command-bar-global.tsx) is mounted
  on Chat by [Providers](../app/providers.tsx). Native Search opens that existing
  palette; it is not an independent search route or native result engine.
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
Retirement is acknowledged only after touch, accessibility, child containment and
any owned presented controller are removed. Popup retirement waits for actual
UIKit dismissal completion. An uncertain acknowledgement quarantines the control until removal
is confirmed; it never retries a navigation action.

Focus-return attempts have a separate generation fence. Failed retirement never
focuses a duplicate DOM control, and it cannot latch a hold for focus that was
not transferred or clear a newer attempt. Chat chrome's authority context includes
the existing vault-session epoch. Selector value changes use ordered updates
rather than becoming a new lease identity; History still follows its owning
agent surface. Device admission starts only after the public fallback loses
focus, independently of software-keyboard visibility.

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
| History utility trigger / owned Close | Standard glass with the shared secondary-label glyph, preserving light OKLCH and dark RGBA opacity | Debug-only handoff candidate; current physical acceptance remains unverified. |
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

## Shared Component Inventory

### Current Candidate and Rollback

The route inventory remains the generated [frontend/native surface map](../../docs/reference/architecture/frontend-native-surface-map.md)
and its [parity audit](../../docs/reference/mobile/capacitor-parity-audit-report.md);
this family inventory joins it without becoming another route authority. All new
families below are iPhone iOS 26 Debug-only, explicitly rehearsed with
`--hushh-native-chat-chrome`. Release, older iOS, Android, web and unqualified
iPad retain existing controls. Do not remove a fallback based on compilation.

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

| Family | State / operation owner | Candidate and retained behavior | Evidence and rollback |
| --- | --- | --- | --- |
| Back | Shared shell's authored Back handler | Existing bounded SwiftUI button; in-place appearance/enabled updates | Current device interaction, overlay and resume checks passed; visual/accessibility/performance admission remains incomplete. Disable capability to retain `NativeShellBack` DOM control. |
| History Open/Close | Chat workspace + existing drawer owner | One identity; geometry change retires Open and installs Close in the drawer slot. List, drafts and transcript remain React. | Current bridge/gesture contracts and device drawer proof; complete native handoff unverified. Disable family capability; same authored DOM actions remain. |
| Profile Close | Controlled `ProfilePane` + Sheet | Named-layer Close after entry settlement; retires during drag/nested overlays. URL stack and photos remain React. | Current device photo preview/pull-to-close passed; native Close admission and visual acceptance remain unverified. Disable `close` capability. |
| More / public short menus | Explicit `ActionMenu` callbacks | SwiftUI trigger and owned UIKit action-sheet adapter; no eligible product consumer yet. Scrolling People's Add, rich labels, desktop dropdown and unauthored menus retain React. | Compiled adapter, not adoption; popup privacy/dismissal device proof outstanding. Capabilities remain Debug-only. |
| Cloud/Puppy | Chat's existing agent-surface handler | Existing finite segmented Picker, ordered current-value updates | Lease contract; accessible segment geometry and physical acceptance outstanding. Disable `agent-surface` capability. |
| Finite/date wheel sheets | Caller validates and commits value | Bounded adapter with transient draft, Done/Cancel; no production consumer yet. Duration rails, forms and complex multiselect remain React. | Native compile and ordered-choice contracts, not adoption proof. Capabilities stay Debug-only; no product operation depends on them. |
| Drawer/pager motion | Existing Profile, History, `SwipeViews` owners | Finger-driven panels/scrims; cancellation, re-grab, single resize reconciliation; inactive panes inert | Focused cancellation/reopen/resize contracts with a resize negative control. Revert bounded shared-owner commits; no route or persistence migration. |
| Vault methods | Existing owner-authorized `VaultService` operations | Compact method rows + details/default selector. No credential suffixes; acknowledged change remains successful if refresh fails. | Profile contracts and owner/request fences; controlled server/device mutation acceptance outstanding. Revert presentation/mutation-handling commit; no store/schema migration. |

Every existing feature consumer inherits a shared family below; no page-level
native router or global primitive replacement is introduced. New adoption must
add its explicit owner, public projection, evidence and rollback here.

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
| Bottom navigation — [Navbar](../components/navbar.tsx), [native plugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift) | UIKit on supported iOS; DOM fallback | Implemented. Keep standard appearance and React selection authority. |
| Top bar, back, Profile — [TopAppBar](../components/app-ui/top-app-bar.tsx), [ShellActionSurface](../components/app-ui/shell-action-surface.tsx) | SwiftUI Back Debug pilot; otherwise DOM | Back interaction verified on iPhone; visual/accessibility promotion remains incomplete. Close/More/utility buttons follow only after full Back acceptance. Retain Profile photos and rich labels. No whole native bar. |
| Shell option menus — [TopShellDropdown](../components/app-ui/top-shell-dropdown.tsx) | DOM anchored menu/popover | Unused candidate, not shipped reuse: the dropdown has no production caller, and the popover's AgentSectionDropdown caller is itself unreferenced. Do not add a native family solely for this abstraction. |
| Section action menus — [ActionMenu](../components/app-ui/action-menu.tsx) | Mobile Sheet; desktop dropdown | Next menu candidate: the reachable People actions in LocationRedesignHub. Use serializable item IDs and labels; arbitrary React labels stay DOM. Preserve disabled/busy state and separate destructive confirmation. The named-circle-flows instance is not current adoption evidence because its enclosing CirclesSection has no production caller. |
| Agent/voice controls — [AgentBar](../components/agent/agent-bar.tsx), [OneVoiceControl](../components/one-voice/one-voice-control.tsx) | DOM controls over existing runtime providers | Conditional: launcher/cancel chrome only. Keep tap/hold, slide-to-cancel, recording, readiness and task state with existing owners; retain transcript/waveform content. |
| Search field and close — [KaiCommandPalette](../components/kai/kai-command-palette.tsx), [SearchClearButton](../components/app-ui/search-clear-button.tsx) | DOM controlled palette | Conditional: native search chrome. Existing query, results and action runtime remain authoritative; prove IME, keyboard and dismissal before replacing the field. |
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
   dragged or swipe-coupled chrome stays React. No `TabView`, `NavigationStack`,
   second WebView or second router is introduced. Minimum iOS remains 17.0.
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
