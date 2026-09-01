# Personal Gmail Information Requests

This is the Email Agent capability for a person's connected Gmail account. It
is distinct from both receipt sync and the `one@hushh.ai` platform-mailbox KYC
workflow.

## Visual Context

Canonical visual owner: [Hussh Platform Architecture](./architecture.md). This
diagram narrows the owner-consent and source-bound reply flow beneath that
platform map.

```mermaid
flowchart LR
  optin["Owner enables monitor"] --> scan["Bounded Gmail scan"]
  scan --> classify["Transient classification"]
  classify --> queue["Metadata-only review queue"]
  queue --> local["Unlocked client creates draft"]
  local --> approve["Owner reviews and approves"]
  approve --> reply["Source-bound Gmail reply"]
```

## Current delivery slice

1. An owner explicitly enables monitoring from the Gmail workspace.
2. A separate scheduled monitor (or the owner's bounded refresh) reads recent
   inbox messages through the existing Gmail connection.
3. Gemini classifies messages transiently as possible personal-information or
   KYC requests. It receives only the opted-in email during classification and
   must return field labels and domains, never extracted values.
4. The workflow persists only provider identifiers, timestamps, classifier
   confidence, requested field labels, exact manifest-leaf scope handles and
   segment identifiers, attachment-presence metadata, and keyed fingerprints.
   A separate keyed scan state prevents unchanged messages from being
   reclassified. All workflow and scan state metadata expire after 30 days. It
   retains no email subject, body, address, attachment content, PKM value,
   decrypted export, or draft.
5. The Gmail workspace presents the opt-in copy and a metadata-only review
   queue. The owner selects only exact manifest-backed leaf scope handles;
   wildcard, domain, and subtree scopes are never eligible for automatic
   drafting. The unlocked client reads only the explicit encrypted segments,
   projects only the selected paths, and creates a deterministic editable draft
   in memory. Attachment content is never read automatically; the owner must
   inspect it in Gmail. Opening an original message always goes back to Gmail.
6. The backend derives the reply recipient, subject, reply headers, and thread
   id from the original message for both prepare and final send. It rechecks a
   keyed source fingerprint immediately before both actions. The owner reviews
   the exact draft, prepares a ten-minute confirmation action, then explicitly
   sends it.

`POST /api/one/email/information-requests/scan-enabled` is the maintenance
entrypoint for background runs. In hosted environments it accepts only a
signed Cloud Scheduler OIDC token with the configured audience and exact
service-account email. It claims a short Postgres lease, scans one bounded
Gmail page per owner, checkpoints the opaque provider cursor, and has an
independent scan state from the receipt worker. It must be invoked by the
platform scheduler; no receipt Pub/Sub watcher may be broadened to include
personal inbox messages.

The operator-owned UAT scheduler shape is
`deploy/gmail/setup_personal_information_request_monitor_scheduler.sh`. It
uses a dedicated OIDC service account and a bounded rotating `POST` job; it
does not share the `one@hushh.ai` watch-renewal token or change that mailbox's
scheduler.

## Consent boundary

Enabling the monitor authorizes only temporary classification of recent inbox
messages. It does **not** authorize a disclosure or a send. Before a draft is
created, the owner explicitly selects exact candidate leaf scopes; the
unlocked client reads only their declared PKM segments, projects only those
paths, and keeps the resulting draft in memory. The server never receives a
PKM value until the owner submits the edited body for the final source-bound
Gmail action. Turning monitoring off immediately deletes this monitor's queue
and scan metadata and prevents an in-flight classifier from inserting new
metadata.

Managed drafting that receives decrypted private values requires a distinct,
independently revocable `agent.email.disclose.llm` consent before it can be
enabled. This v1 deliberately uses a deterministic client-local draft instead.

## Compatibility

`/one/kyc` and `one@hushh.ai` remain live during migration. Their data lives
in `one_email_*` tables and must not be read from or written to by the personal
Gmail monitor. Receipt sync remains a purchase-memory feature and must not
call the personal-monitoring inbox read method.
