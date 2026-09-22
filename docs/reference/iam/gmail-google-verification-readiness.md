# Gmail Google Verification Readiness

> **Status:** implementation review on 2026-09-10. This is a short engineering
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
| Shipped in this working tree | New web, iOS, and Android receipt connections request `openid`, `email`, `profile`, and `gmail.readonly`; the HMAC-bound connect contract supports a separate `send` purpose. | A receipt connection no longer asks for sending permission. Existing grants can still retain previously approved scopes until the owner disconnects/revokes and reconnects. | Keep `gmail.send` disconnected from the receipt flow. Before exposing a send UI, make that UI call the separate `send` purpose and add its feature-specific disclosure and reviewer path. |
| P0 | `kai_gmail_receipts` stores Gmail message IDs, subject, snippet, sender name/email, and purchase fields. The receipt upsert writes those values. | This is durable server-side storage of Gmail-derived information, not an in-memory view. Google requires transparent disclosure, secure handling, and honoring deletion requests. | Define and implement a documented retention/deletion policy for raw receipt fields, including an automatic purge. |
| Shipped in this working tree | Disconnect first disables the connection, cancels active syncs, revokes the refresh token, deletes `kai_gmail_receipts`, `kai_receipt_memory_artifacts`, and sync-run records, and clears browser receipt cache. | A disconnect is now a clear deletion action for provider-derived receipt data. Explicitly saved private-memory records remain outside this deletion boundary. | Verify this against the deployed database and update the live privacy policy and deletion-help text before submitting review material. |
| P0 | The app embeds the external privacy policy at `https://www.hushh.ai/privacy`; this repository does not prove that policy contains Gmail-specific disclosures. | Google requires a public privacy policy plus an in-context disclosure that explains Gmail information access, collection, use, sharing, and deletion. | Update the live policy and add a standalone pre-OAuth disclosure with an affirmative continue action. Include Gmail receipt sync, inbox/search features, sending, retention, deletion, and third-party/AI processing where applicable. |
| P1 | Gmail-derived content can reach managed Gemini through the optional receipt fallback, inbox chat, and personal-Gmail KYC flows. | The exact deployed configuration and provider terms need separate confirmation, and user-facing disclosures must cover every enabled flow. | Inventory the flows, prove the provider configuration complies with Limited Use, add or document prompt-injection protection, and disclose the processing before consent. |
| P1 | Token encryption is implemented with AES-GCM, and disconnect revokes the refresh token. | These are positive controls, but they do not establish a complete restricted-scope security posture or assessment. | Preserve these controls and assemble evidence for encryption at rest, key management, access control, incident handling, and vulnerability management. |

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
   deletion help. The app now presents an immediate read-only/deletion disclosure
   on the Gmail connection surface, but repository code cannot publish the linked
   `https://www.hushh.ai/privacy` policy.
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
- `hushh-webapp/app/api/legal/[doc]/route.ts` — external privacy-policy endpoint.
- Native Gmail-auth plugins — the matching iOS and Android scope requests.

The workspace had in-progress Gmail-related changes during this review. This
document describes the current working tree, not a deployed release; recheck it
before a submission.
