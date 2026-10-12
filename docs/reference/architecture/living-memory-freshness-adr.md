# ADR: Continuous living memory and an owner-controlled always-on runtime

Status: **V1 Markdown memory implemented for One chat; locked and closed-app operation remains unimplemented.**
Updated: 2026-10-11.

## Visual Map

```mermaid
flowchart LR
  Legacy[Existing encrypted PKM domains] -->|first-session compatibility seed| Client[Open unlocked owner client]
  Client --> Memory[Canonical One memory.md]
  Memory --> Prompt[Whole file in every One prompt]
  Client -->|AES-GCM encrypted write| Backend[Backend stores ciphertext only]
  Device[Proposed owner-operated always-on device] -. reviewed local key control .-> Memory
```

Solid arrows describe the implemented unlocked V1 flow. The dotted device path is a proposal requiring separate owner review and implementation. The existing PKM encryption and optimistic-write coordinator remain the persistence boundary; V1 does not introduce a second cryptosystem.

## Current boundary

For One chat, `one_memory.markdown` is the V1 memory authority. It is one Markdown document inside one client-encrypted PKM domain. The backend stores ciphertext and never receives the vault key. Unlock decrypts the document into process memory, every One turn receives the whole document as private context, and chat memory capture rewrites the encrypted document through the existing conflict-aware coordinator. Vault teardown clears the plaintext session copy and fences late publication.

Existing structured PKM domains remain compatibility sources for Finance, KYC, Consent, and other specialist workflows. When an owner has no `one_memory` document yet, the unlocked client renders the existing agent-safe PKM packet into a session-only Markdown seed. The first authorized memory write persists that seed plus the new facts atomically. This preserves existing information without making a background unlock look like owner confirmation. One chat reads the Markdown authority after that first write; specialist contracts continue to use their current stores until separately migrated.

Chat facts are selected by the existing semantic preparation stage using `soul_markdown_v1`, then silently applied to the RAM document and encrypted through the existing writer. The model supplies a plain attributed bullet and section; corrections/extensions replace an exact offered bullet, and deletions remove it rather than saving the request. No legacy domains are imported. This V1 path has no per-fact confirmation card or automatic-memory switch: while the vault is unlocked, usable durable facts use the product-default authorization record and no capture status is added to chat. Owner identifiers may be retained; passwords, passphrases, API keys, tokens, private keys, PINs and card security codes are omitted. The whole document is bounded to 18,000 characters; reconciliation offers at most 256 bullets without silent truncation.

Target references exist only in the preparation snapshot and encrypted recovery envelope, never as paths or IDs inside Soul.md. Stale, duplicate or unoffered targets fail closed. Automatic replacement refuses masked targets; multiline/nested owner-authored bullets need the editor rather than partial mutation. Unrelated text and fenced examples remain unchanged. Encrypted recovery envelopes carry their staging order, so interrupted dependent corrections replay FIFO even when device keys or encryption finish out of order. If any envelope cannot be read, recovery waits rather than replaying a later correction first.

The implemented bridge runs while the owner's application is open and unlocked. It observes owner-scoped PKM commits, Profile identity changes, Consent changes, and connectivity/focus recovery, and verifies remote Profile/Consent sources every minute. Queued metadata or rebuilding on the next unlock does **not** satisfy 24/7 updates. No automatic answering runs in this bridge.

## Coverage and authority audit

| Source | Existing authority and update seam | Derived memory behavior |
| --- | --- | --- |
| Profile name, email and photo | Firebase-backed AccountIdentityService, including effective owner edits | Complete encrypted private source projection, stable owner source ID, observed revisions and source timestamps |
| Consent | Existing received/sent pending, active and previous Consent Center projections | Uncached complete reads, all pages and durable terminal Location requests/invitations; non-authority source IDs, activity/status/revocation/expiry; failed or racing reads preserve prior records and disclose incomplete inventory |
| Saved Location and visit notes | Existing encrypted Location PKM writers | Stable source IDs, original creation time when known, revision receipts and deletion tombstones; every persisted note retained |
| To-Do | Existing encrypted one_todos private tasks | Creation/edit/completion/deletion, source ID and record revision; stale completion cannot overwrite an edit or revive a deletion |
| Memory and eligible specialist sources | Existing encrypted domains remain compatibility inputs | First authorized V1 write carries the decrypted agent-safe view into `one_memory.markdown`; later One prompts use that Markdown authority |
| Chat with One | Semantic fact selection plus the encrypted Markdown writer | Explicit and eligible automatic facts create/update/delete flat bullets in one document; credentials are omitted, while owner identifiers may be retained |

The Consent inventory uses a bounded owner-scoped MVCC equality fence before and after two complete scans. It detects row changes, delete/recreate and effective expiry while paging; it is not a durable owner revision. Reads never settle expiry or modify grants. UI flags and presentation grouping cannot silently remove source records. Authority tokens and provider payloads are excluded from the source projection. Exact private PKM keys survive segmented encrypted storage/readback; neither storage-ID normalization nor a summary may replace the authored complete records.

A mirrored inventory is derived, encrypted and owner-only. It cannot create grants or exports and cannot run an implicit PKM upgrade. Failed reads never imply deletion. Known source times are retained; unknown original creation time stays unknown. The source's content revision remains the canonical concurrency boundary. This does not claim that every historical Chat fact has been captured: the existing capture coverage and save receipts determine what reached PKM.

## Concrete proposed runtime

Use an **owner-operated device** that stays powered on: a supported desktop or small home computer running a dedicated, signed Node 24 runtime. It uses the existing identity, consent, encrypted PKM read/write, manifest and revision contracts. It has no independent semantic router or second PKM authority. This design is proposed for review; no daemon, enrollment or persistent key capability ships in this PR.

1. The owner pairs the runtime from an unlocked client. The client verifies the device public key and a pairing challenge, shows its allowed sources and write operations, and issues an owner-scoped, revocable device credential. Enrollment is separate from answer-composition consent.
2. The owner must explicitly review a **new local key-control exception**: a decryption capability sealed by the device's TPM or Secure Enclave to its measured runtime and local OS account. Hussh receives neither that capability nor its wrapping key. Initial unsealing requires the owner on the device. A machine reboot cannot resume processing until its reviewed local unlock policy permits unsealing. Without this exception, memory keys remain RAM-only and reboot requires owner unlock.
3. The daemon retrieves ciphertext plus committed source metadata. It decrypts in owner-device RAM, verifies source identity/revision, and commits encrypted mutations through the existing compare-and-swap coordinator. Durable cursor/checkpoint state is encrypted on that device; plaintext source values, prompts, documents and keys are excluded from disk, telemetry, crash dumps and server logs.
4. Replay is idempotent by source ID and revision. Out-of-order updates cannot replace newer records. Deletions are revisioned tombstones. Checkpoints advance only after encrypted commit/readback. Conflicts trigger authoritative rereads. A restart replays the encrypted checkpoint before publishing a complete memory view.
5. The exact full view is rebuilt only after every eligible source is verified. Per-source failure, last successful refresh and disconnected runtime health are visible. Powered-off hardware or lost connectivity makes the view stale; no service may advertise continuous freshness merely because a worker or queue exists.
6. Revocation stops new reads/writes and clears RAM. Unpairing erases the locally sealed capability and device credential; a compromised-device response also rotates the owner's applicable keys and credentials. Recovery requires another owner-controlled device or owner recovery credentials, never a backend escrow path.

A purpose-derived HKDF key cannot decrypt existing PKM ciphertext. Restricting this daemon to a smaller decryption capability requires a separately reviewed content-key wrapping/rotation protocol; it cannot be asserted by deriving a differently named key. A hosted private runtime or third-party enclave would introduce different custody and attestation assumptions and is outside this proposal.

## Answer composition is separate

Both active connection categories can request an answer. The owner explicitly approves the question, exact scopes, price and model processing. While unlocked, the owner client prepares a readable Gemini answer and seals it to the requester; **Write answer** retries preparation if needed. Checkout requires a completed nonempty staged envelope. A verified Checkout event releases that envelope once. The requester opens the answer from Feed and unlocks their own vault when needed. Existing paid requests without an envelope still require owner unlock and preparation within the original deadline. The approved projection transits the backend and Google Vertex AI for one composition call; PKM decryption and requester-only encryption occur on the owner device. No vault key is transferred.

Request checkout returns use `answerPaymentRequestId` and the answer's own payment status, including delayed confirmation, cancellation and bounded retries. Historical `paymentRequestId` returns with `paid`/`cancelled` remain supported. Drive's `success`/`cancel` status handler, configuration and payment mode remain independent. A staged envelope is cancellable until release; a verified charge after cancellation or disconnection files the existing full-refund obligation without releasing the envelope. Feed milestones use migration 179's partial unique index for idempotency.

The operator-only `PkmAnswerPaymentService.recover_checkout_event` retrieves the actual Stripe Event and current Checkout Session with the configured answer-mode credentials. It requires exact request/session/attempt/terms/amount/currency/mode binding, then uses the same settlement transaction and replay guard as the signed webhook. PaymentIntent metadata, browser return parameters and HTTP 200 do not establish payment. Recovery cannot manufacture an unstaged answer or decrypt PKM.

The shared Profile Memory renderer now persists a source-linked `memory.md` projection inside the existing encrypted `one_living_sources._private.memory_document`. It preserves the complete inventory, record revisions, tombstones and structured source domains. The signature excludes the document's own write revision, so unchanged authoritative readback reuses the document without a write loop. Failed or incomplete reads cannot overwrite it. Name, photo reference and eligible explicitly recorded facts (including age and sex) retain source paths; no age or sex is inferred. Soul.md and `one_memory.markdown` keep their existing authority.

Paid answers use that renderer with their exact approved source projections, never the owner's whole private document. One coherent ciphertext/manifest read is reused per domain. Only approved source segments are decrypted, then exact eligible paths are projected. Encrypted projection caches are reusable only after current content/manifest revisions, exposure posture and ETag are checked; vault and PKM invalidation epochs reject in-flight stale work. Every question still receives its own existing Gemini composition. Local synthetic cold/warm preparation measurements and encrypted-cache regression coverage live in `answer-read-session.test.ts`; they do not measure deployed provider latency.

The composer flag defaults off. Live mode also requires the separate provider-review attestation. Application telemetry uses ADK NO_CONTENT and refuses processing if environment overrides would capture messages. This does not establish provider zero retention.

Google's [retention policy](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention) describes implicit memory caching up to 24 hours; [abuse monitoring](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring) can retain suspicious requests up to 90 days unless the applicable exemption is verified. [Request-response logging](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/request-response-logging) is separately configurable. The 2026-10-11 read-only probe of the exact UAT managed runtime confirmed implicit cache **enabled** in its separately billed project. Model logging probes returned 404 in global/us/eu, so logging and the contractual abuse-monitoring exemption remain **unverified**. The default-off composer and live-review gate must remain closed until those settings and the owner's disclosure are verified.

## Decision for owner review

Review whether an owner-operated always-on device with the explicit local hardware-sealed capability is acceptable, including reboot unlock and revocation behavior. Until that review and implementation are complete, the supported freshness claim is **continuous while open and unlocked**, with truthful offline and incomplete status. Automatic answering remains deferred regardless of the runtime decision.
