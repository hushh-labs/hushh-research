# Agent One typography audit — 2026-10-14

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).

The primary hierarchy is page and section headings at Jakarta 600, navigation
at CSS 550, body and card copy at 400, primary actions at CSS 650, and
uppercase metadata in system monospace 400. The actual shipped font files are
400, 600, and 700; the intervening CSS values resolve to those faces.

## Scope and method

Four independent read-only passes inventoried (1) anonymous onboarding, login,
registration, and redirects; (2) One home, Feed, Profile, wallet, and settings;
(3) the capability roster, agent chat, connectors, and specialist workspaces;
and (4) shared type tokens, native wrappers, route coverage, and automated
layout checks. The implementation was then made in a fresh branch from `main`.

The route census below contains **153 `app/**/page.tsx` files**: 95 under
`/one` and 58 elsewhere. A route file is not necessarily a unique rendered
screen: some routes redirect, and chat panels, sheets, tabs, and OAuth popups
can render without their own `page.tsx`. These were included in the component
and asset inspection.

A final selector-cascade sweep checked the rendered winner for local overrides,
including shared `!important` type roles, before closing the audit.

## Findings and resolution

| Surface | Audited state before this change | Resolution |
| --- | --- | --- |
| Shared web UI and WebView | `InterVariable` was loaded globally; Tailwind `font-mono` also pointed at the body face. Many local 500/700/800 weights overrode semantic roles. | Self-host Plus Jakarta Sans normal and italic 400/600/700; make it the shared product family; use system monospace for metadata; change semantic title, navigation, section, card, form, and action roles. |
| Anonymous welcome and login | The earlier welcome carousel used several 535–800 weights. Light/dark auth and phone registration overrode the global family with SF Pro. | Set welcome/page headings to 600, body to 400, uppercase kicker to mono 400, action copy to the 650 CSS role; remove SF Pro overrides and keep local form labels at 600. |
| Mentor onboarding V7.2 | While this branch was in review, `main` replaced the earlier welcome carousel with a new four-screen mentor introduction. Its stylesheet carried Inter fallbacks, H1 at 700, CTA at 500, and illustrated card copy at 500/600. | Use Jakarta fallbacks, H1 at 600, primary action at 650, and illustrated card/body copy at 400. The new browser layout contract remains in the shared verification set. |
| Initial Contacts onboarding | A later main update enabled the Contacts setup choice in signup and added a welcome invite sheet. The signup checkbox label inherited body 400, provider CTAs used 700, and “Join Contacts” in the invite sheet used 500. | Give the active signup form label the 600 label role, provider CTAs the CSS 650 role, and the invite card title the 400 regular role. The new welcome screen inherits the shared Jakarta family. |
| One home and Feed | Shared app shell and capability tiles inherit the global family; Feed rows use shared semantic list roles. | Shared family/role change reaches both. The roster and Feed keep their existing route and data behavior. |
| Profile and account | 38 route files under `/one/profile`, including account, security, preferences, connected systems, receipts, and support. Local profile pane and row weights competed with shared tokens. | Align page and pane titles with 600, descriptive rows with 400, and labels/actions with the semantic roles. |
| Personal World Model research and invitations | A later main update added the public invite preview and Profile research/invitation forms. New input labels inherited 400, and research section and coverage topic labels used 500. | Give input, section, and coverage topic labels the 600 role; retain 400 for explanatory copy and consent sentences. The public invite page inherits the shared Jakarta family and PageHeader roles. |
| Specialist agents and chat | The roster includes Messages, Finance/Kai, Wallet, Location, Advisor/RIA, Mail, Calendar, KYC, Memory, Consent, Information Marketplace, and CRM. Chat workspaces and connector panels used local bold/medium utilities. | Use the shared family across One, Puppy, Marketplace, Circle, Gmail, Location, and specialist chat entry points. Align key chat titles, card titles, connectors, calendar, Kai, and Location headings. Capability status and visibility remain state driven. |
| Calendar connected and public screens | A later main update added schedule rows with 600-weight event titles, 500-weight provider titles, a regular-weight Join action, 400-weight form labels, and a 500-weight Ask One CTA override. Its browser contract still expected Inter. The public rescheduling page's “Suggest” links also inherited body weight. | Use 400 for event/provider card titles and quiet row copy, 650 for Join, Ask One, and public “Suggest” actions, 600 for form labels and settings legends, and assert Jakarta in the Calendar browser contract. |
| ToDos | A later main update added a ToDos page with task titles at 600 and an uppercase “Completed” label in Jakarta 600. | Render task titles in the regular 400 row role and the completed-group metadata in system monospace 400. Keep the page and section headings at 600, action buttons at the CTA weight, and form labels at 600. |
| Referrals dashboard | The earlier route-local CSS forced the hero H1 to 700, the streak heading to 500, a reward heading to 650, and the uppercase eyebrow to Jakarta 700. A later dashboard redesign demoted several live H2/H3 headings and the invite CTA through broad 400-weight rules; its new SVG hero still drew live text in Arial. | Set live H1/H2/H3 and reward headings to 600, the highlighted earlier hero span to 700, card titles and rule copy to 400, navigation tabs to 550, the invite CTA to 650, and uppercase eyebrows to system monospace 400. Draw the SVG hero labels and amounts in Jakarta at 400/600. |
| Messages, Circle, Sources, and account dialogs | Later component CSS forced Messages and Circle chat headings and account dialog titles to 700; the agent Sources heading was 500. | Align these live H1/H2 titles to 600 in their winning local selectors. |
| Wallet cards and image export | Versioned SVG artwork embedded Lexend 500/600/700; the live identity overlay used the same separate family. Static card reference pages requested Lexend from Google Fonts. | Embed the shipped Jakarta 400/600/700 faces in each self-contained SVG; use Jakarta for live identity fields and local font files on reference pages. |
| Wallet card scanner | A later main update added a live “Scan here to add card” CTA at 500 weight and an illustrated scan card with baked-in serif lettering. | Use the shared Jakarta CTA weight for live text and 400 for the additional-fields summary. The illustrated card lettering is documented below as raster artwork. |
| Wallet QR actions | A later main update added a compact QR action column whose buttons defaulted to 600, and a setup disclosure title at 500. | Set the action buttons to the 650 CTA role and the “More details” disclosure to the 400 regular role; keep the quiet referral preview link at 400. |
| Wallet sharing details | A later main update added a detail-panel navigation title pinned at 500 despite the shared navigation role being CSS 550; its browser fixture asserted the same stale weight. | Use the CSS 550 navigation role in the panel and its focused browser contract. Card-network labels already inherit the 600 amount/label role. |
| Portfolio image sharing | Canvas snapshot used Manrope. | Draw with loaded Jakarta faces and system mono for uppercase metadata. |
| Mail OAuth placeholder | The brief popup used `system-ui`. | Load the local regular Jakarta face in its same-origin blank document. |
| Verification fixtures | Layout fixtures pinned Inter; one markdown width constant came from Inter's x-height. Browser assertions still expected 700-weight chat headings, and the Wallet fixture served only v1 artwork while the app requested v2. | Load the shipped Jakarta faces, update font/geometry and heading assertions, and serve both v1 and v2 artwork in the browser fixture. |
| Final live-selector sweep | Welcome illustration cues stayed at 700; Profile appearance/access rows, Wallet visitor and swipe rows, connector titles, and an agent-profile empty state stayed at 500. The live payment-card face mixed 700/500/650, bottom navigation labels stayed at 500, Circle sender names were 700, and the chat identity and an email-draft metadata label missed their roles. | Use 400 for body/card rows and wallet nickname, mono 400 for uppercase metadata, 600 for payment-card values and chat/sender names, and CSS 550 for bottom navigation. Shared button and H1 selectors already supply their intended 650/600 weights; the sweep checked winning styles before changing local declarations. |

### Adopted role mapping

| Role | CSS weight | Shipped face |
| --- | ---: | ---: |
| Brand wordmark, page H1, hero, major section heading | 600 | 600 |
| Header navigation, tabs | 550 | 600 |
| Emphasized hero span, primary buttons and CTAs | 700 / 650 | 700 |
| Body, card/role titles, FAQ questions, quiet links, footer copy | 400 | 400 |
| Form labels, pay or wallet amounts | 600 | 600 |
| Uppercase metadata, footer column labels, copyright | system monospace 400 | system monospace |

The 550 and 650 CSS values deliberately choose the adjacent shipped 600 and
700 faces. Browser and OS font fallback still supplies scripts not covered by
the Latin font files.

### Explicit boundaries

The main app renders in web or native WebView and uses the shared CSS. A small
number of platform-owned pixels do not inherit it: iOS native tab labels and
notification initials, Android's privacy overlay, splash images, and generated
map marker initials. Third-party brand marks remain their supplied artwork.
The wallet scanner's illustrated card has baked-in serif lettering (`AGENT ONE`
and `PROFILE`); it is raster artwork rather than live UI text.
Portable report and portfolio PDF generators use their own print-safe fonts;
the app's on-screen and wallet PNG typography is covered here. Historical
unreferenced SVG wordmark files remain static assets; the live wordmark
component uses Jakarta. Versioned v1 wallet SVGs and their Lexend license
remain available for older cached bundles and public links; new wallet
requests use Jakarta-based v2 artwork.
External SOS and KYC email HTML uses email-client-safe system font stacks;
those messages render outside Agent One and do not load the app's local font files.

## Feed and account state coupling check

The release brief also asked whether a removed Feed item stays removed after
sign-out and sign-in. The code-backed answer is **yes for Feed history on the
same account**: authenticated dismiss and Clear requests persist `dismissed_at`
in owner-scoped `feed_events`; the next list excludes those rows. Sign-out
invalidates client caches, and the Feed session remounts by UID. Account reset
and full deletion erase the owner's Feed rows with other account data. This
audit did not run a live cross-session account test; existing tests cover the
server writes, owner scoping, UI acknowledgment, and auth cache invalidation
as separate contracts. The owning paths are the [Feed UI](../../../hushh-webapp/components/feed/feed-page.tsx),
[server Feed service](../../../consent-protocol/hushh_mcp/services/feed_service.py),
and [account cleanup](../../../consent-protocol/hushh_mcp/services/account_service.py).

One narrower exception remains: dismissed revoked SOS actionable IDs and an
old Feed Clear watermark use UID-scoped device storage. The account cleanup
helper does not remove those keys immediately; the old watermark migrates on
the next Feed mount. Active Needs-you actionables are intentionally retained
by Clear. This does not undo a server-persisted history removal, but it is a
separate cleanup item for the account lifecycle owner.

## Route inventory

The complete route-file list below is generated from `hushh-webapp/app/**/page.tsx`
and gives an explicit inspection checklist. Protected routes require account
state for a live visual walkthrough; this audit used source inspection and
automated contracts without signing into a personal account.

| Route | Source |
| --- | --- |
| `/blog/[slug]` | [page.tsx](../../../hushh-webapp/app/blog/[slug]/page.tsx) |
| `/blog` | [page.tsx](../../../hushh-webapp/app/blog/page.tsx) |
| `/c/[token]` | [page.tsx](../../../hushh-webapp/app/c/[token]/page.tsx) |
| `/calendar/reschedule` | [page.tsx](../../../hushh-webapp/app/calendar/reschedule/page.tsx) |
| `/circle/join` | [page.tsx](../../../hushh-webapp/app/circle/join/page.tsx) |
| `/connected-systems/[systemId]` | [page.tsx](../../../hushh-webapp/app/connected-systems/[systemId]/page.tsx) |
| `/connected-systems` | [page.tsx](../../../hushh-webapp/app/connected-systems/page.tsx) |
| `/consents` | [page.tsx](../../../hushh-webapp/app/consents/page.tsx) |
| `/delete-account` | [page.tsx](../../../hushh-webapp/app/delete-account/page.tsx) |
| `/developers` | [page.tsx](../../../hushh-webapp/app/developers/page.tsx) |
| `/getting-started` | [page.tsx](../../../hushh-webapp/app/getting-started/page.tsx) |
| `/gmail` | [page.tsx](../../../hushh-webapp/app/gmail/page.tsx) |
| `/kai/analysis` | [page.tsx](../../../hushh-webapp/app/kai/analysis/page.tsx) |
| `/kai/dashboard/analysis` | [page.tsx](../../../hushh-webapp/app/kai/dashboard/analysis/page.tsx) |
| `/kai/dashboard` | [page.tsx](../../../hushh-webapp/app/kai/dashboard/page.tsx) |
| `/kai/funding-trade` | [page.tsx](../../../hushh-webapp/app/kai/funding-trade/page.tsx) |
| `/kai/import` | [page.tsx](../../../hushh-webapp/app/kai/import/page.tsx) |
| `/kai/investments` | [page.tsx](../../../hushh-webapp/app/kai/investments/page.tsx) |
| `/kai/onboarding` | [page.tsx](../../../hushh-webapp/app/kai/onboarding/page.tsx) |
| `/kai/optimize` | [page.tsx](../../../hushh-webapp/app/kai/optimize/page.tsx) |
| `/kai` | [page.tsx](../../../hushh-webapp/app/kai/page.tsx) |
| `/kai/plaid/oauth/return` | [page.tsx](../../../hushh-webapp/app/kai/plaid/oauth/return/page.tsx) |
| `/kai/portfolio` | [page.tsx](../../../hushh-webapp/app/kai/portfolio/page.tsx) |
| `/login` | [page.tsx](../../../hushh-webapp/app/login/page.tsx) |
| `/logout` | [page.tsx](../../../hushh-webapp/app/logout/page.tsx) |
| `/manishhussh` | [page.tsx](../../../hushh-webapp/app/manishhussh/page.tsx) |
| `/marketplace/connections` | [page.tsx](../../../hushh-webapp/app/marketplace/connections/page.tsx) |
| `/marketplace/connections/portfolio` | [page.tsx](../../../hushh-webapp/app/marketplace/connections/portfolio/page.tsx) |
| `/marketplace` | [page.tsx](../../../hushh-webapp/app/marketplace/page.tsx) |
| `/marketplace/ria` | [page.tsx](../../../hushh-webapp/app/marketplace/ria/page.tsx) |
| `/oauth/authorize` | [page.tsx](../../../hushh-webapp/app/oauth/authorize/page.tsx) |
| `/one/calendar` | [page.tsx](../../../hushh-webapp/app/one/calendar/page.tsx) |
| `/one/career` | [page.tsx](../../../hushh-webapp/app/one/career/page.tsx) |
| `/one/connect` | [page.tsx](../../../hushh-webapp/app/one/connect/page.tsx) |
| `/one/connect/settings` | [page.tsx](../../../hushh-webapp/app/one/connect/settings/page.tsx) |
| `/one/connected-systems/[systemId]` | [page.tsx](../../../hushh-webapp/app/one/connected-systems/[systemId]/page.tsx) |
| `/one/connected-systems` | [page.tsx](../../../hushh-webapp/app/one/connected-systems/page.tsx) |
| `/one/consent` | [page.tsx](../../../hushh-webapp/app/one/consent/page.tsx) |
| `/one/email` | [page.tsx](../../../hushh-webapp/app/one/email/page.tsx) |
| `/one/feed` | [page.tsx](../../../hushh-webapp/app/one/feed/page.tsx) |
| `/one/gmail` | [page.tsx](../../../hushh-webapp/app/one/gmail/page.tsx) |
| `/one/kai/analysis` | [page.tsx](../../../hushh-webapp/app/one/kai/analysis/page.tsx) |
| `/one/kai/funding-trade` | [page.tsx](../../../hushh-webapp/app/one/kai/funding-trade/page.tsx) |
| `/one/kai/import` | [page.tsx](../../../hushh-webapp/app/one/kai/import/page.tsx) |
| `/one/kai/investments` | [page.tsx](../../../hushh-webapp/app/one/kai/investments/page.tsx) |
| `/one/kai/market` | [page.tsx](../../../hushh-webapp/app/one/kai/market/page.tsx) |
| `/one/kai/news` | [page.tsx](../../../hushh-webapp/app/one/kai/news/page.tsx) |
| `/one/kai/onboarding` | [page.tsx](../../../hushh-webapp/app/one/kai/onboarding/page.tsx) |
| `/one/kai/optimize` | [page.tsx](../../../hushh-webapp/app/one/kai/optimize/page.tsx) |
| `/one/kai` | [page.tsx](../../../hushh-webapp/app/one/kai/page.tsx) |
| `/one/kai/plaid/oauth/return` | [page.tsx](../../../hushh-webapp/app/one/kai/plaid/oauth/return/page.tsx) |
| `/one/kai/portfolio/allocation` | [page.tsx](../../../hushh-webapp/app/one/kai/portfolio/allocation/page.tsx) |
| `/one/kai/portfolio/holdings` | [page.tsx](../../../hushh-webapp/app/one/kai/portfolio/holdings/page.tsx) |
| `/one/kai/portfolio` | [page.tsx](../../../hushh-webapp/app/one/kai/portfolio/page.tsx) |
| `/one/kai/portfolio/performance` | [page.tsx](../../../hushh-webapp/app/one/kai/portfolio/performance/page.tsx) |
| `/one/kai/portfolio/sources` | [page.tsx](../../../hushh-webapp/app/one/kai/portfolio/sources/page.tsx) |
| `/one/location/check-in/hotel` | [page.tsx](../../../hushh-webapp/app/one/location/check-in/hotel/page.tsx) |
| `/one/location/check-in` | [page.tsx](../../../hushh-webapp/app/one/location/check-in/page.tsx) |
| `/one/location/invite/[token]` | [page.tsx](../../../hushh-webapp/app/one/location/invite/[token]/page.tsx) |
| `/one/location/map` | [page.tsx](../../../hushh-webapp/app/one/location/map/page.tsx) |
| `/one/location` | [page.tsx](../../../hushh-webapp/app/one/location/page.tsx) |
| `/one/location/request/[token]` | [page.tsx](../../../hushh-webapp/app/one/location/request/[token]/page.tsx) |
| `/one/location/view/[token]` | [page.tsx](../../../hushh-webapp/app/one/location/view/[token]/page.tsx) |
| `/one/marketplace` | [page.tsx](../../../hushh-webapp/app/one/marketplace/page.tsx) |
| `/one/messages` | [page.tsx](../../../hushh-webapp/app/one/messages/page.tsx) |
| `/one` | [page.tsx](../../../hushh-webapp/app/one/page.tsx) |
| `/one/pkm/location/detail` | [page.tsx](../../../hushh-webapp/app/one/pkm/location/detail/page.tsx) |
| `/one/pkm/location` | [page.tsx](../../../hushh-webapp/app/one/pkm/location/page.tsx) |
| `/one/pkm` | [page.tsx](../../../hushh-webapp/app/one/pkm/page.tsx) |
| `/one/pkm/recent` | [page.tsx](../../../hushh-webapp/app/one/pkm/recent/page.tsx) |
| `/one/profile/access/connection` | [page.tsx](../../../hushh-webapp/app/one/profile/access/connection/page.tsx) |
| `/one/profile/access` | [page.tsx](../../../hushh-webapp/app/one/profile/access/page.tsx) |
| `/one/profile/account` | [page.tsx](../../../hushh-webapp/app/one/profile/account/page.tsx) |
| `/one/profile/account/phone` | [page.tsx](../../../hushh-webapp/app/one/profile/account/phone/page.tsx) |
| `/one/profile/connected-systems` | [page.tsx](../../../hushh-webapp/app/one/profile/connected-systems/page.tsx) |
| `/one/profile/connectors/oauth/return` | [page.tsx](../../../hushh-webapp/app/one/profile/connectors/oauth/return/page.tsx) |
| `/one/profile/connectors` | [page.tsx](../../../hushh-webapp/app/one/profile/connectors/page.tsx) |
| `/one/profile/gmail/actions` | [page.tsx](../../../hushh-webapp/app/one/profile/gmail/actions/page.tsx) |
| `/one/profile/gmail/connection` | [page.tsx](../../../hushh-webapp/app/one/profile/gmail/connection/page.tsx) |
| `/one/profile/gmail/oauth/return` | [page.tsx](../../../hushh-webapp/app/one/profile/gmail/oauth/return/page.tsx) |
| `/one/profile/gmail` | [page.tsx](../../../hushh-webapp/app/one/profile/gmail/page.tsx) |
| `/one/profile/google/oauth/return` | [page.tsx](../../../hushh-webapp/app/one/profile/google/oauth/return/page.tsx) |
| `/one/profile/integrations` | [page.tsx](../../../hushh-webapp/app/one/profile/integrations/page.tsx) |
| `/one/profile/my-data/domain` | [page.tsx](../../../hushh-webapp/app/one/profile/my-data/domain/page.tsx) |
| `/one/profile/my-data` | [page.tsx](../../../hushh-webapp/app/one/profile/my-data/page.tsx) |
| `/one/profile` | [page.tsx](../../../hushh-webapp/app/one/profile/page.tsx) |
| `/one/profile/payouts` | [page.tsx](../../../hushh-webapp/app/one/profile/payouts/page.tsx) |
| `/one/profile/pkm-agent-lab` | [page.tsx](../../../hushh-webapp/app/one/profile/pkm-agent-lab/page.tsx) |
| `/one/profile/pkm` | [page.tsx](../../../hushh-webapp/app/one/profile/pkm/page.tsx) |
| `/one/profile/preferences/device` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/device/page.tsx) |
| `/one/profile/preferences/gemini` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/gemini/page.tsx) |
| `/one/profile/preferences/kai` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/kai/page.tsx) |
| `/one/profile/preferences` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/page.tsx) |
| `/one/profile/preferences/voice/changelog` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/voice/changelog/page.tsx) |
| `/one/profile/preferences/voice/examples` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/voice/examples/page.tsx) |
| `/one/profile/preferences/voice` | [page.tsx](../../../hushh-webapp/app/one/profile/preferences/voice/page.tsx) |
| `/one/profile/receipts` | [page.tsx](../../../hushh-webapp/app/one/profile/receipts/page.tsx) |
| `/one/profile/referrals` | [page.tsx](../../../hushh-webapp/app/one/profile/referrals/page.tsx) |
| `/one/profile/regulatory` | [page.tsx](../../../hushh-webapp/app/one/profile/regulatory/page.tsx) |
| `/one/profile/request-pricing` | [page.tsx](../../../hushh-webapp/app/one/profile/request-pricing/page.tsx) |
| `/one/profile/security/devices/authorize` | [page.tsx](../../../hushh-webapp/app/one/profile/security/devices/authorize/page.tsx) |
| `/one/profile/security` | [page.tsx](../../../hushh-webapp/app/one/profile/security/page.tsx) |
| `/one/profile/security/session` | [page.tsx](../../../hushh-webapp/app/one/profile/security/session/page.tsx) |
| `/one/profile/security/vault` | [page.tsx](../../../hushh-webapp/app/one/profile/security/vault/page.tsx) |
| `/one/profile/support/compose` | [page.tsx](../../../hushh-webapp/app/one/profile/support/compose/page.tsx) |
| `/one/profile/support` | [page.tsx](../../../hushh-webapp/app/one/profile/support/page.tsx) |
| `/one/profile/support/routing` | [page.tsx](../../../hushh-webapp/app/one/profile/support/routing/page.tsx) |
| `/one/profile/world-model` | [page.tsx](../../../hushh-webapp/app/one/profile/world-model/page.tsx) |
| `/one/puppy` | [page.tsx](../../../hushh-webapp/app/one/puppy/page.tsx) |
| `/one/referrals` | [page.tsx](../../../hushh-webapp/app/one/referrals/page.tsx) |
| `/one/setup/[capability]` | [page.tsx](../../../hushh-webapp/app/one/setup/[capability]/page.tsx) |
| `/one/setup/calendar` | [page.tsx](../../../hushh-webapp/app/one/setup/calendar/page.tsx) |
| `/one/setup/connected-systems` | [page.tsx](../../../hushh-webapp/app/one/setup/connected-systems/page.tsx) |
| `/one/setup/connections` | [page.tsx](../../../hushh-webapp/app/one/setup/connections/page.tsx) |
| `/one/setup/email` | [page.tsx](../../../hushh-webapp/app/one/setup/email/page.tsx) |
| `/one/setup/finance/import` | [page.tsx](../../../hushh-webapp/app/one/setup/finance/import/page.tsx) |
| `/one/setup/finance` | [page.tsx](../../../hushh-webapp/app/one/setup/finance/page.tsx) |
| `/one/setup/gmail` | [page.tsx](../../../hushh-webapp/app/one/setup/gmail/page.tsx) |
| `/one/setup/kai` | [page.tsx](../../../hushh-webapp/app/one/setup/kai/page.tsx) |
| `/one/setup/location` | [page.tsx](../../../hushh-webapp/app/one/setup/location/page.tsx) |
| `/one/setup` | [page.tsx](../../../hushh-webapp/app/one/setup/page.tsx) |
| `/one/setup/ria` | [page.tsx](../../../hushh-webapp/app/one/setup/ria/page.tsx) |
| `/one/todos` | [page.tsx](../../../hushh-webapp/app/one/todos/page.tsx) |
| `/one/wallet-card` | [page.tsx](../../../hushh-webapp/app/one/wallet-card/page.tsx) |
| `/one/wallet` | [page.tsx](../../../hushh-webapp/app/one/wallet/page.tsx) |
| `/one/welcome` | [page.tsx](../../../hushh-webapp/app/one/welcome/page.tsx) |
| `/` | [page.tsx](../../../hushh-webapp/app/page.tsx) |
| `/people/[personRef]` | [page.tsx](../../../hushh-webapp/app/people/[personRef]/page.tsx) |
| `/pkm` | [page.tsx](../../../hushh-webapp/app/pkm/page.tsx) |
| `/portfolio/shared` | [page.tsx](../../../hushh-webapp/app/portfolio/shared/page.tsx) |
| `/privacy` | [page.tsx](../../../hushh-webapp/app/privacy/page.tsx) |
| `/products/hushh-tech/launch` | [page.tsx](../../../hushh-webapp/app/products/hushh-tech/launch/page.tsx) |
| `/profile/google/oauth/return` | [page.tsx](../../../hushh-webapp/app/profile/google/oauth/return/page.tsx) |
| `/r/[slug]` | [page.tsx](../../../hushh-webapp/app/r/[slug]/page.tsx) |
| `/register-phone` | [page.tsx](../../../hushh-webapp/app/register-phone/page.tsx) |
| `/research` | [page.tsx](../../../hushh-webapp/app/research/page.tsx) |
| `/research/protocol` | [page.tsx](../../../hushh-webapp/app/research/protocol/page.tsx) |
| `/ria/claim` | [page.tsx](../../../hushh-webapp/app/ria/claim/page.tsx) |
| `/ria/clients/[userId]/accounts/[accountId]` | [page.tsx](../../../hushh-webapp/app/ria/clients/[userId]/accounts/[accountId]/page.tsx) |
| `/ria/clients/[userId]` | [page.tsx](../../../hushh-webapp/app/ria/clients/[userId]/page.tsx) |
| `/ria/clients/[userId]/requests/[requestId]` | [page.tsx](../../../hushh-webapp/app/ria/clients/[userId]/requests/[requestId]/page.tsx) |
| `/ria/clients` | [page.tsx](../../../hushh-webapp/app/ria/clients/page.tsx) |
| `/ria/onboarding` | [page.tsx](../../../hushh-webapp/app/ria/onboarding/page.tsx) |
| `/ria` | [page.tsx](../../../hushh-webapp/app/ria/page.tsx) |
| `/ria/picks` | [page.tsx](../../../hushh-webapp/app/ria/picks/page.tsx) |
| `/ria/profile` | [page.tsx](../../../hushh-webapp/app/ria/profile/page.tsx) |
| `/ria/requests` | [page.tsx](../../../hushh-webapp/app/ria/requests/page.tsx) |
| `/ria/settings` | [page.tsx](../../../hushh-webapp/app/ria/settings/page.tsx) |
| `/ria/workspace` | [page.tsx](../../../hushh-webapp/app/ria/workspace/page.tsx) |
| `/terms` | [page.tsx](../../../hushh-webapp/app/terms/page.tsx) |
| `/wallet/open` | [page.tsx](../../../hushh-webapp/app/wallet/open/page.tsx) |
| `/welcome` | [page.tsx](../../../hushh-webapp/app/welcome/page.tsx) |
| `/world-model/invite` | [page.tsx](../../../hushh-webapp/app/world-model/invite/page.tsx) |
