# One Location — "Pick Me Up" & "Safe Arrival" Test Plan

## Visual Context

These two Quick Actions live inside the One Location agent surface. For the
system-level view of how the app, consent grants, and the encrypted share
pipeline fit together, see the canonical architecture visual owner:

- [System architecture](../../docs/reference/architecture/architecture.md)

Manual test guide for the two new Quick Actions on the One Location agent page
(`/one/location` → **Now** tab → **Quick actions** grid).


Both actions reuse the existing end-to-end-encrypted share pipeline
(`createGrant` + `publishEnvelopeWithRetry`), the same trusted circle as SOS /
Check-In, the same foreground live-watch (streams movement + reconnects), and
the same automatic expiry. No new crypto or consent surface was added.

- **Pick Me Up** (amber, `Hand` icon) — inbound "come get me": share your live
  location + a pickup message so a trusted person drives to you.
- **Safe Arrival** (green, `Home` icon) — outbound "watch me get there": share a
  destination + live journey + live ETA until you arrive.

---

## 0. Prerequisites (do this once before either flow)

1. Sign in and **unlock your vault** (both flows need `vaultOwnerToken`).
2. Have **at least one trusted contact who is "share-ready"** — i.e. they've
   opened One Location once and registered a recipient key (`canReceiveLocation`
   + `keyId` + `publicKeyJwk`). Easiest: use two accounts/devices; on Account B
   open `/one/location` once, then on Account A invite/connect B so B shows as
   Ready in People.
3. Grant **location permission** on Account A's device/browser ("While using the
   app"). If blocked, the Device readiness card at the top will say so.
4. Open `/one/location`, land on the **Now** tab, and confirm the Quick actions
   grid shows six tiles: Check-In, SOS, Drive To, **Pick Me Up**, Safe Arrival,
   Meeting. Meeting is the only "Coming soon" tile.

> Tip: to verify the **recipient** side (live map, ETA, "arrived"), keep Account
> B open on `/one/location` → **Inbox** → "Shared with me".

---

## 1. Pick Me Up — test cases

Open: **Now → Quick actions → Pick Me Up** (amber card, subtitle "Come get me").

### 1.1 Happy path (single helper)
1. On the flow screen you should see, top to bottom: header ("Ask someone to come
   get you"), **Where to pick you up** (your location), **Who can come get you?**,
   **How soon do you need it?** (urgency), **Keep sharing for** (duration),
   **Add detail (optional)**, and the amber CTA.
2. Tap **Capture** in the location card → your live map preview appears; the card
   flips to "Live location ready".
3. The first ready contact should be **pre-selected** (checkbox ticked). Confirm.
4. Leave urgency on **Soon**; leave duration on **Until I'm picked up**.
5. Read the preview line at the bottom of "Add detail": it should read
   `"Could you come pick me up soon?"` with your live location + directions note.
6. Tap **Ask 1 person to pick you up**.
   - ✅ Toast: `Pickup requested from 1 person. They can see you live.`
   - ✅ Flow closes back to the Now hub; an **Active share** row appears with a
     "Stops in …" countdown.
7. On Account B (recipient): a share notification/toast arrives; open **Inbox →
   Shared with me** and tap **View** → your live location renders on the map with
   one-tap **Directions**.

### 1.2 Urgency changes the message
- Select **Urgent** → preview becomes `"I need a ride now — please pick me up
  ASAP."`; select **Whenever you can** → `"Could you pick me up when you get a
  chance?"`. Confirm the message the recipient receives matches the chosen lead.

### 1.3 Optional detail is appended
- Type `I'm at the north gate near the coffee cart` in **Add detail**.
- Preview should read `"Could you come pick me up soon? I'm at the north gate near
  the coffee cart"`. The recipient's notification should carry the same text.
- Character counter caps at **120**; typing past it stops.

### 1.4 Multiple helpers
- Tick two+ ready contacts → CTA reads `Ask 2 people to pick you up`.
- Confirm → toast says "2 people", and **two** Active share rows appear (one grant
  per helper). Verify each recipient sees your live location independently.

### 1.5 Duration options
- Pick **30 min** → the active share countdown should reflect ~30 min.
- Re-run with **Until I'm picked up** → longest window (4h).

### 1.6 Live tracking / "reconnect" (the important one)
1. Start a Pick Me Up share, keep the tab foregrounded.
2. Move ~30+ meters (or simulate via browser devtools "Sensors → Location").
3. ✅ Recipient's map dot should update within a few seconds (movement stream),
   and refresh at least on the 20s heartbeat while stationary.
4. Background the tab, then foreground again → the watch reconnects and resumes
   publishing.

### 1.7 Stop early / auto-expire
- On the Now hub, tap **Stop** on the Active share row → share ends immediately;
  recipient's live view drops.
- Or wait for the timer → share auto-expires with no manual action.

### 1.8 Error / edge cases
- **No ready contact selected** → CTA is disabled and reads "Select who can come
  get you".
- **Location not captured** → CTA reads "Capture your location first" and is
  disabled; capturing enables it.
- **Location permission blocked** → tapping confirm shows
  `Location permission is required to request a pickup.` and the readiness card
  offers "Open Location Settings".
- **No trusted contacts at all** → "Who can come get you?" shows
  "No trusted contacts yet. Add people to your Circle first."
- **Search filter**: type a name in "Search contacts…" → list narrows; clearing
  restores it.
- **Cancel** → returns to hub with no share created.

---

## 2. Safe Arrival — test cases

Open: **Now → Quick actions → Safe Arrival** (green card, subtitle "Watch me home").

### 2.1 Happy path
1. Flow shows: header ("Let people know you got there safely"), **Where are you
   headed?** (search), **Starting from** (your location), **Who should know
   you're safe?**, **Watch me for** (duration), **Add a note (optional)**, CTA.
2. In **Where are you headed?** type e.g. `home` or a real place name.
   - ✅ Debounced suggestions appear (Google Places via backend proxy).
   - Pick one → a confirmed destination chip shows with a green check.
   - If you've used Drive To before, **Recent** destinations appear when the box
     is empty — tapping one selects it instantly.
3. Tap **Capture** → "Live location ready".
4. The whole ready circle is **pre-selected**; narrow if you like.
5. Leave duration on **1 hour**; optionally add a note.
6. Tap **Start Safe Arrival watch**.
   - ✅ Toast: `Safe Arrival started. N can watch you reach <destination>.`
   - ✅ Flow closes; Active share row(s) appear.
7. Recipient (Account B) → **Inbox → Shared with me → View**: the map shows your
   live location **plus** a "Driving to <destination>" panel with a live **ETA**.

### 2.2 Destination is required
- Without a destination the CTA reads "Choose your destination" and is disabled.
- Select a place → CTA enables (assuming location captured + a ready recipient).

### 2.3 Live ETA recompute (mirrors Drive To)
1. Start Safe Arrival to a destination a few km away.
2. Move toward it (real movement or devtools Sensors).
3. ✅ On the recipient's card, the ETA shrinks as you approach; the "Driving to
   …" line stays pinned to your chosen destination. ETA recomputes when you've
   moved ≥250 m or every ~60s.
4. ✅ When you reach the destination the recipient sees the live dot arrive at the
   pin (this is the "got there safely" moment).

### 2.4 Duration & note
- Choose **30 min / 1 hour / 2 hours** → active share countdown matches.
- Add a note (≤120 chars) → shown with the share; default is "Watch me get there
  safely — I'll arrive soon".

### 2.5 Places search failure handling
- Turn off network briefly while typing → inline error
  `Couldn't search places. Check your connection.` (no crash); restore network
  and retry.
- Selecting a place that fails to load details → `Couldn't load that place. Try
  another.`

### 2.6 Error / edge cases
- **Permission blocked** → confirm shows `Location permission is required to
  share your arrival.`
- **No ready recipient** → CTA reads "Select who should know".
- **Location not captured** → CTA reads "Capture your location first".
- **ETA service down** → share still starts (destination shown, ETA omitted) —
  this is best-effort by design.
- **Cancel** → returns to hub, no share.

---

## 3. Cross-cutting checks (both flows)

- **Loading state**: the CTA shows a spinner (`safeArrivalBusy` / share busy) and
  is not double-submittable.
- **Auto-close**: on success the flow closes via the shared `shareCompletedTick`
  signal (same as Check-In / Drive To).
- **Privacy status card** on the Now hub flips to "Sharing in progress" while a
  share is active.
- **Encryption**: destinations/ETA for Safe Arrival travel *inside* the encrypted
  envelope; the backend never sees plaintext coordinates or destination.
- **Expiry / Stop**: every share is time-boxed and stoppable from the Active
  shares list — no manual revoke needed for expiry.
- **Dark mode**: toggle theme; verify tone colors (amber for Pick Me Up, green
  for Safe Arrival) and contrast.
- **Mobile width**: the app renders in a 480px column; verify no horizontal
  overflow and comfortable tap targets.

---

## 4. Quick regression (make sure nothing else broke)

- Check-In, SOS, and Drive To still open and work exactly as before.
- Meeting still shows "Coming soon" and is non-interactive.
- People / Links / Inbox tabs unchanged.

---

## 5. Automated check already run

- `npx tsc --noEmit` on `hushh-webapp` → **0 type errors** (exit 0) after these
  changes.
