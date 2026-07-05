# One Location Access Manager Tests

## Visual Context

Canonical visual owner: [Guides Index](../README.md). Local parent: [One Location UAT Test Plan](../one-location-uat-test-plan.md).

## Shell

Open `/consents`.

Expected:

- eyebrow: Access / Consent
- title: Access manager
- Refresh button
- tabs with live counts: Requests, Active Access, History, Relationships
- search box
- tab changes update URL

## Requests

Incoming location requests appear on the owner's Requests tab.

Expected row:

- requester label
- pending badge
- location scope
- coordinate-free summary
- expiry or time-left indicator

Expected actions:

- Allow
- Don't allow
- access duration selector
- Open Location

## Active Access

Active location grants appear for both directions:

- people who can see you
- shares you received

Owned grants expose Revoke. Location rows expose Open Location. Rows remain coordinate-free.

## History

Terminal location events appear with correct status:

- Revoked
- Expired
- Denied

Active grants must not leak into History.

## Relationships

Counterparts roll up into one relationship row with latest state and scope summary. Open Location is available when location context exists, and Revoke is available when an owned active scope remains live.

## Count Consistency

Expected count movement:

- Allow: Requests -1, Active Access +1
- Deny: Requests -1, History +1
- Revoke: Active Access -1, History +1

Refresh must be idempotent and must not duplicate rows.

## Coordinate-Free Guarantee

Inspect UI rows and `/consents` network responses. Consent data must not expose latitude, longitude, address, or map payloads.
