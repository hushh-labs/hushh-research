# Wallet UI contract

Current presentation (26 October 2026): two collections, **My cards** and
**Shared with me**. Add opens an adaptive sheet; selecting a card opens its
details with Share and Manage access. The existing service, consent, encrypted
storage, recipient verification and reveal contracts remain authoritative.

The older measurements below describe the preceding Connect-alignment change
based on `dcc4f611e39c80a0001df0ada3f47e85b445421e`; they are historical evidence,
not verification of this collection layout.

## Save feedback and completion

A valid submission closes Add immediately and displays an unsaved pending tile
in My cards while the existing `WalletService.addCard` pipeline runs. Network
validation, stable registration/draft identity, encryption, atomic PKM writes,
confirmation receipts and Secrets filing remain in their existing services.
The tile does not increase the saved-card count and cannot reveal, share or
remove a card. A single workspace-owned operation prevents duplicate dispatch;
Add is unavailable while that operation is unresolved.

Only the confirmed receipt inserts a saved card. Completion preserves the
current tab/selection. An uncertain result says “Save not confirmed”; explicit
Retry uses the same in-memory input and draft ID, while Dismiss drops its local
retry information. There is no automatic replay. Owner, key, owner-token,
vault epoch, hidden-page and unmount boundaries retire retained input and stale
UI callbacks. Retirement does not claim an already-dispatched write was
cancelled; a later authoritative read reconciles accepted writes.

The 26 October follow-up uses the existing `uat` runtime profile: localhost
frontend with the deployed UAT backend. This avoids local cross-region database
and missing-key configuration delays without changing the save API. A synthetic
live save showed its pending tile at 587ms and the accepted saved card at
8893ms; these are one diagnostic run, not production latency guarantees.

## Loading contract

Route suspense, introduction-preference reads, owned-card reads and received-card
reads use the shared card-grid skeleton with the final responsive geometry.
Recipient discovery uses avatar/name placeholders. Known card details remain
visible while their design loads. Masked summaries and names can render before
cosmetic artwork completes. Initial
presentation progress is memory-only and follows the same owner/auth/vault/source
fences as the final snapshot. Artwork display recovery has one 30-second total
budget; form selection retains its existing shorter budget. Expired approvals
never regain authority through a timeout. Failed recovery settles to a readable
neutral card rather than an indefinite pending face.

Share and Manage access open immediately from a selected card, including while
access state is loading or unavailable. They compose the existing recipient
search, selection, duration, encryption, stable request and grant operations.
The final send stays disabled until the existing access check succeeds; failed
checks show Retry inside the sheet and never fabricate access or send grants.

Received history skips outgoing Profile eligibility. Focus and periodic refresh
coalesce while a history request is running; owner/session changes and privacy
hiding still abort it. Readiness errors remain distinct from an empty collection.
The protected recipient viewer loads on demand and survives the verification
popup's temporary visibility change, while vault/session changes retire it.

Local diagnosis: the backend returned `503 WALLET_CARD_ACCESS_DISABLED` with
all three required tables installed; its two Wallet feature flags were unset.
Enable the existing local runtime flags to exercise sharing. Separately, observed
artwork validation took 18–24 seconds, exceeding the previous 8-second display
budget. The local runtime also exposed request-pool starvation: three LISTEN sessions
plus Gmail scheduled synchronization occupied all four async slots. Gmail now
uses the existing bounded dedicated-connection helper for its advisory lock;
request capacity and lock cleanup have a regression check. Remote
database/authentication latency remains a runtime concern; this
presentation does not bypass those checks.

## Visual Context

[Product UI contracts](./README.md) owns the cross-surface visual map. The
route and state ledger below expands Wallet's mounted presentation and its
handoffs to Connect, Profile, Feed, Messages, and One.

## Mounted route, state and host ledger

| Route or host | Mounted state and visible controls | Source owner | Authority and close behavior |
| --- | --- | --- | --- |
| One launcher → `/one/wallet` | Wallet entry and prewarm; route fallback “Loading cards…” | `components/wallet/wallet-entry-warmup.tsx`, `app/one/wallet/page.tsx` | Navigation through the existing One route; prewarm is not a secret read. |
| `/one/wallet`, owner-local introduction | Loading, “All your cards in one place”, Continue, “Opening your wallet…”, persistence-error toast | `components/wallet/wallet-workspace.tsx` | Continue writes only the owner-local seen flag. Accepted persistence opens Cards; failure leaves Continue available. No consent or vault mutation. |
| `/one/wallet`, My cards | Opening, feature-disabled, locked/Unlock, error/Try again, payment-card grid, framed One card previews on desktop and compact artwork rows on phones, selected detail panel, metadata search from `q`, details, Remove confirmation | `wallet-workspace.tsx`, `wallet-card-browser.tsx`, `wallet-saved-card-details.tsx` | Tab and card selection are local; search only uses `q`. The shared Back layer unwinds request, nested/card/tab state before One. Keep card cancels removal; confirmed removal waits for the accepted encrypted PKM write. |
| `/one/wallet`, Add sheet | Ready form, scan/gallery/camera/crop, OCR review, validation, Save/Cancel, saving/error/accepted | `secure-card-add-form.tsx`, `wallet-card-scanner.tsx`, `wallet-live-card-capture.tsx`, `wallet-card-crop.tsx` | Scan/crop/OCR are local or OS-owned. Save uses the existing Wallet service and stable draft ID; Cancel and Back use the form's reset callback; a valid submission closes Add and moves its pending status into the collection. |
| `/one/wallet`, selected Sharing | Recipient picker, active grants, previous encrypted copies, Revoke | `wallet-saved-card-sharing.tsx` | Selected card/Profile grant authority and exact recipient/duration remain with card-access services. Closing a busy picker retires UI callbacks, not the dispatched operation. |
| `/one/wallet`, Shared with me / Wallet access | Received-card grid and protected viewer; Wallet access panel contains outgoing history and Wallet-wide consent Manage/revoke | `wallet-sharing.tsx`, `wallet-sharing-history.tsx` | History is metadata; wallet-wide consent has its own scopes and action owner. Keep sharing is no API call. Consent pending requests are fetched but their Review branch has no mounted row. |
| `/one/wallet?card_request=id` | Request owner or requester Dialog, loading/error/retry, select/decline/withdraw/fulfil/expire/Done | `wallet-card-request-review.tsx` | Closing only clears `card_request`; exact response identity and role checks stay with the request service. |
| Embedded Profile/NWS; `/one/wallet-card` | Profile bootstrap, intro/edit/preview/success/manage, QR and Apple Wallet actions | `components/wallet-card/wallet-card-workspace.tsx` and children | Embedded details add no route chrome; standalone route retains its authored parent. Public token publication is separate from temporary sharing. |
| `/c/[token]`, `/r/[slug]` | Public Profile/NWS and referral token, QR/pass/link handoffs | `app/c/[token]`, `app/r/[slug]`, `components/wallet-card` | Public access uses its existing token rules and no signed-in Profile control. OS share and pass installation outcomes are external. |
| Person, Feed, Messages, Consent | Request cards, view request, temporary access, earlier sent-copy reader, Wallet-wide scope | `request-cards-button.tsx`, `wallet-card-access-message.tsx`, `wallet-shared-card-message.tsx`, existing owners | Host routes own navigation; recipient access and encrypted copies remain separate authorities. |
| `/wallet/open` | Anonymous encrypted-file chooser, password, Open, error and Hide | `wallet-encrypted-card-viewer.tsx` | Local decryption only; no account, upload or native refusal in this component. File change, Hide and background retire cleartext. |
| One chat | wallet.list/add/reveal widgets, compact Add form, 45-second Reveal | `components/agent/agent-chat-workspace.tsx`, `secure-card-add-form.tsx`, `secure-card-reveal.tsx` | Chat action gateway remains the caller. Compact Add collects no owner CVV; Reveal requires the existing high-risk confirmation and local vault read. |

The mounted Cards deck uses `WalletAddCollection` and `WalletCardSwipe`.
`WalletCardStack`, artwork/design pickers and the generic collection actions do
not have a mounted production entry from this route. OS camera, gallery, share
and Apple Wallet interfaces are external UI.

## Presentation target ledger

The signed-in shell owns its 44 × 44 Back and Profile actions. The final Wallet
breadcrumb is the compact 17/22/600 title beside Back; preceding navigation is
550. The body has no duplicate Wallet title after the shell receives that
breadcrumb. The introduction withholds body controls, and conditional Done
retains its current reducer-only effect.

| Role | Target CSS size / line / weight | Applicable Wallet text |
| --- | --- | --- |
| Workspace tab | 15 / 20 / 550 | My cards, Shared with me |
| Full-page authoring title | 28 / 36 / 600 | Appropriate standalone setup heading only |
| Section and secondary group | 14 / 22 / 600; 12 / 18 / 600 | Details, sharing groups, history |
| Primary and supporting row | 14 / 21 / 550; 12 / 18 / 400 | Names, labels, help and status context |
| Form label and ordinary input | 15 / 22 / 550; phone 16 / 22 / 400, desktop 14 / 22 / 400 | Add, Profile and encrypted-file inputs |
| Helper and status | 13 / 18 / 400; 13 / 18 / 600 | Scan instructions, validation, loading, countdown |
| Compact command | 12 / 18 / 550 | Equivalent ordinary Connect actions |
| Task title, description, action | 20 / 28 / 600; 14 / 20 / 400; 13 / 20 / 600 | Wallet-owned Dialog, AlertDialog, Sheet, Drawer and detail portals |
| Prominent commit | 17 / 22 / 650 | Explicit Save and credential actions where appropriate |

All app text uses the self-hosted `--font-app-body` or `--font-app-display`.
Payment artwork, network marks, QR modules, printed SVGs and intentionally
scaled card numbers are separate from ordinary UI copy. PAN/CVV/expiry keep
their numeric direction and legibility.

Equivalent ordinary commands use the existing Connect quiet outline anatomy:
44px target and inner pill, 1px accent-mixed border, card interior, accent
label/icon, 88px minimum and 15px inset (78/11 at ≤620px; 72/9 at ≤350px).
Long labels expand; destructive, icon-only, selector and explicit-save actions
retain their semantic variants.

## Authority and verification ledger

Source review confirms that Wallet-wide `attr.wallet.secrets.*` projects PAN
and cardholder name and excludes manually saved CVV. The mounted Manage copy
now says “Card numbers and cardholder names. Saved security codes are not
shared.” Selected-card grants, public Profile tokens, referral QR, Wallet-wide
consent and old encrypted copies remain distinct.

Initial `npm run ui:doctor` on clean `main` failed on stale route orchestration,
surface-map and action-gateway generated artifacts. Back and Search coverage
passed. The computed browser evidence for the changed presentation is listed
in the verification section below; source review is not counted as device
verification.

## Visible text, controls and state transitions

The table is scoped to executable callers. Dynamic text is a template, not a
fixture value. The label/placeholder/error authorities are
[`secure-card-add-form.tsx`](../../components/wallet/secure-card-add-form.tsx),
[`wallet-card-copy.ts`](../../components/wallet-card/wallet-card-copy.ts),
[`wallet-card-fields.ts`](../../components/wallet-card/wallet-card-fields.ts),
and the linked components below. Shared `SettingsRow` and `Button` supply the
accessible role, disabled and focus behavior unless a row says otherwise.

| Host and condition | Exact authored text / accessible control | Result, including negative path |
| --- | --- | --- |
| One launcher and route fallback | Wallet; “Loading cards…” | Launcher/prewarm navigates to `/one/wallet`; fallback is loading only. No secret read from the prewarm. |
| Owner-local first visit | “All your cards in one place”; Continue; “Opening your wallet…” | Continue writes the local seen flag. Accepted write reveals Cards; persistence failure leaves the same introduction and retry control. No Skip, consent or vault mutation. |
| Disabled / loading / locked / error | “Wallet is not available here yet.”; “Opening your wallet…”; “Your wallet is locked”; “Unlock your vault to see your cards.”; Unlock; “Your cards did not open”; Try again | Unlock opens the existing Vault dialog. Try again rereads; owner/vault change retires old results. No saved payment cards still leaves three system cards. |
| Cards overview and selected deck | “Your cards”; View details; Add a payment card / Add another card; Back; “{index} / {count}”; Next card; “This is a sample score; no net worth evaluation has been run. Sharing uses your Wallet Profile and its scan totals.” | Order is Profile, Referral, NWS, then saved cards. Swipe preview is masked and local. Back returns overview; Next cannot exceed end; hidden All/thumbnails/+ navigation stays screen-reader-only. Artwork pending is neutral. |
| Cards `?q=nonempty` | Search cards; “Search by nickname, network, last four, or region”; “No cards match that search.”; “{nickname or network} · {network} ending {last4}” | Metadata-only local filter. Selection clears query. No visible Search opener, full-PAN search or pagination. Legacy page query is cleaned. |
| Saved card details | Card details; Card number; Name on card; Card network; Expiry (MM/YY); Issuing region; Not provided; Copy card number / name on card / card network / expiry date / issuing region; Copied.; “Could not copy. Try again.” | Ordinary DOM shows masked PAN. Copy PAN freshly checks owner, vault, selected card and visible context before clipboard. Copy disabled during an operation; absent values retain a 44px alignment spacer. No Copy CVV or full-PAN Reveal control here. |
| Owner CVV row | CVV; •••; Show / Show CVV; Reading…; Hide / Hide CVV; Not saved; “Could not show CVV. Try again.” | Explicit owner-only encrypted read. Auto conceal after 45 seconds; hidden/lock/inactive/epoch changes retire it. No recipient/export projection. |
| Remove confirmation | Remove card; “Remove {nickname or network ending last4}?”; “This removes the card and its details from your vault on every device. You can add it again later.”; Keep card; Remove card; “Removing card…”; “Card removed.”; “The card could not be removed.” | Keep, X, Escape or outside dismissal: no deletion. Confirm waits for accepted encrypted PKM deletion before visual removal and quiet reread. Failed mutation does not delete locally. Busy guard retains captured owner/card context. |
| Add acquisition | Scan card; Scan to add card; Take photo; Choose from photos; “Place your card inside the frame.”; “Camera unavailable. Choose a photo or enter your card details.”; Cancel | Browser camera is inline; native picker/camera is OS-owned. Picker cancellation keeps the form. Capture releases stream on cancel/background. No image upload. |
| Add crop/OCR | Crop card photo; four 44px handles; Read card; Use full photo; Cancel scan; “Reading on your device…”; recognized/unclear/read-failed notices | Crop and OCR are local with optional iOS Vision. Invalid corners disable Read. Cancel/Back retires photo/worker. Recognized, needs-review, missing and owner-edited values remain distinguishable; OCR never saves or overwrites an edit. |
| Add review | Card number (“XXXX XXXX XXXX XXXX”); Name on card; Expiry (MM/YY) (“MM/YY”); Card network; Auto-detect / “Auto-detect · {network}”; Other; Issuing region; “Select region…”; CVV (“3 or 4 digits”); “Only visible to you in Wallet.”; “Network options could not load. Auto-detect is still available.”; Retry network options | Number/expiry caret and grouping stay local. Name uppercases, max 80. Network lookup sends six-digit prefix, length, optional choice; region/CVV validation occurs locally. Optional manual CVV appears only for approved owner web Add; compact chat Add omits it. |
| Add commit | Add to Wallet; Saving…; Cancel; validation list (`ERROR_COPY`); “Check your card details.”; “Your card could not be saved. Please try again.” | Invalid fields focus errors and keep draft. Pending save consumes Back and disables controls. Same draft ID survives failure/uncertainty. Accepted encrypted write clears raw fields, rotates ID, selects saved card in Cards; artwork may resolve later without another Save. Cancel is local reset. |
| Embedded/standalone Profile | “Your profile, one scan away”; “Add a Hussh One pass to Apple Wallet.”; Name; Username; optional Headline; Primary contact (Mail/Phone/LinkedIn/Link); “Shown first after a scan.”; More details / “{count} added”; Company/college; Location (city/region); Summary; Skills; GitHub; Portfolio; “You choose what shows”; “Only what you pick is visible. Change or switch it off anytime.”; Create profile / Save changes; Cancel | Auto-bootstrap is insert-only and may go straight to manage. Optional-field errors open the disclosure and focus the field. Save validates allowlist/URLs/contact; failed save keeps draft. Embedded page adds no second shell; standalone keeps its own route. |
| Profile preview / manage | Preview as visitor; “Loading the visitor view…” / “We couldn't load the visitor view right now. Please try again in a moment.”; Wallet preview; What a visitor sees; Edit shared information; Not now; Wallet Profile; Sharing is on/paused; Last updated; Scans; Last scan; Your QR; Add to Apple Wallet; Share card / Retry card image; Copy link; Revoke access; Pause/Resume sharing; Remove Wallet profile | Preview uses owner `/preview`, so no public scan increment. Setup-origin and manage-origin Back differ. QR recovery/availability, share/download/cancel and OS pass states stay distinct. “Opened” never means installed. |
| Profile confirmations | “Pause sharing?” / “Hide your profile until you resume sharing.”; “Resume sharing?” / same QR and installed pass explanation; “Revoke QR access?” / “Replace shared QR links and reset scans for Profile and NWS.”; “Remove Wallet profile?” / “Permanently remove this profile and stop sharing.”; Cancel; Working…; matching confirm label | Cancel/Back/Escape/outside is no API. Busy rejects dismissal. Accepted pause/resume/rotate/remove updates profile state/device link and existing event; failure keeps old state. Destructive variant stays distinct. Full fixed wording is in `WALLET_CARD_CONFIRMATIONS`. |
| Referral | “Your referral QR”; Add to Apple Wallet; Share card / Retry card image; Copy link; Revoke access; Preview referral page; Link opens; Last opened / No opens yet; Qualified referrals; In progress; Under review; Recent referrals; “Opens include QR scans and links, not unique visitors. Progress updates automatically.”; loading/error/Try again | Real summary counts and rows. Confirmed “Revoke referral QR access?” replaces link and resets opens while earned progress remains. Copy/share/open handoffs do not imply viewing or installation. |
| Public `/c/[token]` | Loading skeleton; This profile is no longer shared.; This profile link has expired.; This profile isn't available. / “Check the link, or ask for a new one.”; We couldn't load this profile. / “Check your connection and try again.” / Try again | Unauthenticated token resolution. Unknown and paused share one unavailable state; revoked and expired have distinct copy. Allowed contact links use safe URLs; badge disclaims identity verification. No signed-in Profile chrome, mounted Save-contact action or private grant conversion. |
| Selected temporary grant | Sharing; Share card; “Temporary access for your connections.”; Shared with; Retry; Loading shares… / No active shares; recipient/date/Revoke; Load more shares / Retry loading shares; Previously sent copies; “Sent copy · cannot be recalled”; Share Profile Card / Share card; “Share your selected profile details with your connections.” / “Share your full card number and details with selected connections.” | Picker opens mobile Sheet/desktop detail. Close retires callbacks and selected map, but dispatched sharing may continue. Direct per-card Revoke is immediate, unlike history revoke. Old encrypted copies are separate and irreversible. |
| Selected grant picker | Search connections; Finding connections…; Retry connections; No connections found.; Search by name to find more connections.; Trusted Circle; “{N} of 20 connections selected. Share with up to 20 at a time.”; Access time (15 minutes / 1 hour / 2 hours); “People outside your Trusted Circle verify their identity before viewing. Security codes are never shared.”; Share with {N} / Sharing… | No select-all, public link or arbitrary recipient. Search is paged read; choices local. Share encrypts permitted details, keeps exact recipient/duration/request ID on retry; accepted grants refresh list. Unknown acknowledgement is reread/retry, never assumed success or cancelled by closing. |
| Person request and `/one/wallet?card_request=id` | Request a card; Send request / Sending…; Cancel; Card request sent; Choose a card to share / Card request; Checking this request…; Retry; Card/Agent One Profile/payment choices; Checking your Profile Card… / Retry Profile Card; Access duration 15m/1h/2h; Share card / Sharing…; Decline / Withdraw request; Done; Card sent / Request declined / Request withdrawn / Request expired | Person dialog verifies connection/keys and stable request ID. Owner choice has no default. Closing only removes query; decline/withdraw call explicit role-owned endpoint. Busy close rejected. Terminal Done is local. Reopen/reread protects response identity and unknown retry. |
| Wallet access / wide consent | Shared cards; Cards shared with you; paged metadata/empty/error/retry; history status/dates/duration/trust/verification/activity; Back to sharing history; Revoke access; Keep sharing; Shared with; Card details / Card summary; Manage; “Stop sharing Wallet access?” | Outgoing active history revoke confirms and warns that viewed information cannot be taken back. Wide consent uses `attr.wallet.summary.*` and `attr.wallet.secrets.*`; active Manage only is reachable. Correction: “Card numbers and cardholder names. Saved security codes are not shared.” Pending Review/Approve/Decline JSX has no rendered entry. |
| Messages temporary grant / old copy | A card was shared with you. / You shared a card.; View card; browser-only notice; Shared card; Checking access…; Verify your identity to view this card.; Verify identity / Verifying…; remaining countdown; This access has ended. / currently unavailable; Hide; old copy View/Unlock/Opening; “Browsers cannot block screenshots or photos.” | Server time and expiry own lifetime; verification does not extend it. Recipient envelope decryption, sender binding and last-four-only recovery are separate. Native viewer is unavailable. Hidden/pagehide/focus/print/owner change retire plaintext; copy/cut/drag/context suppression is UI mitigation, not screenshot prevention. |
| Anonymous `/wallet/open` | Open encrypted card; “Choose the file and enter its password. No account needed.”; Encrypted card file; Password; Reading file… / Opening… / Open card; “The file opens on this device. It is never uploaded.”; exact invalid-file/wrong-password toasts; Card number/Name on card/Card network/Expiry (MM/YY)/Issuing region; Hide card | File/password and decrypted fields remain memory-local. Wrong input keeps form; Hide/file change/background retire cleartext and password. No account, network, download, copy or exporter CTA. Envelope limit is 8 KiB. |
| One chat widgets | Payment cards are not enabled in this environment.; Unlock your vault to work with your cards.; No cards are stored yet.; No stored card matches that reference. Ask for the card list first.; That card could not be decrypted on this device.; “Which card should I show? Use its nickname or last four digits.”; list rows and Reveal; compact Add; revealed Card number/Expires/optional Name on card, Copy..., Copied, Hides in {secondsLeft}s, Hide, Hidden again., Dismiss | One action gateway/high-risk confirmation owns Reveal. Tool-visible list is nickname/last-four metadata. Chat Add has no CVV. Reveal lasts 45s and hides on background; no PAN/CVV/PIN enters model messages. |

The request, consent, Person, Messages and public Profile owners contain their
full neighboring route copy: [Person](./person-profile.md),
[Profile](./profile.md), [Feed](./feed.md), [Profile Memory](./profile-memory.md),
and [Navigation](./navigation.md). Their wording is not reauthored here.

## Read and mutation wires

`A` = `/api/one/wallet/card-access`; `P` = `/api/one/wallet-card`.
The methods below are the **current mounted caller paths**, not a new API.
Owner A requests carry Firebase `Authorization: Bearer <ID token>` and the
vault-owner token in `X-Hushh-Consent`; recipient grant view/verify uses the ID
token without owner consent. Owner P/PKM calls retain their own vault-owner
headers. Public token/pass and referral resolve calls do not attach account
authorization. Every row is fenced by current owner/epoch/visibility as
applicable. Shared list reads serve all their rows.

| Visible read/action and owner | Exact request/query/body | Consumed response and effect |
| --- | --- | --- |
| Owner card summaries, names, explicit PAN/CVV, add/remove — [`WalletService`](../../lib/services/wallet-service.ts) | `GET /api/pkm/domain-data/{userId}/wallet` with optional `segment_ids`; local decrypt. Write base `GET /api/pkm/domain-snapshot/{userId}/wallet`. Accepted mutation `POST /api/pkm/store-domain` with `encrypted_blob`, manifest, mutation plan and `expected_data_version` through the existing PKM owner. | Summary ID/nickname/network/last4/expiry/region/artwork drives deck and rows; unlocked presentation also uses the decrypted owner cardholder name. Full PAN and CVV require their explicit copy/show reads. Save/remove consume accepted success or idempotent replay/version result before local transition and cache event. Conflict/unknown write keeps draft or prior card and rereads. No plaintext-card endpoint. |
| Add network selector — [`WalletService`](../../lib/services/wallet-service.ts) | `GET A/networks`; `POST A/networks/resolve` `{iinPrefix: six digits, panLength, selectedNetwork?}`. | Validated network, source (`prefix`, `owner_selected`, `ambiguous`, `unknown`), candidate list. Fallback Auto-detect and Retry options on failure. Full PAN/CVV/photo never sent. |
| Automatic saved-card artwork — same service | Mounted Save/recovery can call `POST A/artwork/banks` for an approved network illustration; existing catalog validation uses `POST A/artwork/validate` `{selections,purpose}` and `GET A/artwork/assets/{digest}`. `POST A/artwork/resolve` belongs to the unmounted artwork picker. | Catalog version/match/provider/approved digest and image determine cosmetic face only. Pending/failed artwork is neutral and cannot reverse an accepted card Save. The bank/design editor itself is unmounted from this Add caller. |
| Add registration — [`WalletCardAccessService`](../../lib/services/wallet-card-access-service.ts) | `POST A/registrations` `{requestId}` before owner card save. | `{cardId,enabled}` reservation is best effort; encrypted PKM write remains the card authority. Stable draft/request identity survives uncertain save. |
| Per-card eligibility, grants and recipients — same service | `GET A/cards/{cardId}?cursor?`; `GET A/profile`; `GET A/connections?query={encoded search}`. | `eligible/reason/grants/hasMore/nextCursor`, Profile card ID, and `personRef/displayName/photoUrl/trusted` drive state, picker and history. One list request supplies multiple rows. Readiness outage pauses automatic refresh; explicit Retry remains. |
| Selected-card/Profile share — [`WalletCardAccessService`](../../lib/services/wallet-card-access-service.ts), [`wallet-card-share-service`](../../lib/services/wallet-card-share-service.ts) | `POST A/cards/{cardId}/grants` `{requestId,recipientPersonRefs,durationMinutes,encryptedCards?,cardRequestId?}`. UI restricts duration to 15/60/120 and recipients to 20. | Existing recipient-key encryption includes approved card details and excludes CVV. Returned grants/IDs/status/createdAt/expiresAt update active rows and subscribers; same identity/recipients/duration/expiry are retained on retry. Close after dispatch does not cancel the server operation. |
| Direct or history grant revoke — same service | `DELETE A/grants/{grantId}`. | `{revoked}` plus change notification updates matching recipient/history after accepted result; errors keep old access. Per-card row is immediate; outgoing history asks confirmation first. |
| Recipient grant and verification — same service | `GET A/grants/{grantId}`; `POST A/grants/{grantId}/verify` after linked Google/Apple reauthentication. | Status, `serverNow`, `expiresAt`, sender binding, masked card or encryptedCard, permitted profileCard. Server clock controls countdown. Full PAN appears only after recipient-vault envelope decryption and metadata match; last-four-only response stays masked. Verification cannot extend expiry. |
| Outgoing/received history — same service | `GET A/history?direction=outgoing|received&cardType?&cursor?`. | Page `items/hasMore/nextCursor/serverNow`; row/displayLabel/status/dates/duration/trust/verification/activity. Cursor append preserves earlier pages. History is metadata only; no component call to the unused history-detail backend route. |
| Person request create/read/decide — same service | `POST A/requests` `{personRef,requestId}`; `GET A/requests?cursor?`; `GET A/requests/{requestId}`; `POST A/requests/{requestId}/decline` or `/cancel`. | Validated request role/owner/requester/status/expiry/response fingerprint. Person trigger becomes sent only on accepted create; owner selected-card grant fulfils it through share with `cardRequestId`. Decline/withdraw cannot be inferred from closing. Unknown response is reread and retried with same operation identity. |
| Wallet-wide consent — [`WalletSharing`](../../components/wallet/wallet-sharing.tsx) | Existing Consent Center `GET /api/consent/center/list` and `useConsentActions` mutation path, filtered to `attr.wallet.summary.*` and `attr.wallet.secrets.*`; paid-terms interception stays with Consent. | Active bundle completeness, requester, scope, expiry and status feed Shared with/Manage. Projector emits approved summary plus PAN/cardholder name for secrets scope, not manual CVV. Pending requests are fetched but have no rendered review row. |
| Owner Profile — [`WalletCardService`](../../lib/services/wallet-card-service.ts) | `GET P?user_id=...`; `POST P/ensure` `{userId,cardPayload,avatarUrl?,shareToken?}`; `POST P` `{userId,cardPayload,expiresAt?}`; `POST P/rotate` `{userId}`; `POST P/pause` / `/resume` `{userId}`; `DELETE P?user_id=...`; `GET P/preview?user_id=...`. | `enabled/exists/card/status/scanCount/lastScanned/shareTokenVersion` and allowlisted visitor projection drive intro/manage/preview. Ensure is insert-only and recovers missing device link; pause preserves same QR; rotate invalidates it; remove forgets local link. Owner preview does not increment public scan activity. Accepted mutations notify `hushh:wallet-profile-changed`. |
| Public Profile and pass — same service | `GET P/public/{token}`; `GET P/pass/{token}.pkpass` for Profile, with `?variant=referral` or `?variant=nws` for those faces. | Public projection includes only permitted identity/contact/avatar/scan-safe fields. `not_found` covers unknown and paused; revoked/expired distinct. Pass availability is checked before handing signed URL to OS. Unsupported or failed handoff toasts its result; the separately mounted Share link control remains available. A successful URL open does not prove installation. |
| Referral summary/rotation/landing — [`ReferralService`](../../lib/services/referral-service.ts) | Owner `GET /api/one/referrals/summary`; `POST /api/one/referrals/rotate` `{slug}` with ID token. Public `POST /api/one/referrals/resolve` `{slug,landing_route?}` without owner auth. | Link/open count/last opened/qualified/in-progress/under-review/recent rows feed activity. Rotation checks current slug and keeps earned progress. Landing stores only opaque attribution and can proceed unattributed. |
| Anonymous encrypted-file reader — [`wallet-card-file`](../../lib/wallet/wallet-card-file.ts) | **No API call**: local file read and password decrypt. | Maximum 8 KiB allowlisted envelope; decrypted fields only in component memory. Hide/file change/background and stale-operation revision clear display/password. |
| One chat Wallet list/add/reveal — [`agent-chat-workspace`](../../components/agent/agent-chat-workspace.tsx) | Existing `agent_wallet` generated action gateway. List reads summary metadata; Add delegates to `WalletService.addCard` with `surface:chat`, `source:agent_chat_wallet_add`; Reveal local vault decrypt after high-risk confirmation. | Model/tool summaries can include nickname or brand, brand, last four, expiry and issuing region; no PAN, CVV or PIN. Compact Add omits CVV. Successful add removes widget; Reveal screen expires after 45s/Hide/background. No second chat routing authority. |

Local tab/card selection, Back/Done, swipe, search filtering, crop/recognition,
checkboxes/duration selection, clipboard, OS share, QR drawing, file Hide and
modal cancellation make **no API call** themselves. A copied link or dispatched
OS share is not evidence of recipient access. Wallet-wide consent, selected
temporary grants, public Profile, referral QR and prior sent copies never
share a revocation authority.

## Branches, dismissal and focus

| Path | Accepted outcome | Cancel, failure, unknown or Back outcome |
| --- | --- | --- |
| Share → select → Cancel | None | Sheet/desktop detail closes, selection retires, focus returns to Share card. Reopening requires recipient reselection; the last local duration choice can remain. No API. |
| Share → select → confirm | Grant IDs returned and state/list refresh. | While the picker remains open, unknown acknowledgement rereads/retries the same request ID, selected recipients and duration. Closing an in-flight picker retires callbacks and selection; it cannot undo a dispatched grant. |
| Add → scan → Cancel | None | Back-first scanner/crop cancellation revokes object URL, stream and worker; form edits remain. No API. |
| Add → validation failure → correction → accepted Save | Encrypted PKM commit, clear fields, new draft ID, Cards focuses saved card. | Failed validation focuses error; network/PKM uncertainty preserves draft ID and owner input. Pending Save consumes Back; no optimistic card insertion on failed commit. |
| Remove → Keep card | None | Dialog closes/focus returns; no deletion API. Confirmed failure keeps card and announces error. Accepted remove animates/returns overview without revealing a neighbor. |
| Request → decline/withdraw/fulfil/expire | Role-specific accepted endpoint/grant result drives terminal copy. | Close/Done only removes query or dialog. Unknown mutation uses same request/response identity; expiry/readiness denies late action. Successful unlock does not auto-reopen review. |
| Profile pause/resume/rotate/remove | Accepted owner mutation updates management state/link. | Cancel, X, outside, Escape and Back make no API. Busy dismissal rejected. Failed mutation preserves old state. QR rotation is separate from referral rotation/card deletion/grant revoke. |
| History revoke | Confirmed DELETE stops future access and returns focus to trigger. | Keep sharing and outside/Escape dismiss with no API; prior viewed information remains with recipient. |
| Recipient verification/view | Server-authorized unexpired projection/decryption. | Browser-only native refusal; expired/revoked/unavailable no reveal. Blur, hide, pagehide, print, route/owner/epoch change retire cleartext. |

Back order is overlay, nested scanner/editor/detail, tab/card state, authored
parent. `Done` only unfocuses the reducer; selected-card Back returns the
overview; root returns One. The shared shell owns Back and Profile, with the
existing Profile opener/focus restoration. Tabs stay local despite the
`queryParam="view"` declaration; only `q` and `card_request` alter URL state.
No raw history fallback, duplicate shell bar, login gate on public readers or
visible thumbnail dock is added.

## Geometry and portal ownership

These are the final source formulas, with no zoom or scale compensation. The
header change removes one body heading; it does not insert a second shell
reserve. The production CSS fixture checked horizontal fit and control reach
at the widths recorded in the verification section.

| Surface | Final layout and scroll owner | Source |
| --- | --- | --- |
| Standard Wallet shell | Existing shared 44 × 44 Back/Profile targets, one top spacer and bottom chrome reserve. The Wallet introduction uses `min-height: calc(100svh - var(--app-top-shell-height, 64px) - var(--app-bottom-shell-height, 132px) - 32px)`; the owner content column is at most 820px. The body no longer reserves a duplicate Wallet PageHeader. | `WalletWorkspace`, `TopAppBar`, `signed-in-shell-content-offset` |
| Tabs and cards browser | Tabs remain the controlled local pager. The browser has an 820px maximum, 20px padding (32px from 640px), 16px top margin, and its own clipping. Selected card face maximum is `min(420px, (100dvh - 260px) × 1.586)`; the ISO artwork/card ratio stays `85.6 / 53.98`. The deck measures viewport, bottom chrome, details and edge strips before fitting up to 420px. | `wallet-card-browser.module.css`, `wallet-add-collection.tsx`, `wallet-card-face.tsx` |
| Add form and scanner | Form padding is 20px (28px from 640px). Its container becomes two columns at 460px; expiry/network stay paired, fields and crop handles have 44px targets, and the image cap is `min(48vh, 380px)`. `FlowActionGroup` keeps the footer paired. The shell scroll root scrolls the form; no nested form scroller is added. | `secure-card-add-form.module.css`, `wallet-card-crop.tsx`, `wallet-workspace.tsx` |
| Profile, QR and public reader | Standalone Profile inner width is at most 580px; embedded Profile uses the selected-card detail composition. QR/action rows use `clamp(48px, 18%, 80px)` plus a flexible track, 8px action gaps and at most 440px action width; the 480px rule preserves two flexible action columns. `/wallet/open` and selected-card details keep their respective 820px and card-sized bounds. | `wallet-card-workspace.tsx`, `wallet-card-qr-actions.module.css`, `wallet-encrypted-card-viewer.tsx` |
| Selected share and history | Selected-card/Profile picker remains a phone Sheet and a desktop detail panel capped at 580px, with `max-height: calc(100dvh - var(--kb-height, 0px) - 32px)` and an inner scrolling body. History detail uses the shared phone Drawer/desktop detail panel and returns focus to its row. | `wallet-saved-card-sharing.tsx`, `.module.css`, `wallet-sharing-history.tsx`, `SettingsDetailPanel` |
| Requests and confirmations | Person's illustrated request Dialog retains its own 480px composition. Owner request Dialog remains `max-height: 85dvh`, scrollable, with desktop `sm:max-w-lg`. Remove/Profile/history confirmations retain shared AlertDialog width, scrim, focus trap, outside/Escape rules and action ripple. | `request-cards-button.tsx`, `wallet-card-request-review.tsx`, `wallet-card-confirm-dialog.tsx`, `wallet-sharing-history.tsx` |

The actual portalled roots opt into `walletDialog` or `walletPortal` on their
`DialogContent`, `AlertDialogContent`, `SheetContent`, `DrawerContent` and Add
`SelectContent` hosts. The selected share panel, Wallet-wide Manage,
history detail/revoke, request review, Profile confirmations and remove dialog
do not depend on route ancestry for typography. Popovers owned by other host
routes and native camera, gallery, share, pass and keyboard UI keep those
owners' stacking and safe-area rules. The Wallet change does not set a new
overlay z-index.

## Computed presentation evidence and coverage

The figures below come from 390 × 844 Chromium with self-hosted Plus Jakarta
Sans loaded and the mounted Wallet components compiled into production-optimized
fixture CSS. The before run used clean fetched main
`6e6563f32ed2360bdb008cc6daaf82e180b7e598`, whose Wallet files equal the
requested `dcc4f611` reference. The after run used this change. No real card,
recipient, token or account was used.

| Mounted control or text | Before computed | After computed |
| --- | --- | --- |
| Introduction Continue | 17/22/650, 244 × 50px, 0px border, accent fill | 12/18/550, 244 × 44px, 1px border, card interior |
| Body Wallet heading | 28.04/31.04/600 | Absent; shared breadcrumb has the authored 17/22/600 role, pending actual TopAppBar browser measurement |
| Cards tab label | 15/20/550 | 15/20/550 |
| Add card-number input and label | 13/22/400 and 13/20/600 | 16/22/400 and 15/22/550; desktop input separately verified at 14/22/400 |
| Saved-card group heading and row title | 10/14/600 and 13/15.86/400 | 14/22/600 and 14/21/550 |
| Selected-share title and recipient input | 15/18/600 and 16/22/400 | 20/28/600 and 16/22/400 |
| History-detail title and Revoke | 13/15.86/550 and 12/17/650, 44px target | 20/28/600 and 13/20/600, 44px target; destructive fill remains explicit |

CSS requests weights 550 and 650, while the shipped Plus Jakarta Sans files
provide static 400, 600 and 700 faces. The browser computes the requested
weights, then selects the nearest available face; this change adds no font
package or synthetic raster scale. The computed values above establish CSS
resolution and dimensions, not physical-device raster equivalence.

The layout fixture covers real Wallet tabs, deck, Add, Profile/NWS and referral
faces, public visitor preview, selected share and history portals, request
review and anonymous encrypted-file reader with synthetic boundaries. The
fixture build lives in `e2e/fixtures/wallet-workspace-build.ts`; the authored
browser cases remain in `e2e/wallet-workspace.layout.spec.ts`.
The browser run passed 97 distinct cases in Chromium and the same 97 in WebKit:
base layouts at 320/360/390/430/768/1024/1440px, short landscape/desktop,
eight additional 380–767px thresholds, dark and light accent/hover/focus
checks, synthetic add/share/request/revoke/reader flows, and reduced motion.
Six focused unit suites passed 143 cases for affected UI and route behavior;
source review checked the consent/CVV projection and request identity. Actual
signed-in TopAppBar
pixels, disabled/busy contrast across every portal, OS camera/gallery/pass/share UI,
hardware keyboard lift, text zoom, and native iOS/Android devices still require
device or authorized reviewer evidence. A web fixture cannot prove those
external outcomes or a recipient's completed view.

| Final local check | Result |
| --- | --- |
| Wallet browser fixture | 97/97 Chromium and 97/97 WebKit, split between the main and focused boundary/theme runs. |
| Focused Wallet/navigation unit cases | 143/143 across six suites; TypeScript typecheck passed. |
| Back and generated UI contracts | 500/500 Back tests; `ui:doctor` passed Back, Search, surface map, gateway, Siri, route index and validator mutation checks. |
| Cache and design checks | 102/102 cache cases; design-system, accent, Apple hierarchy, restraint and render-performance checks passed. |
| Environment-limited aggregate checks | `verify:design-system` stops at unrelated pre-existing stale brand assets. Full `build:search-contracts` stops at CapabilityGraph generation because the checkout has no usable backend Python runtime; the preceding Search, gateway, surface-map and route-index generation succeeded. |
