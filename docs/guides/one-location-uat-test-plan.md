
# One Location — End-to-End UAT Test Plan

> Manual test plan to verify the One Location sharing feature end to end on UAT
> before it is released to customers. Covers every flow, every edge case, the
> exact notification behaviour to observe, and the acceptance criteria
> (expected/actual) for each case.
>
> Scope of the fixes this plan validates (PR #3456):
> 1. No duplicate / repeating notifications (after refresh, tab change, page load, re-login).
> 2. No false "location removed / expired" popups (incl. re-share to same person).
> 3. Viewing a shared location does NOT depend on opening a notification, and survives refresh.
> 4. "Unwatch" button in **Shared with me**.
> 5. Location **consent** events go to the **consent icon (shield)** + **consent manager tabs**, NOT the general bell.
> 6. Consent manager **Requests / Active Access / History** tabs populate (backend merge on by default).
> 7. `/api/one/location/state` is resilient (a broken side-table no longer 500s the page).

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
- [ ] Open the page: **`/one/location`** loads without an error toast.
- [ ] Open the **consent manager**: **`/consents`** loads (this is the "Access manager").

### 0.3 Where to look (surfaces glossary)
| Surface | Where | What it is |
|---|---|---|
| **One Location page** | `/one/location` | Main feature: Share & Request tab + Activity & Links tab |
| **Shared with me** | `/one/location` → **Activity & Links** tab | List of people who shared their live location with you |
| **Bell icon (general)** | top app bar 🔔 | General app notifications (NOT for consent) |
| **Consent icon (shield)** | top app bar 🛡️ "Pending consents" | Consent notifications — location consent events appear HERE |
| **Consent manager** | `/consents` | Tabs: Requests, Active Access, History, Relationships |

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

### TC-1.1 — First-time location permission prompt
**Steps (User A):**
1. Fresh session, open `/one/location`.
2. Trigger "Show my location" (Device readiness card).

**Expected:**
- Browser/OS asks for location permission.
- On **Allow** → readiness card shows "Location ready"; "Show my location" renders a live map preview.

**Acceptance:** ✅ map preview appears, no error.

### TC-1.2 — Permission denied / services off
**Steps (User A):**
1. Deny location permission (or turn off device Location).
2. Try "Show my location" and try to Share.

**Expected:**
- Clear error toast: "Turn on phone Location…" or "Allow location permission before sharing."
- An action button to open Location/App settings appears.
- App does NOT crash; you can still browse the page, see your circle.

**Acceptance:** ✅ blocked gracefully with a settings shortcut; no white screen.

### TC-1.3 — Intermittent "geo denied while sharing" (KNOWN / DEFERRED)
**Steps:** Share while toggling permission, or on a flaky device.

**Expected (current behaviour):**
- If it denies, you get the permission error + retry/settings path; retry succeeds once permission is granted.

**Acceptance:** ⚠️ Known intermittent device behaviour (deferred for a dedicated device repro). Acceptable for release as long as a retry after granting permission works. **Log device + steps if it reproduces.**

---

## 2. Share location (Owner → Recipient) — happy path

### TC-2.1 — Share to one recipient
**Steps (User A):**
1. `/one/location` → **Share & Request** tab → mode = **Share**.
2. Select **User B** from One Network, pick a duration (e.g. 15 min).
3. **Review Share** → **Confirm & Share Location**.

**Expected (User A):**
- Toast: "Location shared with 1 person."
- Composer resets.

**Expected (User B):**
- Within a short poll, **Shared with me** shows **User A** as an **active** share with a live map inline (see §4).
- A **consent notification** appears under the **shield (consent) icon**, and a One Location toast may appear. (See §6 for exact routing.)
- ❌ It must NOT appear in the **bell** as a generic app task.

**Acceptance:** ✅ B sees A's live location inline; consent surfaces updated; no bell spam.

### TC-2.2 — Share to multiple recipients at once
**Steps (User A):** select 2+ recipients, share.

**Expected:** toast "Location shared with N people." Each recipient independently sees the share. Each recipient gets exactly **one** notification.

**Acceptance:** ✅ N grants created, N recipients notified once each.

---

## 3. Notification correctness (the core fixes) 🔴 most important

> These cases validate the duplicate/false-notification bugs. Observe carefully.

### TC-3.1 — No duplicate "shared" notification on refresh
**Steps (User B):**
1. After A shares (TC-2.1), note the single "Location shared" notification.
2. **Refresh** `/one/location` 3–4 times.
3. Switch between **Share & Request** and **Activity & Links** tabs a few times.

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
2. Before it expires, **share to User B again** (new duration).

**Expected (User B):**
- Sees the refreshed/active share (still works, map updates).
- ❌ Must **NOT** receive a "Location access removed / location removed by this user" popup.
- The backend silently supersedes the old grant; the UI must not surface that as a removal.

**Acceptance:** ✅ no false "removed" notification on re-share. (This was a top reported bug.)

### TC-3.4 — Real revoke DOES notify (once)
**Steps:**
1. A shares to B (active).
2. A revokes that access (owner-side revoke / let it run if a revoke control is available, or from consent manager Active → revoke).

**Expected (User B):**
- Receives exactly **one** "Location access removed" consent notification (in the shield/consent surface).
- The live map for A disappears from **Shared with me**.
- After refresh, the "removed" notification does **NOT** reappear.

**Acceptance:** ✅ genuine revoke = one notification + map gone + no resurrection on refresh.

### TC-3.5 — Expiry notifies once, not on every load
**Steps:** Let a short (15 min) grant expire. Reload a few times after expiry.

**Expected:** at most one "expired" surface update; the expired grant drops out of **Shared with me**; no repeated expiry popups on each reload.

**Acceptance:** ✅ single expiry handling; no per-load spam.

### TC-3.6 — "location removed" must not appear when the other user did nothing
**Steps:** A shares to B; nobody revokes; B just refreshes / navigates repeatedly.

**Expected:** B never sees a "location access removed" notification while the share is still active.

**Acceptance:** ✅ zero phantom removal notifications.

---

## 4. Viewing a shared location (decoupled from notification) 🔴

### TC-4.1 — View without opening the notification
**Steps (User B):**
1. A shares to B.
2. **Dismiss / ignore** the notification entirely.
3. Go to `/one/location` → **Activity & Links** → **Shared with me**.

**Expected:**
- A's share is listed as **active** with **View** + **Unwatch** buttons.
- The empty-state text is **NOT** "Open notification to view". (If nothing is shared, it should say "Nothing shared with you / appears here automatically".)
- Tapping **View** loads A's live map inline.

**Acceptance:** ✅ you can view purely from the page, without ever touching a notification.

### TC-4.2 — View survives page refresh 🔴
**Steps (User B):**
1. While viewing A's live map in **Shared with me**, **refresh** the page.

**Expected:**
- After refresh, the active share is **still listed** and the live map **re-renders automatically** (it silently re-fetches).
- ❌ It must NOT collapse back into "click the notification again to see".

**Acceptance:** ✅ inline live view persists across refresh.

### TC-4.3 — Live updates
**Steps:** A keeps the app in foreground (so A keeps publishing); B watches the map.

**Expected:** B's map updates roughly every ~20s; a "Live location" badge; if stale, an "Last known location" amber note.

**Acceptance:** ✅ map refreshes; stale state labelled clearly.

### TC-4.4 — Deep link from notification still works
**Steps (User B):** tap the One Location consent notification / its "Open".

**Expected:** routes to `/one/location`, switches to Activity tab, scrolls to **Shared with me**, and reveals A's map.

**Acceptance:** ✅ deep link is a convenience, not a requirement.

---

## 5. Unwatch (recipient-side hide) 🆕

### TC-5.1 — Unwatch removes the share locally
**Steps (User B):**
1. In **Shared with me**, on A's active share, tap **Unwatch**.

**Expected:**
- Toast: "Stopped watching A's location."
- A's card disappears from **Shared with me**, map dropped.
- Empty state (if it was the only one) reads like "You unwatched your active shares" / "Nothing shared with you" — NOT "Open notification to view".

**Acceptance:** ✅ unwatch hides it immediately.

### TC-5.2 — Unwatch persists across refresh
**Steps (User B):** after TC-5.1, refresh `/one/location`.

**Expected:** the unwatched share stays hidden (persisted in localStorage); no new notification for it.

**Acceptance:** ✅ unwatch survives refresh and silences its notifications.

### TC-5.3 — Unwatch does NOT affect the owner
**Steps:** check User A's side after B unwatches.

**Expected:** A's grant is unaffected server-side (A still sees the active grant on their side). Unwatch is a recipient-local hide only. (A re-share or B clearing local state can bring it back.)

**Acceptance:** ✅ owner grant intact; recipient view hidden only locally.

---

## 6. Consent routing — shield icon, NOT the bell 🔴

> Core requirement: location **consent** events belong in the **consent
> notification icon (shield)** and the **consent manager**, not the general
> bell.

### TC-6.1 — Share/approve/deny/revoke land on the consent (shield) icon
**Steps:** run a share (TC-2.1), a request (TC-7.1), an approve (TC-7.2), a deny (TC-7.3), a revoke (TC-3.4).

**Expected for each event:**
- The **shield (consent) icon** badge/count updates and the event is reachable from "Pending consents" / consent manager.
- ❌ The **bell (general)** icon must **NOT** list these One Location consent events as generic tasks.

**Acceptance:** ✅ all location consent events route to the consent surface; bell stays clean of them.

### TC-6.2 — Consent icon → opens consent manager
**Steps:** click the shield → "Open consent manager".

**Expected:** lands on `/consents`; the relevant location row is present in the right tab.

**Acceptance:** ✅ navigation + row visible.

---

## 7. Request access flow (Recipient asks Owner)

### TC-7.1 — Send a request
**Steps (User B):** Share & Request tab → mode = **Request** → select **User A** → optional note → **Send Request**.

**Expected (User B):** toast "Request sent…".
**Expected (User A):** a **consent** notification (shield) "Location request — B is asking to view your location"; appears in consent manager **Requests** and in the One Location **Approvals** section. ❌ not in the bell.

**Acceptance:** ✅ request reaches A's consent surfaces + Approvals.

### TC-7.2 — Approve a request
**Steps (User A):** Approvals → **Approve** (pick duration).

**Expected (User A):** "Request approved…".
**Expected (User B):** "Location request approved" consent notification; A now appears in B's **Shared with me** as active with a live map.

**Acceptance:** ✅ approval creates the grant + B can view.

### TC-7.3 — Deny a request
**Steps (User A):** Approvals → **Deny**.

**Expected (User B):** "Location request denied" consent notification (once). No grant created.

**Acceptance:** ✅ deny notifies once; no access.

### TC-7.4 — Duplicate request guard
**Steps (User B):** send the same request to A twice quickly.

**Expected:** A does not get two separate pending duplicates spamming; one actionable pending request.

**Acceptance:** ✅ no duplicate request spam.

---

## 8. Consent Manager tabs populate (`/consents`) 🔴

> Validates the empty-tabs bug (backend merge now default ON).

### TC-8.1 — Requests tab
**Pre:** an incoming location request exists (TC-7.1).
**Steps:** `/consents` → **Requests**.

**Expected:** the location request row is listed (requester label, "wants to see your location"), with a working deep link back to One Location.

**Acceptance:** ✅ Requests tab is NOT empty; location request shows.

### TC-8.2 — Active Access tab
**Pre:** at least one active grant (you shared, or you received).
**Steps:** `/consents` → **Active Access**.

**Expected:** active location shares listed (both directions: people who can see you / shares you received), coordinate-free (no lat/long), with scope "Live location sharing".

**Acceptance:** ✅ Active tab shows active location grants.

### TC-8.3 — History tab
**Pre:** at least one revoked/expired/denied location event.
**Steps:** `/consents` → **History**.

**Expected:** terminal location events listed (revoked/expired/denied).

**Acceptance:** ✅ History tab shows past location events.

### TC-8.4 — Coordinate-free guarantee
**Steps:** inspect any location row in `/consents` (UI + network response if you can).

**Expected:** NO latitude/longitude/address/map fields anywhere in consent data. Only labels, scope, status, timestamps.

**Acceptance:** ✅ zero coordinates leak into the consent surface.

---

## 9. Public link & Invite to One (if exposed in UAT)

### TC-9.1 — Create public location link
**Steps (User A):** Activity & Links → Create public link.
**Expected:** a link is created + copyable/shareable; appears as an active item.
**Acceptance:** ✅ link created.

### TC-9.2 — Public visitor submits a request
**Steps:** open the public link as a visitor, submit name + phone.
**Expected (User A):** a "Public location request" consent notification + entry in public responses; rate limits prevent spam (multiple rapid submits are throttled).
**Acceptance:** ✅ visitor intake works + throttled.

### TC-9.3 — Revoke public link
**Steps (User A):** revoke the active public link.
**Expected:** link becomes inactive; moves to history.
**Acceptance:** ✅ revoke works.

### TC-9.4 — Invite to One (circle invite)
**Steps (User A):** create Invite to One; (User C) opens + accepts after phone verification.
**Expected:** both become One Network connections; "joined your One Network" consent notification.
**Acceptance:** ✅ network connection formed.

---

## 10. Resilience / negative cases

### TC-10.1 — Page never 500s the whole feature
**Steps:** load `/one/location` repeatedly; if possible, with a user that has lots of history.

**Expected:** the page renders core sections even if one auxiliary section has no data; no full-page error toast on every load.

**Acceptance:** ✅ `/api/one/location/state` degrades gracefully (a broken side-table returns empty for that section, not a 500). (Logs would show `one_location.list_state.section_failed section=<name>` if a section degrades.)

### TC-10.2 — Sharing to a recipient who never opened One Location
**Steps (User A):** try to share to a user with no recipient key.

**Expected:** clear message "They need to open One Location once before private sharing can start." (No silent failure.)

**Acceptance:** ✅ explicit setup-needed message.

### TC-10.3 — Network blip during view/publish
**Steps:** throttle network briefly while viewing/publishing.

**Expected:** transient errors retried; a friendly "One is still catching up. Please refresh once…" message on persistent transient failures.

**Acceptance:** ✅ no crash; retry/backoff handles blips.

---

## 11. Cross-surface consistency sweep (final)

Run this as the last pass once everything above is green.

- [ ] Do one full cycle: A shares → B views inline → B unwatches → A re-shares → B views again.
- [ ] Throughout, the **bell** never shows location consent items.
- [ ] Throughout, the **shield/consent** + `/consents` tabs reflect the correct state.
- [ ] No duplicate popups appeared at any refresh/tab-change/re-login.
- [ ] No false "removed" popups appeared at any point.
- [ ] Coordinates never appeared in any consent surface.

---

## 12. Acceptance summary (release gate)

The feature is **ready for customers** only if ALL of these hold:

| # | Acceptance criterion | Pass? |
|---|---|---|
| 1 | Share works; recipient sees live map inline | ☐ |
| 2 | No duplicate notifications on refresh / tab change / re-login | ☐ |
| 3 | No false "location removed" on re-share to same user | ☐ |
| 4 | Genuine revoke/expiry notifies once and does not resurrect on refresh | ☐ |
| 5 | Viewing a share does NOT require opening a notification | ☐ |
| 6 | Inline live view survives page refresh | ☐ |
| 7 | Unwatch hides the share, persists across refresh, silences its notifications | ☐ |
| 8 | All location CONSENT events appear on the consent (shield) icon, NOT the bell | ☐ |
| 9 | Consent manager Requests / Active Access / History tabs populate location rows | ☐ |
| 10 | No coordinates leak into any consent surface | ☐ |
| 11 | Request → Approve/Deny flow works with correct one-time notifications | ☐ |
| 12 | Page never hard-500s; degrades gracefully | ☐ |

> Known/deferred (not a release blocker): intermittent "geo denied while
> sharing" is device permission flakiness; existing retry/recovery handles the
> common path. Capture a device + repro steps if it occurs so it can be fixed
> precisely later.

---

## 13. How to log a failure (so it can be fixed fast)

For any FAIL, capture:
1. Which user (A/B) + device/browser.
2. The exact step (TC id).
3. Screenshot/screen recording of the notification or screen.
4. DevTools Console errors + the failing network call (status + endpoint, e.g. `GET /api/one/location/state`).
5. Whether it reproduces after a clean reset (§0.4).

---

## 14. Results capture sheet (fill while testing)

> Tester: ____________   Date: __________   Build/SHA: __________   UAT URL: __________
>
> Mark **Result** as PASS / FAIL / BLOCKED / N/A. For FAIL, fill the Notes/Evidence.

| TC | Title | Result | Observed behaviour / Notes / Evidence link |
|---|---|---|---|
| 1.1 | First-time location permission prompt |  |  |
| 1.2 | Permission denied / services off |  |  |
| 1.3 | Intermittent geo denied (known/deferred) |  |  |
| 2.1 | Share to one recipient |  |  |
| 2.2 | Share to multiple recipients |  |  |
| 3.1 | No duplicate "shared" on refresh |  |  |
| 3.2 | No duplicate after re-login / new session |  |  |
| 3.3 | Re-share same person → NO "removed" popup |  |  |
| 3.4 | Real revoke notifies once |  |  |
| 3.5 | Expiry notifies once, not per load |  |  |
| 3.6 | No phantom "removed" when nothing changed |  |  |
| 4.1 | View without opening notification |  |  |
| 4.2 | Inline view survives refresh |  |  |
| 4.3 | Live updates / stale label |  |  |
| 4.4 | Deep link from notification |  |  |
| 5.1 | Unwatch removes share locally |  |  |
| 5.2 | Unwatch persists across refresh |  |  |
| 5.3 | Unwatch does not affect owner |  |  |
| 6.1 | Consent events on shield, NOT bell |  |  |
| 6.2 | Consent icon → opens consent manager |  |  |
| 7.1 | Send a request |  |  |
| 7.2 | Approve a request |  |  |
| 7.3 | Deny a request |  |  |
| 7.4 | Duplicate request guard |  |  |
| 8.1 | Consent manager — Requests tab |  |  |
| 8.2 | Consent manager — Active Access tab |  |  |
| 8.3 | Consent manager — History tab |  |  |
| 8.4 | Coordinate-free guarantee |  |  |
| 9.1 | Create public link |  |  |
| 9.2 | Public visitor submits request |  |  |
| 9.3 | Revoke public link |  |  |
| 9.4 | Invite to One (circle invite) |  |  |
| 10.1 | Page never 500s / degrades gracefully |  |  |
| 10.2 | Share to recipient who never opened One Location |  |  |
| 10.3 | Network blip during view/publish |  |  |
| 11 | Final cross-surface consistency sweep |  |  |

### Final verdict
- Total PASS: ____ / 35  | FAIL: ____ | BLOCKED: ____
- Release decision (all §12 criteria green?): ☐ GO  ☐ NO-GO
- Sign-off: ____________________

---

## 15. Note on automated coverage (already green)

These automated checks already protect the highest-risk logic and pass in CI; the manual plan above covers the human/device flows they cannot:

- `hushh-webapp/__tests__/one-location-notifications.test.ts` — 6/6 PASS
  - once-ever de-dup for share + workflow notifications (survives refresh)
  - consent-surface routing (dispatches consent refresh, does NOT create a bell task)
  - unwatch hides + persists + suppresses notifications
- `consent-protocol/tests/test_one_location_list_state_resilience.py` — 3/3 PASS (a broken section degrades to empty, no 500)
- `consent-protocol/tests/test_one_location_center_contributor.py` — 7/7 PASS (consent-center mapping + coordinate-free guard)

> What automation cannot do (must be manual on UAT): real Gmail login, phone OTP
> verification, real GPS from two physical devices, two simultaneous
> authenticated sessions, and push-notification delivery. That is exactly what
> §1–§11 above are for.

