# Location implementation and verification

## Visual Context

Canonical visual owner: [Hussh Webapp Docs](../README.md). [Location](./location.md) owns the shared header, workspace and focused-flow map.

**Implementation complete / acceptance pending.** Expanded implementation is local only, based on main `b34d1e93d291cfa106b08893a9587973867044f2`. No additional push, merge or UAT deployment occurred. Actual source-backed text/state coverage is separate from browser/native acceptance.

## Changed files

The change uses the existing shared shell and semantic typography. A presentation-only context repeats its scope on actual portal hosts. Individual raw text hooks change font properties without introducing wrappers, effects, listeners, requests, timers or a new dependency. Shared contacts and guest onboarding opt in only from Location. The retained, unmounted places-history edit from the earlier narrow patch was removed.

Production owners include the Location page, map/public route clients, onboarding/place picker, immersive map/Nearby, hub/private Check-In/SOS, contacts/invitations and reachable Circle/recipient portal owners. No backend, service, encryption, cache, persistence, native plugin, package or lockfile changes are part of the candidate. Generated Back/Search receipts are refreshed; intermediate receipts from this task are removed.

<details><summary>Full candidate file list</summary>

- `docs/reference/quality/design.md`
- `hushh-webapp/__tests__/components/one-location-agent-page.test.tsx`
- `hushh-webapp/__tests__/components/one-location-hub-hierarchy.contract.test.ts`
- `hushh-webapp/__tests__/utils/top-shell-breadcrumbs.test.ts`
- `hushh-webapp/app/globals.css`
- `hushh-webapp/app/one/location/invite/[token]/page-client.tsx`
- `hushh-webapp/app/one/location/map/page.tsx`
- `hushh-webapp/app/one/location/page.tsx`
- `hushh-webapp/app/one/location/request/[token]/page-client.tsx`
- `hushh-webapp/app/one/location/view/[token]/page-client.tsx`
- `hushh-webapp/components/connections/contact-discoverability-consent-dialog.tsx`
- `hushh-webapp/components/connections/contact-invitation-sheet.tsx`
- `hushh-webapp/components/onboarding/OneWelcomeStory.tsx`
- `hushh-webapp/components/onboarding/guest-preview.tsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/AgentOneOnboarding.tsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/components/OnboardingFooter.tsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/components/SlideLayout.tsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/screens/AskScreen.jsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/screens/ConnectScreen.jsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/screens/ControlScreen.jsx`
- `hushh-webapp/components/onboarding/mentor-onboarding/screens/KnowScreen.jsx`
- `hushh-webapp/components/one-location/contact-sync-results-sheet.tsx`
- `hushh-webapp/components/one-location/location-immersive-map.tsx`
- `hushh-webapp/components/one-location/location-permission-recovery-card.tsx`
- `hushh-webapp/components/one-location/map-name-labels.tsx`
- `hushh-webapp/components/one-location/map-renderer-access.tsx`
- `hushh-webapp/components/one-location/nearby-check-in/nearby-check-in-sheet.tsx`
- `hushh-webapp/components/one-location/nearby-check-in/star-rating-input.tsx`
- `hushh-webapp/components/one-location/onboarding/location-picker-map.tsx`
- `hushh-webapp/components/one-location/onboarding/onboarding-live-map.tsx`
- `hushh-webapp/components/one-location/onboarding/one-location-onboarding-flow.tsx`
- `hushh-webapp/components/one-location/onboarding/save-location-modal.tsx`
- `hushh-webapp/components/one-location/redesign/cards.tsx`
- `hushh-webapp/components/one-location/redesign/check-in-flow.tsx`
- `hushh-webapp/components/one-location/redesign/circles/circle-grow-actions.tsx`
- `hushh-webapp/components/one-location/redesign/circles/circle-member-actions-menu.tsx`
- `hushh-webapp/components/one-location/redesign/circles/named-circle-flows.tsx`
- `hushh-webapp/components/one-location/redesign/contact-picker/atoms.tsx`
- `hushh-webapp/components/one-location/redesign/contact-picker/circle-member-picker.tsx`
- `hushh-webapp/components/one-location/redesign/contact-picker/list-controls.tsx`
- `hushh-webapp/components/one-location/redesign/contact-picker/selected-review-sheet.tsx`
- `hushh-webapp/components/one-location/redesign/duration-presets.tsx`
- `hushh-webapp/components/one-location/redesign/live-share-status-card.tsx`
- `hushh-webapp/components/one-location/redesign/location-header-layout.ts`
- `hushh-webapp/components/one-location/redesign/location-hub-summary.tsx`
- `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx`
- `hushh-webapp/components/one-location/redesign/location-typography.tsx`
- `hushh-webapp/components/one-location/redesign/request-more-time.tsx`
- `hushh-webapp/components/one-location/redesign/selectors.tsx`
- `hushh-webapp/components/one-location/redesign/share-lanes.tsx`
- `hushh-webapp/components/one-location/redesign/share-replacement-notice.tsx`
- `hushh-webapp/components/one-location/redesign/sms-contacts-flow.tsx`
- `hushh-webapp/components/one-location/redesign/sos-panel.tsx`
- `hushh-webapp/components/one-location/saved-locations-section.tsx`
- `hushh-webapp/components/one-location/saved-places-banner.tsx`
- `hushh-webapp/contracts/ui-review/back/b69ddbda3246bb3845aaf7f20dbc773aa014abf1001203815e1b2f434644224e.json`
- `hushh-webapp/contracts/ui-review/search/f2413d9acf6ef68f7f427913aa772ae4eb0222d2ec721e7b570de3f9c4f9a770.json`
- `hushh-webapp/docs/one-location-now-and-map.md`
- `hushh-webapp/docs/ui-contracts/README.md`
- `hushh-webapp/docs/ui-contracts/location-action-coverage.md`
- `hushh-webapp/docs/ui-contracts/location-coverage.md`
- `hushh-webapp/docs/ui-contracts/location-typography-roles.md`
- `hushh-webapp/docs/ui-contracts/location-verification.md`
- `hushh-webapp/docs/ui-contracts/location.md`
- `hushh-webapp/lib/navigation/back-navigation-graph.ts`

</details>

## Header before and after

Before, root Location suppressed its current shared breadcrumb and rendered a large visible body Location title (393px:28.076/31.080/600;1440px:40/44.28/600). After, the root shared header is `[Back] Location [Profile]`, the body title is accessible-only, and the existing switch/status remains above the tabs. Authored Back still resolves overlay → feature layer → route parent.

At matching100% zoom, the Location and actual Connect header rectangles agree:

| Width | Shared bar x / width / height | Back visible control | Current title x / y / size-line-weight | Profile target |
| --- | --- | --- | --- | --- |
|393|16 /361 /60|x20,y14,36×36|72 /21 /17-22-600|x333,y10,44×44|
|1440|316 /808 /68|x320,y18,36×36|376 /25 /17-22-600|x1080,y14,44×44|

These are browser-harness CSS pixels. Shared hit targets, safe-area and responsive owners are retained; the body retains its existing agent measure rather than copying Connect's workspace width. The switch track remains54×24 with its existing44px label target; status is12/18/400.

## Typography before and after

Both aliases resolve to bundled Plus Jakarta Sans. Effective representative before values come from the actual `b34d1e93` page rendered at393/1440; after targets and source owners are fully listed in [the role comparison](./location-typography-roles.md). The full [per-text ledger](./location-coverage.md) distinguishes source declarations from measured computed values and records missing observations.

| Representative role | Before | After |
| --- | --- | --- |
|Root current header title|absent|17/22/600|
|Full flow H1|393:28.076/31.080/600;1440:40/44.28/600|28/36/600|
|Segmented tabs|15/20/550|15/20/550, retained|
|Primary share card heading|17/22/600|14/22/600|
|Now Settings ordinary row|17/22/500|14/21/550|
|Share card supporting line|13/18/400|12/18/400|
|SOS Edit utility|17/22/650|393:12/21/550;1440:13/21/550|
|SOS message label|17/22/400|15/22/550|
|SOS presets / composer action|17/22/650|12/18/550|
|SOS timing / hold status|13/18/400;13/18/600|same matching helper/status, retained|
|SOS SMS display|42/42/600|42/42/600, retained|
|Task title/action|matching shared Task owner|20/28/600;13/20/600|
|Circle search / person row|13/16.9/400;13/15.86/400|same matching shared Circle roles|
|Circle empty/error body|15/20/400|15/20/400, explicit shared-owner exception|
|Vendor toast title/description|system-ui13/19.5/500;12/16.8/400|PJS13/20/500;12/20/400 while Location is mounted|

Ordinary semantic inputs use16/22/400 through620px,14/22/400 above. Semantic Task fields use16px below768 and14px from768; the same shared raw Circle rename input retains16/24/400 at all widths and its raw Task label15/20/600. Explicit Circle input retains13/16.9/400. The Nearby rating textarea remains76px high. Requested550/650 CSS weights select existing bundled600/700 faces; no new font face is introduced.

The request-duration H1 now permits natural wrapping at28/36 instead of a local clamp plus nowrap. This is the documented text-fit correction. Colors, materials, map/ring/control geometry, spacings and authored behavior are preserved. Monospace codes, tabular values, avatar/illustration graphics and shared duration-wheel display roles retain recorded exceptions. Location-only toast corrections have a Connect navigation negative control.

## Screen and state coverage

The fresh ledger contains **1142 mounted text/a11y sites**, **163 composed CTA/state contracts**, and **104 explicitly excluded source sites**. Each in-scope text site has a disposition and an observation or exact evidence gap.

| Family | Explicit source disposition |
| --- | --- |
|A Shell/entry|Shared Back/title/Profile, switch statuses, Now/People/Links, cold/loading/failure/warm, retained sharing, nav/private-agent controls|
|B Onboarding|Features→Place→Ready; permission/settings recovery, save-map/details, contacts/privacy, invite code/copy/share/expiry, join lookup/review/failure, finish/skip/back/busy/retry|
|C Now|Primary share, Ask, Check In, SOS, shared/review counts, Map/Settings, save-place reminder, live countdown/actions|
|D People/contacts|Search/paging/all states, per-person dialogs/readiness, privacy choices, native/Google sync and handoff, all result statistics, request/invitation selection/review/composer outcomes|
|E Share|Audience/Circle resolving, duration/custom controls, note/counter, review/replacement, busy/error/partial, ordinary/SMS lanes, stop/end-time and nested dismissal|
|F Ask/review|Selection/reason/duration, pending/withdraw/extensions, request cards, requested/shorter approval, decline and final/failure|
|G Received|Ordinary/SMS, view/hide, decrypt/first-point/key failure, names/address/coordinates/time/expiry, note/ETA, stop viewing/refresh/Maps|
|H Circles|Actual Location capabilities: create/join/detail/roster/menu/rename/add/code/replace/remove/delete/leave/SMS return; hidden Chat/photo/custom-type excluded|
|I Links|Temporary and connection invites, duration/creation/live/expiry/unrecoverable URL, copy/share/revoke, cancellation/failure|
|J Map|Dedicated route/provider access/consent/retry, app-owned names/markers/legend/popover/tray, private/Ghost status; camera actions distinguished from preference writes|
|K Nearby|Name-only venue/search/duration/consent/check-in, active/moved-away/add-time/leaving, checkout/save/rating/note/counter/Maps|
|L Private Check-In|Separate encrypted flow: point freshness/Find/Refresh/Recenter, recipients/keys, duration/note/counter, edit/reconfirm/partial retained review/retry/cancel|
|M Save My Soul|Every specified label,2000ms hold and composer countdown/cancel, locked/busy/active, Stop confirmation, permission and conditional SMS roster/review/remove|
|N Settings/places|Approval scope/all/Circles/current-future copy/confirm/cancel, safety, Favorite/Checked In places, lock/load/empty/error/address/edit/remove/save feedback|
|O Public/guest|Signed-in invitation gates/acceptance, signed-out welcome/four intro stories/illustration/dots/back/login return, redirect loader, standalone public live/expired/no-point/retry/map/countdown/trust|
|P Cross-cutting|Actual Dialog/AlertDialog/Sheet/Drawer/menus/selects, duration/counters/validation/toasts/loaders and accessible-only copy|

[The action matrix](./location-action-coverage.md) records every composed CTA's initiating and resulting states, affirmative/negative/cancel/Back behavior and exact request or no-request boundary. Dynamic copy bindings and non-text/container/capability exclusions are stored separately. Hotel remains `notFound` and is excluded. No successful composer handoff is renamed delivery confirmation.

## Behavioral verification

- Focused mounted-owner suite:15 files,737 tests passed. Covers SOS hold/release/duplicate suppression/tap-delay Cancel, request/key validation, Stop locks; private Check-In, received/share lanes, contacts/invitation selection and busy Back, onboarding/place saving, map and shared dismissal.
- Back hierarchy suite:16 files,500 tests passed;160 authored routes and63 Location scenarios. Includes overlay/feature/route precedence, native/web Back and map returns.
- Cache regression suite:7 files,102 tests passed. No cache implementation changed.
- TypeScript, ESLint, design-system, frame-pacing/render-performance, product fonts/brand assets and Next production build passed. Final Back/Search source receipts and verification passed after source freeze:160 routes,63 Location scenarios,54 Search contracts,159 pages and2155 source modules. Repository governance, documentation, secret scan and architecture ratchet also pass; no new/worsened architecture findings.
- Independent source checks normalize22 onboarding/map/public owners and13 contacts/share/Circle owners to their pre-edit AST after removing presentation-only changes. Review found no copy, handler, state, auth/API/payload, cache/encryption or timing drift. Parent hub/SOS/private/saved/header changes were reviewed separately.

No real location grant, invitation delivery or emergency alert was issued. Backend/protocol/native suites were not repeated for this local presentation pass; prior unrelated release evidence is not presented as current full-core acceptance.

## Rendered viewport verification

Installed headless WebKit is used without Chrome or additional dependencies. The harness imports actual production page exports, shared AppTopShell/Navbar and real children/portals; only auth/vault/location/service/provider boundaries use sanitized fixtures. The final harness mounts the real VaultUnlockDialog graph rather than a UI replacement. Network writes and provider navigation are blocked.

The initial broad matrix covers16 actual route/view compositions (including Connect reference) × widths360,393,430,768,1024,1440 × light/dark =192 captures. It reports no page errors or outer horizontal overflow and visual viewport scale1. Every rendered text node records family/size/line/weight/tracking, parent and line boxes, wrapping/context and scroll metrics. Initial independently optimized harness CSS is identified separately from final shipped Next global CSS.

Final shipped-CSS evidence: **260 captures passed**, at360/393/430/768/1024/1440 in both themes, plus620/621/767/768 input-boundary cases. Page errors0; interaction errors0; horizontal overflow0. All12 Location/Connect header comparisons match. All10 measured Now card/CTA comparisons preserve size and horizontal position; desktop vertical origins differ by0.266px from the old fractional title line box, while phone origins are exact.

The owning built Next global stylesheet is `.next/static/chunks/1nfwruzdk5dlo.css`, SHA-256 `709a4a2f07be4f0f7f895de9c10a27635b79d2971a962b5f00a4addaf527bc6e`. CSS modules retain their harness build class names. Exact root html/body utility ancestry is mirrored. Actual normal400/600/700 faces load and pass `document.fonts.check` in all12 font-proof pages. Every final capture records stylesheet/source hashes, all visible app text (including visually rendered aria-hidden labels), computed font properties, element/range rectangles, line boxes, scroll regions and blocked network requests.

Twelve explicit keyboard-open/Escape checks cover person actions, auto-approve scope and Circle rename at393/1440 in both themes. They close correctly but return focus to BODY with connected triggers. The same12 checks against unchanged main behave identically. **Same-trigger focus restoration is a preserved baseline gap, not a passing assertion and not a typography regression.**

The browser artifacts are the session's `location-mounted-shipped-matrix`, `location-before`, `location-focus-font-proof` and `location-focus-baseline` bundles; the coverage ledger contains their hashes and record indexes. A contact sheet and original phone/web light/dark screenshots are supplied at handoff.

The existing guest intro forces light; a dark-document capture retains that authored light surface. Provider-owned map labels/credits and OS captions are outside app text ownership. The final screenshot and metadata manifest lives in the session outputs; hashes are linked in the coverage ledger. Source-only or nonuniquely associated text nodes explicitly remain unverified rather than being counted as rendered passes.

## Remaining acceptance gaps

Existing controlled person/scope/rename dialogs restore focus to BODY on Escape in both baseline and candidate. The existing RequestCard also treats pendingDecision as decided and can display Declined before acknowledgement. Both behaviors are documented and retained under the no-logic-change constraint.

- Physical iOS/Android keyboard/visual viewport, dynamic type, actual safe-area insets, native input zoom, permission prompts/Open Settings and lifecycle healing were not exercised.
- Actual auth/vault ownership, encryption/decryption/key rollover, provider map SDK results, contact Google/native handoffs, server partial/unknown outcomes and cross-device persistence are preserved source contracts, not live acceptance claims.
- Native OS composer/share UI and external Maps are not controlled; opening them cannot prove delivery. No emergency send is rehearsed against real recipients.
- Not every conditional empty/loading/error/busy/partial-success branch or long-name/singular/plural variation has uniquely matched DOM evidence at every width. The exact per-node gap remains in the coverage ledger; passing route captures do not close it.
- Browser harness evidence is distinct from a logged-in deployed Next route and physical native rendering. No merge, deploy, live UAT traffic or complete backend/core acceptance is claimed.

These gaps are why the result remains **Implementation complete / acceptance pending**.
