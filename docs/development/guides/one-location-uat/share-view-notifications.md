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

For a private Chat runtime, verify the installed owner runtime or hosted sandbox
image supports conversational Location. The shared backend revision and sandbox
edge gateway do not establish which image a private Chat session uses.

Ask to share just a city, hide coordinates, stop on arrival, or expire automatic
approval after three hours. Verify that Chat explains the unsupported condition
and that no Send control or standing approval appears. A bare “yes” must retain
the restriction. An explicitly revised, supported request can start a fresh review.

Test both the pinned One conversation and an ordinary new or reopened chat.
Use a client advertising `locationChatConversation` for the typed exchanges
below. On a previous client advertising only `locationChatReview`, verify that
the established card confirmation still works.
Type “Turn on my location.” Verify that Chat reports the account or device
action actually needed and that enabling Location creates no recipient grant.
Ask how to enable phone location permission and verify that the reply gives
instructions without opening permission settings.

Type “Share my location.” Chat asks who should receive it. Reply with the name
of a connected test account, then answer the duration question with “1 hour.”
Check the recipient and duration in the final question. Verify that the
recipient has no access yet. Type “yes,” check the receipt, then open the
share as the recipient. Repeat using just the name of the test Circle.
Check its actual recipients before confirming. Repeat with “no” and verify
that no one receives access. Complete these exchanges with the chat composer.

With a ready device and a test Circle named NM, type “Share my location with NM circle for 1 hour”
and send the message. Verify Chat resolves NM and the one-hour duration, then shows
**Share live location** beside its reply. Verify no grant exists before confirmation.
Press the button or reply “yes” and verify the recipient receives the one-hour share.
Repeat with “Ask Ankit to share his location with me for one hour.” Verify **Send location
request** sends to the resolved connection while the sender stays in Chat. Use a test
emergency contact to verify **Send Save My Soul alert** appears after its audience is ready. Repeat on a narrow phone and on desktop. With a larger Circle, check that one
receipt shows the outcome and duration. Ask for the names to inspect the
recipients in Chat. Keep the composer visible while reading or paging through
choices, including when the keyboard opens.

Repeat with an ambiguous name, a changed audience, and an older restored
message. Verify that clarification or a fresh review is required before a share.

Give the audience up front with “Share my location with Maya and Family.”
Change the duration to 30 minutes before confirming. Verify that the final
question retains both audiences and names the new duration. Try an ambiguous
contact name, answer the clarification, and verify the selected identity.
Request a public link explicitly, verify the terms, confirm it, and open it
as a visitor. Stop the link and verify that access ends. Ask for Kushal’s
location with device permission off and verify that Chat does not request
the sender’s GPS.

Ask about Circle membership, then ask a Mail or Calendar question during an
unfinished share. Verify that each request uses its own tools and that an
unrelated “yes” cannot approve the earlier proposal. Explicit navigation
requests may open Location. Sharing and requesting keep the conversation open.

Repeat share and request through an existing private agent that returns the
registered Location navigation or recipient-selection action. The same inline
review must open. A blocked overlay, owner change or unavailable action must
prevent the action. This compatibility path must not execute a mutation or
claim that a share was sent before confirmation.

With a first-time account, send a complete live-share command from a named Chat.
Verify that ONE opens the Location subagent for onboarding. Complete the real
setup and return to the same conversation. Check that the recipient and duration
are preserved and that the recipient gains access only after a fresh typed
confirmation. Repeat with a missing duration. Cancel onboarding, press Back,
refresh and reopen the old conversation. Check that none of these actions sends
a share or an alert. Switch accounts or lock the vault during setup and check
that the pending command stays private. Asking another user for their location
should use the request flow without asking for the sender’s GPS.

With an onboarded account, test sharing turned off, device permission denied,
device Location Services off and paused updates. Recover from Chat and retry the
original action with its audience retained. A browser or device can require its
system permission dialog or Settings. Revoke permission between review and send
and verify no coordinates are published. Lose a response after a successful
write and verify that retry returns the existing receipt with no duplicate grant.
Test Circles, saved places, public links and private check-ins from
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

1. In ONE’s main Chat, ask “Send a one-time pin of my current location to Riley.”
   Verify that One explains it offers live sharing and asks whether you want a
   timed live share instead. The original message must create no proposal,
   grant, or envelope. Ask “Where am I?” and verify the personal device preview
   shares nothing. Reopen a historical pin receipt and verify that replaying it
   creates no new grant or envelope.
2. Use typed Chat and One Live to propose a timed live share to one person and
   to the named Circle. Verify the audience and expiry before confirming through
   the typed conversation or One Live review. On an eligible recipient’s device,
   open the share and verify that a
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
