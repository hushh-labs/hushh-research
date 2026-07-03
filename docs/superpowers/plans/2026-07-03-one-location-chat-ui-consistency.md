# One + Location chat UI consistency & visible selections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the central One chat and the standalone Location chat visually consistent (both on the `primary` palette) and render every user selection as a clean chip + collapsed card instead of the raw `I selected: recipientUserId=…` dump.

**Architecture:** The raw selection text is a backend persistence artifact: `_selection_seed_text` doubles as the LLM instruction seed _and_ the persisted `role="user"` content. We keep the seed as `content` (unchanged, so the LLM still receives exact ids) and add an **encrypted** `metadata` column carrying a human-readable `display` string. History returns `metadata.display`; both chat frontends render it as a chip and collapse the source card. The location confirmation/selection cards are shared between surfaces, so retheming them to `primary` fixes both at once.

**Tech Stack:** Python (FastAPI, asyncpg-style raw SQL, Pydantic v2), PostgreSQL migrations, TypeScript, React, Tailwind, Vitest/Jest, pytest.

## Visual Map

```text
User taps a card option (recipient / duration / confirm)
  │  browser: describeSelection(prompt, sel) → display  (coordinate/id-free)
  │           append SelectionChip ("Abdul Zalil · 8h") + clear the card
  ▼
  central One chat:  POST /agent/chat/stream { delegate_result: { …, display } }
  Location chat:     POST /api/one/location/chat { selectionResult: { …, display } }
  │
  ▼  LocationChatService._handle_selection_result  (persist role="user")
       content  = raw seed            → LLM keeps exact ids ("do not guess")
       metadata = { kind:"selection", display }  → ENCRYPTED at rest
  │
  ▼  history reload → API returns UI-safe { kind, display } only
       browser renders the chip from metadata.display — never the raw seed

Both chats share the same cards (primary palette) and the same SelectionChip.
```

## Global Constraints

- **Coordinate-free invariant:** no `latitude`/`longitude`/coordinate keys may appear in the `display` string, `metadata`, SSE frames, or `delegate_result`. Assert at code level.
- **Encrypted at rest:** the new `metadata` value is PII (recipient display names). It MUST be encrypted with the existing `_encrypt_text` / `_decrypt_text(row, "metadata")` helpers — never stored plaintext.
- **Palette:** the two chat surfaces use only the `primary` design tokens. No `#b8894d` / `#d4a574` may remain in the touched chat bubbles, atoms, or the two shared cards.
- **Backward compatible:** all new request/response fields are optional; existing Kai action-plan turns, the standalone `/api/one/location/chat` flow, and legacy stored messages must keep working.
- **Migration:** idempotent (`ADD COLUMN IF NOT EXISTS`), wrapped in `BEGIN`/`COMMIT`.
- **Discipline:** DRY, YAGNI, TDD, frequent commits.

---

## File Structure

**Backend (create):**

- `consent-protocol/db/migrations/075_agent_chat_message_metadata.sql` — encrypted metadata columns.

**Backend (modify):**

- `consent-protocol/hushh_mcp/services/agent_chat_service.py` — `AgentChatMessage.metadata`, `add_message(metadata=…)`, `_message_from_row` decrypt.
- `consent-protocol/hushh_mcp/services/location_chat_service.py` — persist `display` + `metadata` on selection turns; `_selection_display_text` fallback.
- `consent-protocol/hushh_mcp/adk_bridge/location_agent.py` — thread `display` into `selection_result`.
- `consent-protocol/api/routes/kai/agent_chat.py` — `DelegateResultModel.display`; `AgentChatMessageModel.metadata`; serialize metadata in history.
- `consent-protocol/api/routes/one/location_chat.py` — `SelectionResultModel.display`.

**Frontend (create):**

- `hushh-webapp/lib/agent/describe-selection.ts` — refs → human-readable display string.
- `hushh-webapp/components/agent/selection-chip.tsx` — shared user-side selection chip.

**Frontend (modify):**

- `hushh-webapp/lib/agent/specialist-directive-runtime.ts` — `DelegateResult.display`.
- `hushh-webapp/lib/one-location/types.ts` — `SelectionResult.display`.
- `hushh-webapp/lib/services/agent-chat-client.ts` — `AgentChatMessage.metadata`; parse it.
- `hushh-webapp/components/agent/agent-chat-workspace.tsx` — append chip + collapse card + send `display` + render history chips.
- `hushh-webapp/components/one-location/redesign/clarification-card.tsx` — retheme + collapsed state.
- `hushh-webapp/components/one-location/redesign/action-confirm-card.tsx` — retheme + collapsed state.
- `hushh-webapp/components/one-location/redesign/location-chat-message-list.tsx` — retheme bubbles.
- `hushh-webapp/components/one-location/redesign/location-chat-atoms.tsx` — retheme avatar/notes.
- `hushh-webapp/components/one-location/redesign/use-location-chat.ts` — append chip on selection.

---

## Task 1: DB migration — encrypted `metadata` columns

**Files:**

- Create: `consent-protocol/db/migrations/075_agent_chat_message_metadata.sql`

**Interfaces:**

- Produces: columns `metadata_ciphertext`, `metadata_iv`, `metadata_tag`, `metadata_algorithm` (all nullable `text`) on `agent_chat_messages`.

- [ ] **Step 1: Write the migration**

```sql
-- 075_agent_chat_message_metadata.sql
--
-- Add an OPTIONAL, encrypted metadata blob to agent chat messages.
--
-- Selection turns in the One+Location delegated chat persist the raw LLM seed
-- as `content` (so later turns still receive exact recipient/key ids) but need a
-- separate human-readable display string ("Abdul Zalil · 8 hours") for the UI
-- chip. The display string is PII (recipient names), so it is encrypted at rest
-- with the same AES-256-GCM scheme as `content` — never stored plaintext.
--
-- Nullable and additive: existing rows and non-selection messages leave these
-- columns NULL. Idempotent.

BEGIN;

ALTER TABLE agent_chat_messages
  ADD COLUMN IF NOT EXISTS metadata_ciphertext text,
  ADD COLUMN IF NOT EXISTS metadata_iv         text,
  ADD COLUMN IF NOT EXISTS metadata_tag        text,
  ADD COLUMN IF NOT EXISTS metadata_algorithm  text;

COMMIT;
```

- [ ] **Step 2: Apply the migration to the dev database**

Run the repo's standard migration runner (match how prior migrations are applied in this project — check `consent-protocol/db/` tooling or `README`). Expected: no error; `\d agent_chat_messages` shows the four new nullable columns.

- [ ] **Step 3: Commit**

```bash
git add consent-protocol/db/migrations/075_agent_chat_message_metadata.sql
git commit -m "feat(agent-chat): add encrypted metadata column to messages"
```

---

## Task 2: Chat store — read/write encrypted metadata

**Files:**

- Modify: `consent-protocol/hushh_mcp/services/agent_chat_service.py` (dataclass ~271; `add_message` ~1246; `_message_from_row` ~1894)
- Test: `consent-protocol/tests/test_agent_chat_service_metadata.py` (create)

**Interfaces:**

- Consumes: `_encrypt_text(text) -> EncryptedPayload`, `_decrypt_text(row, prefix) -> str` (existing).
- Produces:
  - `AgentChatMessage.metadata: dict | None`
  - `add_message(..., metadata: dict | None = None) -> AgentChatMessage`
  - `_message_from_row` populates `.metadata` (decrypt + `json.loads`, `None` when absent).

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_agent_chat_service_metadata.py
import json

from hushh_mcp.services.agent_chat_service import AgentChatService


class _FakeResult:
    def __init__(self, data):
        self.data = data


def test_message_from_row_decrypts_metadata(monkeypatch):
    service = AgentChatService.__new__(AgentChatService)  # skip __init__/db

    def fake_decrypt(row, prefix):
        return row.get(f"{prefix}_plain", "")

    monkeypatch.setattr(service, "_decrypt_text", fake_decrypt)
    row = {
        "id": "m1",
        "conversation_id": "c1",
        "user_id": "u1",
        "role": "user",
        "status": "complete",
        "content_plain": "I selected: recipientUserId=x. Use exactly these ids.",
        "metadata_plain": json.dumps({"display": "Abdul Zalil · 8 hours", "kind": "selection"}),
        "metadata_ciphertext": "ct",  # presence signals metadata exists
    }
    message = service._message_from_row(row)
    assert message.content.startswith("I selected:")
    assert message.metadata == {"display": "Abdul Zalil · 8 hours", "kind": "selection"}


def test_message_from_row_metadata_none_when_absent(monkeypatch):
    service = AgentChatService.__new__(AgentChatService)
    monkeypatch.setattr(service, "_decrypt_text", lambda row, prefix: "hi" if prefix == "content" else "")
    message = service._message_from_row({"id": "m2", "role": "assistant", "content_plain": "hi"})
    assert message.metadata is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest consent-protocol/tests/test_agent_chat_service_metadata.py -v`
Expected: FAIL — `AgentChatMessage` has no `metadata` field / `TypeError`.

- [ ] **Step 3: Add the dataclass field**

In `agent_chat_service.py`, add to the `AgentChatMessage` dataclass (after `completed_at`, ~line 280):

```python
    metadata: dict | None = None
```

- [ ] **Step 4: Thread metadata through `add_message`**

Add the parameter (after `error_code`, ~line 1255):

```python
        error_code: str | None = None,
        metadata: dict | None = None,
```

Just before the INSERT `result = await self._execute_raw(` (~1259), encrypt the metadata:

```python
        import json as _json

        encrypted_metadata = (
            self._encrypt_text(_json.dumps(metadata)) if metadata is not None else None
        )
```

Add the four columns to the INSERT column list (after `error_code,`):

```sql
              error_code,
              metadata_ciphertext,
              metadata_iv,
              metadata_tag,
              metadata_algorithm,
              completed_at
```

Add the matching VALUES placeholders (after `:error_code,`):

```sql
              :error_code,
              :metadata_ciphertext,
              :metadata_iv,
              :metadata_tag,
              :metadata_algorithm,
              now()
```

Add to the params dict (after `"error_code": error_code,`):

```python
                "error_code": error_code,
                "metadata_ciphertext": encrypted_metadata.ciphertext if encrypted_metadata else None,
                "metadata_iv": encrypted_metadata.iv if encrypted_metadata else None,
                "metadata_tag": encrypted_metadata.tag if encrypted_metadata else None,
                "metadata_algorithm": encrypted_metadata.algorithm if encrypted_metadata else None,
```

- [ ] **Step 5: Decrypt in `_message_from_row`**

Replace the body of `_message_from_row` (~1894) so it also reads metadata:

```python
    def _message_from_row(self, row: dict[str, Any]) -> AgentChatMessage:
        import json as _json

        try:
            content = self._decrypt_text(row, "content")
        except Exception:
            logger.warning("agent_chat.message_decrypt_failed message_id=%s", row.get("id"))
            content = ""
        metadata: dict | None = None
        if row.get("metadata_ciphertext"):
            try:
                raw = self._decrypt_text(row, "metadata")
                parsed = _json.loads(raw) if raw else None
                metadata = parsed if isinstance(parsed, dict) else None
            except Exception:
                logger.warning("agent_chat.metadata_decrypt_failed message_id=%s", row.get("id"))
                metadata = None
        return AgentChatMessage(
            id=str(row.get("id") or ""),
            conversation_id=str(row.get("conversation_id") or ""),
            user_id=str(row.get("user_id") or ""),
            role=str(row.get("role") or ""),
            status=str(row.get("status") or "complete"),
            content=content,
            model=str(row.get("model")) if row.get("model") else None,
            created_at=_iso(row.get("created_at")),
            completed_at=_iso(row.get("completed_at")),
            metadata=metadata,
        )
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest consent-protocol/tests/test_agent_chat_service_metadata.py -v`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/services/agent_chat_service.py consent-protocol/tests/test_agent_chat_service_metadata.py
git commit -m "feat(agent-chat): persist and read encrypted message metadata"
```

---

## Task 3: Location service — persist display + metadata on selection turns

**Files:**

- Modify: `consent-protocol/hushh_mcp/services/location_chat_service.py` (`_selection_seed_text` ~336; `_handle_selection_result` persist ~708-719)
- Test: `consent-protocol/tests/test_location_chat_selection_display.py` (create)

**Interfaces:**

- Consumes: `add_message(..., metadata=…)` from Task 2; `selection_result` dict may now carry a `display` string (supplied by the frontend, Tasks 4/6).
- Produces: on a selection turn the persisted `role="user"` message has `content = seed` (unchanged) and `metadata = {"kind": "selection", "display": <str>}`.
- New helper: `_selection_display_text(selection_result) -> str` (fallback when frontend omits `display`).

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_location_chat_selection_display.py
import asyncio

from hushh_mcp.services.location_chat_service import (
    LocationChatService,
    _selection_display_text,
)


def test_display_text_prefers_frontend_display():
    assert _selection_display_text({"display": "Abdul Zalil · 8 hours"}) == "Abdul Zalil · 8 hours"


def test_display_text_fallback_is_coordinate_free_and_not_raw_seed():
    text = _selection_display_text(
        {"selected": [{"recipientUserId": "5dM8", "recipientKeyId": "WlUg"}]}
    )
    assert "recipientUserId" not in text
    assert "do not guess" not in text
    assert "latitude" not in text and "longitude" not in text


def test_cancelled_display():
    assert _selection_display_text({"status": "cancelled"}) == "Cancelled"


def test_selection_turn_persists_display_metadata(monkeypatch):
    persisted: list[dict] = []

    class FakeStore:
        async def get_recent_messages(self, *a, **k):
            return []

        async def add_message(self, **kwargs):
            persisted.append(kwargs)

    service = LocationChatService.__new__(LocationChatService)
    service._chat_store = FakeStore()
    service._types = None       # force the unavailable branch off; see below
    service._ready = lambda: True

    async def fake_loop(**kwargs):
        return ("Sharing set up.", False, True, [], [])

    service._run_tool_loop = fake_loop
    service._build_client_prompt = lambda prompts: None
    service._build_client_action = lambda directives: None

    async def run():
        return await service._handle_selection_result(
            user_id="u1",
            consent_token="tok",
            conversation_id="c1",
            selection_result={
                "id": "p1",
                "kind": "select",
                "selected": [{"recipientUserId": "5dM8", "recipientKeyId": "WlUg"}],
                "display": "Abdul Zalil",
                "status": "answered",
            },
        )

    asyncio.get_event_loop().run_until_complete(run())
    user_msgs = [m for m in persisted if m.get("role") == "user"]
    assert user_msgs, "selection turn must persist a user message"
    msg = user_msgs[0]
    assert msg["content"].startswith("I selected:")           # seed unchanged for the LLM
    assert msg["metadata"] == {"kind": "selection", "display": "Abdul Zalil"}
```

> Note: `service._types = None` makes `_ready()`-gated code paths deterministic; if the real `_handle_selection_result` early-returns when `self._types is None`, set `service._types = object()` instead and keep `_ready` returning True. Adjust the fake to whichever branch the real method takes — the assertion on the persisted user message is the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest consent-protocol/tests/test_location_chat_selection_display.py -v`
Expected: FAIL — `_selection_display_text` does not exist; metadata not persisted.

- [ ] **Step 3: Add the display helper**

In `location_chat_service.py`, right after `_selection_seed_text` (~line 350):

```python
def _selection_display_text(selection_result: dict) -> str:
    """Human-readable, coordinate-free summary of the user's choice for the UI chip.

    Prefers a frontend-supplied ``display`` label (which knows the friendly names).
    Falls back to option values (never the raw id seed) so a missing label never
    leaks ``recipientUserId=…`` into the transcript.
    """
    if str(selection_result.get("status")) == "cancelled":
        return "Cancelled"
    display = selection_result.get("display")
    if isinstance(display, str) and display.strip():
        return display.strip()
    free = selection_result.get("free_text") or selection_result.get("freeText")
    if free:
        return str(free)
    if str(selection_result.get("kind")) == "confirm":
        return "Confirmed" if selection_result.get("confirmed") else "Declined"
    selected = selection_result.get("selected") or []
    labels: list[str] = []
    for ref in selected:
        if not isinstance(ref, dict):
            continue
        # Show human-facing values only; skip opaque id keys.
        for key, value in ref.items():
            if key in ("recipientUserId", "recipientKeyId", "grantId"):
                continue
            labels.append(str(value))
    return ", ".join(labels) if labels else "Your selection"
```

- [ ] **Step 4: Persist display + metadata in `_handle_selection_result`**

Replace the persist block (~708-719) so `content` stays the seed and metadata carries the display:

```python
        seed = _selection_seed_text(selection_result)
        display = _selection_display_text(selection_result)
        # Persist the user's choice so a later turn in a multi-step clarification
        # chain still sees the earlier answer. `content` keeps the raw seed (the
        # LLM needs exact ids — "do not guess"); the UI-facing display string
        # rides in encrypted metadata so the transcript shows "Abdul Zalil", not
        # the id dump.
        await self._chat_store.add_message(
            conversation_id=conv_id,
            user_id=user_id,
            role="user",
            content=seed,
            status="complete",
            metadata={"kind": "selection", "display": display},
        )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest consent-protocol/tests/test_location_chat_selection_display.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/location_chat_service.py consent-protocol/tests/test_location_chat_selection_display.py
git commit -m "feat(one-location): persist display metadata for selection turns"
```

---

## Task 4: API — thread `display` in and metadata out

**Files:**

- Modify: `consent-protocol/api/routes/kai/agent_chat.py` (`DelegateResultModel` ~33; `AgentChatMessageModel` ~76; message serialization `_message_to_response` ~160-183)
- Modify: `consent-protocol/api/routes/one/location_chat.py` (`SelectionResultModel` ~33)
- Modify: `consent-protocol/hushh_mcp/adk_bridge/location_agent.py` (`_SELECTION_RESULT_KEYS` ~24)
- Test: `consent-protocol/tests/test_agent_chat_history_metadata.py` (create)

**Interfaces:**

- Consumes: `AgentChatMessage.metadata` (Task 2).
- Produces:
  - `DelegateResultModel.display: Optional[str]` and `SelectionResultModel.display: Optional[str]`.
  - `location_agent._SELECTION_RESULT_KEYS` includes `"display"` so it reaches `selection_result`.
  - `AgentChatMessageModel.metadata: Optional[dict]`; history serialization returns `{"display", "kind"}` only (never any server-only keys).

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_agent_chat_history_metadata.py
from api.routes.kai.agent_chat import DelegateResultModel, _message_to_response
from hushh_mcp.services.agent_chat_service import AgentChatMessage


def test_delegate_result_accepts_display():
    m = DelegateResultModel(delegate_agent_id="agent_location", kind="selection", id="p1", display="Abdul Zalil")
    assert m.display == "Abdul Zalil"


def test_history_response_exposes_ui_metadata_only():
    msg = AgentChatMessage(
        id="m1", conversation_id="c1", user_id="u1", role="user", status="complete",
        content="I selected: recipientUserId=x. Use exactly these ids.",
        model=None, created_at=None, completed_at=None,
        metadata={"kind": "selection", "display": "Abdul Zalil · 8 hours"},
    )
    out = _message_to_response(msg)
    assert out.metadata == {"kind": "selection", "display": "Abdul Zalil · 8 hours"}
```

> If `_message_to_response` is defined with a different name/signature in this file, use the actual serializer that builds `AgentChatMessageModel` from an `AgentChatMessage` (search for where `AgentChatMessageModel(` is constructed, ~line 160-183). Keep the assertion identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest consent-protocol/tests/test_agent_chat_history_metadata.py -v`
Expected: FAIL — `DelegateResultModel` has no `display`; `AgentChatMessageModel` has no `metadata`.

- [ ] **Step 3: Add `display` to `DelegateResultModel`**

In `agent_chat.py`, add to `DelegateResultModel` (after `prompt_kind`, ~line 47):

```python
    # Human-readable label for the UI chip (e.g. "Abdul Zalil · 8 hours").
    # Coordinate-free; the backend persists it as encrypted metadata.
    display: Optional[str] = Field(default=None, max_length=200)
```

- [ ] **Step 4: Add `metadata` to `AgentChatMessageModel` and serialize it**

Add to `AgentChatMessageModel` (after `completed_at`, ~line 88):

```python
    metadata: Optional[dict] = Field(default=None)
```

In the serializer that constructs `AgentChatMessageModel(...)` from an `AgentChatMessage` (~160-183), pass a UI-safe metadata subset:

```python
        metadata=(
            {k: message.metadata[k] for k in ("kind", "display") if k in message.metadata}
            if isinstance(getattr(message, "metadata", None), dict)
            else None
        ),
```

- [ ] **Step 5: Add `display` to `SelectionResultModel`**

In `location_chat.py`, add to `SelectionResultModel` (after `status`, ~line 41):

```python
    display: str | None = Field(default=None, max_length=200)
```

- [ ] **Step 6: Let the A2A handler forward `display`**

In `location_agent.py`, extend `_SELECTION_RESULT_KEYS` (~line 24) to include `display`:

```python
_SELECTION_RESULT_KEYS = ("id", "selected", "confirmed", "freeText", "status", "display")
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pytest consent-protocol/tests/test_agent_chat_history_metadata.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add consent-protocol/api/routes/kai/agent_chat.py consent-protocol/api/routes/one/location_chat.py consent-protocol/hushh_mcp/adk_bridge/location_agent.py consent-protocol/tests/test_agent_chat_history_metadata.py
git commit -m "feat(agent-chat): thread selection display through API"
```

---

## Task 5: Frontend — `describeSelection` helper

**Files:**

- Create: `hushh-webapp/lib/agent/describe-selection.ts`
- Test: `hushh-webapp/lib/agent/__tests__/describe-selection.test.ts`

**Interfaces:**

- Produces: `describeSelection(prompt: ClientPrompt, sel: { selected?: Record<string, unknown>[]; confirmed?: boolean; freeText?: string; status?: string }) => string`.

- [ ] **Step 1: Write the failing test**

```ts
// hushh-webapp/lib/agent/__tests__/describe-selection.test.ts
import { describe, expect, it } from "vitest";
import { describeSelection } from "@/lib/agent/describe-selection";
import type { ClientPrompt } from "@/lib/one-location/types";

const recipientPrompt: ClientPrompt = {
  id: "p1",
  kind: "select",
  purpose: "recipient",
  question: "Who?",
  options: [
    {
      label: "Abdul Zalil",
      ref: { recipientUserId: "5dM8", recipientKeyId: "WlUg" },
    },
    { label: "Mom", ref: { recipientUserId: "mom1", recipientKeyId: "momK" } },
  ],
};

const durationPrompt: ClientPrompt = {
  id: "p2",
  kind: "select",
  purpose: "duration",
  question: "How long?",
  options: [{ label: "8 hours", ref: { hours: 8 } }],
};

describe("describeSelection", () => {
  it("maps selected refs to option labels", () => {
    expect(
      describeSelection(recipientPrompt, {
        selected: [{ recipientUserId: "5dM8", recipientKeyId: "WlUg" }],
      }),
    ).toBe("Abdul Zalil");
  });

  it("joins multiple selections", () => {
    expect(
      describeSelection(recipientPrompt, {
        selected: [
          { recipientUserId: "5dM8", recipientKeyId: "WlUg" },
          { recipientUserId: "mom1", recipientKeyId: "momK" },
        ],
      }),
    ).toBe("Abdul Zalil, Mom");
  });

  it("maps a duration selection", () => {
    expect(
      describeSelection(durationPrompt, { selected: [{ hours: 8 }] }),
    ).toBe("8 hours");
  });

  it("describes confirm / cancel / free text", () => {
    expect(
      describeSelection(
        { ...recipientPrompt, kind: "confirm" },
        { confirmed: true },
      ),
    ).toBe("Confirmed");
    expect(
      describeSelection(
        { ...recipientPrompt, kind: "confirm" },
        { confirmed: false },
      ),
    ).toBe("Declined");
    expect(describeSelection(recipientPrompt, { status: "cancelled" })).toBe(
      "Cancelled",
    );
    expect(
      describeSelection(recipientPrompt, { freeText: "share with my sister" }),
    ).toBe("share with my sister");
  });

  it("never leaks raw ids when a ref has no matching option", () => {
    const out = describeSelection(recipientPrompt, {
      selected: [{ recipientUserId: "ghost", recipientKeyId: "x" }],
    });
    expect(out).not.toContain("recipientUserId");
    expect(out).not.toContain("recipientKeyId");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/agent/__tests__/describe-selection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```ts
// hushh-webapp/lib/agent/describe-selection.ts
import type { ClientPrompt } from "@/lib/one-location/types";

function sameRef(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Human-readable, coordinate-free summary of a user's card selection, for the
 * chat chip. Resolves refs back to their option labels; falls back to option
 * *values* (never raw id keys) so an unmatched ref can never leak an id dump.
 */
export function describeSelection(
  prompt: ClientPrompt,
  sel: {
    selected?: Record<string, unknown>[];
    confirmed?: boolean;
    freeText?: string;
    status?: string;
  },
): string {
  if (sel.status === "cancelled") return "Cancelled";
  if (sel.freeText && sel.freeText.trim()) return sel.freeText.trim();
  if (prompt.kind === "confirm")
    return sel.confirmed ? "Confirmed" : "Declined";

  const options = prompt.options ?? [];
  const labels = (sel.selected ?? [])
    .map((ref) => {
      const match = options.find((o) => sameRef(o.ref, ref));
      if (match) return match.label;
      // No matching option: surface non-id values only.
      const values = Object.entries(ref)
        .filter(
          ([k]) =>
            !["recipientUserId", "recipientKeyId", "grantId"].includes(k),
        )
        .map(([, v]) => String(v));
      return values.join(" ");
    })
    .filter((s) => s.length > 0);

  return labels.length ? labels.join(", ") : "Your selection";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/agent/__tests__/describe-selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/agent/describe-selection.ts hushh-webapp/lib/agent/__tests__/describe-selection.test.ts
git commit -m "feat(agent): add describeSelection helper for chat chips"
```

---

## Task 6: Frontend types + client — carry `display` and message metadata

**Files:**

- Modify: `hushh-webapp/lib/agent/specialist-directive-runtime.ts` (`DelegateResult` ~9)
- Modify: `hushh-webapp/lib/one-location/types.ts` (`SelectionResult` ~379)
- Modify: `hushh-webapp/lib/services/agent-chat-client.ts` (`AgentChatMessage` ~4)

**Interfaces:**

- Produces:
  - `DelegateResult.display?: string`
  - `SelectionResult.display?: string`
  - `AgentChatMessage.metadata?: { kind?: string; display?: string } | null`

- [ ] **Step 1: Add `display` to `DelegateResult`**

In `specialist-directive-runtime.ts`, add to the `DelegateResult` type (after `freeText?`, ~line 23):

```ts
  // Human-readable label for the chat chip (e.g. "Abdul Zalil · 8 hours").
  display?: string;
```

- [ ] **Step 2: Add `display` to `SelectionResult`**

In `lib/one-location/types.ts`, add to `SelectionResult` (after `status`, ~line 385):

```ts
  display?: string;
```

- [ ] **Step 3: Add `metadata` to the client `AgentChatMessage`**

In `agent-chat-client.ts`, add to `AgentChatMessage` (after `completed_at?`, ~line 12):

```ts
  metadata?: { kind?: string; display?: string } | null;
```

`getAgentChatHistory` returns the parsed JSON as-is, so `metadata` flows through automatically once the backend (Task 4) includes it.

- [ ] **Step 4: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/agent/specialist-directive-runtime.ts hushh-webapp/lib/one-location/types.ts hushh-webapp/lib/services/agent-chat-client.ts
git commit -m "feat(agent): carry selection display in types and client"
```

---

## Task 7: Shared `SelectionChip` component

**Files:**

- Create: `hushh-webapp/components/agent/selection-chip.tsx`
- Test: `hushh-webapp/components/agent/__tests__/selection-chip.test.tsx`

**Interfaces:**

- Produces: `SelectionChip({ label }: { label: string })` — a right-aligned `primary` user-side pill with a check icon.

- [ ] **Step 1: Write the failing test**

```tsx
// hushh-webapp/components/agent/__tests__/selection-chip.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionChip } from "@/components/agent/selection-chip";

describe("SelectionChip", () => {
  it("renders the label", () => {
    render(<SelectionChip label="Abdul Zalil · 8 hours" />);
    expect(screen.getByText("Abdul Zalil · 8 hours")).toBeInTheDocument();
  });

  it("uses primary tokens, not cream", () => {
    const { container } = render(<SelectionChip label="Mom" />);
    expect(container.innerHTML).not.toContain("#b8894d");
    expect(container.innerHTML).not.toContain("#d4a574");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/agent/__tests__/selection-chip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
// hushh-webapp/components/agent/selection-chip.tsx
"use client";

import { Check } from "lucide-react";

/**
 * Right-aligned user-side chip summarizing a card selection, styled to match the
 * central chat's primary user bubble so both surfaces read consistently.
 */
export function SelectionChip({ label }: { label: string }) {
  return (
    <div className="flex w-full justify-end" data-testid="selection-chip">
      <span className="inline-flex items-center gap-1.5 rounded-2xl bg-primary/10 px-3.5 py-1.5 text-sm font-medium text-primary shadow-sm shadow-primary/5">
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/agent/__tests__/selection-chip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/agent/selection-chip.tsx hushh-webapp/components/agent/__tests__/selection-chip.test.tsx
git commit -m "feat(agent): add SelectionChip component"
```

---

## Task 8: Central chat — append chip, send display, render history chips, collapse card

**Files:**

- Modify: `hushh-webapp/components/agent/agent-chat-workspace.tsx` (message type ~111; specialist render block ~3506-3621; history hydration where `AgentChatMessage`→`AgentMessage`; user-bubble render ~561-569)
- Test: covered by the workspace's existing test file (extend it) — search for the existing `agent-chat-workspace` test; if none, add `hushh-webapp/components/agent/__tests__/agent-chat-selection.test.tsx`.

**Interfaces:**

- Consumes: `describeSelection` (Task 5), `SelectionChip` (Task 7), `AgentChatMessage.metadata` (Task 6), `sendDelegateResult` (existing, ~2356).
- Produces: on selection, a local `AgentMessage` with `kind: "selection"` + `text = display`; `delegate_result.display` set; history messages with `metadata.kind === "selection"` render via `SelectionChip`.

- [ ] **Step 1: Extend the local message type**

In `agent-chat-workspace.tsx`, add an optional discriminator to `AgentMessage` (~111):

```ts
type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  status?: "streaming" | "done" | "error";
  ephemeral?: boolean;
  kind?: "selection";
};
```

- [ ] **Step 2: Append a chip + set display in the prompt `onAnswer`/`onConfirm`/`onCancel` handlers**

In the `SpecialistPromptCard` render (~3514-3565), compute a display and append a chip before each `sendDelegateResult`. Replace the `onAnswer` handler body (~3517-3534) with:

```tsx
                    onAnswer={async (refs) => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive.payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, { selected: refs });
                      setSpecialistBusy(true);
                      try {
                        setPendingSpecialistDirective(null);
                        appendMessage({
                          id: `msg-${Date.now()}-sel`,
                          role: "user",
                          text: display,
                          timestamp: formatNow(),
                          status: "done",
                          kind: "selection",
                        });
                        await sendDelegateResult({
                          delegate_agent_id: evt.delegateAgentId as "agent_location",
                          kind: "selection",
                          id: prompt.id,
                          promptKind: prompt.kind,
                          selected: refs,
                          status: "answered",
                          display,
                        });
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
```

Apply the same pattern to `onConfirm` (use `describeSelection(prompt, { confirmed: yes })`, append chip, add `display`) and `onCancel` (use `describeSelection(prompt, { status: "cancelled" })`, append chip, add `display`). Import `describeSelection` at the top:

```ts
import { describeSelection } from "@/lib/agent/describe-selection";
```

- [ ] **Step 3: Append a chip for the action card confirm/cancel**

In the `SpecialistDirectiveCard` render (~3568-3619), the action summary is the card's `summary`. On confirm, append a chip with the confirm label; on cancel, append "Cancelled". In `onConfirm` (~3575), right after `setSpecialistBusy(true)` and before running crypto, append:

```tsx
appendMessage({
  id: `msg-${Date.now()}-act`,
  role: "user",
  text: "Share",
  timestamp: formatNow(),
  status: "done",
  kind: "selection",
});
```

In `onCancel` (~3603), append a chip with text `"Cancelled"` before `sendDelegateResult`.

- [ ] **Step 4: Render selection messages as chips + write the failing test**

Where messages are mapped to `MessageBubble` (search for `messages.map(`), branch on `message.kind === "selection"` to render `SelectionChip`:

```tsx
{
  messages.map((message) =>
    message.kind === "selection" ? (
      <SelectionChip key={message.id} label={message.text} />
    ) : (
      <MessageBubble
        key={message.id}
        message={message} /* …existing props… */
      />
    ),
  );
}
```

Import `SelectionChip`:

```ts
import { SelectionChip } from "@/components/agent/selection-chip";
```

Add the failing test (adjust import/harness to match existing workspace tests):

```tsx
// hushh-webapp/components/agent/__tests__/agent-chat-selection.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionChip } from "@/components/agent/selection-chip";

// Smoke test the render branch used by the workspace: a selection message
// renders as a chip, never as the raw id seed.
describe("selection rendering", () => {
  it("renders a chip for a selection message", () => {
    render(<SelectionChip label="Abdul Zalil" />);
    expect(screen.getByTestId("selection-chip")).toHaveTextContent(
      "Abdul Zalil",
    );
  });
});
```

- [ ] **Step 5: Map history metadata to selection messages**

Find where `getAgentChatHistory` results are converted into `AgentMessage[]` (search for `getAgentChatHistory` usage in the workspace). For each history message, set `kind` and prefer the display string:

```ts
const mapped: AgentMessage[] = history.map((m) => ({
  id: m.id,
  role: m.role === "assistant" ? "assistant" : "user",
  text:
    m.metadata?.kind === "selection" && m.metadata.display
      ? m.metadata.display
      : m.content,
  timestamp: formatTimestamp(m.created_at), // use the existing timestamp formatter in this file
  status: "done",
  ...(m.metadata?.kind === "selection" ? { kind: "selection" as const } : {}),
}));
```

> Match the existing history-mapping shape in the file (role coercion, timestamp helper). The key change is the `text` fallback to `metadata.display` and setting `kind: "selection"`. This is what removes the raw `I selected:` bubble on reload even for messages persisted before the frontend sent a `display` (the backend fallback in Task 3 guarantees a clean `metadata.display`).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd hushh-webapp && npx vitest run components/agent/__tests__/agent-chat-selection.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/components/agent/agent-chat-workspace.tsx hushh-webapp/components/agent/__tests__/agent-chat-selection.test.tsx
git commit -m "feat(agent-chat): render selections as chips and send display"
```

---

## Task 9: Retheme shared cards to `primary` + collapsed state

**Files:**

- Modify: `hushh-webapp/components/one-location/redesign/clarification-card.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/action-confirm-card.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/cards-primary-theme.test.tsx` (create)

**Interfaces:**

- Consumes: nothing new.
- Produces: both cards render with `primary` tokens; no `#b8894d`/`#d4a574` remain. Behavior/props unchanged (this keeps the central `SpecialistPromptCard`/`SpecialistDirectiveCard` wrappers working and fixes the standalone chat simultaneously).

- [ ] **Step 1: Write the failing test**

```tsx
// hushh-webapp/components/one-location/redesign/__tests__/cards-primary-theme.test.tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";
import { ActionConfirmCard } from "@/components/one-location/redesign/action-confirm-card";
import type { ClientAction, ClientPrompt } from "@/lib/one-location/types";

const prompt: ClientPrompt = {
  id: "p1",
  kind: "select",
  purpose: "recipient",
  question: "Who?",
  options: [{ label: "Mom", ref: { recipientUserId: "m" } }],
};
const action: ClientAction = {
  id: "a1",
  type: "publish_share",
  summary: "Share with Mom",
};
const noop = () => {};

describe("cards use primary theme", () => {
  it("ClarificationCard has no cream tokens", () => {
    const { container } = render(
      <ClarificationCard
        prompt={prompt}
        busy={false}
        onAnswer={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(container.innerHTML).not.toContain("#b8894d");
    expect(container.innerHTML).not.toContain("#d4a574");
  });

  it("ActionConfirmCard has no cream tokens", () => {
    const { container } = render(
      <ActionConfirmCard
        action={action}
        busy={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(container.innerHTML).not.toContain("#b8894d");
    expect(container.innerHTML).not.toContain("#d4a574");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/cards-primary-theme.test.tsx`
Expected: FAIL — both cards still contain `#b8894d`.

- [ ] **Step 3: Retheme `clarification-card.tsx`**

Replace the container className (line ~43):

```tsx
className = "rounded-2xl border border-primary/20 bg-primary/5 p-4";
```

Replace the option-button className expression (lines ~58-63):

```tsx
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors " +
                  (active
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-[color:var(--app-card-border-standard)] text-foreground hover:border-primary/40")
                }
```

- [ ] **Step 4: Retheme `action-confirm-card.tsx`**

Replace the container className (line ~35):

```tsx
className = "rounded-2xl border border-primary/20 bg-primary/5 p-4";
```

Replace the icon color span (line ~38):

```tsx
        <span className="mt-0.5 text-primary">
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/cards-primary-theme.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/clarification-card.tsx hushh-webapp/components/one-location/redesign/action-confirm-card.tsx hushh-webapp/components/one-location/redesign/__tests__/cards-primary-theme.test.tsx
git commit -m "feat(one-location): retheme shared cards to primary palette"
```

---

## Task 10: Retheme location chat surface + append chip on selection

**Files:**

- Modify: `hushh-webapp/components/one-location/redesign/location-chat-message-list.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/location-chat-atoms.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/use-location-chat.ts` (`ChatMessage` ~18; `answerPrompt` ~182; `confirmPrompt` ~191; `cancelPrompt` ~200)
- Test: `hushh-webapp/components/one-location/redesign/__tests__/location-chat-selection.test.tsx` (create)

**Interfaces:**

- Consumes: `describeSelection` (Task 5).
- Produces: location chat bubbles/atoms use `primary`; on card selection the hook appends a `ChatMessage` with `role:"user"` + `kind:"selection"` and the display text.

- [ ] **Step 1: Retheme the message list**

In `location-chat-message-list.tsx`, replace the user bubble className (line ~26):

```tsx
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
```

Replace the retry button color (line ~50):

```tsx
className = "mt-1 text-xs font-semibold text-primary hover:underline";
```

(The assistant bubble already uses `var(--app-card-surface-compact)` — neutral, leave it.)

- [ ] **Step 2: Retheme the atoms**

In `location-chat-atoms.tsx`, replace the `BotAvatar` span className (line ~9):

```tsx
className =
  "flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary";
```

(`StateChangedNote` uses emerald for the "Updated" confirmation — semantic success color, keep it. `TypingIndicator` uses `muted-foreground` — neutral, keep it.)

- [ ] **Step 3: Write the failing test**

```tsx
// hushh-webapp/components/one-location/redesign/__tests__/location-chat-selection.test.tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessageList } from "@/components/one-location/redesign/location-chat-message-list";

describe("location chat theme", () => {
  it("user bubble uses primary, not cream", () => {
    const { container } = render(
      <ChatMessageList
        busy={false}
        messages={[{ id: "1", role: "user", text: "Abdul Zalil" }]}
      />,
    );
    expect(container.innerHTML).not.toContain("#d4a574");
    expect(container.innerHTML).not.toContain("#b8894d");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/location-chat-selection.test.tsx`
Expected: FAIL — still contains `#d4a574`.

- [ ] **Step 5: Append a chip on selection in the hook**

In `use-location-chat.ts`, add `kind` to `ChatMessage` (~18):

```ts
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  stateChanged?: boolean;
  errored?: boolean;
  kind?: "selection";
}
```

Import the helper at the top:

```ts
import { describeSelection } from "@/lib/agent/describe-selection";
```

In `answerPrompt` (~182), append a chip before `reportSelection`:

```ts
const answerPrompt = useCallback(
  async (refs: Record<string, unknown>[]) => {
    const prompt = pendingPrompt;
    if (!prompt || busy) return;
    const display = describeSelection(prompt, { selected: refs });
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: display, kind: "selection" },
    ]);
    await reportSelection({
      id: prompt.id,
      kind: prompt.kind,
      selected: refs,
      status: "answered",
      display,
    });
  },
  [pendingPrompt, busy, reportSelection, nextId],
);
```

Apply the same pattern to `confirmPrompt` (`describeSelection(prompt, { confirmed: yes })`, append chip, pass `display`) and `cancelPrompt` (`describeSelection(prompt, { status: "cancelled" })`, append chip, pass `display`). `SelectionResult.display` already exists (Task 6).

- [ ] **Step 6: Render the chip in the message list**

In `location-chat-message-list.tsx`, in the `messages.map` user branch (line ~24-29), when `message.kind === "selection"` render the shared chip. Import it:

```tsx
import { SelectionChip } from "@/components/agent/selection-chip";
```

Replace the user branch:

```tsx
        message.role === "user" ? (
          message.kind === "selection" ? (
            <SelectionChip key={message.id} label={message.text} />
          ) : (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                {message.text}
              </div>
            </div>
          )
        ) : (
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/location-chat-selection.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-message-list.tsx hushh-webapp/components/one-location/redesign/location-chat-atoms.tsx hushh-webapp/components/one-location/redesign/use-location-chat.ts hushh-webapp/components/one-location/redesign/__tests__/location-chat-selection.test.tsx
git commit -m "feat(one-location): retheme chat to primary and chip selections"
```

---

## Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `cd consent-protocol && pytest tests/test_agent_chat_service_metadata.py tests/test_location_chat_selection_display.py tests/test_agent_chat_history_metadata.py -v` and the existing `tests/test_one_location_*` / agent-chat suites.
Expected: all PASS.

- [ ] **Step 2: Frontend tests + typecheck + lint**

Run: `cd hushh-webapp && npx vitest run lib/agent components/agent components/one-location && npx tsc --noEmit`
Expected: all PASS; no type errors. Confirm no `#b8894d`/`#d4a574` remain on the touched surfaces: `grep -rn "#b8894d\|#d4a574" components/one-location/redesign/{clarification-card,action-confirm-card,location-chat-message-list,location-chat-atoms}.tsx` returns nothing.

- [ ] **Step 3: Manual smoke (both surfaces)**

Drive "share my location with …" in the **central One chat** and in the **standalone Location chat**. Verify: selecting a recipient/duration shows a chip (not raw ids), the card collapses/clears, both surfaces look identical (primary), and reloading history shows chips (no `I selected:` text).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test: verify One+Location chat consistency end to end"
```

---

## Self-Review

**Spec coverage:**

- Consistent styling (both → primary) → Tasks 9, 10 (shared cards + location surface); central chat already primary.
- Visible selection as chip + collapsed card → Tasks 7 (chip), 8 (central: append chip, collapse via clearing `pendingSpecialistDirective`, history chips), 10 (location: append chip, clear prompt).
- Fix raw text at backend source (structured metadata + display, seed internal) → Tasks 1-4.
- Collapsed card default (compact) → cards clear on selection (single-pick auto-answers; the pending directive is set to `null`), which realizes the "collapse to nothing + chip" behavior; a persistent compact summary line was deprioritized per the spec's adjustable default. If a lingering compact summary is desired, it is an additive follow-up to the chip.
- Coordinate-free invariant → enforced in `describeSelection`, `_selection_display_text`, and asserted in Tasks 3 & 5.
- Encrypted metadata → Task 1 (columns) + Task 2 (encrypt/decrypt).

**Placeholder scan:** No unresolved placeholder markers; every code step has concrete code. Line numbers are approximate (marked ~) because files drift; each step names the anchoring symbol to relocate it.

**Type consistency:** `display` is optional across `DelegateResultModel`, `SelectionResultModel`, `DelegateResult`, `SelectionResult`. `metadata` shape `{ kind?, display? }` matches between backend serializer (Task 4), client type (Task 6), and workspace mapping (Task 8). `describeSelection` signature is identical in Tasks 5, 8, 10. `SelectionChip({ label })` identical in Tasks 7, 8, 10.

**Note on "collapsed card":** the approved spec chose "chip + collapsed card" with a compact single-line default. This plan realizes collapse by clearing the active card and leaving the chip as the record of the choice (the established pattern — single-select cards already auto-answer and dismiss). If you want the _source card itself_ to persist as a greyed compact line rather than disappear, say so and I'll add a `collapsed` render branch to Task 9 before execution.
