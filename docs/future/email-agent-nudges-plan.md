# Email Agent — Inbox Nudges & A2A (`feat/email-a2a`)

Context doc for anyone picking up this branch. It explains the vision, what is
built so far, the architecture, how to run it, and what comes next.

## Vision

Grow the **Gmail agent** from a passive *receipts reader* into a proactive inbox
assistant, mirroring the two agents that already exist in the app:

- **Location agent** — proactive **flashcard nudges** (`lib/one-location/kai-circle-sections.ts`,
  `notifications.ts`): sectioned cards with title / description / CTA.
- **Information Marketplace agent** — **A2A** durable request → approve/deny flow
  (`lib/one-marketplace/service.ts`).

So the email agent gets the same treatment in two phases:

- **Phase 1 — Nudges (this branch):** read the inbox → surface smart flashcards
  ("Needs a reply", "Upcoming meeting", …) with actions.
- **Phase 2 — A2A (later):** another agent asks the email agent for info / to
  schedule → durable request → user approves/denies, same as the marketplace.

## Key enabler (why this needs no new permission)

The receipts connection is granted the **`gmail.readonly`** scope
(`hushh_mcp/services/gmail_receipts_service.py`). That is read access to the whole
mailbox — receipts sync just *filters* to `category:purchases`. Nudges reuse the
**same** connection with different queries. **No new OAuth scope, no re-consent.**
Consent is still enforced per request via `VAULT_OWNER`.

## What is built (Phase 1 — "Needs a reply")

### Backend
- **`hushh_mcp/services/gmail_nudges.py`** *(new)* — pure, I/O-free derivation.
  `NudgeMessage` / `NudgeThread` / `Nudge` dataclasses + `derive_needs_reply_nudges`.
  A thread "needs a reply" when its newest message is inbound (not the account
  holder), from a human (automated/no-reply senders filtered), and recent
  (`max_age_days`, default 30). Sorted newest-first, capped by `limit`.
  Fully unit-tested — no Gmail/DB needed.
- **`hushh_mcp/services/gmail_receipts_service.py`** — `list_nudges(user_id, limit)`:
  reuses `_ensure_access_token`, resolves the connected address via the Gmail
  profile, lists recent primary-inbox threads (`in:inbox category:primary
  newer_than:30d`, ≤25 threads), fetches thread metadata, maps to `NudgeThread`,
  and calls `derive_nudges`. Helpers: `_get_thread_metadata`,
  `_nudge_thread_from_payload`, `_message_received_at`.
- **`api/routes/kai/gmail.py`** — `GET /gmail/nudges/{user_id}?limit=` — verifies
  `VAULT_OWNER` consent before any inbox read (same gate as `/gmail/receipts`).
- **`tests/test_gmail_nudges.py`** *(new)* — 9 tests over the derivation logic.

### Frontend
- **`lib/services/kai-profile-api-paths.ts`** — `nudges` template + `buildGmailNudgesPath`.
- **`lib/services/gmail-receipts-service.ts`** — `GmailNudge` / `GmailNudgesResponse`
  types + `GmailReceiptsService.listNudges(...)`.
- **`components/gmail/gmail-nudges-section.tsx`** *(new)* — the "Needs a reply"
  flashcard section: loads nudges when Gmail is connected, renders cards
  (title = subject, "From {sender} · {time ago}") with a **Draft reply** CTA.
  v1 CTA opens the Gmail thread in a new tab; wiring it to the in-app draft flow
  is a follow-up.
- **`components/gmail/gmail-receipts-page.tsx`** — above the receipts list, in
  order: `<GmailChatPanel>` (top), then `<GmailNudgesSection>` (which renders
  **Needs a reply** then **Upcoming meeting**). Reached via the **Email/Gmail**
  workflow card on the One home (`ROUTES.GMAIL`).

## What is built (Phase 1 — "Upcoming meeting")

Second nudge type, composed behind the same `list_nudges` response (the array
now carries both `needs_reply` and `upcoming_meeting` items, discriminated by
`type`).

Meetings come from **two** sources, both surfaced:
- **Scheduled** — a `.ics` calendar invite, or a body email with a parseable
  future time. Shows the start time ("in 2h · Mon, Jul 6, 4:00 PM").
- **Mentioned** — a recent meeting-language email with no parseable time (e.g.
  "we are meeting"). Shows "Mentioned by {sender} · {ago}" so it isn't lost.

### Backend
- **`hushh_mcp/services/gmail_nudges.py`** — pure, stdlib-only:
  - `parse_ics_event` / `parse_ics_datetime` — iCalendar parsing (SUMMARY,
    DTSTART, ORGANIZER; RFC-5545 line-unfolding).
  - `looks_like_meeting(text)` — meeting-language detector (secondary filter over
    the coarse Gmail search).
  - `extract_meeting_datetime(text)` — conservative future time from free text
    (requires an explicit time-of-day like "3pm"; picks day from
    "tomorrow"/weekday). Returns None → the event becomes an undated *mention*.
  - `derive_upcoming_meeting_nudges` — scheduled (future, ≤30-day horizon) +
    mentions (received ≤14 days); one per thread; scheduled soonest-first, then
    mentions newest-first. `MeetingEvent` carries `starts_at` (nullable),
    `received_at`, `source` ("invite"|"email"). `Nudge` gained `starts_at`.
- **`hushh_mcp/services/gmail_receipts_service.py`**:
  - `_fetch_meeting_events` — scans `.ics` invites (`filename:ics newer_than:45d`),
    pulls the `text/calendar` part (inline or attachment), parses it.
  - `_fetch_body_meeting_events` — scans meeting-language emails
    (`_NUDGE_BODY_MEETING_QUERY`), confirms intent with `looks_like_meeting`,
    extracts a time, builds mention/scheduled events.
  - Both folded into `list_nudges` (invites first so they win per-thread de-dupe;
    best-effort — meeting failures never break the needs-reply list).
- Tests: `tests/test_gmail_nudges.py` covers ics parse, time extraction, mentions,
  and ordering.

### Frontend
- **`components/gmail/gmail-nudges-section.tsx`** — splits nudges by `type` and
  renders two labelled groups; the meeting card shows the parsed time when
  scheduled, or "Mentioned by {sender}" for an undated mention.

## What is built (Phase 1 — inline chat / "agent chatbot")

Mirrors the Information Marketplace chat (`InformationChatService` +
`MarketplaceChatPanel`): a read-only conversational agent over the inbox.

### Backend
- **`hushh_mcp/services/email_chat_service.py`** *(new)* — `EmailChatService`: a
  Gemini function-calling loop with two read-only tools bound to the user —
  `list_needs_reply` (the nudge deriver) and `search_inbox` (raw Gmail query →
  message summaries). Durable conversation persistence via `AgentChatService`.
  No `HushhContext` (Gmail auth is the connection, route gates `VAULT_OWNER`); no
  tool mutates state. Model call is injectable (tested with fakes, no live LLM).
- **`hushh_mcp/services/gmail_receipts_service.py`** — `search_inbox(user_id,
  query, limit)` reusing the same connection + metadata helpers.
- **`api/routes/one/email_chat.py`** *(new)* — `POST /api/one/email/chat`
  (registered in `api/routes/one/__init__.py`), `VAULT_OWNER`-gated.
- **`tests/test_email_chat_service.py`** *(new)* — 4 tests over the tool loop.

### Frontend
- **`lib/services/email-chat-service.ts`** *(new)* — `EmailChatService.chat(...)`.
- **`components/gmail/gmail-chat-panel.tsx`** *(new)* — inline chat panel
  (messages, suggestion chips, composer). Rendered on the Gmail page when
  connected + vault unlocked.

## Data flow

```
Gmail page (connected)
  -> GmailReceiptsService.listNudges()  [GET /api/kai/gmail/nudges/{uid}]
     -> route verifies VAULT_OWNER consent
     -> GmailReceiptsService.list_nudges()  [reuses gmail.readonly]
        -> messages.list (inbox/primary/30d) -> thread ids
        -> threads.get(metadata) per thread  -> NudgeThread[]
        -> derive_nudges()  (pure)           -> Nudge[]
  -> flashcards render; "Draft reply" -> Gmail thread
```

## Run it locally

1. Backend + Cloud SQL proxy: `bash scripts/runtime/run_backend_local.sh local --reload`
   (binds `127.0.0.1:8000`, proxy on `127.0.0.1:6543`).
2. Frontend: `cd hushh-webapp && npm run dev` (`http://localhost:3000`).
3. Sign in → One home → **Email/Gmail** card. Connect Gmail (receipts) if not
   already — that grants the readonly scope. Above receipts, in order: the
   **Email assistant** chat, then **Needs a reply** flashcards, then **Upcoming
   meeting** (parsed from calendar invites in your inbox).

Tests:
- Backend: `.venv/bin/python -m pytest tests/test_gmail_nudges.py tests/test_email_chat_service.py -q`
  (run from `consent-protocol/`).
- Frontend typecheck: `cd hushh-webapp && npx tsc --noEmit`.

## File map (handoff quick reference)

All paths under `consent-protocol/` (backend) or `hushh-webapp/` (frontend).

| File | Role |
|---|---|
| `hushh_mcp/services/gmail_nudges.py` | **Pure** nudge logic (needs-reply + meetings). Start here. No I/O. |
| `hushh_mcp/services/gmail_receipts_service.py` | Gmail I/O. `list_nudges`, `search_inbox`, meeting fetchers. Reuses the receipts OAuth connection. |
| `hushh_mcp/services/email_chat_service.py` | Inbox chatbot (Gemini function-calling loop; read-only tools). |
| `api/routes/kai/gmail.py` | `GET /gmail/nudges/{user_id}`. |
| `api/routes/one/email_chat.py` | `POST /api/one/email/chat` (registered in `api/routes/one/__init__.py`). |
| `tests/test_gmail_nudges.py`, `tests/test_email_chat_service.py` | Unit tests (no live Gmail/LLM/DB). |
| `lib/services/gmail-receipts-service.ts` | `listNudges` + `GmailNudge` types. |
| `lib/services/email-chat-service.ts` | `EmailChatService.chat`. |
| `lib/services/kai-profile-api-paths.ts` | API path templates (`nudges`). |
| `components/gmail/gmail-nudges-section.tsx` | Needs-reply + upcoming-meeting flashcards. |
| `components/gmail/gmail-chat-panel.tsx` | Inline chat UI. |
| `components/gmail/gmail-receipts-page.tsx` | Hosts the sections (chat → nudges → receipts). |

## Extending: add a new nudge type

1. **Pure logic** in `gmail_nudges.py`: add a `NUDGE_*` id and a
   `derive_<type>_nudges(...)` that returns `Nudge`s (reuse/extend `Nudge`
   fields; keep it I/O-free and unit-test it in `tests/test_gmail_nudges.py`).
2. **I/O** in `gmail_receipts_service.py`: fetch what the deriver needs (Gmail
   query + parse), call the deriver, and merge into the `list_nudges` response
   array (best-effort try/except so one type can't break the others).
3. **Frontend**: add the `type` to `GmailNudgeType`, then render a group/card in
   `gmail-nudges-section.tsx`.
4. **Chat (optional)**: expose it as a tool in `EmailChatService._build_tools` +
   `_function_declarations`.

## Known limitations / gotchas

- **Meeting times are best-effort UTC.** `.ics` `TZID` timezones and free-text
  times are normalized to UTC; the relative "in Xh/Xd" label is fine but precise
  local time can be off. Proper tz handling is a follow-up.
- **Body meeting detection is heuristic.** `looks_like_meeting` + a coarse Gmail
  query; expect occasional misses/false-positives. An LLM-extraction pass would
  be more robust (the Gmail agent is not ZK — it already reads Gmail server-side
  and the chat sends snippets to Gemini).
- **Pre-push hook is slow.** `.githooks/pre-push` runs a consent-protocol
  subtree-sync guard (`git subtree split`) that hangs for minutes. For
  feature-branch pushes use `git push --no-verify`; real subtree sync happens at
  merge via `./bin/hushh protocol sync`.
- **Pre-commit runs ruff** on consent-protocol — `ruff format` + `ruff check`
  before committing. `S105/S106` fire on literal tokens in tests (use a module
  constant + `# noqa`).
- **Draft-reply CTA** currently just opens the Gmail thread; it does not yet use
  the in-app draft flow.

## Next steps

- **More nudge types**: **Waiting on them** (you sent last, no reply),
  **Follow-up / due** (deadline language).
- **Better meeting time extraction**: an LLM pass (or `dateparser`) for reliable
  NL times + timezone handling, replacing the conservative regex extractor.
- **Better "needs a reply"**: fold the reply detection into a `derive` refinement,
  add snooze/dismiss state.
- **Draft-reply hand-off**: route the CTA (and a chat "draft a reply" intent)
  into the existing KYC/email draft flow instead of opening Gmail.
- **More chat tools**: summarize a thread, list unread, group by sender — compose
  behind `EmailChatService._build_tools`. All read-only for now.
- **Phase 2 — A2A**: durable requests + approve/deny mirroring
  `lib/one-marketplace/service.ts`; a mutating chat tool (e.g. send/schedule)
  would then need a `HushhContext` consent gate like the marketplace tools.
- **Calendar scope** (future, needs new consent) for real calendar meetings.
