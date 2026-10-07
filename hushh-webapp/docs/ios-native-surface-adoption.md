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
- Profile Appearance and Accent are explicit Debug iPhone candidates with
  independent `profile-appearance` and `profile-accent` IDs. Appearance uses an
  icon segmented SwiftUI Picker for Light/Dark/System; System remains the selected
  preference even when its resolved canvas is light or dark. Accent uses the
  owned UIKit short menu for the existing Blue/Gold values. Choices invoke
  `setTheme`/`writeAccent`; no native preference store is introduced. The owning
  Profile pane must be open and stationary. Scroll, ancestor animation/transition,
  clipped geometry, inactive retained panes and nested overlays retire admission;
  native restoration waits for settlement and acknowledged layout. Release/iPad
  enablement and physical acceptance remain separate gates.

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
| Appearance / Accent | Existing `setTheme` / `writeAccent` | Public icon Picker / owned short menu, independent IDs; scroll and animation retirement | Focused public-value and lifecycle contracts pass. Current candidate requires iPhone proof; Release/iPad stay DOM. Disable the two capabilities to retain web operations. |
| Finite/date wheel sheets | Caller validates and commits value | Bounded adapter with transient draft, Done/Cancel; no production consumer yet. Duration rails, forms and complex multiselect remain React. | Native compile and ordered-choice contracts, not adoption proof. Capabilities stay Debug-only; no product operation depends on them. |
| Drawer/pager motion | Existing Profile, History, `SwipeViews` owners | Finger-driven panels/scrims; cancellation, re-grab, single resize reconciliation; inactive panes inert | Focused cancellation/reopen/resize contracts with a resize negative control. Revert bounded shared-owner commits; no route or persistence migration. |
| Vault methods | Existing owner-authorized `VaultService` operations | Compact method rows + details/default selector. No credential suffixes; acknowledged change remains successful if refresh fails. | Profile contracts and owner/request fences; controlled server/device mutation acceptance outstanding. Revert presentation/mutation-handling commit; no store/schema migration. |

Every existing feature consumer inherits a shared family below; no page-level
native router or global primitive replacement is introduced. New adoption must
add its explicit owner, public projection, evidence and rollback here.

### Route Coverage and Device Admission

#### Complete screen accounting and batch order — 2026-10-06

The existing [generated surface map](../frontend-native-surface-map.generated.json)
accounts for **145 route entries / 144 physical pages**: 75 standard, 47 redirect,
17 hidden and 6 flow layouts. `/agent` is a virtual compatibility entry. There are
98 nonredirect physical pages, not 145 distinct native screens. The authored
[native inventory](../native-route-inventory.json) has 125 rows: 98 functional,
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

The following **20 map entries have no native-inventory row**. Together with
the 125 classified rows, this accounts for every map entry without hiding gaps:

| Entries | Accounting and required proof |
| --- | --- |
| `/agent`, `/connected-systems/[systemId]`, `/kai/funding-trade`, `/kai/investments`, `/one/kai/funding-trade`, `/one/kai/investments`, `/one/setup/[capability]`, `/profile/google/oauth/return`, `/r/[slug]` | Nine compatibility inputs, not new destination screens. Validate actual targets and valid callback/slug conditions; redirect source alone is not an exercised return flow. |
| `/one/profile/connectors/oauth/return` | Functional OAuth callback despite its redirect layout: it completes provider authentication or saves custom OAuth configuration before returning. Native classification and authorized callback proof remain missing. |
| `/c/[token]`, `/one/location/invite/[token]`, `/one/location/request/[token]`, `/one/location/view/[token]` | Four hidden token flows; authorized live fixtures required. Never invent or persist private tokens for coverage. |
| `/products/hushh-tech/launch` | Hidden external-authorization flow; requires its owning launch prerequisites. |
| `/one/connected-systems/[systemId]` | Localhost-only CRM detail; Capacitor export rejects it. Web proof, not a native acceptance obligation. |
| `/one/messages` | Functional selected-conversation surface; current-owner selection and an authorized conversation fixture required. |
| `/ria/clients/[userId]`, `/ria/clients/[userId]/accounts/[accountId]`, `/ria/clients/[userId]/requests/[requestId]` | Three functional role-bound detail templates; authorized RIA/client fixtures required before accepted device journeys. |

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
Close uses the outer pane's settled identity, while Back/content retain their
stack-bound contexts. Identical active acknowledged updates no longer advance
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
| Bottom navigation — [Navbar](../components/navbar.tsx), [native plugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift) | UIKit on supported iOS; DOM fallback | Implemented. Keep standard appearance and React selection authority. |
| Top bar, back, Profile — [TopAppBar](../components/app-ui/top-app-bar.tsx), [ShellActionSurface](../components/app-ui/shell-action-surface.tsx) | SwiftUI Back Debug pilot; otherwise DOM | Back interaction verified on iPhone; visual/accessibility promotion remains incomplete. Close/More/utility buttons follow only after full Back acceptance. Retain Profile photos and rich labels. No whole native bar. |
| Shell option menus — [TopShellDropdown](../components/app-ui/top-shell-dropdown.tsx) | DOM anchored menu/popover | Unused candidate, not shipped reuse: the dropdown has no production caller, and the popover's AgentSectionDropdown caller is itself unreferenced. Do not add a native family solely for this abstraction. |
| Section action menus — [ActionMenu](../components/app-ui/action-menu.tsx) | Mobile Sheet; desktop dropdown | Retain scrolling People's Add actions in LocationRedesignHub. A future stationary public trigger needs serializable item IDs/labels, disabled/busy state and separate destructive confirmation. Rich labels stay DOM. The named-circle-flows instance is not current adoption evidence because its enclosing CirclesSection has no production caller. |
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
Appearance/Accent remain explicitly opt-in Debug iPhone families; full accessibility,
visual and Release performance admission remain outstanding. No merge, deployment
or distribution is implied.

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

The latest Circle layout from main is normally merged at `97bd81e7`; the four
incoming files leave the native and Wallet fixes unchanged. Its core passes in
232s and all 65 focused Circle tests pass. The subsequent nearest native,
Wallet and continuity contracts pass 105 checks. These results retain their
source identities; later heads still need canonical core and exact-head CI.
