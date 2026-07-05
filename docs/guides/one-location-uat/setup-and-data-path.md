# One Location UAT Setup And Data Path

## Visual Context

Canonical visual owner: [Guides Index](../README.md). Local parent: [One Location UAT Test Plan](../one-location-uat-test-plan.md).

## Accounts And Devices

Use two real, phone-verified users.

| Role | Purpose | Device suggestion |
| --- | --- | --- |
| User A | location owner / sharer | phone or mobile browser with real GPS |
| User B | recipient / requester | second phone or separate browser profile |

Both users must:

- complete onboarding
- complete phone verification
- open One Location at least once so recipient encryption keys are provisioned
- use separate sessions so local storage does not collide

## Environment Checks

- UAT build is loaded.
- `/one/location` opens on the Now tab.
- Hub tabs render: Now, People, Links, Inbox.
- `/consents` loads as Access Manager.
- Access Manager tabs render: Requests, Active Access, History, Relationships.

## Data Path

1. The sharer's device captures location with the Web Geolocation API or native `HushhLocation` plugin.
2. The sharer encrypts each point per recipient through the One Location encryption path.
3. The backend stores opaque encrypted envelopes only.
4. The recipient decrypts the envelope client-side.
5. `LocalMapPreview` renders a Google Maps embed from the decrypted point.

Consent surfaces must stay coordinate-free. They can show counterpart, scope, reason, status, and timestamps; they must not show latitude, longitude, address, or map payloads.

## Live Update Expectations

- movement update threshold: about 25 m, throttled to at least 8 seconds apart
- stationary heartbeat: about 20 seconds
- stale label: shown when updates stop for about 60 seconds

## Reset Helper

To rerun a clean local notification test, clear local storage keys starting with:

- `one_location_seen_notifications_v1:`
- `one_location_opened_grants_v1:`
- `one_location_unwatched_grants_v1:`

Also clear session storage key:

- `kai_app_background_tasks_v1`

Then hard refresh.
