# Gmail Google Verification Readiness

> **Status:** source and Console review on 2026-10-12. This is a short engineering
> gap assessment, not a Google approval decision, legal advice, or a CASA report.

## Visual Context

This is a Gmail-specific readiness note under the [IAM reference](./README.md).

## Bottom line

Hussh currently uses Google restricted Gmail access and persists Gmail-derived
receipt records on its servers. The application is therefore not ready to claim
Google verification readiness until the confirmed product gaps below are closed
and the Google Cloud Console submission, privacy policy, and any required CASA
assessment are independently verified.

Google classifies `gmail.readonly` as restricted and `gmail.send` as sensitive.
Google says server storage or transmission of restricted-scope information
requires a security assessment. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

## Implementation status and remaining gaps

| Priority | Current evidence | Why it matters | Smallest next step |
| --- | --- | --- | --- |
| Shipped in this working tree | The backend base/read purpose requests `openid`, `email`, `profile` and `gmail.readonly`. Explicit `send`, `compose` and `modify` purposes add their respective scope; the current web Connectors entry defaults to `send`. The HMAC-bound connection records the returned grant. | Requested permissions depend on the invoking feature. Existing read-only grants need incremental consent before sending; native purpose parity must be checked independently. | Keep draft and mailbox-management permissions out of the initial read/send flow. Confirm each enabled purpose against Console submission and its user-facing demonstration; do not infer the submitted scope list from code. |
| P0 | `kai_gmail_receipts` stores Gmail message IDs, subject, snippet, sender name/email, and purchase fields. The receipt upsert writes those values. | This is durable server-side storage of Gmail-derived information, not an in-memory view. Google requires transparent disclosure, secure handling, and honoring deletion requests. | Define and implement a documented retention/deletion policy for raw receipt fields, including an automatic purge. |
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
