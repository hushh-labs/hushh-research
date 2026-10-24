# Location implementation and verification

## Visual Context

Canonical visual owner: [Hussh Webapp Docs](../README.md). [Location](./location.md) owns the shared header, workspace and focused-flow map.

## 24 October 2026 local CTA pass — revision-bound report

**Implementation complete / acceptance pending.** Started from fetched `origin/main` `dcc4f611e39c80a0001df0ada3f47e85b445421e` in a clean, detached worktree, then moved onto current `origin/main` `6e6563f32ed2360bdb008cc6daaf82e180b7e598` for review; the prompt’s `9af321d2a95610d7a90ecc8f80ee9d54bd8171b6` is an ancestor with no scoped Location/Connect/CSS/doc delta. The original developer branch and other edited checkout were left untouched. No merge, deploy, real location grant, connection request, invitation delivery or emergency alert was performed. This section supersedes earlier “latest” and “local only” language below; older captures and test counts remain tied to their own source and CSS hashes.

**Changed production owners:** `components/one-location/redesign/location-action-styles.ts`, `location-redesign-hub.tsx`, `check-in-flow.tsx`, `sos-panel.tsx`, `components/one-location/contact-sync-results-sheet.tsx`, `location-permission-recovery-card.tsx`, `onboarding/one-location-onboarding-flow.tsx`, and `saved-locations-section.tsx`. Browser fixtures/specs were updated in `e2e/one-location-people-rows.layout.spec.ts`, `e2e/fixtures/sms-flow.tsx` and `e2e/sms-flow.layout.spec.ts`. The five canonical Location contracts record this revision. No API/service/native/storage or shared Connect owner changed.

| Area | Before → after | Verification boundary |
| --- | --- | --- |
| Root shared header | Back + Location 17/22/600 + Profile, body sr-only H1/status → unchanged. The focused SOS breadcrumb remains navigation context; its body H1 remains the required 28/36/600 screen title. | Route graph/shared renderer and mounted return inspected; no new production header code. Authenticated six-width shell comparison for this revision pending. |
| Typography | Existing Plus Jakarta semantic roles, portal scopes and responsive inputs → unchanged. SOS SMS leaf now names its existing 42/42/600 `sms-display` role explicitly. | Source cascade and scoped SOS browser fixture measured. This does not certify every conditional text leaf. |
| People, Links, contact, invite row actions | Filled/grey/generic-outline or 36–40px controls → Connect neutral accent-border 44px pill/target where semantically matched; Copy width is stable across Copying…/Copied. | Current owner classes plus browser fixture across 320/350/351/360/393/430/620/621/767/768/1024/1440, light/dark. The wider pills preserve the single-line ellipsis for long person names; this is the bounded fit correction. |
| Recovery, saved places and private Check-In | Sub-44px quiet controls → 44px transparent targets; private final submit uses shared primary with a 54px minimum, wrapping long labels. | Source and focused behavioral/layout suites; not every state has a current mounted screenshot. |
| Circle Join/Decline and SOS Add/Edit | Join stays a 50px primary; Decline becomes 44px quiet. SOS Add becomes shared 52px primary; Edit stays 44px utility without scale. Emergency ring/timer/presets/Stop remain distinct. | Focused source and SOS fixture checks; destructive confirmation and exact native handoff remain separate. |

**Behavioral proof:** `npm run typecheck` and focused ESLint passed after the final production and fixture edits; 279 focused Vitest tests passed for Location page, SOS emergency and top-shell breadcrumbs. Seven focused Chromium layout specs passed 181 tests, covering People/Links geometry, onboarding Ready, contact sync, private Check-In, save-place sheet, CTA layout and SOS events. The final scoped SOS spec passed 53 tests in Chromium/WebKit against the optimized CSS, with one Chromium-only autoplay case intentionally skipped in WebKit. Its safe callbacks prove Add emergency contacts does not trigger a send, while browser pointer/keyboard events exercise preset, tap Cancel, hold, active receipt and Stop without live recipients. The portalled Stop confirmation measured the existing 20/25/600 raw-overlay title and explicit Connect scope. The revised invite/link fixture passed 24 light/dark breakpoint cases; the revised People pill passed 24. No test of a real grant or delivery is claimed.

**Optimized CSS proof:** a full `next build` passed with synthetic, nonproduction Firebase and loopback backend origins. The emitted global stylesheet `3dwl9_t-ggt45.css` has SHA-256 `d76fa7ca5efd30d0b629e98afe7e8df214205446ac12d8acbfe2a043ad27f92e`. It contains the accent `color-mix` border and 44/78/72px rules. Sixty-six focused Chromium cases initially passed against these **emitted bytes**: 48 People/invite/link cases across the 12 widths and both themes, plus 18 scoped SOS role/recovery cases. The final SOS run then passed 45 Chromium/WebKit cases against the same bytes, adding measured input roles at the 620/621px boundary and the Stop portal title. The fixture loads the shipped Plus Jakarta faces and checks computed family/size/line/weight, pill border/radius/rectangles, overflow and Copy label stability. This is source-coupled component/fixture proof, not an authenticated full-route capture. Initial unconfigured builds failed at page-data collection because backend/Firebase build configuration was absent; compilation and TypeScript had already passed, and the synthetic-config build closed the build check.

**Generated contract proof:** fetched main initially failed `npm run ui:doctor` on stale generated UI contracts. `npm run build:ui-contracts` refreshed Back (500/500 hierarchy cases; 160 routes and 63 Location Back scenarios), Search (54 contracts, 159 pages, 2216 modules), action gateway and surface projections, then stopped at the capability-graph step because the Windows `python3` alias was unavailable. A targeted run using the repository virtualenv Python exposed CRLF-dependent hashes in otherwise unchanged capability inputs; those platform-specific graph/catalog outputs were restored. The new immutable Back/Search receipts remain. The final `npm run ui:doctor` passed Back, Search, surface map, action gateway, Siri, route orchestration and 12 mutation regressions. `git diff --check` passed.

**Remaining acceptance gaps:** the complete authenticated mounted route and every body portal have not been captured at all requested widths/themes against live application state. Public/guest, deep Circle, received/review, partial/unknown, warm-cache, map/provider and native OS branches retain source and previous-revision evidence but lack unique current rendered proof. Actual auth/vault/key rollover, consent, native keyboard/safe area, map SDK, contact handoff, phone verification, clipboard/share destination and live emergency outcomes were not exercised. Existing Escape focus restoration and pending-decision display issues documented below are historical baseline gaps, not certified fixed here. The `local.default` action ledger record is a generic fallback without a concrete mounted binding. PR validation, merge and release status require separate GitHub and environment evidence.

**Implementation complete / live acceptance pending.** Initial source inspection and the full mounted matrix used main `b34d1e93d291cfa106b08893a9587973867044f2`; the release follow-up below records the later heading correction and supplemental evidence. GitHub delivery and environment deployment are proved separately by PR/workflow receipts. Source-backed text/state coverage is separate from native and live acceptance.

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
- `hushh-webapp/contracts/ui-review/back/48e04c4109b8c77cdbdd075029a772097cf8ba5f4ebfa754c7b0d72c37c38622.json`
- `hushh-webapp/contracts/ui-review/search/ac90b21a3a6a779a0f2d5c49ad86c9566864e259ec139fe6bb56e3b9f66c68ce.json`
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

The fresh ledger contains **1144 mounted text/a11y sites**, **163 composed CTA/state contracts**, and **104 explicitly excluded source sites**. Each in-scope text site has a disposition and an observation or exact evidence gap.

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


## Release typography and fixture follow-up — 2026-10-22

Hosted browser QA exposed two stale reference assumptions and one font-role mistake. Wallet's unchanged body-header geometry now compares with a frozen shared workspace reference instead of reconstructing Location's removed body heading. Every numeric spacing, geometry and font comparison remains; the fixture retains Wallet's authored compact-shell marker. No Wallet production code changed.

The onboarding feature-card heading owner now explicitly uses section-heading, and its six visual title lines inherit 14px / 22px / 600 with normal tracking. Its supporting descriptions use 12px / 18px / 400. Full-flow heading 28px / 36px / 600 is preserved. The source coverage entries entry-0007/0008 are corrected; their earlier description classification must not be treated as current heading evidence.

Focused WebKit verification passed nine cases: feature-card layout at 320/375/390/430/768/1440 and Wallet reference geometry at 320/393/1440. The card check measures all five font properties on actual visible title lines as well as their parent and descriptions. Existing copy/art/CTA fit, overflow and viewport bounds remain asserted.

Supplemental mounted onboarding feature captures: 12 passed at widths 360/393/430/768/1024/1440 in light and dark, using the final production build stylesheet. All 72 visible heading-leaf observations resolve to Plus Jakarta Sans 14px / 22px / 600, normal tracking; zero page/interaction errors or horizontal overflow at 100% zoom. All 48 image observations decode successfully, including the SVG pin after correcting the offline capture server’s MIME type. Task artifact name: location-onboarding-feature-title-fix, including heading-role-proof.json and source metadata. The earlier 260-state evidence remains historical proof; these observations supersede its onboarding feature-heading classification.

The supplemental onboarding capture build used global CSS chunk30v_qq8ofiwa6.css, SHA-256 `9ea92a27da54c41ad3a91c1a946e6a64d23e370c65856cee5a5f39b5dc21b982`; globals source SHA-256 `0a31272431447c194595773fe9964fc7d7f9ba0f4cbb7140f336b7fd368dc50b`. The upstream Memory addition is isolated beneath its own workspace hook. The prior mounted bundle is archived with the release evidence.

Combined-source review was refreshed after integrating main `275c203421f1cc466c68d4c47c9ab6b6b5227218`. The Back/Search receipts bind that combined source rather than the previous branch-only fingerprint. Location production files and the captured typography remain unchanged by this freshness merge; upstream private-chat, stream and deploy changes are inherited from main and are outside this PR’s diff.

The subsequent freshness review incorporates main `7da63ceda1b251d50edae23ff6e57177e7851751`, including shared subordinate tabs, Circle surfaces and profile/header controls. The Circle portal wrappers remain the only local changes in both overlapping Circle modules. Upstream phone member Share remains the header icon action; at that historical composition the shared custom-type input retained its InputGroup owner. The Location contract records the updated Share position. Initial captures remain dated evidence of their source; they do not claim verification of this later upstream composition. Regenerated Back/Search receipts above bind the combined source. Completed core evidence at `143776b9324345fbd18bd677fdea475be05aaee5` is paired with fresh changed-dependency checks; it is not described as a core run on a later SHA. Delivery and live UAT status require separate workflow proof.

Fresh combined-source captures (task artifact `location-latest-release`): 12 screenshots covering Now, Connect and Circle member actions at 393px and1440px, light/dark, 100% zoom. Zero page/interaction errors or horizontal overflow; all four Location/Connect root-header pairs match in font family, 17px /22px /600 title, baseline and shared control geometry. The phone member Share icon retains its upstream header position. These captures use Next global CSS `0e0cky5cnncc0.css`, SHA-256 `3e0c670de960f9ae6570d5cb8f7d24bf47374035e865ebaad1a25b25ab4fffa3`, from globals source SHA-256 `264f61327180019b252e3f8e054df8eb1d013a0904457b33e83c549058736fa3`. Metadata binds source `85b3ce246baea54fac13be51db17575a38c6f99c`; the following documentation/receipt commit does not change product source. Synthetic auth/service boundaries remain explicit; this is visual evidence, not live UAT acceptance.

A later freshness merge incorporates main `0ea0f8fce3f3a871fd5009876fd8b9fa568d99ed`. It brings upstream dependency/security and Direct Messages changes; the Location PR delta remains frontend presentation, tests and contracts only. Location production files, shared Back/Profile owners and global typography source are byte-identical to the 12-capture source above. The receipts bind this latest combined source. Existing visual evidence is reused within that unchanged UI scope; dependency verification uses the new frozen locks on Node24, targeted backend composition checks, import collection, packed MCP runtime and fresh frontend/governance checks. Exact-head hosted CI and release proof remain separate.

The refreshed Node24 build emits the exact same global CSS bytes as the 12-capture build: chunk `0e0cky5cnncc0.css`, SHA-256 `3e0c670de960f9ae6570d5cb8f7d24bf47374035e865ebaad1a25b25ab4fffa3`. No Location, Back/Profile, font or global CSS source delta exists from the captured source; principal React/Radix/Vaul/Tailwind runtime packages also retain their prior locked versions. This bounds reuse of those screenshots while the new dependency/combined-head gates are verified separately.

The final freshness review incorporates main `38082590d287830fef4dfdf7e3f25b6ab4ee9633`. Its inherited One profile sheet change removes the text-approval control and applies the existing activity-feed typography hook. This private-agent sheet is mounted by AgentChatWorkspace; it is separate from Location's top-bar Profile pane. Location, the captured shared header and Circle portal owners, fonts and global CSS remain unchanged. The combined Back/Search receipts are refreshed because the shared source graph changed; no Location functionality or backend dependency is added by this PR. Owner-specific profile checks and the final exact-head CI run are recorded separately from the reusable Location screenshots.

The next freshness review incorporates main `4da24d00ab79039422699209ffe473b0b532afb6`, including upstream Nearby discovery, strict Café/Stays categories and incomplete-discovery recovery. The inherited API/service behavior remains unchanged relative to main. This PR adds only the matching row-description and compact-action typography hooks to the new warning and retry text. The ledger records 1144 text/a11y sites and extends the existing K.retry contract; the action count remains 163. Old Nearby captures do not cover the new branch; fresh owner verification and supplemental mounted captures are recorded separately. Root Now/Connect/header and Circle member screenshot owners remain unchanged.

Supplemental Nearby evidence (task artifact `location-nearby-main-refresh`): 12 actual mounted-route/sheet captures at360/393/430/768/1024/1440, light/dark,100% zoom, with the refreshed shipped stylesheet. All24 new warning/retry observations match Plus Jakarta Sans, normal tracking,12px/18px with weight400/550 respectively; both texts are in view in every capture. Zero page/interaction errors or outer horizontal overflow. Source16e1c1c4326b3435d3b9c13e0b613ad74a888065 is bound by metadata and stylesheet hashes. Owner verification passed89 Nearby/service/category cases,9 duration-mapping cases and27 WebKit layout cases;134 focused backend cases also pass against the unchanged inherited backend tree, which exactly matches green upstream PR8348. The two new ledger records carry these observations; real transport/provider/native acceptance remains pending.

The subsequent combined-source review incorporates main `e9a02af1fc8f886a3323f5e3a2f6fc428d712198`, including inherited MCP OAuth registration, Dev runtime recovery and CI portability. Location render owners and global typography remain unchanged; these upstream changes add no backend or business-logic delta to this PR. Both Back and Search source receipts are refreshed because the inherited OAuth UI changes their input graphs. The dedicated Back-only CI job does not replace the broader local/Web Core verification. Exact backend API, MCP, database and dependency identities are compared with green upstream PR8350; fresh bounded composition checks and exact-head hosted validation remain distinct release evidence.

The latest composition incorporates main `9e8905d1d770719cb0af1a093f53da790115d0d1` (Calendar/Connect polish). Approved upstream Share icon contrast and ContactSync canonical-avatar changes are preserved. Circle name focus styling is inherited; its actual nearest shared owner remains14/22/400 at phone and desktop. Connect-only custom Type now uses the shared raw field and remains excluded from Location. The historical avatar ledger ID is retargeted to shared ConnectionPersonAvatar; its populated-results branch has source/unit proof and an explicit rendered-evidence gap. Counts remain1144 text/a11y sites,163 composed actions and104 exclusions.

Fresh task artifact `location-9e-release` contains20 actual mounted captures at393/1440 in light/dark: Now, matching Connect, Circle member actions, focused Circle name and onboarding Ready. Four header pairs match all five font properties, title baseline and shared Back/Profile geometry. Four focused Circle-name observations measure14/22/400 with normal tracking and loaded Plus Jakarta Sans. All20 captures have zero page/interaction errors or outer horizontal overflow at100% zoom. They use shipped CSS `23c1uriqmb9t2.css` (SHA256 `10ec9dc86d9bc459995b3db82669fa04505934bf81201f6d03c3b22a3f995a32`) from source `9cf9498320055520490b1d72610868d8e6f50d78`. The screenshot sheet uses four unmodified Now captures. Shared-owner tests pass274 cases plus7 canonical-avatar cases; eight focused WebKit Connect layout/reference checks pass. Earlier six-width evidence remains dated and reusable only within unchanged owner boundaries; real auth/provider/native/UAT acceptance is separate.

The subsequent composition incorporates main `901838b512c426656c30a87c4f61f09760d1b09e` (Mail receipt continuity and bounded security-alert cursor handling). No Location/Connect/header/Profile/icon/font/CSS render owner changes in that upstream delta. Both combined receipts are refreshed because the Mail and shared Vault/PKM/resource inputs changed. The Location PR delta remains frontend presentation, tests and contracts only; ledger counts remain1144/163/104. The shared Vault addition clears Mail display cache on lock;91 focused vault/cache/storage cases pass. New inherited Mail backend behavior is checked by96 owner cases and a31093-case import collection, with existing schema/configuration/locks unchanged. Same-source upstream MCP and Integration success is reusable; canceled upstream Protocol runs are explicitly not a full-backend green proof. Hosted exact-head validation remains separate from this bounded composition evidence and the dated mounted screenshots.

Fresh `location-901-release` evidence repeats20 mounted phone/desktop light/dark captures against the new shipped stylesheet `38oo46uzj5nmn.css` (SHA256 `9d9659f38385e5c10e3782a01b9312d0d1aafc07c6a2144b8b82b55a19fac8e2`), source `b24322e8e75df138d7c170f15671e01d391833d9`. All4 header pairs and4 focused Circle-name comparisons match; all20 captures have loaded fonts,100% zoom,zero page/interaction errors and outer overflow. The4 Now screenshots are pixel-identical to the delivered9e sheet. This refresh does not expand physical-device/provider/real-session acceptance.

The additional inherited Mail verification passes115 proxy/storage/migration/markdown/recent-row cases and59 full receipt-page cases. One initial grouped page test timed out under the unchanged5s limit; the isolated full59-case file passes in7.17s, with no code or threshold change. Fresh combined UI generation, complete Web Core, governance, standard selected integration, docs and secret checks pass; final DCO and exact published-head CI are recorded separately. Two stale nested ledger source descriptors are corrected to the shared avatar graphic owner and conditional raw Circle input; counts and behavior contracts are unchanged.
