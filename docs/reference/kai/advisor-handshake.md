# Finance advisor introductions

## Visual Map

```mermaid
flowchart LR
  Analysis[Portfolio Analysis] --> Agent[Inline private agent review]
  Analysis --> Choose[Choose a verified advisor]
  Choose --> Approve[Approve connection and sealed Finance snapshot]
  Approve --> Pending[RIA Clients request inbox]
  Pending --> Accept[Accept on the existing or newly connected edge]
  Accept --> Workspace[Participant workspace and expiring snapshot]
  Workspace --> Agree[Agree on an introduction time]
  Agree --> Calendar[Book the exact authorized offer or confirm a client proposal]
  Calendar --> Plan[Advisor offers monthly price and terms]
  Plan --> Checkout[Owner approves Stripe test checkout]
  Checkout --> Readback[Signed event and provider reconciliation]
```

## Product boundaries

Portfolio Analysis shows charts from the saved portfolio and the active
investing persona below Net Worth Score. Enabling automatic review approves a
bounded portfolio summary for model processing in the current visible vault
session. The review refreshes on saved changes to the approved source and reuses
results for matching inputs. Owners can turn it off from Analysis. The four
onboarding answers can support a Snapshot score when the portfolio and planning
inputs are sufficient. The optional 13-question refinement updates the active
persona and planning inputs.

An introduction uses one explicit approval for a connection and a full saved
Finance snapshot. It contains holdings, values, quantities and cost basis when
available, cash, allocation, saved balance history and available investment
preferences. Missing goals or preferences are shown as unavailable. It contains
no unrelated documents, transactions, account identifiers, credentials or keys.
The snapshot is encrypted separately for the owner and advisor using the existing
recipient-key system. Only ciphertext crosses the Finance request endpoint.

The pending recipient sees the sender and introduction, not the snapshot.
Verified RIA acceptance reuses the active canonical connection. If a connection
is needed, acceptance activates it with its legacy mirrors. The reference-only
message and snapshot release share the same transaction. It does not grant
trading, model-processing, Circle membership or any other data scope. Decline or
withdraw removes the ciphertext. Repeated requests reuse the exact immutable
request id; one pending or accepted workspace per owner/advisor pair prevents
duplicates. A definite refusal requires a fresh approval; uncertain responses
retry the same request.

## Access and discovery

Requests expire seven days after creation. Acceptance retains that original
snapshot deadline. Snapshot expiry does not erase the meeting/subscription
workspace. Every snapshot read rechecks participant, verified advisor, active
connection, block status, current key and server deadline. Disconnection or block
stops snapshot access permanently; reconnecting cannot revive it. The browser
clears decrypted content on expiry, visibility/session changes and failed access
checks. Account erasure removes either participant's request.

Discovery reuses the existing public advisor directory for postal-code or current
location searches, then matches exact CRD identities to discoverable, verified
platform advisors. Public records without an eligible in-app identity cannot
receive a request. Keyless advisors are shown as unavailable until they unlock
One. Location is sent in a private POST body, never in a route or persisted search.
The directory can return no matches, approximate coverage or a provider failure;
postal-code search remains available after location permission refusal.

## Calendar and missing setup

Either participant can propose a time. An advisor with Calendar scheduling
permission can authorize automatic booking of an exact offer for up to 24 hours.
A client's unchanged acceptance claims that offer once and verifies the advisor's
placement, verified invitee, active connection, expiry and original Calendar grant
before Google receives the create request. An expired or unapproved offer uses the
manual booking review. The advisor reviews and explicitly confirms a client
proposal. A counterproposal replaces the active offer and its authority.

Both participants see their own Calendar connection and the same meeting layout.
A client can receive an email invitation and join without connecting Calendar.
An uncertain create can be retried with its original event ID after read-back.
A previously confirmed event that is missing loses its Join action. Calendar
reconciliation checks the original grant and only saves against the observed
meeting state.

After the confirmed end time either participant can schedule another meeting.
Past meetings remain in the workspace. The advisor can mark the original
introduction complete after its end, including after a follow-up is proposed.
A meeting is optional. The advisor plan is available once the review is accepted, with or without a meeting.

## Advisor offers and one-time payments

Once the review is accepted, the advisor sets a one-time USD price. Service details
and cancellation terms are optional. The advisor must finish sandbox payout setup in Plan
before offering a plan. The owner reviews the exact revision and explicitly
approves the payment before Checkout. An uncertain checkout reuses its reserved
attempt and Stripe idempotency key. A new attempt requires provider-confirmed
expiry. An additional purchase requires a new offer revision and client approval.

UAT reads `RIA_STRIPE_TEST_SECRET_KEY` and `RIA_STRIPE_TEST_WEBHOOK_SECRET` from
Secret Manager in `hushh-pda-uat`. Grant the backend runtime identity secret
accessor on those two resources. Use a test key from the platform that owns the
advisor's existing sandbox Connect account. Register `checkout.session.completed`,
`checkout.session.expired` and `charge.refunded` events at
`/api/payments/advisor/stripe/webhook`.

Stripe returns both roles to Plan. Provider reconciliation verifies the offer
revision, price, destination and captured test charge. The client sees the
amount and date once payment clears. The advisor's latest sandbox bank payout
is an account-level status. Existing monthly subscription records remain
available for readback and cancellation.

Deletion queues known open checkouts and retained subscription references in the
provider-only cleanup outbox. After the API revision is serving in UAT,
configure the `ria-sandbox-cleanup-uat` Cloud Scheduler job to POST every five
minutes to `https://api.uat.hushh.ai/api/payments/advisor/stripe/cleanup`.
Use that exact URL as its OIDC audience and the dedicated
`ria-sandbox-cleanup@hushh-pda-uat.iam.gserviceaccount.com` identity. Uncertain
cleanup remains queued until Stripe confirms the provider state.

## Schema, rollout and verification

Migration `447_finance_advisor_handshake.sql` adds the participant request,
test-subscription and provider-cleanup tables with service-only RLS, immutable
approval fields, disconnect/block triggers and account-deletion fences. Its
schema projections are generated by
`consent-protocol/scripts/generate_advisor_review_schema_contracts.py` and checked
with `--check`. The rollback refuses outstanding active or unreconciled billing;
reconcile provider resources before dropping the feature tables.
`456_finance_advisor_one_time_payment.sql` preserves payment state per offer
revision and queues open Checkout sessions on erasure. Keep that additive
schema when rolling back the app with paid or unsettled payment records.

Focused tests cover approval, pending confidentiality, participant/placement
authority, retry binding, Calendar recovery, payment evidence and responsive
phone/desktop controls. PostgreSQL tests cover atomic accept/connection/message,
concurrent decisions, replay, disconnect and erasure. They require an isolated
`ONE_COMMAND_TEST_DATABASE_URL`. Synthetic browser fixtures do not establish
authenticated two-account, Google Calendar, Stripe webhook or deployed acceptance.
This work adds no Live Memory source: Finance content and consent/share artifacts
remain excluded from automatic memory ingestion.
