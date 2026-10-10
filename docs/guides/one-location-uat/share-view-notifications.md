# One Location Share, View, And Notification Tests

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
7. With notifications disabled or an expired token, the durable share remains
   accessible when the recipient returns. The sender must not claim device
   receipt. Verify token re-registration after permission recovery/login.
8. Stop the active alert, including after the roster becomes empty. Confirm the
   recipient loses live access and the sender can start a new alert.

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
