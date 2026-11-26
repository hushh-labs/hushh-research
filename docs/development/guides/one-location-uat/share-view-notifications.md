# One Location Share, View, And Notification Tests

[One location uat](README.md)

## Visual Context

Canonical visual owner: [Guides Index](../README.md). Local parent: [One Location UAT Test Plan](../one-location-uat-test-plan.md).

## Permission Readiness

Test first-time permission, denied permission, and retry after permission recovery from Now -> Device readiness.

Expected:

- allow shows a ready state and map preview
- denial shows a clear settings/retry path
- browsing the four hub tabs still works
- intermittent device permission failures are acceptable only when retry after granting permission succeeds

## Share Happy Path

User A:

1. Now -> Share my location.
2. Select User B.
3. Choose precise or approximate location.
4. Choose duration and optional note.
5. Review consent rows.
6. Start sharing.

Expected:

- User A sees an active share with countdown and Stop sharing.
- User B sees the share under Inbox -> Shared with me.
- User B can view the map inline.
- Consent notification routes to shield/Access Manager, not the bell.

## Main Chat Location Acceptance

Apply database migration `464_one_location_chat_plans` before enabling
`ONE_MAIN_CHAT_LOCATION_ENABLED=true` on the backend. Build the web and
native web bundles with `NEXT_PUBLIC_ONE_MAIN_CHAT_LOCATION_ENABLED=true`.
Use signed-in test accounts with vault access and registered Location recipient
keys. Use a named Circle with at least two participants.

Test both the pinned One conversation and an ordinary new or reopened chat.
Say “Share my location to Kushal,” then “1 hour.” Verify the inline review
shows Kushal and one hour. Ask for Kushal’s location with device permission
turned off. Verify the request opens in Chat without asking for the sender’s GPS.

Start by typing “Share my location” in the main Chat. Verify that it offers
private sharing and a temporary public link. In private sharing, search and
select both a connection and a Circle. Check the audience on the review card.
Then choose a public link, preview the position, and confirm. Open the link as
a visitor, and verify that stopping it from Chat or Location ends access.

Repeat from typed Chat using “Private with Maya and Family” followed by “Make
it 30 minutes.” Check that the review carries the chosen audience forward and
that a typed yes leaves confirmation on the card. Try an ambiguous contact
name and resolve it from the picker. Check that Location support requests and
Circle membership questions still use their existing read tools, and that a
subsequent Mail or Calendar request resumes its own flow. Explicit navigation
requests may open Location; sharing and requesting must keep the Chat route
and conversation mounted.

Repeat share and request through an existing private agent that returns the
registered Location navigation or recipient-selection action. The same inline
review must open. A blocked overlay, owner change or unavailable action must
prevent the action. This compatibility path must not execute a mutation or
claim that a share was sent before confirmation.

From Chat, test Location setup, account sharing off, device permission denied,
device Location Services off and paused updates. Recover through the card and
retry the original action with its audience retained. Browser and OS settings
may require a system prompt or Settings; the app must keep the pending review
in Chat. Test Circles, saved places, public links and private check-ins from
their inline reviews. “Check me in here” opens the Check-in screen to find
venues from the device’s current position. Reopening chat history must keep
the conversation visible. Ask to enable Auto approve for a named Circle, review
the scope, then turn it off from Chat. Verify the saved preference on both
surfaces and that requests already waiting still require an answer.

For Save My Soul (SMS), review the current emergency contacts in Chat, then
send only to consenting test accounts. Change the roster or recipient key
between review and send and require a fresh review. Check per-contact delivery,
partial failure, email fallback failure and Stop while email fallback is still
pending. A stopped alert must not resume ordinary sharing that was already off.

1. In ONE’s main Chat, type a request to share your current location with a
   named person. Confirm the recipient, preview the point, and tap to send.
   The same pin appears under Location → Sent pins and under the recipient’s
   Shared with me. Move the publishing device and verify the original point
   stays fixed. Verify that the pin becomes unavailable at its one-hour expiry
   or immediately after a connected stop. The view must offer no duration edit.
2. Use typed Chat and One Live to propose a timed live share to one person and
   to the named Circle. Verify the reviewed audience and expiry before tapping
   Start. On an eligible recipient’s device, open the share and verify that a
   new published point reaches it. Check that a non-member and an ineligible
   member cannot read the Location data. Rotate a recipient key or change Circle
   membership between review and confirmation and verify the affected share asks
   for a fresh review.
3. Change the live end time in Location, then confirm the original Chat card
   and recipient reflect it. Add time from Chat and check the same grant in
   Location. Send a request for extra time as the recipient, approve from either
   surface, and verify the exact active grant keeps its ID. Run the reverse
   direction for a new request and for a decline. Check that asking someone
   already sharing opens their existing share without issuing another request.
4. Retry a confirmation after a lost response, refresh an executed typed card,
   and repeat with two tabs. Verify that the operation has one visible result.
   Verify that an offline stop pauses local publishing, syncs after reconnect,
   and becomes terminal for the recipient. Repeat with sign-out, vault lock,
   expired grants, no initial fix, and a declined permission prompt.
5. Repeat on responsive web and physical Android and iOS devices. Cover
   foreground, background, return to app, approximate permission, revoked
   permission and OS-killed app. Record platform, build, permission level and
   network for each run. Measure median and 95th-percentile time from proposal
   to review, confirmation to receipt, and publish to recipient update. Check
   that stale UI reports waiting or the last verified update time.

One Live proposals require a tap on the review. The proposal is shown in the
active voice session. Completed actions remain visible in Location. Web
continuity depends on page visibility and permission. Native background
continuity depends on OS permission and the existing publisher in the installed
app build. [Web geolocation](https://www.w3.org/TR/geolocation/),
[Android background location](https://developer.android.com/develop/sensors-and-location/location/permissions/background),
and [iOS background location](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background).

## Duplicate Notification Guard

For each share, request, revoke, deny, and expiry:

- notification appears at most once per event
- refresh does not recreate it
- tab switching does not recreate it
- re-login does not recreate an already-seen event
- re-share to the same person does not produce a false removal popup

Genuine revoke or expiry can notify once and must not resurrect on refresh.

## Save My Soul Regression And Device Acceptance

Use consenting test accounts with eight SMS Circle members. Browser fixture
tests exercise the real panel with local callbacks; they do not send emergency
alerts or prove APNs/FCM delivery. Complete the device checks below on a release
candidate before claiming delivery across iOS, Android and web.

Release the backend before the updated web and native web bundles so clients
receive the complete roster projection. The IDs-only response remains supported
during a rolling deployment, but its legacy recipient-picker fallback can be
bounded. No database migration is required for this repair.

1. Confirm all eight roster members appear, including members outside the first
   ranked picker page. A stale, incomplete identity shadow must be refreshed from
   canonical phone verification before readiness is evaluated. A genuinely
   unverified account or missing recipient key must still fail its readiness
   gate; never mark it verified solely because it is in an SMS Circle.
2. Select each preset and check that it populates the editable input. Edit it
   and verify the exact edited note reaches recipients after vault unlock.
3. Tap Send: a two-second countdown starts and Cancel stops it. Hold Send or the
   SMS circle for two seconds: exactly one alert starts. Releasing an unfinished
   hold, changing focus or backgrounding the app cancels it. Repeat using a
   keyboard on web and actual touch on iOS and Android.
4. Inject one grant failure and one first-envelope failure among eight contacts.
   Later healthy contacts must still be attempted. Keep created grants in the
   incident so Stop revokes them. Report partial sharing and push requests
   honestly; a queued push is not a delivery receipt.
5. For each recipient platform, test foreground, background and terminated
   states with notifications permitted and a current registered token. Foreground
   receives one emergency card and a Feed item; background receives the system
   notification. Open the body into Feed and verify authorized live location.
   Separately test the iOS Open live location action.
6. Reconcile the share into Feed before delivering its push. The live emergency
   card must still appear once. Replaying the push must not duplicate the card or
   Feed row. Opened/unwatched shares stay quiet.
   Repeat with an ended SMS and a separate active ordinary share from the same
   owner: reconciliation must still silence the ended SMS's delayed push.
7. With notifications disabled or an expired token, the durable share remains
   accessible when the recipient returns. The sender must not claim device
   receipt. Verify token re-registration after permission recovery/login.
8. Stop the active alert, including after the roster becomes empty. Confirm the
   recipient loses live access and the sender can start a new alert.
9. Test foreground sound before the first app gesture and after one ordinary
   interaction. Blocked browser audio must leave the system fallback eligible;
   a failed system display must be retryable without repeating the in-app card.
   Backgrounding during a tone must stop it without replaying it on resume.
   On rebuilt iOS/Android apps, unavailable Web Audio must use the existing
   HushhNotifications foreground cue once, without a second system popup.
   Stop, sign-out and backgrounding must cancel that cue. Older installed
   wrappers need a new native build to gain this fallback; a hosted UAT deploy
   alone does not update their native bridge.
10. Deliver an expired creation push, then replay an already-presented or ended
    SMS after restarting the web worker. None should sound. A different active
    grant must still alert. Verify native sound on both channel-based Android and
    Android 7, and the iOS custom sound with notifications and sound permitted.
    Browser audio tests cannot establish physical speaker output or OS delivery.

The sender's readiness disclosure distinguishes unconfirmed account verification,
unfinished secure sharing setup and missing roster projections. Membership alone
does not establish readiness. The recipient must establish their own sharing key;
the sender cannot create it for them. Push lifetime is bounded by the share's
expiry (legacy alerts without an expiry are immediate-only). Web workers retain
opaque grant presentation and terminal receipts for the maximum push lifetime.
Silent expired pushes retain the same transport deadline and cannot create a
new active Feed card.

The repaired regression involved a separate cached phone-readiness gate, a
preset state disconnected from the composer, recipient fan-out stopping at the
first error, and Feed reconciliation consuming live presentation deduplication.
These are code-path findings; the affected production account's identity rows
must be checked separately if its canonical verification still fails.

## View Without Notification

User B must be able to ignore the notification and still view the active share from Inbox -> Shared with me.

Expected:

- share card is present
- View loads the inline map
- refresh preserves the active share and re-renders the inline map
- deep links are convenience only, not a requirement for viewing

## Dismiss / Unwatch

User B can dismiss a received share locally.

Expected:

- the share disappears locally
- dismissal persists across refresh
- dismissal silences notifications for that grant
- the owner's grant remains active server-side

## Ask Flow

User B:

1. Now -> Ask someone.
2. Select User A.
3. Choose duration and reason.
4. Send request.

User A can approve from Inbox -> Needs your review or Access Manager -> Requests.

Expected:

- request reaches shield and Access Manager, not the bell
- approve creates an active grant and User B can view the map
- decline notifies once and creates no grant
- duplicate rapid requests do not create multiple actionable pending rows
