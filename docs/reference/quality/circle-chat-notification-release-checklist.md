# Circle setup and chat notification acceptance

## Visual Map

```mermaid
flowchart LR
  pr[PR validation] --> build[Signed app build]
  build --> device[Two-account device checks]
  device --> release[Release acceptance]
```

This checklist covers Circle creation, grouped Circle/direct Feed rows and
notification presentation across web, iOS and Android. It extends the existing
multi-installation push registry and migration 290 delivery pipeline. SMS alarm
capability negotiation adds migration 441; use the canonical release manifest
and schema contracts, including its rollback after application rollback.

## Release sequence

1. Run the current PR validation and canonical native export/archive lanes.
2. Deploy the backend and web changes through their existing release workflows.
3. Build signed iOS/Android apps with the normal Firebase/APNs configuration,
   preview keychain access group and notification extension enabled.
4. Run the physical acceptance scenarios below before release acceptance.

This Windows workspace can run TypeScript, focused/browser tests, PostgreSQL
integration tests and Android compilation. It cannot produce an Xcode archive
or establish physical APNs/FCM delivery. Current verification results belong in
the PR; older-base test counts are not evidence for the submitted head.

## Physical acceptance

Use two connected accounts and an ordinary Circle containing both. Run the same
message cases for direct and Circle chat. Record build, OS/browser and permission.

| Scenario | Expected result |
| --- | --- |
| Create from Connect or Location | Members opens with a clear add/invite action; at least one other active member is needed to start chat |
| Empty name, rapid double tap, failed create | Validation/retry; one Circle; setup remains reachable |
| Circle type selection | Tinted border/check selection; primary CTA remains visually distinct |
| Matching chat visibly readable | Message appears live; no redundant foreground sound/banner |
| Another tab/chat, modal or attachment viewer | System alert when permitted; tap opens the owning chat after authentication |
| Background, locked and normally terminated | Circle/direct alert and sound; supported badge and warm/cold routing |
| One-thread burst | One Feed row with current count; one web card or native conversation group |
| Two threads | Separate Feed rows and system groups |
| Open Feed only | Feed attention clears; conversation messages remain unread |
| Read chat twice, then receive delayed push | Covered cards clear; later unread messages remain; retained frontiers prevent foreground replay |
| Read on another native installation | Native quiet synchronization reconciles cards and supported badges when delivered |
| Mute, leave, remove member or rejoin | No new eligible alerts to muted/revoked memberships or old membership epochs |
| Permission denied then enabled in Settings | Explicit setup action; registration repairs on resume without repeated prompts |
| Registration fails then Retry | Delivery is not represented as active before registration succeeds |
| Token registers but native preview custody fails | Generic alerts remain available; chat readiness reports retryable failure and repairs without dropping owner fences |
| No registered device, then registration recovers within retry budget | Unread eligible chat intent retries; already accepted installations are not sounded again |
| Stream connects after a message commit; listener reconnect or queue overflow | Current authorized messages reload immediately from reset, without waiting for fallback polling |
| iOS communication-intent donation stalls | Basic decrypted notification completes within its one-second fallback; late donation does not duplicate presentation |
| Switch account while cleanup awaits | Old callbacks cannot clear the new key's notifications or badge |
| One installation rejects delivery | Only unaccepted installations retry within the existing delivery limit |

## SMS, Location and relationship alerts

The non-chat delivery worker uses migration 361's source-transaction outbox.
Deploy the additive migration and backend before testing fresh native builds;
web deployment alone does not update an installed native wrapper. TestFlight
and App Store distributions both require production APNs. The release lanes
verify distribution-exported IPA entitlements/profile before upload; a green export
check is not evidence that an iPhone displayed or sounded an alert.

Use two connected accounts. Record the candidate commit, app version/build,
OS, environment, permission and channel/sound state for each result.

| Event or recovery | Foreground | Background, locked, normally terminated |
| --- | --- | --- |
| SMS / Save My Soul | One red emergency popup and one repeating alarm until recipient acknowledgement; expiry/revocation never acknowledge it; no replay after acknowledgement | Android capability v1 owns one persistent alarm service, with a visible local fallback if admission/audio fails. iOS 26+ uses authorized AlarmKit through the notification extension; older iOS retains finite OS push sound. Tap opens the authorized Location surface |
| Location share and location request | Feed and current Location state refresh | Visible OS alert with the normal notification sound |
| Circle add and connection request | Feed and relationship state refresh | Visible OS alert with normal sound; no alert from silent roster synchronization |
| Temporary provider outage or backend restart | Committed source retains the intent | Only devices without accepted delivery retry; a successful device is not replayed for another device's failure |
| SMS capture/encryption fails | No location alert before the first encrypted envelope commits | No premature system alarm |
| Revoke/expiry while retry waits | Reconcile current source; never resurrect a stopped SMS popup | Suppress stale alerts on retry |
| Share expires or sender stops after recipient alarm starts | Alarm and explicit acknowledgement remain available | Admitted alarm continues until recipient acknowledgement |
| Multiple SMS grants; acknowledge one | One siren continues for remaining grants | One native audible owner; each alert retains its own acknowledgement |
| Reload or offline restart with pending SMS | Restore pending receipts without requiring network registration | Restore through native identity/key admission; acknowledged receipts never replay |
| iOS 26 alarm permission denied, then explicitly allowed | Separate Allow alarms action; ordinary notification permission remains independent | Finite APNs fallback on denial, extension failure or timeout; authorized AlarmKit requires physical locked-device qualification |
| Notification/sound disabled, then enabled in Settings | Location exposes explicit setup/settings recovery; resume repairs registration without another permission prompt | Re-test new events after enabling; OS controls remain authoritative |
| Token rotates, logout, or account changes | Register through the active native auth session; reject stale callbacks | Never send an old account's alert to the transferred installation |

Local PostgreSQL/provider mocks establish queue, replay, authority and retry
behavior. They do not establish APNs/FCM physical receipt. Record fresh signed
TestFlight and Android physical-device results before native acceptance.

## Platform boundaries

Sound depends on notification permission, Focus/Do Not Disturb, Android channel
settings and device restrictions. Android launcher dots/counts follow launcher
support. Web Badging follows browser support and installed-app requirements.
Safari cannot receive silent Web Push: background read-only synchronization is
native only; web reconciles through local reads and foreground events.

Apple requires the restricted notification-filtering entitlement to discard an
already accepted iOS alert in the extension. This app does not have that
entitlement; the extension silences read alerts and removes stale preview/badge
content, but a quiet read-status card may remain until normal reconciliation.
Do not confuse provider acceptance with exactly-once sound or device receipt.
Force-stop/explicit force-quit are separate OS cases from ordinary background.

Physical iPhone acceptance requires a fresh TestFlight build. AlarmKit system
Stop, including supported hardware controls, acknowledges its alarm. Browser
autoplay/suspension and OS force-stop remain platform boundaries; no release
receipt can replace the two-account locked-device checks above.
