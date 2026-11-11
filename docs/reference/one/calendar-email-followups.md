# Calendar email follow-ups contract

Status: implementation contract. The relevance, incremental-sync, reconciliation and card changes in this document are covered by the synthetic and frozen-clock checks below. It is not evidence of a deployed mailbox scan, a live model run, or notification delivery; those remain the release gates at the end.

## Visual Context

The [One reference index](./README.md) owns the surrounding product map. The Calendar Insights screenshots in the task are the layout reference; this document owns the narrower account, analysis, reminder, and review contract.

## Current owners and boundary

Calendar Insights already selects one verified Google account. The legacy personal Gmail connector owns one mailbox per person, while additional Calendar accounts have Calendar-only credentials. The Email agent already has a tool-free, source-checked analyzer, but its turn-local reads cap visible body text. The system push outbox already owns durable delivery intent and device retry. None of those existing contracts is a Calendar email follow-up monitor.

The feature extends these owners. It does not run the receipt sync, the personal-information-request monitor, Mail Chat, Calendar booking, or PKM writes on their behalf.

## Account and consent contract

1. Every request carries the authenticated owner and the selected Calendar `account_id`. The server resolves the selected account's current Google subject and Calendar grant generation. A client-supplied email address, account label, or Google URL is never an authority.
2. Gmail read permission is checked separately for that exact Google subject. For the default account, the existing personal Gmail read grant may be used only when its subject matches the selected Calendar account. Additional accounts need an explicit account-specific `gmail.readonly` OAuth grant attached to their existing encrypted Google credential, with a separate service-grant revision. Calendar permission alone never passes this check. There is no fallback to the default Mail account.
3. The Connect Mail action starts OAuth only after a click and binds the attempt to the selected account and owner. Callback publication verifies the same subject, the requested Gmail scope, the original Calendar account generation, and a current attempt. Grant loss or account replacement invalidates reads, previews, pending analysis, and due delivery.
4. Monitoring is an independent, default-off preference keyed by owner and account. Enabling requires an explicit action; the first scan always covers the most recent 30 days, which the card states. The chosen cutoff and user time zone are captured with the preference. Switching Calendar accounts neither enables nor changes another account's preference. Disabling stops scans and suppresses due reminders for that account. Revocation, disconnect, erasure, or owner deletion cancels pending work and hides protected rows.
5. Scan, detail, and mutation routes require Firebase owner identity; protected content and mutations also require a current `VAULT_OWNER` token. Background workers use their own OIDC/service authority and recheck the stored owner/account/Mail grant. They never inherit a browser token.

### One Google consent, with monitoring still off

Connecting the first Calendar account, or choosing Add account, opens Google directly: no checkbox, no "One more step" page and no Hussh permission dialog in between. One request covers Calendar, Google Meet files, Drive file details and Gmail (read and send), taken from the single set in `consent-protocol/hushh_mcp/services/google_calendar_authorization.py`. Every account gets the same request. Renewing a lapsed account never adds Mail.

Gmail permission is not monitoring. Mail is recorded for an account only when that attempt asked for it and Google's reply contains `gmail.readonly`: an additional account sets its own independent read grant in the same owner-locked publication, and the primary account's grant is recorded in the existing Mail connection by `calendar_mail_adoption.py`. That record starts no receipt sync, mailbox watch or scan, never replaces a mailbox that belongs to another Google account, never narrows permissions Mail already has, and reuses a valid grant without writing. A Gmail scope that merely rides along on an older credential, or a declined Gmail checkbox on Google's screen, leaves Mail off and Calendar connected.

Monitoring stays the independent, default-off preference above. After connecting, the account's Follow-ups card offers "Turn on" with the reminder preference (there is no look-back choice); because Mail is already allowed it asks Google for nothing. That click is the explicit, account-specific opt-in. Native sign-in and private-agent connections do not yet carry the Gmail scopes in one consent; they keep the card's "Allow email access" step. Whether `gmail.readonly` and `gmail.send` are listed and verified on the Google Cloud consent screen is Console state this repository cannot show; see [Gmail Google verification readiness](../iam/gmail-google-verification-readiness.md).

## Complete source read and semantic assessment

1. The opted-in scanner pages selected-mailbox conversations within the explicit historical window, excluding Spam and Trash. Page and thread cursors are sealed and bound to owner, account, grant generation, cutoff, and scan revision. A partial page does not advance the checkpoint past unread messages. The scanner has bounded work per invocation and resumes until coverage is complete; it does not impose a silent total-thread limit.
2. Each relevant message is fetched with Gmail `format=full`. The reader walks nested MIME parts and fetches separately stored readable body parts through the Gmail attachment endpoint. Filename-bearing file attachments are excluded. It normalizes plain text or safe HTML text without executing HTML, links, commands, or instructions from the sender. A provider error, unsupported or oversized part, missing text, or deadline marks coverage incomplete; it never produces a definitive empty result.
3. Complete readable text is divided into deterministic, bounded, offset-identified sections with overlap. Every byte of the normalized body, including the ending, belongs to at least one section. The analysis result records expected and completed section identities. Overlap duplicates are merged by validated source and evidence identity. A failed section leaves the conversation incomplete and prevents a new definitive reminder from it.
4. The existing Email agent runtime owns a new tool-free, typed extraction child. It returns turn-local request indices for distinct actions, deadlines, and proposed meetings, with the source message/thread reference, exact supporting excerpt, original due wording, parsed instant only when supported, responsibility, ambiguity reason, and same-thread update references. The server mints durable request IDs from the exact owner/account/message identity, validated global evidence span, kind, and a stable evidence discriminator. The host validates offered source IDs, excerpt membership, section offsets, chronology, schema, and time-zone format. It may reject malformed output; it does not replace a successful semantic decision with keywords or regexes.
5. A later message can correct, cancel, or complete one request without automatically changing its siblings. Unknown date, responsibility, duration, or time zone is labelled `needs_review`; the service does not invent urgency or a meeting event. Email content can propose a review item only. It cannot execute tools, send mail, book Calendar, or write Chat, Memory, or PKM.

## Calendar relevance (assessment version 4)

The extractor is told what a Calendar follow-up is. It returns, for every candidate, a relevance verdict (`actionable`, `informational` or `uncertain`), a Calendar category (`meeting_request`, `schedule_change`, `document_or_information`, `deliverable_deadline`, `response_needed` or `assigned_task`), who asked, a short reason grounded in the quoted text, and optional urgency and meeting state. The host admits a candidate only when the verdict is explicitly `actionable`, the category is allowed, evidence exists, and responsibility does not belong to someone else. `uncertain` is deliberately kept off the owner's list. The authored assessment now asks for consequential professional commitments: documents or files to send, deadlines or explicit urgency, meeting requests, scheduling proposals, and project or client updates requiring action around a real commitment. A specific professional document request or meeting ask can be valuable without an exact date. LinkedIn and generic social requests, routine PR review notifications without a concrete dated or urgent assignment, vague undated responses, security alerts, OAuth notices, marketing, receipts, status-only mail, Calendar invitations, quoted earlier requests and signatures are excluded. The model decides from the request and its commitment, not a sender-domain or subject keyword rule.

Within one conversation, two candidates are one obligation only when they have the same kind, the same verified dates and strongly overlapping titles (Jaccard overlap of the normalized words of at least one half); the more complete, earlier statement is kept. Different kinds or dates, such as a document due 26 October and a call on 27 October, keep their own identity and state. Urgency is `asap`, `time_bound` or `none` and never implies a due date: an undated "ASAP" stays `needs_review` with no invented deadline. A proposed meeting is `meeting_state=proposed` and is never described as scheduled. Older assessments on visible requests follow the bounded reassessment rules below.

## Incremental sync and incomplete scans

The first scan reads the most recent 30 days at most, newest mail first, even when a longer period was approved: dated follow-ups rarely look further ahead, and a shorter first scan puts results on the card sooner. It walks every Gmail page inside that window with a sealed, resumable checkpoint, and a first scan sealed before this cap restarts inside it (messages already assessed are skipped without a fetch or a model call). Work per invocation is bounded by wall-clock time rather than a few steps: the on-screen catch-up answers within about eight seconds, so it always beats the web proxy's limit and the card asks again while the result is `pending`, and the scheduled worker spends about thirty-five seconds per account, scanning up to three accounts at once. A pass that ends early logs only its value-free reason code. Later scans start from the saved `historyId` and read only added, changed and deleted messages through `users.history.list`; a message already assessed at the current version is skipped before its body is fetched. A deleted message retires the active follow-ups that depended on it (state `source_unavailable`, reminder cancelled, Feed items removed) and keeps finished ones. The cursor advances only after a page is handled. An expired history cursor (HTTP 404) restarts from the last complete point minus one day, carrying the incomplete-source state forward, instead of discarding it.

Failures are classified, never flattened into "incomplete": permanently unreadable messages (no text, oversized assessment) are counted and not retried; deleted sources are retired; recoverable source problems and transient provider errors retry with bounded, per-source exponential backoff (60 s base, 3600 s cap, jitter, six attempts) honoring `Retry-After`; lost or revoked grants need the owner. A message whose model call keeps failing is set aside after three attempts. A scan is reported `complete` only when no source is outstanding. Status is `catching_up` (background retry in progress, shown quietly with no warning) or `needs_attention` (reconnect Mail, a source that exhausted its retries, or a prolonged provider outage), the only state that asks the owner to act. A completed monitor re-checks about every five minutes; a failing one backs off instead of retrying each minute. Retry from the card is an explicit, forced scan, offered only with the Reconnect action; the card has no settings menu. Opening Insights shows verified items first and lets the server continue once per interval; the server refuses a scan that is not due, so reopening never repeats work.

## Calendar reconciliation

Calendar is the source of truth for scheduled meetings. Before a meeting proposal is stored, the scanner reads the selected account's Calendar events around the proposed day (read only). A proposal that matches an existing, non-cancelled event (same day within 15 minutes, or a close title match) is dropped; a recurring occurrence such as the daily Growth Sync stays on the Board and is not recreated. A non-meeting action that names an existing meeting is linked to that occurrence and shown as "About: ...". A truncated Calendar page proves nothing about absence, so the proposal is kept for review; a Calendar read failure is a retryable source problem. Reconciliation never creates events, sends invitations or changes RSVP.

## Durable operational state

Store the smallest owner-scoped state outside PKM: an account monitoring preference and sealed scan checkpoint; opaque conversation and request IDs; account/Google-subject/grant-generation digests; source message/thread references and fingerprints; request revision/state; due and reminder instants; and encrypted owner-visible title, excerpt, sender and original due wording. Use authenticated encryption with owner/account/request AAD and a purpose-separated server key. Do not put raw email bodies, subjects, addresses, or extracted text in Feed rows, push payloads, logs, URLs, or analytics.

Request states are `needs_review`, `pending`, `done`, `snoozed`, `dismissed`, `cancelled`, and `source_unavailable`. A conversation is a grouping key, not a completion unit. Writes use expected revision and idempotency keys. Re-analysis reconciles by server-minted source/evidence identity, preserving owner completion and reminder edits unless a validated later source revision explicitly changes that request. An obsolete source revision suppresses its prior reminder before a new one is eligible. Two requests without distinguishable evidence identities stay `needs_review`; they are never silently merged.

### Semantic-stage declaration

| Required declaration | Contract |
| --- | --- |
| Owning agent and manifest | Existing `agent_email`; new tool-free `agent_email_followup_extractor` child in `consent-protocol/hushh_mcp/agents/email/agent.yaml`. |
| Output | `FollowupChunkAssessmentV1` under assessment version 5 returns distilled Calendar action titles, typed dates and date effects, offered replacement IDs, and separate exact source evidence. |
| Validator | Admit only offered message, thread and section refs; prove exact excerpt membership and global offset; reject duplicate durable identities, out-of-order update refs, unsupported time zones and malformed output. It does not create a request or due instant by interpreting sender text itself. |
| Live evaluation before promotion | Run a consented, held-out owner-mail fixture and opt-in pilot before enabling the monitor outside development. Require 100% source attribution, no automatic send/booking/PKM effects, and reviewed precision/recall for multi-request, tail, correction and ambiguous-date cases. Keep the feature kill switch closed until the result is recorded. |

A date worded "before 26 October" is exclusive: with a one-day lead the reminder is due on 25 October at the owner's configured hour and time zone. A proposed meeting is reminded the day before at the same hour: a call proposed for 27 October reminds on 26 October, so there is still time to schedule it. It gets no reminder when it is already confirmed, someone else is to arrange it, or its day is unclear, and a reminder time that has already passed is not scheduled. Proposals stored before meetings had reminders receive theirs when the next scan pass finishes, once. The reminder notification names only the kind of request ("Meeting reminder"), never anything from the email, and opens that request; scheduling it clears the reminder. A request with no verified date gets no reminder and is shown as such. Changing the reminder lead or hour recomputes unsent reminders and keeps the scan checkpoint and every owner decision; re-granting Mail or narrowing the period never deletes finished items. One confirmed reminder schedule is attached to one pending request revision. The due worker claims rows with a lease, rechecks owner, opt-in, current Mail grant, request revision, and source-thread freshness before projecting a generic Feed item and one `calendar_email_follow_up` system-push source. A later unscanned thread message, incomplete source check, revocation, deletion, or uncertain worker outcome defers delivery rather than sending an obsolete alert. The outbox and Feed deduplicate the revision, and recorded device sends are skipped on retry. A transport response lost after provider acceptance can still produce a duplicate device alert; exact-once receipt is not claimed. A minute OIDC wake and a feature kill switch are required for scale-zero delivery; their configuration is reviewed separately from source code. Notification data contains only an opaque follow-up ID and typed target; opening it reauthenticates, selects the matching account, and loads the exact request. Existing notification channel, quiet/privacy settings, and owner time zone remain authoritative.

## Review and action contract

Calendar Insights shows up to two upcoming conversations in Follow-ups. View all opens paged Upcoming, Overdue, and Snoozed lists. A row shows the assessed action and verified timing, with a count for other actions. History remains an internal classification for expired and closed requests. The centered Review dialog shows active actions and verified timing or linked Calendar context. Original email opens the exact account-scoped Gmail message. Calendar Review does not fetch email bodies or display source excerpts, subject lines, or sender addresses.

Swipe right to Keep or left to Remove. Keyboard users can use Right Arrow or Delete on the row. Keep leaves the request and its reminder in place. Remove asks for confirmation and dismisses only the displayed request by its current revision. Other requests from the same conversation remain available. Mark done and Reminder are the two default review actions for tasks. Schedule opens the existing centered booking form with the proposed details, and its Schedule meeting action confirms them and submits one event; the reminder is cleared once the event exists.

## Temporal eligibility, restated obligations and reassessment

Assessment version 5 tightens eligibility for automated obligations. The Calendar list
and detail show only current assessments, and the existing bounded reassessment
revisits older visible requests within the approved period. The read projection keeps
legacy response keys for compatibility and leaves raw evidence fields empty.
The live model remains subject to the evaluation gate above.

**Which list a request is in** is computed from the clock and the stored verdict on every
read, in SQL, before the page is chosen, so an expired item can never occupy a slot that
is then hidden by the client. Nothing is marked done, dismissed or deleted because a date
passed. The owner's local day comes from the monitor's time zone. A deadline stated as
"before" a date passes at the start of that date, matching reminder expiry.

| View | A live, un-merged request is in it when |
| --- | --- |
| `upcoming` (default) | dated today or later with an unpassed deadline; or undated, the owner's or urgent, and first seen within 45 days |
| `overdue` | past its deadline, the owner's own, not a meeting proposal, and `after_date` is `owed` or `unspecified` |
| `snoozed` | snoozed until a time that has not come; it returns to its date-based list when that time passes |
| `history` | closed by the owner or its source; a lapsed opportunity (`after_date=lapses`); a past meeting proposal; work that is not the owner's; an undated ask older than 45 days |

Earlier rows default to `after_date=unspecified`. A past non-meeting obligation
assigned to the owner remains Overdue when its date effect is unknown. `upcoming` is ranked by
verified urgency or a deadline within seven days, then later dates, then undated work; within
that, owner-assigned work first, then the earlier date, then fewer recorded ambiguities (the
only confidence signal the ledger holds). The full view pages 15 conversations
(`FOLLOWUP_PAGE_SIZE`); the compact Insights card shows the first two of `upcoming`.

**Semantic contract.** The extraction child decides what is asked of the owner, whether the
date is an event or a deadline, and what passing the date means. The new typed fields are
`category=scheduled_event` (a confirmed test or appointment, its own request with its own
date, never the registration deadline), `after_date` (`owed`, `lapses`, `unspecified`) and
`supersedes_request_id`. The host only validates: an event with no date is dropped; a
replacement is honoured only for a request ID the model was offered, and an unknown ID
leaves the candidate as its own request. Promotions, plan or product notices, security
findings and unassigned automated mail remain excluded by the model's relevance verdict; a
date or the word urgent never admits a request.

**One obligation, many emails.** A request that restates another is folded into the earliest
one (`merged_into`, hidden from lists, own sealed source kept) only when owner, account,
kind, category, responsibility, date relation, dates and sender domain agree, and the titles
share the same numbers and contain no conflicting terms. Each absorbed request must match
the survivor itself. A model-named replacement also needs the same conversation and kind,
matching wording, and a message newer than the target's latest source revision. Two
candidates claiming one request replace nothing.
Ambiguous matches stay separate. Done, dismissed, a future snooze and a future manual
reminder move onto the survivor; a merged request keeps no reminder, so one obligation
alerts once.

**Reassessment is bounded.** Raising the assessment version re-reads only messages that
still back a visible request created under an older version, through the existing
`reassess` scan mode and its checkpoints (scan progress is preserved). A message that
backs no visible request was already judged not to be Calendar work and is never re-read;
there is no mailbox rescan. A reassessed request is upgraded in place with its state,
reminders and manual choices untouched, or hidden (`suppressed_at`, reason
`reassessed_not_relevant`) when the current contract no longer supports it.
**Older suppressed records are not reconsidered automatically.** If the new contract is
suspected of having been too strict about them, reconsideration must be a targeted,
owner-visible action over a named message set, not a rescan; none is built here.

**Migration 454** (`454_calendar_email_followup_temporal.sql`) is additive: `after_date`
(defaulted), `merged_into`, the `scheduled_event` category and two partial indexes. The
previous producer's INSERT shape still works against the expanded schema. Its rollback
hides scheduled events instead of deleting them and drops the two columns, so a
rolled-back row reads `unspecified`; the rollback is not zero-loss once real
assessment history exists. The UAT port adds 454 after its existing release head 451.
The migration owner reconfirms numbering against the latest target before release.

**Stage B handoff.** The read-only Chat boundary is unchanged: nothing here adds a Chat
tool, proposal or write. Scope request-level discovery to the authenticated owner,
selected Calendar account, current monitor generation and current Mail grant. Use the
admitted turn clock and read only `suppressed_at IS NULL AND merged_into IS NULL`. The
read can use `after_date` and the `bucket` projection (`upcoming|overdue|snoozed|history`)
directly. Treat `view` as an optional parameter defaulting to `upcoming`. The list reports
`view_counts` across all four views and paginates conversations. Detail exposes
the request's `bucket`, `after_date` and `repeat_count`. Existing reminder links resolve
to the current same-account `request_id`. The separate `/source/link` route returns an
exact Gmail reference with a current grant check.

## Acceptance and rollout gates

- Synthetic frozen-clock evidence: a five-paragraph 10 October 2026 email has a document request in its final paragraph before 26 October and a 27 October call proposal. Both appear under one conversation as distinct requests. A configured 25 October reminder queues once into Feed and the push outbox; a later correction suppresses the obsolete revision; the call remains unbooked until explicit confirmation. These extraction tests use a deterministic mocked Email gene output, not a live model invocation.
- Relevance regression (synthetic model double): the Google "Security alert" email that the unfixed contract turned into "Check account activity and secure your account" and "Check activity" yields no follow-up; a real document request and a call proposal in one email stay distinct, duplicated phrasings and quoted requests collapse, and a `uncertain` or non-Calendar verdict is dropped. Live-model precision and recall are not established by these tests and remain part of the live evaluation gate above.
- Cover long MIME parts and chunk seams; same-category multiple requests; later edits/cancellations; ambiguous dates and DST; account B/C isolation; missing or revoked Gmail access; partial pages and failed sections; worker restart/concurrency; stale UI responses; deep links; keyboard and phone layout; and unchanged Mail Chat, receipts, information requests, Feed, Calendar booking, Drive, and PKM.
- Source/schema/route/agent tests and final-SHA CI prove checked-in behavior. Approved live-mail and physical-device notification verification are separate release gates. No shared migration, OAuth configuration, scheduler, merge, or deployment is implied by this document.

## UAT release controls

- `deploy/uat-surface-gates.txt` is read from the deployed commit by `scripts/deploy/backend-deploy.sh`, which asks `deploy/calendar/verify_followup_release.py read-gates` to validate it (a commit that predates the file deploys with the surface off). Its first line, `calendar_email_followups`, sets `CALENDAR_EMAIL_FOLLOWUPS` and binds the existing `CALENDAR_EMAIL_FOLLOWUP_KEY` secret; the deploy stops before any revision exists if that secret is not readable. Its second line, `calendar_email_followup_drain`, sets `CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED` and may be `true` only while the first is. The combined UAT build is at Cloud Build's 200-substitution limit, so the gates cost no substitution.
- A backend release then runs `deploy/calendar/setup_followup_scheduler.sh`: gate `true` creates or resumes the OIDC job `calendar-email-followups-uat` (every minute, `limit=10`, service account `calendar-email-followups`, audience `https://api.uat.hushh.ai`); anything else pauses it and never creates it. `deploy/calendar/verify_followup_release.py` then compares every Cloud Run revision serving traffic with the gates and uploads sanitized evidence.
- The gates only open the routes and the job. No account is monitored until its owner connects Gmail and opts in.
- A newly created scheduler identity can require time to propagate. Only an exact Scheduler creation `NOT_FOUND` after creating that identity gets bounded exponential backoff: eight attempts and at most 127 seconds of sleep. Existing-identity failures, permission denials and uncertain transport outcomes stop immediately; exact OIDC configuration readback remains required. See [Google's identity propagation guidance](https://docs.cloud.google.com/iam/docs/service-accounts-create).
- Rollback needs a deployment: set both lines to `false` and run Deploy to UAT. That closes the routes, pauses the job and keeps the secret, the sealed rows and every owner's preferences. For an immediate stop before that deploy lands, pause the job with `gcloud scheduler jobs pause calendar-email-followups-uat --project=hushh-pda-uat --location=us-central1`.
