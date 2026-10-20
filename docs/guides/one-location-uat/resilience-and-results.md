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
2. A connected user who never opened Location remains eligible for Ask. Secure
   receiving initializes automatically after vault unlock, without Location
   onboarding or GPS permission. If its key is still unavailable, Share explains
   receiving readiness and never offers to invite that existing connection.
3. Network blips during publish/view show retry or friendly recovery.
4. `/one/consent` handles stale deep links with guidance, not a full-page error.

### Connected-recipient lifecycle regression

Use two test accounts and record the deployed frontend/backend revision.

| Case | Reproduce | Required result |
| --- | --- | --- |
| Optional onboarding skipped | B creates the vault under `/one/setup`, returns directly to Chat or Connect, connects with A, and never opens Location | A can Ask; B's receiving key initializes automatically and A's already-open Share picker becomes available without refresh |
| Initial registration offline | Keep B offline past the bounded setup retries, then restore connectivity while B stays in Chat | Registration retries without a new unlock; A's open People, Share and SMS lists reconcile |
| Missing receiving key | Connect A/B with B not yet cryptographically ready | B remains connected, Ask remains available, Share sends no unencrypted location and never labels B as needing an invitation |
| Account deletion | With A's People, Share, Ask or SMS flow open, B completes full account deletion | B disappears from all connection-backed lists and retained selections without manual reload; old in-flight responses cannot restore B |
| Ask confirmation deletion | Select B outside the workspace's first 50, continue to Ask details, then delete B; repeat with a second valid person selected | B disappears from the confirmation and stored selection; an empty audience disables Send request, while a mixed selection can send to the remaining person without failing on B's stale ID |
| Failed deletion | Roll back B's deletion before commit | A receives no removal signal and B remains connected |
| Missed live event | Drop the live event while A keeps Share/Ask open | The visible minute repair or earlier foreground recovery removes B/reconciles readiness; server audience validation still rejects stale sends |
| Repeated registration | B unlocks repeatedly using the same active public key, including private-backup backfill | No repeated peer fanout; valid existing grants remain intact |
| Rotation and identity | Rotate B's receiving key; separately delete/recreate B as a new account with the same display name | Key changes refresh A's audience; old account relationships are removed and a new account never inherits consent merely through matching names |

Source/unit results do not establish delivery on a physical device. Capture both
accounts' observed list transitions, the deployed revisions, and any delivery
failure before marking these cases passed. Do not infer account deletion from
the teammate's “inactive” description or from absent optional setup preferences.

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
