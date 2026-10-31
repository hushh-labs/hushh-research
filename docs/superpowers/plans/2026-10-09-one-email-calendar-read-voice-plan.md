# One Email and Calendar Read/Voice — Implementation Plan

Status: first release merged as PR #7678 and deployed to UAT; second audit implementation complete. [PR #7686](https://github.com/hushh-labs/hushh-research/pull/7686) records current CI, merge and exact-SHA UAT release evidence. Date: 2026-10-09. The current-code [Email graph](../../reference/one/one-email-knowledge-graph.md) and [Calendar graph](../../reference/one/one-calendar-knowledge-graph.md) hold the evidence and disposition. Preserve the [owner-approved Gmail contract](../../reference/one/gmail-owner-approved-email.md).

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


## Second audit: read reliability and latency

The second pass uses four independent audit assignments (Calendar REST/authorization, Voice runtime, web connection/cards, Email retrieval) followed by disjoint implementation assignments and an integration review. Audits examined executable code and ran 290 existing focused tests; passing baseline tests did not cover the newly reproduced defects. The matrix below is a verification inventory, not a claim that 64 production incidents occurred.

Confirmed defects drive this implementation order:

1. Stabilize Calendar authorization identity across access-token refresh while retaining reconnect, account and service-grant fences. Recognize equivalent existing read scopes without requesting broader permissions.
2. Reject malformed/incomplete availability responses; bound safe REST reads and retry only transient read failures within the same deadline.
3. Cancel or supersede slow Voice reads and narration at stream intake, settle cards once, keep mutation settlement independent, and prevent unpublished read offers from becoming later targets.
4. Fix owner/status request races, free/busy time rendering, all-day dates, attendee details and provider-specific recovery cards.
5. Reject disconnected Voice Mail before semantic planning, eliminate invented empty-result prose, bound each analysis category, and preserve useful partial outcomes.
6. Add private Calendar page continuation, reject ambiguous/nonexistent local DST boundaries, regenerate contracts, and run focused tests plus required core/CI gates before exact-SHA UAT.

### Connected read architecture

~~~mermaid
flowchart LR
  input["Owner request + current timezone"] --> semantic["One semantic tool selection"]
  semantic --> preflight["Owner / vault / feature / provider grant"]
  preflight --> mail["Email typed read planner"]
  preflight --> calendar["Calendar typed read arguments"]
  mail --> gmail["Gmail REST: bounded list / message / thread"]
  calendar --> gcal["Calendar REST: calendars / events / freebusy"]
  gmail --> interpretation["Isolated tool-less interpretation"]
  gcal --> fence["Current grant + input generation fence"]
  interpretation --> fence
  fence --> card["Private result card"]
  fence --> narration["Isolated bounded narration"]
  fence --> receipt["Operational model: status / count only"]
  cancel["New input / provider cancel / deadline"] --> fence
  cancel --> settle["One terminal outcome; cancel pending read work"]
  preflight --> recovery["Connect / reconnect / permission / temporary failure"]
~~~

Google returns paged JSON over REST. The app streams tool lifecycle, answer, card and audio events over its existing transports; it does not describe the Google response as a token stream. Permission to invoke a tool, permission to read provider information, and permission to persist it remain separate.

### Scope and capability inventory

| Google scope | Provider permission | Current product read boundary |
| --- | --- | --- |
| `gmail.readonly` | Read mailbox content | Inbox/sent/search, bounded message bodies and threads, semantic analyses. Attachments and complete mailbox export are outside this reader. |
| `gmail.metadata` | Headers/labels and metadata, without body content; Gmail query limitations apply | Not a substitute for the current body-capable reader; no request for this additional grant. |
| `gmail.send` | Send mail | Does not grant read access. Existing reviewed-send path is separate. |
| `gmail.modify` / `gmail.compose` | Broader mailbox/draft operations | Existing incremental review paths; availability of an OAuth scope never authorizes an unreviewed effect. |
| `calendar.events.readonly` | Read events | Primary/selected-calendar list, search and exact detail. |
| `calendar.events` | Read and edit events | Existing manage grant must satisfy event reads; no Voice Calendar writes are added. |
| `calendar.freebusy` | Read availability | Busy periods and bounded openings; unknown availability must never become free time. |
| `calendar.calendarlist.readonly` | List subscribed calendars | Separate list capability; missing list access must not block primary events. |
| `calendar.readonly` | Broader Calendar read permission | Existing broad grants can satisfy their contained read operations; new connections retain narrower scopes. |

Google Chat is a separate API and permission family. Internal names such as `gmail_chat_reads` and `cap.email.metadata.read` are application capabilities, not Google Chat OAuth scopes. Calendar ACL/settings reads and Gmail attachment/export capabilities are not exposed merely because a broader provider grant exists.

References checked against Google's current documentation: [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Gmail performance](https://developers.google.com/workspace/gmail/api/guides/performance).

### Edge-case verification matrix

`Regression` identifies a confirmed gap addressed by this follow-up and requiring its focused test. `Existing` identifies the audited current guard. `Limit` and `Unverified` are not passing claims. Test families: C = Google Calendar service/grant tests; V = Voice Calendar tool tests; R = relay input-pump/external-content tests; W = web connection/card tests; E = delegated Email/metadata-reader tests.

| ID | Scenario and required outcome | Disposition / proof family |
| --- | --- | --- |
| 01 | Calendar disconnected: no provider read, actionable Calendar connection | Existing + recovery regression / C,V,W |
| 02 | Expired Calendar access token refresh: successful read remains usable | Regression / C |
| 03 | Reconnect to another Google account during read: discard old content | Existing / C,V |
| 04 | Reconnect to same account during read: authorization generation changes | Regression / C |
| 05 | Service grant revoked during read: discard fetched content | Existing / C |
| 06 | Manage grant permits event read without literal readonly scope | Regression / C |
| 07 | Only freebusy permission cannot authorize event bodies | Regression negative / C |
| 08 | Missing calendar-list permission preserves primary events | Existing / V |
| 09 | Calendar 401 offers reconnect; no generic retry loop | Regression / V,W |
| 10 | 403 rate-limit reason never becomes consent prompt | Existing + retry regression / C |
| 11 | 429 bounded retry; no retry beyond request budget | Regression / C |
| 12 | 503/network transient retries once for reads | Regression / C |
| 13 | Calendar writes never inherit read retry behavior | Regression negative / C |
| 14 | Grant/token/provider work shares a bounded read deadline | Regression / C,R |
| 15 | HTTP 200 with per-calendar error never produces free time | Existing / C |
| 16 | Missing busy collection fails closed | Regression / C |
| 17 | Invalid/missing busy timestamp fails closed | Regression / C |
| 18 | Reversed/zero-length busy interval fails closed | Regression / C |
| 19 | Incomplete group expansion fails closed | Regression / C |
| 20 | Overlapping busy intervals merge before openings | Existing / C |
| 21 | Fractional-second interval ordering uses timestamps | Regression / C |
| 22 | Invalid/reversed/over-31-day Voice window refuses | Existing / V |
| 23 | Owner-local time maps correctly to UTC | Existing / V |
| 24 | DST nonexistent time requires explicit valid time | Regression / V |
| 25 | DST repeated time requires offset disambiguation | Regression / V |
| 26 | Event/calendar IDs are URL-encoded | Existing / C |
| 27 | Detail without a fresh offered event refuses | Existing / V |
| 28 | Foreign-grant/expired event position refuses | Existing / V |
| 29 | More than ten events reports bounded coverage | Existing / V,W |
| 30 | Next Calendar page reuses private query/window/calendar | Regression / V |
| 31 | Next page with changed filters or grant refuses | Regression / V |
| 32 | Empty intermediate Calendar page can continue | Regression / V |
| 33 | Page cursor/query never enter operational model or durable Voice context | Regression / V |
| 34 | Freebusy card renders provider string timestamps | Regression / W |
| 35 | One-day all-day event uses exclusive end correctly | Regression / W |
| 36 | Event detail shows returned attendees and safe conference link | Regression / W |
| 37 | Owner A to B immediately hides A connection/email | Regression / W |
| 38 | Reverse status response order cannot overwrite latest status | Regression / W |
| 39 | Logout/disabled/unmount invalidates status requests | Regression / W |
| 40 | Upcoming events cannot publish stale owner/connection result | Existing / W |
| 41 | Provider cancels running read: stop work and settle once | Regression / R |
| 42 | New speech supersedes old read before dispatch catches up | Regression / R |
| 43 | New typed input supersedes old read | Regression / R |
| 44 | Cancellation during narration suppresses stale audio | Regression / R |
| 45 | Read/receipt/client-write/close deadlines release stalled dispatch | Regression / R |
| 46 | Read cancellation does not cancel an accepted mutation/send | Regression negative / R |
| 47 | Canceled read cannot replace previously published entity offer | Regression / R |
| 48 | Hostile email/event text cannot choose operational tools | Existing / R,V,E |
| 49 | Disconnected Voice Mail fails before planner/provider | Regression / E |
| 50 | Typed saved-receipt read works without Gmail connection | Existing preserved / E |
| 51 | Mail send-only grant cannot authorize body reads | Regression / E |
| 52 | Mail disconnect during interpretation suppresses answer | Existing / E |
| 53 | Email account change invalidates offered message IDs | Existing / E |
| 54 | Expired/foreign-owner/foreign-chat Email offer refuses | Existing / E |
| 55 | Out-of-range ordinal never becomes newest email | Existing / E |
| 56 | Ambiguous typed message selection asks for target | Existing / E |
| 57 | Gmail rate limits honor bounded retry and Retry-After | Existing / E |
| 58 | One failed parallel Gmail fetch cancels sibling reads | Existing / E |
| 59 | Empty mail result cannot acquire model-invented narrative | Regression / E |
| 60 | Slow personal-information analysis has category deadline | Regression / E |
| 61 | One failed analysis category preserves other successes | Existing + deadline regression / E |
| 62 | Workspace policy/daily quota failure has accurate recovery | Regression / E |
| 63 | Mailbox next-page and independent compound reads | Limit: no complete multi-query/mailbox continuation contract |
| 64 | Claim-level entailment and deployed p50/p95 under real load | Unverified: source references and deadlines do not establish these |


### Release acceptance and owner stories

Automated acceptance must cover the regression rows above with negative controls, current contract generation, core mirror, PR gates, and exact landed-SHA UAT provenance. Wall-clock deadlines cap waiting; they are not measured p95 improvements. The actual Live model passed all nine Calendar selection scenarios after the first canary exposed a preparatory read for an unavailable write. The semantic instruction now explains unavailable effects without substituting a read. This bounded canary does not establish every paraphrase, microphone behavior or end-to-end latency. Physical spoken/audio quality still requires owner acceptance.

Owner UAT stories after deployment:

1. With Calendar disconnected, ask “What is on my calendar tomorrow?” Expect a Calendar connection path and no claimed events. Repeat for disconnected Mail; it must name Email, not Drive.
2. Connect Calendar, ask for tomorrow's meetings, ask for more, then open the second event on the latest page. Check the selected event and attendee details.
3. Ask when you are busy and for a 30-minute opening. Check displayed times and an all-day event against Google Calendar.
4. Start a Mail/Calendar read and immediately ask a different question or stop. The old answer must not speak or replace the current result.
5. Switch the signed-in owner, or reconnect to a different Google account. Previous connection labels, events and selections must disappear.
6. Ask for mail matching a nonexistent topic. Expect an empty result without invented content; ask for mixed analyses and expect any failed category to be named.

Remaining product work is explicit: complete cross-calendar aggregation, Gmail attachments/export, independent compound mailbox reads, claim-level entailment and a measured live latency SLO. None is implied by OAuth scope availability or a green mocked test.


Integration review also reproduced an unbounded provider-response await after the read timed out. The final relay bounds provider receipt delivery and the complete timeout/cancellation settlement to three seconds, closes unhealthy transports within one second, and never retries an uncertain provider receipt. Six regression variants cover blocked provider writes, client writes and close. This is a dispatch-liveness guarantee under cooperative cancellation, not evidence that an external dependency always responds.

Local proof at integration: 207 Calendar/service/authorization tests; 283 Email tests; 108 web card/hook/page/service tests; 205 baseline relay tests plus the final 43 focused relay tests; 35 initial Calendar adapter/time/continuation tests with three subsequent recovery cases; contract, type and lint checks. Counts overlap and must not be summed into a unique test total. Core and GitHub release results are recorded separately.

### Deployment prerequisite found during release

An unrelated UAT deployment, run `37950082299`, failed before application promotion because replaying migration 262 narrowed the Drive event constraint installed by migration 288. Existing `document_share_request_sent` records then violated the older constraint. The release includes a bounded replay-guard repair that preserves an installed superset, with a PostgreSQL regression covering populated upgraded state. It does not remove records, change migration execution mode, or advance the schema version. Local PostgreSQL availability and the exact-head CI PostgreSQL result must be reported separately.
