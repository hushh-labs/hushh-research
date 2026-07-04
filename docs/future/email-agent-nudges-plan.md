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
- **`components/gmail/gmail-receipts-page.tsx`** — renders `<GmailNudgesSection>`
  and `<GmailChatPanel>` above the receipts list. Reached via the **Email/Gmail**
  workflow card on the One home (`ROUTES.GMAIL`).

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
   already — that grants the readonly scope. Above receipts you get the **Needs a
   reply** flashcards and the **Email assistant** chat ("what needs a reply?",
   "find unread emails from this week", "any invoices?").

Tests:
- Backend: `.venv/bin/python -m pytest tests/test_gmail_nudges.py tests/test_email_chat_service.py -q`
- Frontend typecheck: `cd hushh-webapp && npx tsc --noEmit`

## Next steps

- **More nudge types** (compose behind `derive_nudges`): **Upcoming meeting**
  (calendar-invite `.ics` emails + meeting-language), **Waiting on them** (you sent
  last, no reply), **Follow-up / due**.
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
