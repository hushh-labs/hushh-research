# One Email and Calendar Read/Voice — Implementation Plan

Status: P0 implementation complete in branch; automated release validation and UAT deployment pending. Date: 2026-10-09. The current-code [Email graph](../../reference/one/one-email-knowledge-graph.md) and [Calendar graph](../../reference/one/one-calendar-knowledge-graph.md) hold the evidence and disposition. Preserve the [owner-approved Gmail contract](../../reference/one/gmail-owner-approved-email.md).

## Implementation ledger

| Slice | Branch disposition |
| --- | --- |
| A. Calendar trust | Implemented: typed external-read barrier, durable redaction, owner/account/grant recheck, free/busy fail-closed, quota reason mapping, stale UI fence. |
| B. Email target/send | Implemented: private encrypted-session exact-ID offer, ambiguous-target clarification, stale immediate-send unknown settlement, removed phrase override. |
| C. Live Voice | Implemented: negotiated mail-tool eligibility plus executor guard; read-only Calendar tool, private card, isolated narration enabled on UAT only. |
| D. Calendar breadth | Implemented: subscribed-calendar list with incremental web consent, selected-calendar bounded list/search, exact event detail through a private ordinal offer, explicit truncation. One typed connector read per turn and native optional-list consent remain limits. |
| E. Repetition/grounding | Partial: metadata-based replies now say possible. Independent compound reads, interpreter bypass, and claim-level entailment need a separate authority-preserving design and tests. |
| F. Measurement | Focused automated tests and runtime tool budget are implemented. Production p95 by intent, real-model held-out evaluation, and browser UAT remain release/operations work; skipped model tests are not proof. |

## Goal and boundary

Make Email reads and sends truthful, fast enough to measure, and safe after interruption; make Calendar useful as a read-only capability in typed Chat and Live Voice. One remains the semantic decision maker. Deterministic code validates authority, exact target, bounds, and effects; it does not infer intent from English substrings. Google OAuth plus direct Gmail/Calendar REST is a supported integration path. A hosted Workspace MCP adapter is not the active provider path.

The release covers the person's connected Google account. Calendar write proposals already present in typed Chat retain their separate owner-review boundary; no Calendar write tool enters Live Voice. For read breadth, support subscribed-calendar discovery, bounded event list/search, exact event detail and availability using the narrow scopes each requires. Google recommends [least-privilege Calendar scopes](https://developers.google.com/workspace/calendar/api/auth). Request new grants incrementally so existing event-read connections continue working.

## Visual Map

~~~mermaid
flowchart LR
  audit["Four code-backed audits"] --> trust["A. Trust and account freshness"]
  audit --> truth["B. Email target and send truth"]
  trust --> voice["C. Voice read and tool eligibility"]
  trust --> breadth["D. Calendar read breadth"]
  truth --> semantic["E. Grounding and compound reads"]
  voice --> proof["F. Automated outcome and latency proof"]
  breadth --> proof
  semantic --> proof
  proof --> uat["Exact-SHA merge and UAT"]
~~~

## A. Close Calendar external-read and account boundaries — P0

Add all existing typed Calendar read tool names to One's external-read barrier and durable result projection. No later same-turn action may be selected from event text; no raw title, description, attendees, or location may be serialized into the durable tool projection. Use the existing Google connection binding to check owner, grant and account before and after each REST call. An account change during a slow read returns a safe unavailable result. Reject a free/busy response with per-calendar errors instead of treating it as empty busy data. Parse Google's error reason before deciding whether 403 is quota, policy or missing permission; retry only safe reads within a bounded deadline. Fence the proactive web card's async response by owner/connection generation.

**Acceptance:** Inject an event description requesting an email send or Calendar proposal: no second provider/tool effect occurs in the turn, and the durable session projection contains no raw event text. Disconnect/reconnect during a delayed read releases no old-account event. A free/busy error never yields an opening. A 403 rateLimitExceeded remains retryable and does not ask for reconnect. An old UI response cannot repopulate a switched account.

## B. Fix Email target and send outcome truth — P0

The typed Email bridge currently loses the offered message IDs. Bind any positional follow-up to an owner/account/conversation-scoped, fresh offer before an exact-ID read; if no trusted offer exists, ask which message rather than fetching the newest. The semantic planner may identify an ordinal, but it cannot invent or authorize a provider ID. Preserve the existing Voice offered-ID path. Recover a stale immediate send that was claimed as sending before process cancellation into non-retryable outcome_unknown after a conservative lease; never resend it automatically. Remove the two-substring draft override, or make it an explicit owner-chosen template action. The reviewed send ledger and same-action status endpoint remain the authority.

**Acceptance:** List A/B, insert C, then ask for the second: read B or clarify, never C. Switching Google account invalidates the offer. Cancellation before and after the Gmail POST results in a bounded, non-retryable status; no second send occurs. A negated template phrase does not replace the requested draft.

## C. Make Live Voice eligibility and spoken reads coherent — P0

Declare only tools the negotiated client and current rollout gates can execute. On review-capable clients, use the current compose/review path and refuse the legacy draft-opening send path in the executor; a prompt preference alone is insufficient. Keep the Live model's semantic selection among eligible tools. Add Calendar read-only tool specs over the existing owner-scoped Calendar service; validate interval, calendar choice and exact event target. Keep third-party mail and event text out of the resumable operational model. A separate, tool-less narration channel may speak a bounded, source-grounded digest; if it is unavailable, say that details are on screen. Do not add Calendar mutation tools to the Voice catalog.

**Acceptance:** A draft-only utterance opens one editable card with no provider send. One final Send approval makes exactly one Gmail POST. Voice paraphrases of Calendar today, tomorrow, a named event, a selected calendar and free/busy choose read tools; negated or hypothetical actions make no write proposal. Spoken details match the displayed grounded result; external text never reaches the operational model. A narration failure settles honestly.

## D. Cover the useful Calendar read surface — P0/P1

Keep existing primary-calendar reads working. Add subscribed-calendar list and selected-calendar bounded event list/search, exact event detail, and continuation or explicit partial coverage. Use incremental calendar-list consent rather than changing the meaning of an existing read grant in place. Owner-local today/tomorrow must use the owner's zone; all-day and recurring instances need correct dates. Availability must distinguish unknown from free across every selected calendar. Bounded provider fanout and partial fields may reduce transport cost after contract tests.

**Acceptance:** A person with primary and secondary calendars can ask what is on each, search by title/date, open an exact event, and ask when they are free. Tests cover all-day, recurrence, DST, pagination and provider error. A limited page says what was not checked. The new calendar-list grant is requested only when that capability is used; older event-read grants still work.

## E. Reduce Email repetition and unsupported certainty — P1

Treat list_needs_reply as a metadata heuristic and say possible replies until a bounded body-based semantic assessment supports stronger language. For simple metadata lists, evaluate whether deterministic presentation after semantic planning can remove the interpreter model call without losing source and coverage truth. For independent compound requests, plan at most two bounded reads before external content is exposed, then synthesize once; do not make retrieved mail a new planning instruction. Validate consequential factual claims against evidence fields or narrow extracts, not source-reference existence alone. Existing one-page/body/thread caps stay visible in answers.

**Acceptance:** A mere thanks is not presented as a confirmed task. Unread inbox plus last sent yields two bounded reads and one answer, without a duplicated summary. A fabricated amount with a valid source reference is rejected or expressed as unknown. Truncation and partial coverage are explicit.

## F. Prove outcomes, safety and speed — release gate

Use focused fault-injection tests and existing type, lint, manifest, gateway, docs and core-CI checks. Extend typed and Live semantic evaluation with held-out paraphrases, Hindi/Hinglish, negation, positional follow-ups, source-grounded answers, partial coverage, prompt injection, and exact provider-call counts. The existing Live Mail model selection suite is opt-in; run a small real-model canary as an advisory exact-SHA release artifact and the broader suite on a scheduled cadence, without silently treating a skipped test as proof. Measure first useful answer and p50/p95/p99 by surface, intent and outcome. Existing Email plan/fetch/analyze/interpret spans are a starting point; separate OAuth refresh, Gmail/Calendar list/fanout, root resume and narration. Never log mail/calendar content or tokens.

Before merge, verify current main and exact PR head, generated contracts and focused tests, then the repository core mirror. After merge, require exact landed-SHA smoke, UAT release artifact and 100% Cloud Run provenance for the requested services. The person will do browser UAT; no Chrome/manual browser pass or local iOS/Android build is required for this task. A release is incomplete if a failed worker rolls traffic back or the artifact is unhealthy. Report any step skipped by the automated plan.

## Rollback and residual limits

Rollback preserves send ledger rows, OAuth connection rows and existing grants. If offer binding cannot be trusted, clarify; if send status is unresolved, show unknown and ask the owner to check Gmail Sent Mail. If Calendar data freshness cannot be proved, discard the read. Disable a faulty Live Calendar read family without enabling writes. Legacy Gmail receipt sync remains disabled until its committed-history checkpoint is redesigned in the earlier Email plan. Public OAuth verification and any restricted-scope assessment are external release checks, not proven by repository tests.
