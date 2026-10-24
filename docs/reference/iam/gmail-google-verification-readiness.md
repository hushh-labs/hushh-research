# Gmail Google Verification Readiness

> **Status:** updated source and live evidence on 2026-10-24; earlier checkpoints
> below are historical. This is a short engineering
> gap assessment, not a Google approval decision, legal advice, or a CASA report.

## Visual Context

This is a Gmail-specific readiness note under the [IAM reference](./README.md).

## Bottom line

Hussh uses Google restricted Gmail access and may retain historical Gmail-derived
receipt records. Current source disables new writes to the legacy receipt cache;
that does not prove historical records have been purged. The application is not ready to claim
Google verification readiness until the confirmed product gaps below are closed
and the Google Cloud Console submission, privacy policy, and any required CASA
assessment are independently verified.

Google classifies `gmail.readonly` as restricted and `gmail.send` as sensitive.
Google says server storage or transmission of restricted-scope information
requires a security assessment. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

## Implementation status and remaining gaps

| Priority | Current evidence | Why it matters | Smallest next step |
| --- | --- | --- | --- |
| Shipped in this working tree | The backend base/read purpose requests `openid`, `email`, `profile` and `gmail.readonly`. Explicit `send`, `compose` and `modify` purposes add their respective scope; the web Connectors and Mail entries now default to `read`; explicit sending/draft/management upgrades remain separate. The HMAC-bound connection records the returned grant. | Requested permissions depend on the invoking feature. Existing read-only grants need incremental consent before sending; native purpose parity must be checked independently. | Keep draft and mailbox-management permissions out of the initial read flow. Confirm each enabled purpose against Console submission and its user-facing demonstration; do not infer the submitted scope list from code. |
| P0 | Legacy `kai_gmail_receipts` rows contain message IDs, subject, snippet, sender details and purchase fields. Current source gates receipt upserts with `receipt_storage_writes_enabled()`, which is false. | Disabled new writes do not establish that historical server records were removed. Google requires transparent disclosure, secure handling and deletion. | Verify deployed write behavior and historical retention/purge evidence; distinguish private saved memories and encrypted device snapshots. |
| Shipped in this working tree | Disconnect first disables the connection, cancels active syncs, revokes the refresh token, deletes `kai_gmail_receipts`, `kai_receipt_memory_artifacts`, and sync-run records, and clears browser receipt cache. | A disconnect is now a clear deletion action for provider-derived receipt data. Explicitly saved private-memory records remain outside this deletion boundary. | Verify this against the deployed database and update the live privacy policy and deletion-help text before submitting review material. |
| Changed 2026-09-27 (pending founder and legal review) | The app now serves its own Privacy Policy and Terms of Use at `https://one.hushh.ai/privacy` and `https://one.hushh.ai/terms` from `hushh-webapp/lib/legal/legal-documents.ts`. The policy describes Gmail, Calendar and Drive access, stored receipt fields, disconnect, and model processing, and carries the Google API Services User Data Policy Limited Use statement. | Google requires a public privacy policy plus an in-context disclosure that explains Gmail information access, collection, use, sharing, and deletion. | Point the OAuth consent screen privacy and terms URLs at those pages once the text is approved. The standalone pre-OAuth disclosure with an affirmative continue action is still open. |
| P1 | Gmail-derived content can reach managed Gemini through the optional receipt fallback, inbox chat, and personal-Gmail KYC flows. | The exact deployed configuration and provider terms need separate confirmation, and user-facing disclosures must cover every enabled flow. | Inventory the flows, prove the provider configuration complies with Limited Use, add or document prompt-injection protection, and disclose the processing before consent. |
| P1 | Token encryption is implemented with AES-GCM, and disconnect revokes the refresh token. | These are positive controls, but they do not establish a complete restricted-scope security posture or assessment. | Preserve these controls and assemble evidence for encryption at rest, key management, access control, incident handling, and vulnerability management. |

## Domain and client verification checkpoint — 12 October 2026

The October 6 reviewer email for `hushh-pda` requested scope justification,
demonstrations, model-processing details and reviewer access. The October 12
Console read is newer evidence: homepage, branding, appropriate data access and
minimum scopes are marked complete. App functionality remains blocked by the
missing OAuth-consent walkthrough, insufficient feature demonstration and
working reviewer login. Privacy policy and additional requirements remain under
review. Preserve the accepted scope justifications; do not reopen them merely
because the older email lists deficiencies. These individual statuses are not
final application approval or an assigned/completed CASA assessment.

A background Console read confirms published branding still names `Hushh` and
`www.hushh.ai`; **Hussh** and `www.hussh.ai` are under review. `hussh.si` is listed
as an authorized domain, which alone does not prove domain ownership verification.
The domain cutover candidate prepares updated application policy addresses and
self-hosted Drive indexing disclosure; those changes are not claimed live here.

Current runtime receipts show Firebase ordinary sign-in and UAT/production
Gmail/Calendar share one retained OAuth client. Google's
[client guidance](https://support.google.com/cloud/answer/15549257)
requires separate client IDs for ordinary and agent workflows. Do not mark this
mixed client as agentic or replace credentials under existing refresh tokens.
Keep legacy grants bound to their original client during a controlled transition;
record new agent clients separately for each environment and verify their actual
callers. Agent classification does not grant scopes or constitute verification.

The inspected production Data Access page lists `openid`, `userinfo.email`,
`userinfo.profile`, `drive.file`, `drive`, `gmail.readonly` and `contacts.readonly`.
It does not list the current incremental Gmail send/compose/modify or Calendar
scopes. Reconcile those enabled purposes separately before claiming submission
coverage. A listed scope and a completed minimum-scope review do not themselves
prove final verification.

Drive selected-file access requests `drive.file`; optional live access requests
full `drive`. The owner elected to retain full Drive in the verification plan.
Demonstrate an enabled function that needs access beyond selected files; do not
promise unrestricted operations solely from the scope. Never broaden read-only
Gmail permissions or delete source mail to satisfy the older email's ambiguous
instruction to show a message “purged”.

Managed model processing uses Vertex ADC. Gemini Developer API BYOK also exists,
but no paid/no-training assurance has been established for arbitrary owner keys.
The enabled provider inventory, applicable terms and processing configuration
must be proved before asserting Limited Use compliance for every path. Providers
marked coming soon in the public catalog are not asserted as enabled merely
because their adapters exist.

## What must be checked outside this repository

These are required review inputs, but code inspection cannot confirm them:

1. **Google Cloud Console:** production/external publishing state, verified domains,
   redirect URIs, support contacts, homepage/terms/privacy URLs, and the exact
   submitted scopes.
2. **Reviewer package:** English walkthrough video, test account and reproducible
   reviewer path, feature-by-feature scope justification, and truthful explanation
   of all Gmail use cases. The current web route has authentication and vault
   prerequisites, so the reviewer instructions must cover those steps.
3. **Privacy and operations:** the live privacy policy, user-facing deletion help,
   retention jobs, subprocessor disclosures, production model configuration, and
   evidence that no Gmail-derived information is used to train a general model.
4. **CASA/security assessment:** confirm with Google or an authorized assessor
   whether the deployed restricted-scope use requires a Letter of Assessment,
   then complete the applicable assessment. Do not call the application
   "CASA compliant" before that external result exists.

## Suggested delivery order

1. Freeze the Gmail scope list and make it truthful in code, Console, and review material.
2. Ship the live Gmail-specific privacy-policy language, retention policy, and
   deletion help. The connection disclosure must describe the permissions
   requested by the invoking feature. Verify the publicly served application
   policy and the actual Console policy URL together, including retained domain
   aliases (source: `hushh-webapp/lib/legal/legal-documents.ts`). Do not assume a
   source URL change updates the Console submission.
3. Produce an evidence pack: data-flow diagram, scope-to-feature matrix, deletion
   proof, encryption/key-management evidence, access controls, incident response,
   vulnerability-management evidence, and reviewer recording.
4. Submit or resume Google verification only after a designated owner has checked
   the external items above.

## Policy anchors

- [Google Workspace user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy): minimum permissions, in-context disclosure immediately before consent, deletion help, Limited Use, encryption, prompt-injection protection, and restricted-scope security requirements.
- [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies): scope minimization and accurate OAuth configuration.
- [Google verification requirements](https://support.google.com/cloud/answer/13464321) and [security assessment guidance](https://support.google.com/cloud/answer/13465431): external review and assessment process.

## Evidence inspected

- `consent-protocol/hushh_mcp/services/gmail_receipts_service.py` — OAuth scope construction, AES-GCM token handling, disconnect behavior, optional Gemini fallback, and receipt writes.
- `consent-protocol/db/legacy/init_legacy_schema.sql` — `kai_gmail_receipts` stored fields.
- `hushh-webapp/components/gmail/gmail-receipts-page.tsx` — disconnect copy retaining receipts.
- `hushh-webapp/app/privacy/page.tsx` and `hushh-webapp/lib/legal/legal-documents.ts` — the served privacy policy.
- Native Gmail-auth plugins — the matching iOS and Android scope requests.

The workspace had in-progress Gmail-related changes during this review. This
document describes the current working tree, not a deployed release; recheck it
before a submission.

## OAuth closure candidate — 24 October 2026

Initial shared and private Gmail authorization is read-only in this candidate.
Explicit private management intent survives the phone handoff; a bare legacy
Gmail link never requests mailbox changes. Shared native reconnect reads current
owner status and retains previous send, compose and modify grants, including
reauthentication records with false capability flags. Provider readback still
owns upgrade success. This is source evidence, not a production deployment.

The production release inspected in this audit was
`904fbd215c661dd376a57ff712b11f12b9eec23c`. The initial 24 October Console
read showed seven scope entries. Ankit subsequently approved the complete
fifteen-scope union. All fifteen entries and the sensitive, Drive and Gmail
purpose explanations were saved in Google Cloud and independently verified
after reloading Data Access. The save confirmation updates the existing
verification request and may require prior information to be reviewed again.
This is submission alignment, not Google approval or a production deployment.
The dedicated reviewer rehearsal and replacement recording remain pending.

Across separate candidate connection purposes and transports, the authorization
union is fifteen scope URIs, not one authorization request. Eight additions to
the original Console inventory are: `gmail.send`, `gmail.compose`, `gmail.modify`,
`drive.readonly`, `calendar.events.readonly`, `calendar.freebusy`,
`calendar.calendarlist.readonly` and `calendar.events`, each prefixed with
`https://www.googleapis.com/auth/`. Private Drive requests the distinct
`drive.readonly` URI; listing full `drive` does not list that requested URI.
Private native Calendar initially requests event management and free/busy;
management is not universally an incremental upgrade. Shared Calendar retains
read/manage purposes with calendar-list access varying by transport. Existing
exact-owner Drive switches do not provide a general
verification staging gate for Calendar or optional Gmail writes. The expanded
submission does not authorize public rollout of unverified permissions. Use an
authorized staged reviewer environment for consent and source-account proof;
neither source changes nor the saved inventory establish Google approval.

Authenticated 24 October reads of managed Vertex project `hushh-gemini-bridge`
returned `retentionConfig.retentionType=DURABLE`. Publisher configuration for
`gemini-3.8-flash` at global, `gemini-live-2.5-flash-native-audio` at us-central1
and `gemini-embedding-001` at global returned 404: resources are absent, consistent
with default-off request/response logging, rather than explicit disabled flags.
Current Google guidance describes durable caching as encrypted, project-scoped
and deleted within 24 hours. Global caching has no single-region guarantee.
No-training does not mean no retention; abuse-monitoring exemption is unproved.

Arbitrary Gemini Developer API and Vertex API keys have no verified account-terms
admission. Billing, no-training eligibility and potential Express restrictions
must be established before a blanket Workspace-processing claim. History and
saved context can contain derived information; blocking only a fresh connector
read is insufficient. Two inspected receipt-fallback/ADK exception sinks now
emit error class only, without raw exception text or traceback. This bounded fix
is not an audit of every logging sink. No CASA Letter of Assessment was inspected.

Google reviewers need ordinary provider sign-in, completed onboarding, their own
vault and harmless test information. The internal review bridge is not that
login. Staged full Drive/indexing/sharing uses existing exact-UID
`CONNECTOR_PRODUCTION_OWNER_COHORT` plus feature switches. That admission never
grants Google permissions, vault access or private information. Do not activate
all-users rollout to provision one reviewer; rehearse the actual selected identity.

The operator approved blocking unverified Gemini-key processing for One on
24 October. The candidate removes BYOK from One’s hosted credential policy and
refuses Gemini key transports at the resolved private inference target (including sealed selections, commands and Memory proposals), shared/private text-model construction
boundary before model creation, history replay or tool dispatch. Key-based Live model
construction is refused too. Both Developer
API and unknown Vertex API keys are rejected. This does not silently route an
owner key request through Hussh credentials. Existing standard workload ADC
processing is retained; other provider products are not newly certified by this
restriction. Runtime/deployment acceptance remains separate from source tests.

One-owned native and regional model construction now share that admission,
including profile/world-model research, default specialist models, Files
foreground analysis and Live. Generic model factories and synthetic credential
probes remain separate. Files background organization already independently
requires ADC; passing a probe never authorizes owner-context processing.

The candidate privacy policy v2.12 requires explicit prior consent for merger, acquisition or asset-sale transfers of Google information. This wording is not deployed yet.
