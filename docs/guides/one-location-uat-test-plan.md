# One Location — End-to-End UAT Test Plan

> Manual test plan to verify the One Location sharing feature end to end on UAT
> before it is released to customers. Covers every flow, every edge case, the
> exact notification behaviour to observe, the **Access Manager (`/consents`)**
> verification across all of its tabs, and the acceptance criteria
> (expected/actual) for each case.
>
> **Updated for the redesigned One Location UI** (mobile-first hub — Figma
> `one_location_final_fixed_clean_navigation`). The page now renders a
> four-tab hub — **Now · People · Links · Inbox** — plus focused, full-screen
> task flows (**Share / Ask / Invite / Temporary link**). The old
> "Share & Request" / "Activity & Links" tabs and the inline
> "Review Share → Confirm & Share Location" composer no longer exist.
>
> Scope of the fixes this plan validates (PR #3456):
> 1. No duplicate / repeating notifications (after refresh, tab change, page load, re-login).
> 2. No false "location removed / expired" popups (incl. re-share to same person).
> 3. Viewing a shared location does NOT depend on opening a notification, and survives refresh.
> 4. **Dismiss (unwatch)** control in **Inbox → Shared with me**.
> 5. Location **consent** events go to the **consent icon (shield)** + **Access Manager** tabs, NOT the general bell.
> 6. Access Manager **Requests / Active Access / History / Relationships** tabs populate location rows (backend merge on by default).
> 7. `/api/one/location/state` is resilient (a broken side-table no longer 500s the page).

---

## New UI at a glance (read this first)

The redesigned `/one/location` opens on the **Now** tab. The persistent
**One Location** header shows a tab-aware subtitle and a **Refresh** button.

| Hub tab | Subtitle | What lives here |
|---|---|---|
| **Now** | "Private by default" | Privacy status card, **Share my location** + **Ask someone** buttons, **Active shares** (with **Stop sharing**), **Device readiness**, **Quick paths**. |
| **People** | "Circle, contacts and invites" | **Trusted Circle** (Invite trusted person · Sync contacts · Share to contacts), **Ready people** (per-person **Share**), **Pending invites**. |
| **Links** | "Temporary and invite links" | **Create temporary link**, **Active temporary link**, **Invite link** (Copy · Share · Revoke). |
| **Inbox** | "Requests and shared locations" | **Needs your review** (approve = **Share 1 hour** / **Decline**), **Shared with me** (**View** / **Dismiss**), **Sent by you**, **Recent receipts**. Tab shows a count badge e.g. **Inbox (1)** when there are pending requests. |

Full-screen task flows (replace the old inline composer; local tabs are hidden while a flow is open):

- **Share flow** (from **Share my location**): Step 1 "Who can see you?" → **Continue** · Step 2 "What are you sharing?" (location type + duration + optional note) → **Review share** · Step 3 "Before you start" (consent check) → **Start sharing**.
- **Ask flow** (from **Ask someone**): pick person + duration + reason chip + message → **Send request**.
- **Invite flow** (from **Invite trusted person**): "Invite to Circle" → **Create invite** → share/copy/revoke.
- **Temporary link flow** (from **Create temporary link**): "Share outside your Circle" → **Review temporary link** → active link with Copy/Share/Revoke.

The **Access Manager** lives at `/consents` (page title **"Access manager"**, eyebrow **"Access / Consent"**) and has four segmented tabs with counts: **Requests (N) · Active Access (N) · History (N) · Relationships (N)**. Location consent events appear here (and on the shield icon), never on the general bell. Full Access Manager coverage is in §8.

---

## How live location works (data path testers should know)

Understanding the pipeline makes the privacy assertions below testable:

1. **Capture (sharer's device) — uses geolocation, continuously.** Coordinates are read via
   the **HushhLocation** plugin:
   - **Web:** the browser **Geolocation API** — `getCurrentPosition` for one-shot reads plus a continuous **`watchPosition`** subscription for live tracking.
   - **iOS / Android:** the native Capacitor **HushhLocation** plugin (foreground-only capture + watch).
   - While the share is active and the app is foreground, the sharer runs a **continuous movement watch**: a fresh encrypted update is published **as soon as they move** (~25 m threshold, throttled to ≥ 8s apart), and a **~20s heartbeat** keeps a standing user's point fresh. So recipients see the dot **follow real movement**, not just a fixed-interval refresh.

2. **Encrypt + publish.** Each captured point is **end-to-end encrypted per recipient**
   (`encryptLocationForRecipient`) and uploaded as an opaque envelope. **Plaintext
   coordinates never reach the backend** — only encrypted envelopes do. This is why the
   consent surfaces (§8) are coordinate-free by contract.
3. **Display (recipient's device) — does NOT use a geolocation API.** The recipient
   **decrypts** the envelope (`decryptLocationEnvelope`) and the point is rendered by
   `LocalMapPreview` inside a **Google Maps embed iframe**
   (`https://www.google.com/maps?q=<lat>,<lng>&output=embed`). The Directions / Start
   buttons are plain Google Maps URLs. The recipient's own device location is not read to
   show someone else's shared location.

> Net: geolocation (Web Geolocation API / native Capacitor location) powers **capture on
> the sharer's side**; the recipient simply **decrypts and renders a Google Maps embed**.
> A "Live location" vs "Last known location" badge (stale > ~60s) is derived from the
> point's `capturedAt`, not from any recipient-side geolocation call.

---

## Visual Map


How the two test users, the surfaces under test, and the consent routing relate
during this UAT:

```text
   User A (Owner)                         User B (Recipient)
   /one/location                          /one/location
   [Now·People·Links·Inbox]               [Now·People·Links·Inbox]
        |                                      |
        |  1. Share my location ──────────────►|  Inbox → "Shared with me"
        |     (Share flow, E2EE envelope)       |  + can Dismiss (unwatch)
        |                                      |
        |◄── 2. Ask someone ────────────────────|
        |    (Inbox → Needs your review:        |
        |     Share 1 hour / Decline)           |
        |                                      |
        +───────────────┬──────────────────────+
                        │ consent events
                        ▼
        Consent icon (shield)  +  Access Manager (/consents)
        Requests · Active Access · History · Relationships
                   (NOT the general bell)
```

- Coordinates never reach the backend; only encrypted envelopes do.
- Location **consent** events route to the shield + `/consents`, never the bell.

---

## 0. Pre-requisites & Setup

### 0.1 Accounts / devices
You need **two real, phone-verified users** (because sharing requires One Network / phone verification). Recommended:

| Role | Who | Device suggestion |
|---|---|---|
| **User A (Owner)** | shares their location | Phone / mobile browser (real GPS) |
| **User B (Recipient)** | receives + views A's location | Second phone or second browser profile |

- Both users must have completed onboarding and **phone verification**.
- Both must have **opened One Location at least once** (this provisions the recipient encryption key — without it, sharing to them is blocked with "needs to open One Location once").
- Use two **separate browsers / profiles / incognito** windows so sessions and localStorage do not collide.

### 0.2 Environment checks (do once before testing)
- [ ] Confirm you are on the **UAT** build (check app version / deploy banner).
- [ ] Confirm backend deploy includes PR #3456 (consent-center merge default ON). No Secret Manager change is needed; the flag `ONE_LOCATION_CONSENT_CENTER_ENABLED` defaults ON when unset.
- [ ] Open the page: **`/one/location`** loads on the **Now** tab without an error toast.
- [ ] Confirm the four hub tabs render: **Now · People · Links · Inbox**.
- [ ] Open the **Access Manager**: **`/consents`** loads (title "Access manager") and shows the four tabs **Requests · Active Access · History · Relationships**.

### 0.3 Where to look (surfaces glossary)
| Surface | Where | What it is |
|---|---|---|
| **One Location hub** | `/one/location` | Four tabs: **Now · People · Links · Inbox** + the **Refresh** button in the header |
| **Now tab** | `/one/location` → **Now** | Privacy status, **Share my location** / **Ask someone**, **Active shares** (Stop sharing), **Device readiness**, **Quick paths** |
| **People tab** | `/one/location` → **People** | Trusted Circle, invites, Ready people, Pending invites |
| **Links tab** | `/one/location` → **Links** | Temporary public links + Circle invite links |
| **Shared with me** | `/one/location` → **Inbox** | People who shared their live location with you (**View** / **Dismiss**) |
| **Needs your review** | `/one/location` → **Inbox** | Incoming location requests (**Share 1 hour** / **Decline**) |
| **Bell icon (general)** | top app bar 🔔 | General app notifications (NOT for consent) |
| **Consent icon (shield)** | top app bar 🛡️ "Pending consents" | Consent notifications — location consent events appear HERE |
| **Access Manager** | `/consents` | Title "Access manager"; tabs: **Requests · Active Access · History · Relationships** |

### 0.4 Reset helper (to re-run a clean test)
On a given browser, to fully reset the local notification/unwatch memory for that user:
- DevTools → Application → Local Storage → delete keys starting with:
  - `one_location_seen_notifications_v1:*`
  - `one_location_opened_grants_v1:*`
  - `one_location_unwatched_grants_v1:*`
- DevTools → Application → Session Storage → delete `kai_app_background_tasks_v1`.
- Then hard refresh.

> Note: a "notification fires once ever per event" by design. To re-observe a
> first-time notification you must reset as above (or use a brand new
> share/request, which has a new id).

---

## 1. Permissions & Readiness

> All readiness controls live in **Now → Device readiness**.

### TC-1.1 — First-time location permission prompt
**Steps (User A):**
1. Fresh session, open `/one/location` (lands on **Now**).
2. In the **Device readiness** card, tap **Show my location**.

**Expected:**
- Browser/OS asks for location permission.
- On **Allow** → readiness card shows the "ready" state; a live map preview renders below the card and the button changes to **Refresh location**.

**Acceptance:** ✅ map preview appears, no error.

### TC-1.2 — Permission denied / services off
**Steps (User A):**
1. Deny location permission (or turn off device Location).
2. In **Device readiness**, tap **Show my location**, then open the Share flow (**Share my location**) and try to start a share.

**Expected:**
- Clear error toast: "Turn on phone Location before sharing." or "Allow location permission before sharing."
- The Device readiness card shows a warning/blocked tone with an action button to open Location/App settings.
- App does NOT crash; you can still browse all four tabs.

**Acceptance:** ✅ blocked gracefully with a settings shortcut; no white screen.

### TC-1.3 — Intermittent "geo denied while sharing" (KNOWN / DEFERRED)
**Steps:** Share while toggling permission, or on a flaky device.

**Expected (current behaviour):**
- If it denies, you get the permission error + retry/settings path; retry succeeds once permission is granted.

**Acceptance:** ⚠️ Known intermittent device behaviour (deferred for a dedicated device repro). Acceptable for release as long as a retry after granting permission works. **Log device + steps if it reproduces.**

---

## 2. Share location (Owner → Recipient) — happy path

> Sharing is now a **3-step full-screen flow** opened from **Now → Share my location**.

### TC-2.1 — Share to one recipient
**Steps (User A):**
1. `/one/location` → **Now** → **Share my location**.
2. **Step 1 "Who can see you?"** → search/select **User B** (a "Ready" person) → **Continue**.
3. **Step 2 "What are you sharing?"** → choose location type (**Precise live location** or **Approximate area**), pick a duration (e.g. **15 min**), optional note → **Review share**.
4. **Step 3 "Before you start"** (consent check) → confirm the review rows (Can see / Location type / Duration / Control) → **Start sharing**.

**Expected (User A):**
- Toast: "Location shared with 1 person."
- The flow closes back to the hub; **Now → Active shares** shows "Sharing with User B" with a **Live** badge, a "Stops in …" countdown, and a **Stop sharing** button.

**Expected (User B):**
- Within a short poll, **Inbox → Shared with me** shows **User A** ("User A is sharing with you") as an active share with **Live**, and an inline map after tapping **View** (see §4).
- A **consent notification** appears under the **shield (consent) icon**, and a One Location toast may appear. (See §6 + §8 for exact routing.)
- ❌ It must NOT appear in the **bell** as a generic app task.

**Acceptance:** ✅ B sees A's live location in Inbox; consent surfaces updated; no bell spam.

### TC-2.2 — Share to multiple recipients at once
**Steps (User A):** in **Step 1** of the Share flow, select 2+ ready people, then complete Steps 2–3.

**Expected:** toast "Location shared with N people." Each recipient independently sees the share in their **Inbox → Shared with me**. Each recipient gets exactly **one** notification.

**Acceptance:** ✅ N grants created, N recipients notified once each.

---

## 3. Notification correctness (the core fixes) 🔴 most important

> These cases validate the duplicate/false-notification bugs. Observe carefully.

### TC-3.1 — No duplicate "shared" notification on refresh
**Steps (User B):**
1. After A shares (TC-2.1), note the single "Location shared" notification.
2. **Refresh** `/one/location` 3–4 times.
3. Switch between the **Now / People / Links / Inbox** tabs a few times.

**Expected:**
- The "Location shared" notification is **NOT** re-created on each refresh/tab change.
- No repeated toasts.

**Acceptance:** ✅ exactly one notification for that share, ever. ❌ FAIL if it re-pops on refresh/tab-switch.

### TC-3.2 — No duplicate after re-login / new session
**Steps (User B):** log out and back in (or new browser profile after the share already happened and was seen).

**Expected:** the already-seen share does not produce a fresh popup again (seen-state persists in localStorage).

**Acceptance:** ✅ no re-notification for an already-seen event.

### TC-3.3 — Re-share to the SAME person within window → NO "location removed" popup 🔴
**Steps (User A):**
1. Share to **User B** (active grant exists).
2. Before it expires, run the Share flow to **User B again** (new duration).

**Expected (User B):**
- Sees the refreshed/active share in **Inbox → Shared with me** (still works, map updates).
- ❌ Must **NOT** receive a "Location access removed / location removed by this user" popup.
- The backend silently supersedes the old grant; the UI must not surface that as a removal.

**Acceptance:** ✅ no false "removed" notification on re-share. (This was a top reported bug.)

### TC-3.4 — Real revoke DOES notify (once)
**Steps:**
1. A shares to B (active).
2. A revokes that access: **Now → Active shares → Stop sharing** (or from Access Manager → **Active Access** → select the row → **Revoke**, see §8.3).

**Expected (User A):**
- Toast: "Location access revoked." The card leaves **Active shares**.

**Expected (User B):**
- Receives exactly **one** "Location access removed" consent notification (in the shield/consent surface).
- The share for A disappears from **Inbox → Shared with me**.
- After refresh, the "removed" notification does **NOT** reappear.

**Acceptance:** ✅ genuine revoke = one notification + share gone + no resurrection on refresh.

### TC-3.5 — Expiry notifies once, not on every load
**Steps:** Let a short (15 min) grant expire. Reload a few times after expiry.

**Expected:** at most one "expired" surface update; the expired grant drops out of **Inbox → Shared with me** (and **Now → Active shares** on the owner side); no repeated expiry popups on each reload.

**Acceptance:** ✅ single expiry handling; no per-load spam.

### TC-3.6 — "location removed" must not appear when the other user did nothing
**Steps:** A shares to B; nobody revokes; B just refreshes / navigates between tabs repeatedly.

**Expected:** B never sees a "location access removed" notification while the share is still active.

**Acceptance:** ✅ zero phantom removal notifications.

---

## 4. Viewing a shared location (decoupled from notification) 🔴

> Received shares live in **Inbox → Shared with me**.

### TC-4.1 — View without opening the notification
**Steps (User B):**
1. A shares to B.
2. **Dismiss / ignore** the consent notification entirely.
3. Go to `/one/location` → **Inbox** → **Shared with me**.

**Expected:**
- A's share is listed ("User A is sharing with you", **Live**) with **View** + **Dismiss** buttons.
- The empty-state text is **NOT** "Open notification to view". (If nothing is shared, the empty state reads "No active items after expiry" / "Locations shared with you appear here while they are live".)
- Tapping **View** loads A's live map inline; the button then reads **Open map**.

**Acceptance:** ✅ you can view purely from the page, without ever touching a notification.

### TC-4.2 — View survives page refresh 🔴
**Steps (User B):**
1. While viewing A's live map in **Inbox → Shared with me**, **refresh** the page.

**Expected:**
- After refresh, the active share is **still listed** in **Inbox** and the live map **re-renders automatically** (it silently re-fetches).
- ❌ It must NOT collapse back into "click the notification again to see".

**Acceptance:** ✅ inline live view persists across refresh.

### TC-4.3 — Live updates (movement-driven)
**Steps:** A keeps the app in foreground and **physically moves** (walk/drive, real GPS); B watches the map in **Inbox**.

**Expected:**
- While A is **stationary**, B's map stays fresh via the ~20s heartbeat; a "Live location" badge shows.
- While A is **moving**, A publishes a fresh encrypted update **as they move** (≈ every 25 m, throttled to ≥ 8s apart), so B's map **follows A's movement** (the point visibly tracks the route, not only every 20s).
- If updates stop (A backgrounds the app / loses GPS), B sees a "Last known location" amber note ("Location update may be stale. Ask them to refresh sharing.").

**Acceptance:** ✅ B's map follows A's real movement while moving, stays fresh while stationary, and labels stale state clearly.


### TC-4.4 — Deep link from notification / Access Manager still works
**Steps (User B):** tap the One Location consent notification / its "Open", and separately from the Access Manager use the **Open Location** link (§8.5).

**Expected:** routes to `/one/location` with the canonical params (section / grantId / requestId). A "shared" grant link reveals A's map in **Shared with me** on arrival; otherwise open **Inbox → Shared with me** to view.
(Note: the share is always reachable from **Inbox** even if the tab does not auto-switch — the deep link is a convenience, not a requirement.)

**Acceptance:** ✅ deep link routes to the page; the share is viewable from **Inbox** with or without it.

---

## 5. Dismiss / Unwatch (recipient-side hide) 🆕

> In the redesign the recipient-side hide control is labeled **Dismiss** (it is
> the same "unwatch" behaviour as before; the success toast is unchanged).

### TC-5.1 — Dismiss removes the share locally
**Steps (User B):**
1. In **Inbox → Shared with me**, on A's active share, tap **Dismiss**.

**Expected:**
- Toast: "Stopped watching A's location."
- A's card disappears from **Shared with me**, map dropped.
- The empty state (if it was the only one) reads "No active items after expiry" / "Locations shared with you appear here while they are live." — NOT "Open notification to view".

**Acceptance:** ✅ Dismiss hides it immediately.

### TC-5.2 — Dismiss persists across refresh
**Steps (User B):** after TC-5.1, refresh `/one/location` and reopen **Inbox**.

**Expected:** the dismissed share stays hidden (persisted in localStorage); no new notification for it.

**Acceptance:** ✅ Dismiss survives refresh and silences its notifications.

### TC-5.3 — Dismiss does NOT affect the owner
**Steps:** check User A's side after B dismisses.

**Expected:** A's grant is unaffected server-side (A still sees the active grant under **Now → Active shares**, and it still appears in B's Access Manager **Active Access** because the grant is live). Dismiss is a recipient-local hide of the live map only. (A re-share or B clearing local state can bring it back.)

**Acceptance:** ✅ owner grant intact; recipient live-map view hidden only locally.

---

## 6. Consent routing — shield icon, NOT the bell 🔴

> Core requirement: location **consent** events belong in the **consent
> notification icon (shield)** and the **Access Manager**, not the general bell.

### TC-6.1 — Share/approve/deny/revoke land on the consent (shield) icon
**Steps:** run a share (TC-2.1), a request (TC-7.1), an approve (TC-7.2), a deny (TC-7.3), a revoke (TC-3.4).

**Expected for each event:**
- The **shield (consent) icon** badge/count updates (numeric badge when pending > 0). The shield dropdown header reads "Pending consents"; the location event is listed and reachable.
- ❌ The **bell (general)** icon must **NOT** list these One Location consent events as generic tasks.

**Acceptance:** ✅ all location consent events route to the consent surface; bell stays clean of them.

### TC-6.2 — Consent icon → opens Access Manager
**Steps:** open the shield dropdown ("Pending consents") and use its link to the Access Manager (or navigate to `/consents`).

**Expected:** lands on `/consents` ("Access manager"); the relevant location row is present in the correct tab (see §8).

**Acceptance:** ✅ navigation + row visible in the right tab.

---

## 7. Request access flow (Recipient asks Owner)

> Requests are sent via the **Ask flow** (**Now → Ask someone**) and reviewed in
> the owner's **Inbox → Needs your review**.

### TC-7.1 — Send a request
**Steps (User B):** **Now → Ask someone** → select **User A** → pick a **Duration requested** → pick a **Reason** chip (Safety check-in / Meeting nearby / Pick-up / Other) → optional message → **Send request**.

**Expected (User B):** toast "Request sent…".
**Expected (User A):** a **consent** notification (shield) "… wants to see your location …"; appears in Access Manager **Requests** tab and in **Inbox → Needs your review** (with an **Inbox (1)** badge on the tab). ❌ not in the bell.

**Acceptance:** ✅ request reaches A's consent surfaces + Inbox.

### TC-7.2 — Approve a request
**Steps (User A):** **Inbox → Needs your review** → on B's request, tap **Share 1 hour** (one-tap approve; the card states "If approved: 1 hour"). (Approving from the Access Manager **Requests** tab is covered in §8.2.)

**Expected (User A):** "Request approved and encrypted update published.".
**Expected (User B):** "Location request approved" consent notification; A now appears in B's **Inbox → Shared with me** as active with a live map.

**Acceptance:** ✅ approval creates the grant + B can view.

### TC-7.3 — Deny a request
**Steps (User A):** **Inbox → Needs your review** → **Decline**.

**Expected (User A):** "Request denied.".
**Expected (User B):** "Location request denied" consent notification (once). No grant created.

**Acceptance:** ✅ deny notifies once; no access.

### TC-7.4 — Duplicate request guard
**Steps (User B):** send the same request to A twice quickly (run the Ask flow twice).

**Expected:** A does not get two separate pending duplicates spamming **Needs your review** / Access Manager **Requests**; one actionable pending request.

**Acceptance:** ✅ no duplicate request spam.

---

## 8. Access Manager (`/consents`) — verify ALL tabs + location action items 🔴

> The Access Manager (title **"Access manager"**, eyebrow **"Access / Consent"**)
> is the canonical consent workspace. Location rows are merged in by the backend
> contributor (`one_location_center_contributor`) and routed by lifecycle:
> **incoming requests → Requests**, **active grants → Active Access**,
> **revoked/expired/denied → History**, and every counterpart is grouped under
> **Relationships**. This section validates each tab and the location-specific
> action items inside it.
>
> **Where a location action lands (cheat sheet):**
>
> | Location action | Tab it appears in | Status badge | Available action(s) in detail |
> |---|---|---|---|
> | B asks A (request) | **Requests** (A's side) | Pending | **Allow** / **Don't allow** + duration; **Open Location** |
> | A shares / A approves | **Active Access** (both sides) | Active | **Revoke** (owner); **Open Location** |
> | Revoked by owner | **History** | Revoked | (terminal) **Open Location** |
> | Expired | **History** | Expired | (terminal) **Open Location** |
> | Denied request | **History** | Denied | (terminal) |
> | Any counterpart (rollup) | **Relationships** | latest state | scope rollup; **Open Location** |

### TC-8.0 — Access Manager shell loads
**Steps:** open `/consents`.
**Expected:**
- Header shows eyebrow "Access / Consent", title "Access manager", and a **Refresh** button.
- Four segmented tabs render **with live counts**: **Requests (N) · Active Access (N) · History (N) · Relationships (N)**.
- A **Search** box is present; placeholder reads `Search requests by name, email, scope, or reason` (changes per tab; Relationships uses "Search relationships by name, email, scope, or status").
- Switching tabs updates the URL (`?tab=requests|active|history|relationships`).

**Acceptance:** ✅ shell, four tabs with counts, search, and Refresh all present; no full-page error.

### TC-8.1 — Requests tab (incoming location requests)
**Pre:** an incoming location request exists (TC-7.1, B → A). Test on **User A**.
**Steps:** `/consents` → **Requests**.

**Expected:**
- The **Requests (N)** count is ≥ 1 and the location request row is listed: requester label + a coordinate-free summary like "**{B} wants to see your location …**" (or "… for {duration}." when a duration was requested), a **Pending** badge, scope text (location scope), and a relative expiry (e.g. "45 min left").
- Selecting the row opens the detail panel with a **Decision** group: **Allow** and **Don't allow** buttons plus an **Access duration** selector (24 hours / 7 days / 30 days / 90 days, capped to the requested duration).
- A **Location sharing** row is present with description "Review this location request, active access, and expiry in One Location." and an **Open Location** link.
- Search filters the list (type B's name).
- If empty: an explanatory empty state shows (not a crash).

**Acceptance:** ✅ Requests tab is NOT empty; location request shows with Allow / Don't allow + duration + Open Location.

### TC-8.2 — Approve / Deny from the Requests tab
**Pre:** TC-8.1 row visible on **User A**.
**Steps:**
1. Select the location request → pick a duration → tap **Allow**.
2. (Re-run with a fresh request) select it → tap **Don't allow**.

**Expected:**
- **Allow**: button shows "Allowing…", the row leaves **Requests**, the count drops, and the grant appears under **Active Access** (TC-8.3). User B is notified once (consent surface) and can view A's map.
- **Don't allow**: button shows "Rejecting…", the row leaves **Requests** and lands in **History** as **Denied**. User B gets one "denied" consent notification; no grant created.

**Acceptance:** ✅ Allow → Active Access (+grant); Don't allow → History (Denied); each notifies B once.

### TC-8.3 — Active Access tab (live grants, both directions)
**Pre:** at least one active grant (you shared, or you received / were approved).
**Steps:** `/consents` → **Active Access**.

**Expected:**
- The **Active Access (N)** count is ≥ 1; active location shares are listed for **both directions** (people who can see you / shares you received), each with an **Active** badge, scope label, and a relative expiry / "Stops in …".
- For grants you own, selecting the row exposes a **Revoke** action in the detail panel (and per-scope **Revoke** for grouped lifecycles).
- An **Open Location** link is present on location rows.
- **Coordinate-free:** the row/summary shows scope, status, timestamps, and counterpart label only — **no latitude/longitude/address/map** (see TC-8.7).

**Acceptance:** ✅ Active tab shows active location grants both ways; Revoke available for owned grants; Open Location present.

### TC-8.4 — Revoke from the Active Access tab
**Pre:** TC-8.3, an owned active grant (A → B).
**Steps (User A):** **Active Access** → select the A→B grant → **Revoke** (button shows "Revoking…").

**Expected:**
- The row leaves **Active Access**, the count drops, and the grant moves to **History** as **Revoked**.
- User B receives exactly **one** "Location access removed" consent notification and the map disappears from B's **Inbox → Shared with me** (matches TC-3.4).
- After refresh, the revoked row stays in **History** and does not reappear under Active.

**Acceptance:** ✅ Revoke moves grant to History (Revoked), notifies B once, no resurrection.

### TC-8.5 — "Open Location" deep link from every tab
**Steps:** from **Requests**, **Active Access**, and **History**, select a location row and tap **Open Location**.

**Expected:** routes to `/one/location` with the canonical params (section / grantId / requestId). For an active "shared" grant it reveals the map in **Shared with me**; for a request it lands ready to review in **Inbox**. (If the hub does not auto-switch tabs, the relevant item is still reachable from **Inbox**.)

**Acceptance:** ✅ Open Location routes correctly from each tab; lands on the right One Location surface.

### TC-8.6 — History tab (terminal location events)
**Pre:** at least one revoked/expired/denied location event.
**Steps:** `/consents` → **History**.

**Expected:**
- The **History (N)** count reflects terminal events; location rows are listed with the right badge: **Revoked**, **Expired**, or **Denied**.
- Where a counterpart has multiple events, a grouped **Consent history** lifecycle view shows ordered events ("Lifecycle 1", scope label, "Latest {date}"), and any still-active scope offers **Revoke**.
- Search filters History.

**Acceptance:** ✅ History shows past location events with correct terminal badges; no active grants leak here.

### TC-8.7 — Coordinate-free guarantee (all tabs)
**Steps:** inspect any location row across **Requests / Active Access / History / Relationships** (UI + the `/consents` network response if you can).

**Expected:** NO latitude/longitude/address/map fields anywhere in consent data. Only counterpart label, scope/scope description, status, reason, and timestamps. The location summary copy is coordinate-free (e.g. "… wants to see your location …").

**Acceptance:** ✅ zero coordinates leak into any consent surface or payload.

### TC-8.8 — Relationships tab (counterpart rollup)
**Pre:** at least one location interaction with User B (request/share/history).
**Steps:** `/consents` → **Relationships**.

**Expected:**
- The **Relationships (N)** count is ≥ 1; User B appears as a single grouped relationship reflecting the latest location state (active/pending/previous), with a scope rollup summary (e.g. "N scopes shared in this relationship").
- Selecting the relationship shows details and any available action (e.g. **Open Location**, or **Revoke** if a scope is still active).
- Search by name/email/scope/status filters the list.

**Acceptance:** ✅ Relationships groups the location counterpart correctly with latest state + scope rollup.

### TC-8.9 — Counts and live updates stay consistent
**Steps:** perform an Allow (TC-8.2) and a Revoke (TC-8.4), watching the tab counts before/after; use **Refresh** in the header.

**Expected:** the **Requests / Active Access / History** counts adjust correctly (Allow: Requests −1, Active +1; Deny: Requests −1, History +1; Revoke: Active −1, History +1). **Refresh** re-pulls the latest state without duplicating rows.

**Acceptance:** ✅ tab counts move correctly per action; Refresh is idempotent (no dupes).

---

## 9. Public link & Invite to One (if exposed in UAT)

> Public/temporary links live in the **Links** tab; Circle invites are created
> from the **People** tab (**Invite trusted person** → Invite flow).

### TC-9.1 — Create temporary (public) location link
**Steps (User A):** **Links → Create temporary link** → choose duration + location type → **Review temporary link** → confirm.
**Expected:** a link is created + copyable/shareable; appears under **Links → Active temporary link** (with **Copy / Share / Revoke** and a "Stops in …" countdown).
**Acceptance:** ✅ link created.

### TC-9.2 — Public visitor submits a request
**Steps:** open the temporary link as a visitor, submit name + phone.
**Expected (User A):** a "Public location request" consent notification + entry in public responses; rate limits prevent spam (multiple rapid submits are throttled).
**Acceptance:** ✅ visitor intake works + throttled.

### TC-9.3 — Revoke temporary (public) link
**Steps (User A):** **Links → Active temporary link → Revoke**.
**Expected:** toast "Public location link revoked."; the link becomes inactive and leaves the Active section.
**Acceptance:** ✅ revoke works.

### TC-9.4 — Invite to One / Circle (circle invite)
**Steps (User A):** **People → Invite trusted person** → choose expiry → **Create invite** → share the link; (User C) opens + accepts after phone verification.
**Expected:** the created invite shows under **Links → Invite link** (Pending) with **Share invite / Copy link / Revoke invite**; after C accepts, both become One Network connections; "joined your One Network" consent notification.
**Acceptance:** ✅ invite created + network connection formed.

---

## 10. Resilience / negative cases

### TC-10.1 — Page never 500s the whole feature
**Steps:** load `/one/location` repeatedly and switch across all four tabs; if possible, with a user that has lots of history.

**Expected:** the hub renders core sections even if one auxiliary section has no data; no full-page error toast on every load. (On a hard load error the page falls back to the legacy layout rather than a white screen.)

**Acceptance:** ✅ `/api/one/location/state` degrades gracefully (a broken side-table returns empty for that section, not a 500). (Logs would show `one_location.list_state.section_failed section=<name>` if a section degrades.)

### TC-10.2 — Sharing to a recipient who never opened One Location
**Steps (User A):** open the Share flow and try to select a user with no recipient key.

**Expected:** that person shows in **Step 1** with a "pending"/"Invite first to enable sharing" state and cannot be selected/shared; a clear message indicates they need to open One Location once before private sharing can start. (No silent failure.)

**Acceptance:** ✅ explicit setup-needed state; non-ready people cannot be shared to.

### TC-10.3 — Network blip during view/publish
**Steps:** throttle network briefly while viewing/publishing.

**Expected:** transient errors retried; a friendly "One is still catching up. Please refresh once…" message on persistent transient failures.

**Acceptance:** ✅ no crash; retry/backoff handles blips.

### TC-10.4 — Access Manager degrades gracefully
**Steps:** open `/consents` and switch tabs; if a deep link points to a handled/expired request.

**Expected:** if a request was already handled, a "Request not found" / "Request not visible" empty state explains it (suggesting Active Access or History) rather than erroring. The Access Manager still renders its tabs and counts.

**Acceptance:** ✅ Access Manager never hard-errors on stale deep links; guidance shown.

---

## 11. Cross-surface consistency sweep (final)

Run this as the last pass once everything above is green.

- [ ] Do one full cycle: A shares → B views inline (Inbox) → B dismisses → A re-shares → B views again.
- [ ] Throughout, the **bell** never shows location consent items.
- [ ] Throughout, the **shield/consent** + `/consents` tabs (Requests · Active Access · History · Relationships) reflect the correct state and counts.
- [ ] No duplicate popups appeared at any refresh/tab-change/re-login.
- [ ] No false "removed" popups appeared at any point.
- [ ] Coordinates never appeared in any consent surface or payload.

---

## 12. Acceptance summary (release gate)

The feature is **ready for customers** only if ALL of these hold:

| # | Acceptance criterion | Pass? |
|---|---|---|
| 1 | Share flow works; recipient sees live map inline in Inbox | ☐ |
| 2 | No duplicate notifications on refresh / tab change / re-login | ☐ |
| 3 | No false "location removed" on re-share to same user | ☐ |
| 4 | Genuine revoke (Stop sharing)/expiry notifies once and does not resurrect on refresh | ☐ |
| 5 | Viewing a share does NOT require opening a notification | ☐ |
| 6 | Inline live view survives page refresh | ☐ |
| 7 | Dismiss (unwatch) hides the share, persists across refresh, silences its notifications | ☐ |
| 8 | All location CONSENT events appear on the consent (shield) icon, NOT the bell | ☐ |
| 9 | Access Manager Requests / Active Access / History / Relationships tabs populate location rows with the correct status + actions | ☐ |
| 10 | No coordinates leak into any consent surface | ☐ |
| 11 | Ask → Approve (Share 1 hour)/Decline flow works with correct one-time notifications | ☐ |
| 12 | Allow / Don't allow / Revoke from the Access Manager move rows across tabs with correct counts | ☐ |
| 13 | Page never hard-500s; One Location + Access Manager degrade gracefully | ☐ |

> Known/deferred (not a release blocker): intermittent "geo denied while
> sharing" is device permission flakiness; existing retry/recovery handles the
> common path. Capture a device + repro steps if it occurs so it can be fixed
> precisely later.

---

## 13. How to log a failure (so it can be fixed fast)

For any FAIL, capture:
1. Which user (A/B) + device/browser.
2. The exact step (TC id) and the hub tab / Access Manager tab / flow you were in.
3. Screenshot/screen recording of the notification or screen.
4. DevTools Console errors + the failing network call (status + endpoint, e.g. `GET /api/one/location/state` or the `/consents` center call).
5. Whether it reproduces after a clean reset (§0.4).

---

## 14. Results capture sheet (fill while testing)

> Tester: ____________   Date: __________   Build/SHA: __________   UAT URL: __________
>
> Mark **Result** as PASS / FAIL / BLOCKED / N/A. For FAIL, fill the Notes/Evidence.

| TC | Title | Result | Observed behaviour / Notes / Evidence link |
|---|---|---|---|
| 1.1 | First-time location permission prompt (Now → Device readiness) |  |  |
| 1.2 | Permission denied / services off |  |  |
| 1.3 | Intermittent geo denied (known/deferred) |  |  |
| 2.1 | Share flow to one recipient |  |  |
| 2.2 | Share flow to multiple recipients |  |  |
| 3.1 | No duplicate "shared" on refresh / tab change |  |  |
| 3.2 | No duplicate after re-login / new session |  |  |
| 3.3 | Re-share same person → NO "removed" popup |  |  |
| 3.4 | Real revoke (Stop sharing) notifies once |  |  |
| 3.5 | Expiry notifies once, not per load |  |  |
| 3.6 | No phantom "removed" when nothing changed |  |  |
| 4.1 | View from Inbox without opening notification |  |  |
| 4.2 | Inline view survives refresh |  |  |
| 4.3 | Live updates / stale label |  |  |
| 4.4 | Deep link (notification / Access Manager) |  |  |
| 5.1 | Dismiss removes share locally |  |  |
| 5.2 | Dismiss persists across refresh |  |  |
| 5.3 | Dismiss does not affect owner |  |  |
| 6.1 | Consent events on shield, NOT bell |  |  |
| 6.2 | Consent icon → opens Access Manager |  |  |
| 7.1 | Send a request (Ask flow) |  |  |
| 7.2 | Approve a request (Share 1 hour) |  |  |
| 7.3 | Decline a request |  |  |
| 7.4 | Duplicate request guard |  |  |
| 8.0 | Access Manager shell + four tabs + counts |  |  |
| 8.1 | Requests tab populates location request |  |  |
| 8.2 | Approve / Deny from Requests tab |  |  |
| 8.3 | Active Access tab (both directions) |  |  |
| 8.4 | Revoke from Active Access tab |  |  |
| 8.5 | "Open Location" deep link from each tab |  |  |
| 8.6 | History tab (Revoked/Expired/Denied) |  |  |
| 8.7 | Coordinate-free guarantee (all tabs) |  |  |
| 8.8 | Relationships tab (counterpart rollup) |  |  |
| 8.9 | Counts/live updates consistent + Refresh idempotent |  |  |
| 9.1 | Create temporary (public) link |  |  |
| 9.2 | Public visitor submits request |  |  |
| 9.3 | Revoke temporary (public) link |  |  |
| 9.4 | Invite to One / Circle (circle invite) |  |  |
| 10.1 | One Location never 500s / degrades gracefully |  |  |
| 10.2 | Share to recipient who never opened One Location |  |  |
| 10.3 | Network blip during view/publish |  |  |
| 10.4 | Access Manager degrades gracefully (stale deep link) |  |  |
| 11 | Final cross-surface consistency sweep |  |  |

### Final verdict
- Total PASS: ____ / 43  | FAIL: ____ | BLOCKED: ____
- Release decision (all §12 criteria green?): ☐ GO  ☐ NO-GO
- Sign-off: ____________________

---

## 15. Note on automated coverage (already green)

These automated checks already protect the highest-risk logic and pass in CI; the manual plan above covers the human/device flows they cannot:

- `hushh-webapp/__tests__/one-location-notifications.test.ts` — 6/6 PASS
  - once-ever de-dup for share + workflow notifications (survives refresh)
  - consent-surface routing (dispatches consent refresh, does NOT create a bell task)
  - dismiss/unwatch hides + persists + suppresses notifications
- `consent-protocol/tests/test_one_location_list_state_resilience.py` — 3/3 PASS (a broken section degrades to empty, no 500)
- `consent-protocol/tests/test_one_location_center_contributor.py` — 7/7 PASS (consent-center mapping into Requests/Active Access/History + coordinate-free guard)

> What automation cannot do (must be manual on UAT): real Gmail login, phone OTP
> verification, real GPS from two physical devices, two simultaneous
> authenticated sessions, push-notification delivery, and the human read of the
> Access Manager tabs/relationship rollup. That is exactly what §1–§11 above are
> for.
