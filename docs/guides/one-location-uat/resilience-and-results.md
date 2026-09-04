# One Location Resilience And Results

## Visual Context

Canonical visual owner: [Guides Index](../README.md). Local parent: [One Location UAT Test Plan](../one-location-uat-test-plan.md).

## Public Link And Circle Invite

If exposed in UAT:

- Links -> Create temporary link creates a copyable/shareable active link.
- Visitor submit is rate-limited and creates a public location request for the owner.
- Revoke temporary link removes the active link.
- People -> Invite trusted person creates a Circle invite.
- Accepted Circle invite creates a One Network connection after phone verification.

## Resilience Cases

Run these negative checks:

1. `/one/location` never hard-fails the whole feature when auxiliary sections degrade.
2. Sharing to a user who never opened One Location shows setup-needed state.
3. Network blips during publish/view show retry or friendly recovery.
4. `/one/consent` handles stale deep links with guidance, not a full-page error.

## Final Cross-Surface Sweep

Run one complete cycle:

1. User A shares.
2. User B views inline from Inbox.
3. User B dismisses.
4. User A re-shares.
5. User B views again.
6. User A revokes.

During the sweep:

- bell never shows location consent items
- shield and `/one/consent` reflect correct state
- no duplicate popup appears
- no false removed popup appears
- coordinates never appear in consent surfaces

## Failure Log

For any failure, capture:

1. user and device/browser
2. exact test module and step
3. tab or flow name
4. screenshot or screen recording
5. console errors
6. failing network call and status
7. whether it reproduces after reset

## Results Sheet

| Area | Result | Evidence |
| --- | --- | --- |
| setup and data path |  |  |
| permissions |  |  |
| share happy path |  |  |
| duplicate notification guard |  |  |
| view without notification |  |  |
| dismiss / unwatch |  |  |
| ask / approve / decline |  |  |
| Access Manager Requests |  |  |
| Access Manager Active Access |  |  |
| Access Manager History |  |  |
| Access Manager Relationships |  |  |
| coordinate-free consent payloads |  |  |
| public link / invite |  |  |
| resilience cases |  |  |
| final cross-surface sweep |  |  |

Final decision: GO / NO-GO
