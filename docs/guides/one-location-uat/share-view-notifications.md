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

Run the flow once per location type:

- Precise shows an exact moving pin, live updates, and recipient navigation.
- Approximate shows only a shaded 1 km+ area, says it refreshes about every five
  minutes, exposes no exact pin/directions, and remains approximate after tab
  changes, refresh, iOS background/resume, and a later device fix.
- With one precise and one approximate recipient active simultaneously, each
  recipient continues to receive only their consented mode.
- If device accuracy becomes worse than the consented approximate radius, the
  update fails safely instead of widening or publishing an exact point.

## Duplicate Notification Guard

For each share, request, revoke, deny, and expiry:

- notification appears at most once per event
- refresh does not recreate it
- tab switching does not recreate it
- re-login does not recreate an already-seen event
- re-share to the same person does not produce a false removal popup

Genuine revoke or expiry can notify once and must not resurrect on refresh.

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
