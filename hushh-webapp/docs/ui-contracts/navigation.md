# Shared Navigation UI Contract

Status: current product and UI reference, checked against source revision
`3ff2620b48567177dce5c667e77a70203e4a8c35` on 20 October 2026. Owner: frontend architecture. Classification:
`canonical`, package-local. This is the shared shell entry/CTA inventory for
Profile, Feed, and their neighboring routes. See [Typography](./typography.md)
for the font role of each control.

## Visual Map

```mermaid
flowchart TD
  shell["Signed-in shared shell"] --> top["Top app bar"]
  shell --> bottom["Chat · One · Connect · Feed"]
  top --> back["Authored Back and breadcrumb"]
  top --> profile["Profile pane"]
  top --> unlock["Conditional Unlock vault"]
  top --> persona["Conditional Switch role"]
  shell --> tabs["Registered contextual tabs"]
  shell --> voice["Existing voice slot"]
```

## Controls, destinations, and guards

| Surface / CTA | Current effect |
| --- | --- |
| Chat | Canonical `/` route. |
| One | `/one`. |
| Connect | `/one/connect`. |
| Feed | `/one/feed`. Attention dot when pending requests or unread Feed activity is positive. |
| Open Profile | Rightmost signed-in top-bar action. Opens Profile pane over current route, retaining opener for focus restoration. Signed-in photo/generic fallback; 32px image within 44px control. |
| Back | Resolves overlay, active feature layer, then authored route parent. Shell, iOS edge gesture and Android Back share the same hierarchy. |
| Breadcrumb parent | Clickable authored ancestor; final current label is noninteractive. |
| Unlock vault | Offered when signed in, a vault exists, and it is locked. Opens existing unlock owner; no new credential flow. |
| Switch role | Only persona-switch routes; Investor / Advisor or Set up Advisor. Busy switching disables menu choices. |
| Onboarding Account actions | Replaces the ordinary Profile cluster. Sign out, or Delete account → Cancel/Delete account confirmation. |
| Voice slot | Existing shared voice owner, narrower than tab segments in the bottom surface. Its session/permission decisions retain the voice runtime contract. |
| App-wide Search | Disabled/archived; no current app-wide Search segment or palette launcher. Page-local search/filter controls remain with each feature. |

Sources: [bottom action resolver](../../lib/navigation/app-bottom-nav.ts),
[bottom renderer](../../components/navbar.tsx),
[top app bar](../../components/app-ui/top-app-bar.tsx),
[pane entry](../../lib/navigation/profile-pane.ts),
[route layout](../../lib/navigation/app-route-layout.contract.json), and
[voice runtime](../../../docs/reference/one/one-voice-runtime-architecture.md).

The four bottom items keep their order. A specialist does not append Finance
or RIA to that bar. Auth, route shell, onboarding, and explicit hide flags
control visibility. Native admission additionally considers unlocked vault,
negotiated appearance and session suppression. Modal/pane/privacy states
must isolate underlying DOM and native controls alike.

## Contextual tabs

Tabs use the central registry and owning route/query, not a second route-local
navigation authority. The registered rail belongs below the module heading
where that workspace owns it; the shell must not draw another copy.

| Workspace | Labels | State owner |
| --- | --- | --- |
| Connect | Connections / Circles | `tab`; [Connect contract](./connect.md). |
| Location | Now / People / Links | Existing `view` and Location route owner. |
| Finance | Market / Portfolio / Analysis | `/one/kai?tab=…` and generated Finance builders. |
| Consent Center | Requests / Active / History / Connections | Existing consent route-tab registry. |
| RIA | Profile / Clients / Picks | RIA route registry. |
| Public knowledge | Research / Blog / Developers | Public route registry. |
| Calendar / Wallet local sets | Owning controlled pager labels | Reuse the shared renderer; derive actual values from each workspace. |

Selecting a tab requests its authored route/state. Cells use equal-width
segments, responsive labels and truncation; this renderer does not own a
horizontal overflow scroller. Local pagers retain their owning state. Sources:
[top-tab registry](../../lib/navigation/top-shell-tabs.ts),
[tab renderer](../../components/app-ui/top-shell-tabs.tsx), and
[RIA tabs](../../lib/navigation/ria-route-tabs.ts).

## Per-control source, wire and branch contract

A route request is not a consent/relationship/payment operation. Destination
components can perform their own work after navigation; idle prefetch can
fetch route assets before tapping. Current controls are owned by the linked
Navbar/top bar, [Back dispatcher](../../lib/navigation/top-shell-back.ts),
[persona context](../../lib/persona/persona-context.tsx),
[RIA service](../../lib/services/ria-service.ts),
[vault service](../../lib/services/vault-service.ts) and auth owner.

| Control/guard | Read/projection | Every action/negative boundary |
| --- | --- | --- |
| Chat / One / Connect / Feed | Always displayed keys chat/dashboard/connect/feed; current route+accepted intent select active | Resolve ordinary keys with scope `one`, contextual navigation `scroll:false` to `/`, `/one`, `/one/connect`, `/one/feed`; native same handler. No domain mutation. Same selected key suppresses selection haptic; still runs portfolio guards and dispatches canonical route, potentially clearing nested query. Prefetch can use current scope even though click resolves ordinary scope. |
| Portfolio saving | `busyOperations.portfolio_save` | Blocks tab navigation; `Saving to vault. Please wait until encryption completes.` No nav/API. |
| Portfolio unsaved review | `portfolio_review_active && portfolio_review_dirty` | Browser confirm `You have unsaved portfolio changes. Leaving now will discard them.` Negative stays; affirmative navigates, not a save. Browser owns button captions; do not invent Yes/No labels. |
| Feed dot | Positive pending-consent count **OR** positive unread count | Dot, not summed count. Tapping tab does not mark read; Feed owns acknowledgement. |
| Profile avatar | Effective current-owner cached identity photo, fallback Firebase photo | Local pane-open event source tap with opener/focus restoration; no save API. |
| Unlock vault | Signed in, known hasVault true, locked; unknown hides CTA | Existing unlock Dialog; Cancel stays locked. `Unlock vault` / `Unlock your vault to use secure memory and background activity.` |
| Role pill | Interactive center title only `/one/kai` family; active role | Local dropdown open/close no call. Eligible alternate role POST below; setup routes only. No role confirmation dialog. |
| Back | Overlay→deepest/newest matching feature→authored route parent | Escape through overlay; refused dismissal still consumes Back. Feature cancel/reset callbacks next; no raw history fallback. |
| Breadcrumb parent | Authored label/href; final item inert | Direct ancestor route/full transition/scrollfalse, distinct from Back unwind. No mutation. |
| Contextual tab | Central registry active/labels/hrefs | Disabled/current no-op; controlled pager local onValueChange, routed default replace or owning push. Finance resets scroll/bottom chrome. |
| Account actions | Onboarding chrome replaces ordinary Profile cluster | Menu open/close/outside/Escape no operation. Sign out/delete separate below. |

### Persona, attention and vault read models

`F` denotes current Firebase bearer. IAM web proxy forwards path/query/auth/
JSON through [IAM catchall](../../app/api/iam/[...path]/route.ts) to
[backend IAM](../../../consent-protocol/api/routes/iam.py) and RIAIAMService.
Persona GET hot30s/stale10min/timeout30s; force bypasses hot hit. Cached values
are current-owner hints, not permission authority.

| Read/action | Exact wire and fields | UI/persistence/recovery |
| --- | --- | --- |
| Role bootstrap | F GET `/api/iam/persona[?force=1]`→`user_id,personas,last_active_persona,active_persona,primary_nav_persona,ria_setup_available,ria_switch_available,investor_marketplace_opt_in,iam_schema_ready,mode` | Active=active_persona else last_active_persona else investor. IAM-not-ready disables capability; otherwise switch availability decides switch/setup. GET can ensure actor/vault rows and reconcile runtime persona; not blanket zero-write. Error retains cache, otherwise investor compatibility. No shell Retry. |
| Switch | F POST `/api/iam/persona/switch`, `{persona:"investor" or "ria"}`→full persona state | Invalidates dependent caches, writes returned session state; mutation sequence rejects older refresh. Investor route remembered lastKaiPath/finance root; Advisor remembered non-onboarding lastRiaPath/riaEntryRoute. Failure current role/spinner released, `Couldn't switch roles right now. Please retry.` |
| Setup Advisor | No switch POST | Routes RIA setup; labels `Investor`, `Advisor`, `Set up Advisor`, `Switching to Investor`, `Switching to Advisor`. Optional onboarding-status GET belongs to RIA owner. |
| Vault presence | Memory→session→bootstrap; cold F GET `/api/vault/check?userId=<uid>`→`{hasVault}` | [Web proxy](../../app/api/vault/check/route.ts) POSTs `/db/vault/check`, `{userId}`; backend owner match/read-only ensure_entryfalse. Cache60s/dedupe, retry timeout/5xx once. Native HushhVault.hasVault→exists. Error unknown; cached presence is not unlocked authority. |
| Pending dot | F GET `/api/consent/center/summary?mode=consents`; actor=ria only `/ria`+active RIA | `user_id,actor,mode,counts:{pending,active,previous}`; dot counts.pending. Hot30s/stale5min/timeout20s; mutation refresh bypasses stale hot state. Current-owner retained summary/error null initially. Eligibility-combined summary, not raw event count. |
| Unread dot | F GET `/api/one/feed/unread-count`, no query/body→`{unread_count}` | SHORT cache/invalidation epoch; failures retain last count. Starts null; successful missing field currently normalizes0. Shared Feed events/recounts can retire older fetches. Hook does not POST `/feed/read`. |

Attention owners: [pending hook](../../lib/consent/use-consent-pending-summary-count.ts),
[summary service](../../lib/services/consent-center-service.ts),
[summary proxy](../../app/api/consent/center/summary/route.ts),
[unread hook](../../lib/feed/use-feed-unread-count.ts),
[Feed service](../../lib/services/feed-service.ts). Root-chat deferred/foreground
chat guards avoid competing reads. Bootstrap can provision state; an eligible
badge read is not itself approval of information access.

### Onboarding account actions: preparation versus erasure

| Action/branch | Exact behavior/copy |
| --- | --- |
| Sign out | Existing auth owner tears down native/Firebase sessions then `/`; no confirm. Failure `Couldn't sign out. Please retry.` |
| Delete account preparation | `resolveDeleteAccountAuth`: existing token reused; existing vault without token unlocks; no-vault branch may issue token. This is not erasure. |
| Token preparation | F POST `/api/consent/vault-owner-token`, `{userId,renewalOfToken}`→`token,expiresAt,scope,renewalValidated?`; native existing HushhConsent bridge. Token issuance doesn't delete. |
| Unlock | `Unlock Vault to Delete Account` / `Unlock your Vault to confirm account deletion. This permanent action removes your saved Vault information.` Success retries preparation after300ms; Cancel no delete. |
| Confirmation | `Delete account?` / `Deletes your account, vault, memory, chats, and connections.` |
| Cancel | No verified erasure. Cancel/Delete buttons disabled busy, but root onOpenChange is not busy-guarded; universal dismissal blocking would be a false claim. |
| Delete account / Deleting... | Re-resolve authority→shared [verified deletion](../../lib/flows/delete-account.ts); exact erasure/deprovision/recovery in [Profile](./profile.md). |
| Feedback | `Failed to delete account. Please try again.`; `Deleting your account...`; `Account deleted.`; outcome-specific errors from shared owner. |

### Spatial axes, anchoring and layers

Coordinates are container-relative source rules. A centered control uses
`x=center of its authored slot−width/2`; content-dependent Y is not a fixed
screen coordinate. Portal collision may move a menu from preferred placement.

| Surface | Dimensions/anchor/scroll/layer |
| --- | --- |
| Role pill/menu |36high center-title anchor; dropdown aligncenter,min200/default offset4/collision handling; transient portal10100. |
| Onboarding menu |36×36/glyph20; end-aligned dropdown,radius14/p4; item radius10;10100. Opening doesn't call auth. |
| Top chrome |fixed top0/insetX0,z50; Unlock-visible z505. Old backdrop499 comment is not current layer authority. |
| Avatar |44target/image32; distinct from shared36high icon/pill recipe. |
| Breadcrumb |gap4; ancestor max144; chevron14; final inert. |
| Bottom |fixed z120 unlocked/505 locked; bottom `max(effectiveSafeBottom,10)+chromeLift`; shared width/slot AppBottomShell.4segments minimum44; labels10/13. |
| Contextual rail |36high,p2,equal flex cells/px12; local buttonsz10 above indicator. >3labels11→12≥360→14≥400→15≥640. No horizontal overflow scroller. |
| Native |Admitted native bar uses inert negotiated-height DOM spacer/same guards. Active blocking voice layer disables underlying native interaction. OS frames/typography are not web CSS. |
| Token ladder |Chrome118,feature700/701,Sheet711/712,boot790,Dialog800/801,takeover9000,system9999,transient10099/10100; explicit chrome tiers above still apply. |

## Interaction, native presentation, and verification

Use the shared shell action surface for icon/pill controls and preserve
focus, ripple and busy behavior. Its current icon/pill recipe is 36px high;
the Profile avatar is 44px and some control wrappers provide a larger target.
Do not infer a universal 44px target from the shared recipe. The preferred
touch-control contract remains 44px; source geometry must be checked for
each actual control. Route changes inherit the one
shared route transition. A nested editor registers its own Back cleanup;
raw browser history is not the application Back contract. Sources:
[shell controls](../../components/app-ui/shell-action-surface.tsx),
[Back layers](../../lib/navigation/back-layers.ts), and
[app-surface design system](../../../docs/reference/quality/app-surface-design-system.md).

An acknowledged supported iOS native bottom bar uses standard UIKit tabs
with the same four destinations. Unsupported wrappers, web and Android
retain DOM presentation. Native controls are not evidence that every native
candidate scene is admitted; negotiated capability and presentation policy
remain authoritative. UIKit labels use OS typography, whereas WebView text
uses the product family. See
[native navigation](../../lib/capacitor/native-navigation.ts) and
[native adoption](../ios-native-surface-adoption.md).

Nearest existing checks include
[bottom-nav behavior](../../__tests__/components/navbar-bottom-nav.test.tsx),
[pane navigation](../../__tests__/navigation/profile-pane.test.ts), and
[top](../../e2e/app-shell-top-clearance.layout.spec.ts) /
[bottom clearance](../../e2e/app-shell-bottom-clearance.layout.spec.ts) fixtures.
These are source/fixture evidence, not device permission or Dynamic Type
acceptance. This documentation change performs no navigation/runtime mutation.

## Experimental native Tasks

When the existing experimental native-interface preference admits the iPhone
workspace, `/one/todos` uses the shared native presentation owner. React retains
loading, task projection, encrypted writes, confirmation outcomes and feedback.
The adapter maps grouped pending/completed rows, receipts, retries and the
existing source links; task detail provides complete/restore, Open/Join and
Delete with confirmation. A bounded list window has explicit Previous/More.

Add uses native title/notes fields and optional native date/time pickers. Cancel
and the authored shell Back clear the local draft and restore the collection;
failed saves keep the editor. All values flow to the existing task callbacks.
Flag-off, unsupported hosts or a confirmed presentation failure retain the
complete existing React route. This does not add another lifecycle mechanism.

## Experimental native Mail

On an admitted iPhone, canonical Mail and its setup variant share one presentation owner across Overview, KYC and Receipts. React retains connector admission, account and vault fences, sync, persistence, verification drafts and all writers. The effect-only receipt-to-Memory saver stays mounted when native controls are visible.

The native projection uses the existing tab selection, receipt filters/month grouping/paging, KYC queue/activity and guarded confirmation callbacks. Only the selected current-account pane owns a native workspace. Historical receipts remain an explicit, account-unverified reader handoff; they cannot admit a competing collection workspace.

Receipt source/evidence details, encrypted identity intake, exact-scope reply review, receipt update details and Google transition/authorization retain their complete authored presentations after confirmed native retirement. Dismissal readmits the native owner. Renderer-off or unavailable capabilities retain the complete React route. Runtime scope and fixture limits are recorded in the adoption ledger; implementation alone is not route acceptance.

## Experimental native Calendar

Calendar and its setup variant retain the connection/OAuth owner. The current multi-account Board, Invitations and Insights panes share one native presentation owner; the Board's one-time OAuth-return initializer and existing read/cache generations remain mounted. Account and date selection, paging, filters, search and refresh dispatch to those owners. A native date picker publishes only validated ISO days in the selected display timezone.

Event/invitation review, booking/conflict review, occasions, meeting-file contents and provider authorization use their complete authored handoffs after confirmed retirement. Revalidate the current row and its enabled/pending state after retirement; booking also checks the current complete board, date, timezone and opening. Incomplete coverage cannot authorize booking. The Insights library retains its authored Back layer, and invitation details register against the normalized static-export pathname. Native disconnect confirmation shares the original state and writer; Cancel does not invoke it.

The older connected response without account metadata retains its complete React schedule. Anonymous/public rescheduling is a separate presentation capability, not this authenticated workspace. Renderer-off retains the complete React route. Runtime scope and fixtures remain distinct from these mappings.

## Experimental native News and Identity-check preferences

Market News composes a native list through the existing reader, scope/snapshot fences, refresh and paging callbacks. URL validation and external opening stay in JavaScript. Native windowing performs no additional provider reads; a new snapshot/window has its own presentation identity while the resource owner stays mounted. Locked or renderer-disabled entry retains the complete React route.

After the existing protected intake and setup readiness gates, Identity checks maps its authoritative response-preparation preference, retry and Finish/Skip callbacks. Intake and vault admission retain their complete authored presentations. The preference writer, sender checks and setup coordinator remain unchanged. Native switches use the existing On-first/Off-second renderer contract; the bridge rejects reversed workspace options. Connector models follow that same convention, including public visibility. Consequential toggles and terminal setup actions retain their binding-verification boundary.

## Experimental native Finance

Finance's retained Market, Portfolio and Stocks panes share the existing workspace presentation owner. The registry still owns query selection, scroll reset and authored return; feature models supply native rows, search and finite-choice menus. Source switching, refresh and destructive review keep the same vault, busy and active-source guards as React. Reselecting a selected menu item is inert; the bridge carries opaque handles rather than source identifiers or operation parameters.

Portfolio section routes reuse their existing reader and callbacks. Detailed charts/sector holdings, holdings editors, report/sharing/advisor review, import/provider/extraction flows, and Stocks company/saved-analysis/comparison/debate views retain complete React presentations. Native controls retire before these presentations; dismissal or authored Back restores the native parent. Renderer-disabled and unsupported projections retain complete React behavior. Actual creation, deletion, provider grants, analysis submissions and financial actions are not implied by presentation verification.

The addressable hardcoded `?preview=analysis|connect` prototypes remain separate mapping gaps; their names do not establish unreachable or live-service parity. Runtime acceptance and fixture limits belong in the adoption ledger, bound to the installed artifact.

## Experimental native Career

The owner-keyed Career workspace retains its existing encrypted resume reader, roles reader, drafts and action callbacks. A change of owner or lock state retires the previous private state even when both accounts were otherwise ready. Native summary, upload/replace/edit, roles and receipts map those owners. File selection/cancellation, complete resume editing and exact outgoing application review remain authored React handoffs; Back cancels reversible drafts and is blocked during an active save or application.

An absent professional domain is an empty result; a failed read is an error with Retry. A save closes the draft only after the write coordinator reports success. External application token acquisition is pinned to the originating owner and checked against the vault credential epoch before POST. Sending an application and persisting its local receipt are separate outcomes. Presentation review does not authorize or claim an external application.

Location's experimental native workspace reuses Now / People / Links selection,
recipient search and paging, public-link duration, Settings and sharing/request
lists from the existing route owners. Maps, consent/application reviews, Share,
Ask, Save My Soul, invitations and saved-place editing remain complete authored
presentations. Settings Back returns from the saved-place review to Settings;
sharing/request Back returns from rich detail to its list. Auto-approval On opens
the existing scope picker; only its existing explicit confirmation can save it.
Temporary DOM overlay tokens retire native controls before exposing React and
release admission after actual dismissal; they are not permanent renderer failure.
Read-only reviewer entry skips ambient identity/key registration without changing
normal interactive setup or explicit action-boundary key preparation.
