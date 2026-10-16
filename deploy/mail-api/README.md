# hushh-mail-api

Standalone Cloud Run service that sends Hushh email through Google Workspace.

## One OTP transport

Version 1.1 adds an optional One-only transport to the same `POST /v1/send` URL.
It requires `MAIL_ONE_DELEGATED_ENABLED=true`, a unique `MAIL_API_KEY_ONE`, and a
short-lived `gmail.send` bearer in `x-one-gmail-access-token`. The backend obtains
that authority from its existing One credential source; no private key moves to
this service. The bearer must never be logged, returned, persisted or accepted
from browser code. Prior deployed source provenance is in `source-provenance.json`.

The exact JSON fields are `transport: "one-delegated"`, one plain `to` address,
six-digit `code`, integer `expiresInSeconds` from 15 to 300, and an
`email-otp:<opaque challenge>` idempotency key. The service constructs the fixed
message and uses the fixed Gmail mailbox/From/Reply-To `one@hushh.ai`. Extra
recipients, attachments, caller HTML and sender overrides are rejected. Failure
never falls back to the existing SMTP sender. The caller owns current domain
admission; a token or successful API call is not proof of domain review.

Run `npm ci --ignore-scripts` and `npm test`. Core web CI runs these tests and is
scheduled by changes here. `deploy.sh` creates a candidate only after explicit
production authority, preserving IAM, secrets and runtime configuration. Verify
and promote separately, recording the prior revision for rollback. Historical
first-time setup commands below must not replace current bindings.

Built to the same shape as `hushh-wallet-api`: one service, one API key per
consuming project, no origin allowlist, credentials bound from Secret Manager
and never exposed to a browser. Any Hushh project can send an invitation with
one HTTP call and no mail code of its own.

| | |
|---|---|
| Service | `hushh-mail-api` · `hushh-tech-prod` · `us-central1` |
| Transport | Google Workspace Gmail SMTP (`smtp.gmail.com:465`, App Password) |
| Auth | `x-api-key: <key>` or `Authorization: Bearer <key>` |
| Source | `deploy/mail-api/` |
| Deploy | `MAIL_API_APPROVED_PRODUCTION=1 MAIL_API_REVISION_SUFFIX=<reviewed suffix> bash deploy/mail-api/deploy.sh` (candidate only) |

---

## Routes

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | no | Health and configuration status. Booleans and counts only. |
| `GET` | `/v1/templates` | yes | Registered templates, their required fields and options. |
| `POST` | `/v1/send` | yes | Render a template (or take raw HTML) and send it. |

### `POST /v1/send`

```jsonc
{
  "to": "invitee@example.com",        // string | string[] | [{email, name}]
  "cc": [], "bcc": [], "replyTo": "",

  "template": "invitation",            // registered template id...
  "data": { "actionUrl": "https://hushhtech.com/invite/abc" },

  // ...OR bring your own markup instead of `template`/`data`:
  // "subject": "...", "html": "<p>…</p>", "text": "…",

  "from": { "name": "Hushh Invites", "email": "invites@hushh.ai" },
  "attachments": [{ "filename": "brief.pdf", "content": "<base64>", "contentType": "application/pdf" }],

  "idempotencyKey": "invite-42",       // a retry with the same key will not send twice
  "dryRun": false                      // true renders and returns the HTML without sending
}
```

Success:

```json
{
  "success": true,
  "messageId": "<...@hushh.ai>",
  "template": "invitation",
  "subject": "Ankit invited you to Hushh",
  "consumer": "hushhtech",
  "accepted": ["invitee@example.com"],
  "rejected": []
}
```

| Status | Meaning |
|---|---|
| `400` | Invalid payload — bad recipient, unknown template, missing required field |
| `401` | Missing or wrong API key |
| `413` | Body over 20 MB |
| `429` | Per-key rate limit; honour `Retry-After` |
| `502` | Well-formed request, SMTP hop failed |
| `503` | Service is unconfigured (no API key, or no Workspace credentials) — fails closed |

---

## Templates

`GET /v1/templates` is the live contract; this table is orientation.

| id | Required | For |
|---|---|---|
| `invitation` | `actionUrl` | Invite someone to join, attend, or accept access |
| `notification` | `heading` | Generic branded notification with optional CTA |
| `verification` | `code` | One-time code / confirm-your-email |

Anything the registry does not cover: send `subject` + `html` directly. You keep
full control of the markup and still get the Workspace transport, the key model,
idempotency, and rate limiting.

### Adding a template

1. Create `src/templates/<id>.js` exporting
   `{ id, description, required, fields, build(data) }`, where `build` returns
   `{ subject, html, text }`. Compose the shell with `buildEmailShell()` from
   `src/templates/layout.js` to inherit the Gmail-safe chrome.
2. Register it in `src/templates/index.js`.
3. Redeploy. `GET /v1/templates` picks it up automatically.

Templates render **Gmail-safe** HTML: table layout with `bgcolor` attributes,
inline styles only, no webfonts, no `<style>` block — the same rules the
existing `cloud-run/email-template-api` templates follow. All caller-supplied
data is HTML-escaped, and every URL is scheme-checked, so a `javascript:` link
can never reach a rendered email.

---

## Integrating from another project

You need two things: the service URL and your own API key. Nothing else — no
registration, no origin allowlist entry, no change to this service.

**curl**

```bash
curl -sS -X POST "$MAIL_API_ENDPOINT/v1/send" \
  -H "x-api-key: $MAIL_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "to": "invitee@example.com",
    "template": "invitation",
    "data": {
      "inviteeName": "Ada Lovelace",
      "inviterName": "Ankit Kumar Singh",
      "organizationName": "Hushh Fund A",
      "role": "Limited Partner",
      "actionUrl": "https://hushhtech.com/invite/abc123",
      "expiresAt": "August 20, 2026"
    }
  }'
```

**Node** — copy `api/lib/mailClient.js` from the website repo:

```js
import { sendInvitation } from "./lib/mailClient.js";

await sendInvitation("invitee@example.com", {
  inviterName: "Ankit Kumar Singh",
  organizationName: "Hushh Fund A",
  actionUrl: "https://hushhtech.com/invite/abc123",
});
```

**Python**

```python
import os, requests

requests.post(
    f"{os.environ['MAIL_API_ENDPOINT']}/v1/send",
    headers={"x-api-key": os.environ["MAIL_API_KEY"]},
    json={
        "to": "invitee@example.com",
        "template": "invitation",
        "data": {"actionUrl": "https://hushhtech.com/invite/abc123"},
    },
    timeout=15,
).raise_for_status()
```

Build the template first with `"dryRun": true` — it returns the rendered subject
and HTML without sending and without consuming rate limit or Workspace quota.

> **Never call this from a browser.** The key must stay server-side. A
> browser-reachable passthrough would be an open mail relay sending as Hushh
> with our SPF and DKIM on it. See the header comment in `api/lib/mailClient.js`.

---

## Onboarding a new consumer

The service accepts **every** `MAIL_API_KEY*` environment variable, so each
project gets a key bound independently. Revoking one never affects the others.

```bash
PROJECT=hushh-tech-prod
CONSUMER=newproject                      # lowercase, no underscores

# 1. Mint a 256-bit key and store it. The value is never printed.
openssl rand -base64 32 | tr -d '\n' \
  | gcloud secrets create "hushh-mail-api-key-${CONSUMER}" \
      --project="$PROJECT" --data-file=- --replication-policy=automatic

# 2. Let the runtime service account read it.
gcloud secrets add-iam-policy-binding "hushh-mail-api-key-${CONSUMER}" \
  --project="$PROJECT" \
  --member="serviceAccount:hushh-mail-api@${PROJECT}.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor

# 3. Bind it as MAIL_API_KEY_<CONSUMER>. No code change, no image rebuild.
gcloud run services update hushh-mail-api \
  --project="$PROJECT" --region=us-central1 \
  --update-secrets="MAIL_API_KEY_$(echo "$CONSUMER" | tr '[:lower:]-' '[:upper:]_')=hushh-mail-api-key-${CONSUMER}:latest"
```

Hand the consuming project its key value out of band, and have them store it in
their own secret manager. `deploy.sh` picks up extra consumers automatically:

```bash
MAIL_API_KEY_CONSUMERS="hushhtech newproject" bash cloud-run/hushh-mail-api/deploy.sh
```

To revoke one consumer, remove that one binding — everyone else keeps working:

```bash
gcloud run services update hushh-mail-api --project="$PROJECT" --region=us-central1 \
  --remove-secrets=MAIL_API_KEY_NEWPROJECT
```

---

## First-time setup

```bash
PROJECT=hushh-tech-prod
REGION=us-central1

# Runtime service account — dedicated, not the default compute SA.
gcloud iam service-accounts create hushh-mail-api \
  --project="$PROJECT" --display-name="Hushh Mail API runtime"

# The Workspace sender secrets already exist for the website. Grant read access.
for secret in hushh-tech-gmail-user hushh-tech-gmail-app-password; do
  gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT" \
    --member="serviceAccount:hushh-mail-api@${PROJECT}.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done

# Default consumer key.
openssl rand -base64 32 | tr -d '\n' \
  | gcloud secrets create hushh-mail-api-key --project="$PROJECT" \
      --data-file=- --replication-policy=automatic
gcloud secrets add-iam-policy-binding hushh-mail-api-key --project="$PROJECT" \
  --member="serviceAccount:hushh-mail-api@${PROJECT}.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor

bash cloud-run/hushh-mail-api/deploy.sh
```

---

## Configuration

| Variable | Source | Required | Purpose |
|---|---|---|---|
| `GMAIL_USER` | secret `hushh-tech-gmail-user` | yes | Workspace account that authenticates to SMTP |
| `GMAIL_APP_PASSWORD` | secret `hushh-tech-gmail-app-password` | yes | App Password for that account |
| `MAIL_API_KEY` | secret `hushh-mail-api-key` | yes | Default consumer key |
| `MAIL_API_KEY_*` | secret per consumer | no | One key per project |
| `MAIL_ALLOWED_FROM` | env | no | Comma-separated verified "Send mail as" aliases |
| `MAIL_DEFAULT_FROM_NAME` | env | no | Display name. Default `Hushh` |
| `MAIL_DEFAULT_REPLY_TO` | env | no | Reply-To when a caller does not set one |
| `MAIL_RATE_LIMIT_PER_MINUTE` | env | no | Recipients per key per minute. Default `60` |

### Google Workspace specifics

These are the constraints that shape the transport — worth knowing before
changing anything:

1. **App Password, not OAuth.** Requires 2-Step Verification on the Workspace
   account; issued at <https://myaccount.google.com/apppasswords>. It bypasses
   OAuth entirely, which is exactly why it must never reach a browser.
2. **Gmail rewrites the From header** to the authenticated user unless the
   address is a verified *Send mail as* alias on that account. The service
   therefore only honours `from` addresses in `MAIL_ALLOWED_FROM`; anything else
   falls back to `GMAIL_USER` and the response carries a `warnings` entry saying
   so. Add the alias in Gmail → Settings → Accounts → *Send mail as* first, then
   to `MAIL_ALLOWED_FROM`.
3. **Daily send cap.** Workspace allows ~2,000 messages/day per account, counted
   **per recipient**. The rate limiter is a burst guard, not a quota manager — a
   high-volume campaign needs a dedicated sender account or a bulk provider, not
   this service.
4. **`service: "gmail"`** in nodemailer resolves to exactly `smtp.gmail.com:465`
   over implicit TLS. This service states host and port explicitly instead.

### Rate limiting caveat

The limiter and the idempotency store are **per instance and in memory**. With
`--max-instances=10` the effective ceiling is up to ten times
`MAIL_RATE_LIMIT_PER_MINUTE`, and an idempotency key only de-duplicates against
the instance that served the first request. Both are real backstops against a
runaway loop — the failure mode that actually burns the Workspace daily quota —
but neither is a strict global guarantee. Making them exact needs shared state
(Redis or Firestore), which is deliberately not a dependency today.

---

## Local development

```bash
cd cloud-run/hushh-mail-api
npm install

GMAIL_USER=you@hushh.ai \
GMAIL_APP_PASSWORD='your-app-password' \
MAIL_API_KEY="$(openssl rand -base64 32)" \
npm run dev
```

Then, without sending anything real:

```bash
curl -sS -X POST localhost:8080/v1/send \
  -H "x-api-key: $MAIL_API_KEY" -H 'content-type: application/json' \
  -d '{"to":"me@example.com","template":"invitation",
       "data":{"actionUrl":"https://hushhtech.com/invite/x"},"dryRun":true}' \
  | jq -r .html > /tmp/preview.html && open /tmp/preview.html
```

## Tests

```bash
npm test    # node --test, no network, fake SMTP transport
```

Covers the auth matrix (missing / wrong / `x-api-key` / `Bearer` / per-consumer
keys / fails-closed-when-unconfigured), template rendering and escaping, the
`javascript:` URL rejection, From-header rewriting, dry run, idempotency,
recipient and attachment validation, and the 429 path.
