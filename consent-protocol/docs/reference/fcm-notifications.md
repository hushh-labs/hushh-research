# FCM Notifications

> **Status**: Production (Pure Push)
> **Last Updated**: September 2026
> **Scope**: Web (FCM), iOS/Android (Capacitor Firebase Messaging)


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## Overview

Notification wake-ups are delivered through **Firebase Cloud Messaging (FCM)** using a **pure push** architecture. The backend sends enriched payloads so the client can refresh the durable Feed for every push and refresh recognized owning-domain state without a notification-data poll.

**Supported platforms**: Web (FCM JS SDK), iOS (Capacitor Firebase Messaging), Android (Capacitor Firebase Messaging).

### Cross-platform presentation policy

Routine notification families—including consent, connection, One Location,
Kai, and forward-compatible types—follow one lifecycle policy:

| App state | Presentation | State behavior |
| --------- | ------------ | -------------- |
| Active/visible | No routine Sonner toast and no browser/native foreground banner or sound; badge may update | Always refresh Feed; also refresh recognized consent, connection, and One Location state |
| Background/terminated native app, or no visible web client | One operating-system notification | Durable Feed remains authoritative |
| External notification body tap | Open `/one/feed` | The Feed row owns later detail navigation/action |

Registered iOS consent action buttons still open their review/confirmation flow
and never approve or deny directly; Android does not register equivalent native
action buttons. The service worker elects one visible client to acknowledge
foreground ownership; hidden tabs cannot suppress the system fallback or replay
stale popup UI. Historical hydration and One Location state reconciliation are
state-repair paths only and never presentation sources.

Every shared push carries an explicit
`notification_presentation=alert|silent` data field. A silent event (for
example `consent_opened` or `consent_resolved`) may invalidate client state and
close the matching stale system card, but it must never synthesize a fallback
title/body or call the operating-system presentation API.

### Durable Feed and identity contract

An alert-class push is a wake-up/delivery mechanism, not notification history.
Before a routine notification type is added, its authoritative transition must
already produce either a durable `feed_events` row or a live Feed actionable.
Current coverage includes consent, connection actionables, the full One
Location notification lifecycle (including Circle joins and referrals), and
terminal funding-transfer statuses. Calendar and Mail also project
privacy-safe, durable in-app Feed outcomes: Calendar connection state and
confirmed create/reschedule/cancel actions; Mail connection state, opted-in
information requests, receipt sync outcomes, and owner-approved send outcomes.
These Feed projections do not themselves send an OS push. A new emitter that
only calls FCM is incomplete.

`message_id` identifies one semantic transition and `notification_tag`
identifies the system card it may replace. Connection requests are scoped by
request id; funding messages use transfer id plus normalized status for
`message_id` and transfer id for the replacement tag. Web tags, Android tags,
and APNs thread ids use the same semantic tag. Client dedupe also includes the
notification revision/sequence so a real state transition is not mistaken for
a transport retry.

Warm web notification clicks use an acknowledgement handshake: the service
worker requests internal Feed navigation first (preserving the memory-only
vault), then falls back to `WindowClient.navigate`/`openWindow` if an old or
uncontrolled page does not acknowledge. Consent request identity is carried to
Feed as bounded query metadata and acknowledged only after authentication and
vault unlock, which prevents the final reminder from firing after the user has
already attended the system notification. Transient acknowledgement failures
retry with capped backoff while Feed remains open and retry immediately when
connectivity returns; permanent authorization or validation failures do not
spin in the background.

### One replied (`one_reply`)

A One chat turn keeps running on the server after the app stops reading it
(the person left the chat, or the native app went to the background), and its
answer is sealed into the conversation with the turn's own chat key. When such
a turn settles with something to open, the server sends one bare wake-up:

| Field | Value |
| ----- | ----- |
| Title / body | `Hussh One` / `One replied` (fixed; never answer or prompt text) |
| `type` | `one_reply` |
| Data | `conversation_id` (opaque) and `message_id` only; no `user_id` |
| Platforms | iOS and Android tokens only; a web token is skipped |
| Body tap | `/?conversation=<id>`; the chat selects it after unlock through its owner-checked history load. `deep_link` is ignored |

It is sent only when the stream had already closed before the turn settled
(a client still reading receives the answer live), and only for turns whose
client asked for it with `forwardedProps.notifyOnDetach` — the native app. A
web tab's closed stream never wakes the person's phone. Bridge bookkeeping
events (`state_update_*`) are not read as a turn, so a review pause counts as
settled and earns the push. Inside the open app the chat
shows its own "One replied" notice (see `AgentChatTurnNotifier`), and nothing
while the person is looking at that conversation.

**Exception to the Feed-row rule, by design.** The durable record is the
conversation itself, sealed with the person's chat key. A `feed_events` row is
not chat-key sealed, so writing one per reply would move chat metadata out of
the sealed store. The body tap therefore opens the conversation, not Feed.

### Consent request (`consent_request`) is bare

The owner's push names who is asking and nothing else: title `Consent request`,
body `{Name} asked to see your information` (final reminder: `{Name}'s request
is still waiting for you.`). Data carries identifiers, the requester's display
name and photo URL, and timing fields only. Scope, scope description, purpose,
existing grants and access summaries are never in the push, because the push
provider and the lock screen see it before the vault is unlocked. The app loads
those details after unlock from the owner-scoped pending list. Built by
`build_consent_push_content` in `api/consent_listener.py`; guarded by
`tests/test_consent_listener_notifications.py`.

### Information request answered (`information_request_updated`)

When the owner approves or declines a person-to-person request, it times out,
or the owner later ends access, the requester gets one bare alert. This is the
canonical outcome event documented in `docs/reference/architecture/api-contracts.md`
(`information_request_updated`), sent exactly once per event (migration 259):

| Field | Value |
| ----- | ----- |
| Title / body | `Hussh One` / `Your information request has an answer`; for `REVOKED`, `Access to information shared with you has ended` (fixed; never a scope, label or value) |
| `type` | `information_request_updated` with `action`, `bundle_id`, `request_id`, `outcome` (the bundle's outcome word) and `at` |
| Alert | `CONSENT_GRANTED`, `CONSENT_DENIED`, `TIMEOUT`, `REVOKED`, once the whole request is settled (`outcome` not `pending`); `CANCELLED` stays silent |
| Tag | `information-request:{bundle_id}` (one card per request) |
| Body tap | `/?informationRequest=<bundle_id>`; after unlock the app finds the asking conversation in the person's sealed history and continues it there |

Inside the open app the requester's One chat continues on its own
(`AgentConsentContinuationNotifier`): on the chat, the request card shows
`Consent approved` and One answers from the shared information; elsewhere in
the app a `Consent approved` notice appears and the existing `One replied`
notice follows. The notifier polls only the requests this tab saw waiting, so
it works when web push is blocked. The durable record is the sealed
conversation, the same exception to the Feed-row rule as `one_reply`.

### One has something for you (`one_feed_attention`)

When a notable Feed row appears, the person gets one bare alert. One writes what
it has to say only after they open the app with the vault unlocked, as an
ordinary chat turn sealed with their chat key; the server never pre-writes or
stores that message.

| Field | Value |
| ----- | ----- |
| Title / body | `Hussh One` / `One has something for you` (fixed; never the event, a name or a value) |
| `type` | `one_feed_attention` |
| Data | `feed_item_id` (the opaque `feed_events` id) and `message_id` only; no `user_id` |
| Platforms | iOS and Android tokens only, like `one_reply` |
| Body tap | `/?feedAttention=<id>`; after unlock a fresh chat opens and One speaks about that row. `deep_link` is ignored |

Only a closed list of event types is notable (`mail_information_request_detected`,
`mail_reconnect_required`, `mail_message_failed`, `mail_delivery_unconfirmed`,
`calendar_reconnect_required`, `kai_analysis_completed`, `kyc_status_changed`):
rows that need the person or report a failure, from domains with no push of
their own. At most two are sent per person in any 24 hours, counted in
`one_attention_ledger` under a per-person advisory lock; a capped row is recorded
`throttled` and never reconsidered. A person with notifications off has no device
token, so nothing is sent and the row is recorded `no_device`, which does not
spend a slot. There is no separate server-side notification preference today.
The sweep runs every 60 s over the last hour of rows and is off unless
`ONE_FEED_ATTENTION_PUSH_ENABLED=true`. The Feed row remains the durable record.

### Emergency SMS alert policy

One Location `SMS · Save my soul` sends are a separate emergency notification
profile, identified by:

```json
{
  "type": "location_share_created",
  "share_kind": "sos",
  "notification_profile": "one_location_sms_emergency",
  "notification_category": "ONE_LOCATION_SMS_EMERGENCY"
}
```

The explicit profile is canonical. Receivers also recognize
`type=location_share_created` plus `share_kind=sos` so an older queued payload
still receives emergency presentation.

| Surface | Emergency behavior |
| ------- | ------------------ |
| Visible web app | Assertive red emergency card, three-pulse Web Audio alarm, supported-device vibration, and a 30-second presentation window |
| Background web / PWA | Persistent browser notification with emergency vibration metadata; body tap enters Feed |
| Android | Dedicated `one_location_sms_emergency_v1` high-importance channel using the device alarm sound, red notification light, and emergency vibration pattern |
| iOS background/terminated | `ONE_LOCATION_SMS_EMERGENCY` category, custom `one_location_sms_alarm.wav` sound generated in the app's `Library/Sounds`, badge, and an Open live location action |
| iOS foreground | Shared red in-app emergency card and alarm; Capacitor's Firebase Messaging router presents only the badge to prevent a duplicate banner and duplicate sound |

The explicit iOS **Open live location** safety action is the only notification
action that bypasses Feed and opens the validated One Location target. A normal
notification body tap, including an emergency body tap, still enters Feed.

This profile does **not** bypass Focus or Do Not Disturb. Android explicitly
keeps channel DND bypass disabled. iOS Critical Alerts are not requested because
that capability requires a separate Apple entitlement and review. Browser
vendors and operating systems retain control over closed-tab notification
sounds, so web background delivery cannot guarantee the custom three-pulse
audio; the browser notification remains persistent and vibrates where supported.

### Reminder policy

Consent notifications now use a bounded two-step schedule:

- sequence `1`: initial request push
- sequence `2`: one final reminder near expiry

There is no midpoint reminder and no repeated reminder loop once a request has been attended or resolved.

### Architecture

```
1. MCP Agent → POST /api/v1/request-consent
2. Backend inserts consent_audit row
3. PostgreSQL pg_notify trigger fires
4. consent_listener.py receives event
5. Builds a bare FCM payload: identifiers and the requester's name only (details load after unlock)
6. Sends FCM message to user's registered tokens
7. Client receives push → refreshes Feed/domain state; OS presents when the native app is backgrounded/terminated or no visible web client claims the push
8. No polling and no production SSE requirement for notification data
```

### Stale Token Handling

When Firebase returns `messaging.UnregisteredError` or `messaging.SenderIdMismatchError`, the listener automatically deletes the stale token from `user_push_tokens`.

### Token Lifecycle

| Event        | Action                                    |
| ------------ | ----------------------------------------- |
| Login        | Register token via `POST /api/notifications/register` |
| Token rotate | Native listener re-registers new token    |
| Logout       | Delete token via `DELETE /api/notifications/unregister` |

---

## FCM vs gcloud: What Can and Cannot Be Done

### Cannot be done with gcloud CLI alone

Consent push uses **Firebase Cloud Messaging (FCM)**. FCM is a **Firebase product** (part of Google Cloud). The following **cannot** be fully configured or operated from the **gcloud CLI** alone:

| Task | Why gcloud is not enough |
|------|---------------------------|
| **Web push (VAPID key)** | VAPID keys are created and managed in the **Firebase Console** (Project Settings → Cloud Messaging → Web Push certificates). There is no gcloud command to create or list VAPID keys. |
| **FCM project configuration** | Enabling Cloud Messaging, linking to a Firebase project, and client configuration (sender ID, app ID) are done in the **Firebase Console**. |
| **Client registration** | The web app uses the **Firebase JS SDK** (`getToken`, `onMessage`). Token registration and foreground handling are implemented in code, not via gcloud. |
| **Sending messages in production** | The backend uses the **Firebase Admin SDK** (with `FIREBASE_ADMIN_CREDENTIALS_JSON`) to send FCM messages. There is no first-class `gcloud messaging send` command. |

So: **consent push cannot be driven “directly using the gcloud CLI”** as a single tool. You need Firebase Console for setup and the application (backend + frontend) for sending and receiving.

### What gcloud CLI is used for

gcloud is used for **GCP resources** that support the FCM-based flow:

| Task | gcloud usage |
|------|--------------|
| **Enable APIs** | `gcloud services enable fcm.googleapis.com` (optional; Firebase/Cloud Messaging may already be enabled with Firebase). |
| **Store service account secret** | Store `FIREBASE_ADMIN_CREDENTIALS_JSON` in Secret Manager so the backend can send FCM: `gcloud secrets create FIREBASE_ADMIN_CREDENTIALS_JSON --data-file=sa.json` (see [env-vars.md](./env-vars.md)). |
| **Deploy backend/frontend** | Deploy consent-protocol to Cloud Run via `gcloud run deploy` (see [Deployment](#deployment) in the root README). |
| **Get an OAuth token for FCM HTTP v1 (testing)** | You can obtain an access token (e.g. Application Default Credentials after `gcloud auth application-default login`) and send a **test** message via the FCM HTTP v1 API with `curl`. This does not replace the Firebase Console or the app for normal operation. |

---

## Architecture (short)

1. **consent_audit** row inserted → Postgres trigger **NOTIFY consent_audit_new**.
2. **Notification worker** (in consent-protocol) **LISTEN**s; on NOTIFY it:
   - Sends FCM to the user’s registered tokens (Firebase Admin SDK),
   - Pushes the event into a per-user in-app queue for SSE.
3. **Web client**: Requests permission, gets FCM token (`getToken` with VAPID key), registers token via `POST /api/notifications/register`; handles **onMessage** as a Feed/domain refresh while visible and routes service-worker **notificationclick** to `/one/feed`.

Circle lifecycle transitions use the same dual-transport client contract with a
separate metadata-only PostgreSQL channel, `one_user_state_changed`. The
mutation worker publishes one doorbell after commit; every backend
worker/instance listens and only the worker that owns the recipient's open SSE
stream enqueues it locally. FCM remains the offline/native lane, while the
shared transition `message_id` lets the client deduplicate an event received on
both transports. The channel is deliberately restricted to
`location_circle_*` event types and carries no Circle roster or private
location payload.

See the plan in `.cursor/plans/` and [consent-protocol.md](./consent-protocol.md) for full flow.

---

## Event pipeline (trigger → listener → queue → SSE / FCM)

Consent requests reach the user only when the following chain is in place:

1. **Trigger** – When a row is inserted into `consent_audit`, a Postgres trigger runs and sends **NOTIFY consent_audit_new** with a JSON payload (user_id, request_id, action, etc.). The trigger is defined by the canonical release migration `db/migrations/011_consent_audit_notify_trigger.sql`. **The trigger must be applied to the same database the app uses at runtime** (the one pointed to by `DB_HOST` / `DB_NAME`). If the trigger is missing on that database, NOTIFY never fires and neither FCM nor in-app SSE will receive consent events.

2. **Listener** – The consent-protocol backend starts a background task that **LISTEN**s to `consent_audit_new` on an asyncpg connection to the same DB. When NOTIFY is received, it (a) optionally pushes the event into a per-user queue for non-production SSE debugging, and (b) calls the FCM path to send push to the user’s registered tokens. If the DB pool is unavailable at startup (e.g. missing `DB_*` env), the listener does not start and no NOTIFY is ever handled; check logs for `Consent listener: DB pool not available` and (in development only) verify `GET /debug/consent-listener` shows `listener_active: true` after startup.

3. **Queue → SSE fallback** – The in-app SSE generator creates a queue per user when the first SSE connection for that user is opened. Local development and UAT are expected to keep `CONSENT_SSE_ENABLED=true` so web fallback delivery can be validated when FCM is blocked or misconfigured. Production stays FCM-first by default with `CONSENT_SSE_ENABLED=false`, and `/api/consent/events/{user_id}/poll/{request_id}` remains hard-disabled there.

4. **UI** – The frontend notification provider subscribes to FCM/SSE wake-ups and refreshes Feed plus the pending list. Routine events never create foreground popup cards.

**Diagnostic:** In development, call `GET /debug/consent-listener` to see `listener_active`, `queue_count`, and `notify_received_count`. In production this endpoint is intentionally unavailable (`404`), so use backend logs/metrics instead. If `notify_received_count` never increases after creating a consent request, NOTIFY is not reaching the process (trigger not on runtime DB or listener not running). If it increases but users see no push, the issue is downstream (no tokens, Firebase not configured, or send failure; check backend logs for "FCM skipped" or "FCM send failed").

---

## Required setup (Firebase Console + env)

1. **Firebase Console**  
   - Same Firebase project as auth.  
   - **Cloud Messaging**: Ensure Cloud Messaging is enabled.  
   - **Web Push**: Under Project Settings → Cloud Messaging → “Web configuration”, generate a **Key pair** (VAPID key). Use the **Key pair** value as `NEXT_PUBLIC_FIREBASE_VAPID_KEY` in the frontend.
   - **Environment model**: If the app uses one Firebase identity plane across dev/UAT/prod and only the databases differ, keep the same Firebase project/web config aligned across those environments. Do not point auth at one Firebase project and web messaging at another.

2. **Backend**  
   - **FIREBASE_ADMIN_CREDENTIALS_JSON**: Service account JSON (Firebase Console → Project Settings → Service accounts → Generate new private key). Stored in GCP Secret Manager and injected into consent-protocol (see [env-vars.md](./env-vars.md)).

3. **Frontend**  
   - **NEXT_PUBLIC_FIREBASE_VAPID_KEY**: VAPID key from step 1. Without it, web FCM token registration is skipped (see [env-vars.md](./env-vars.md)).

4. **gcloud**  
   - Create/update secret:  
     `gcloud secrets create FIREBASE_ADMIN_CREDENTIALS_JSON --data-file=path/to/sa.json`  
     (or use Secret Manager in Cloud Console.)  
   - Deploy backend so it has access to this secret (e.g. Cloud Run with `--set-secrets`).

---

## Web fallback delivery

Web consent delivery now uses two lanes:

1. **Primary**: Browser FCM push
2. **Fallback**: Authenticated SSE + Feed/inbox refresh while the tab is open

The client exposes these delivery states:

| State | Meaning |
|------|---------|
| `push_active` | Browser FCM is healthy and token registration succeeded. |
| `push_blocked` | Browser permission is blocked, so the app falls back to live SSE Feed/inbox refresh while the tab is open. |
| `push_failed_fallback_active` | Push registration failed or is misconfigured, but SSE Feed/inbox refresh is active. |
| `inbox_only` | Neither push nor live SSE is currently active. Requests still appear in the consent center on next load. |

If web push fails, the app:

- clears stale browser push subscriptions,
- clears cached Firebase web push IndexedDB state,
- retries the SDK path,
- attempts a manual FCM registration path,
- then activates authenticated SSE fallback if push still fails.

Closed-tab behavior remains limited by browser push availability: if push is disabled or misconfigured and the tab is closed, the durable fallback is Feed and the owning inbox on next app open.

---

## Operator runbook for web push failures

When web consent notifications fail:

1. Confirm browser permission is allowed for the active origin.
2. Open the consent center and check the reported delivery mode.
3. Use `Retry push registration` in the consent center after any config changes.
4. Verify a successful registration creates a row in `user_push_tokens`.
5. In Firebase Console, open the active project:
   - **Project Settings → Cloud Messaging → Web configuration**
   - confirm the Web Push key pair matches the Firebase project used for login and token verification
   - update `NEXT_PUBLIC_FIREBASE_VAPID_KEY` to the public key from that same project
6. If the browser still returns `401 Unauthorized` from `fcmregistrations.googleapis.com`, first check for a Firebase project mismatch between auth verification and web messaging before assuming the VAPID key itself is wrong.

Remember:

- `gcloud` can enable APIs and manage secrets.
- `gcloud` cannot create or rotate the Firebase Console Web Push key pair.
- A healthy fallback path on web is **SSE + inbox**, not repeated FCM retry loops.

## Native iOS alert checklist

Use this when Firebase accepts an iOS send but the device does not visibly alert:

1. Confirm the token row exists in `user_push_tokens` with `platform='ios'`.
2. Confirm the send returned a Firebase `message_id` instead of `THIRD_PARTY_AUTH_ERROR`.
3. On the device, verify the Hussh app has:
   - `Allow Notifications`
   - `Notification Center`
   - `Lock Screen`
   - `Banners`
   - `Sounds`
4. Confirm Focus / Do Not Disturb is off.
5. Background the app before testing.
6. Check native logs for:
   - APNs token registration
   - FCM token refresh
   - foreground receipt
   - notification tap callback

If the backend accepted the send and the app still does not present anything, debug the device presentation path before changing Firebase or the sender again.

---

## Sending a test message (gcloud + curl, optional)

If you want to **test** FCM delivery without the full app flow, you can use an OAuth token and the FCM HTTP v1 API. This still requires a valid **device token** (from the app or from a test registration) and does **not** replace Firebase Console for configuration.

1. **Get an access token** (Application Default Credentials; requires `https://www.googleapis.com/auth/firebase.messaging` or `cloud-platform`):

   ```bash
   gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform
   export FCM_TOKEN=$(gcloud auth application-default print-access-token)
   ```

2. **Send one message** (replace `PROJECT_ID` and `DEVICE_REGISTRATION_TOKEN`):

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $FCM_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "message": {
         "token": "DEVICE_REGISTRATION_TOKEN",
         "data": { "type": "consent_request", "request_id": "test-123" },
         "notification": {
           "title": "Consent request",
           "body": "Test from gcloud + curl"
         }
       }
     }' \
     "https://fcm.googleapis.com/v1/projects/PROJECT_ID/messages:send"
   ```

The **device registration token** must come from the client (web app’s `getToken()` or a mobile app). There is no gcloud command to generate or list device tokens; they are created by the Firebase client SDKs when the app runs.

---

## Summary

| Question | Answer |
|----------|--------|
| Can consent push be done **directly with gcloud CLI**? | **No.** FCM requires Firebase Console (VAPID, project/config) and application code (Firebase Admin SDK + client SDK) for production. |
| What **is** gcloud used for? | Enabling APIs, storing `FIREBASE_ADMIN_CREDENTIALS_JSON` in Secret Manager, deploying services. Optionally getting an OAuth token to send a **test** message via FCM HTTP v1 with `curl`. |
| Where is the VAPID key set? | **Firebase Console** → Project Settings → Cloud Messaging → Web configuration → Key pair. Set in frontend as `NEXT_PUBLIC_FIREBASE_VAPID_KEY`. |
| Where is the service account JSON set? | **Firebase Console** → Project Settings → Service accounts → Generate key. Store in **GCP Secret Manager** and inject into the backend (see [env-vars.md](./env-vars.md)). |

See also: [env-vars.md](./env-vars.md), [consent-protocol.md](./consent-protocol.md).
