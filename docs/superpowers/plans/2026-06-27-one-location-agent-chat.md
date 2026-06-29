# One Location Agent Chat (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing `LocationAgent` over `POST /api/one/location/chat` so users can run control-plane location commands (query, revoke, request, deny, refer) conversationally, with multi-turn memory and full consent enforcement preserved.

**Architecture:** A new `LocationChatService` orchestrates each turn: it reuses `AgentChatService` for durable, encrypted conversation persistence, folds recent history into the prompt, and runs the turn through `LocationAgent.handle_message` (the consent-gated ADK path) restricted to a 5-tool control-plane allow-list. A thin FastAPI route under the existing `/api/one` router exposes it; a self-contained React chat panel on `/one/location` calls it and refreshes page state on mutations.

**Tech Stack:** Python / FastAPI / Pydantic / pytest (backend, `consent-protocol/`); TypeScript / Next.js / React / Jest + React Testing Library (frontend, `hushh-webapp/`).

## Visual Map

```text
POST /api/one/location/chat
  → require_vault_owner_token  (token → user_id, consent_token)
  → LocationChatService.handle_turn(user_id, message, consent_token, conversation_id?)
       1. AgentChatService.prepare_turn        (persist user msg, AES-256-GCM at rest)
       2. fold recent history → preamble
       3. direct-Gemini function-calling loop INSIDE HushhContext
            → 5 control-plane @hushh_tool (each re-validates scope)
       4. AgentChatService.add_message(assistant)
       5. → { conversationId, response, isComplete, stateChanged }

Coordinates never enter this path. stateChanged=true only when a mutating tool ran.
```

## Global Constraints

These apply to **every** task. Copied from the approved spec (`docs/superpowers/specs/2026-06-27-one-location-agent-chat-design.md`):

- **Consent enforcement preserved.** Every turn runs inside `HushhContext` via `LocationAgent.handle_message`; each tool re-validates its scope. Never route the LLM turn through the Gemini-direct `AgentChatService.stream_response`/`plan_action` (those bypass consent).
- **Zero server-side plaintext coordinates.** No code added here ever reads, logs, or returns lat/lng. Control-plane tools do not touch coordinates.
- **Non-streaming.** Single JSON response through the synchronous consent-gated path. No SSE.
- **Control-plane only (5 tools).** The agent used by chat must expose exactly: `list_location_recipients`, `revoke_location_share`, `request_location_access`, `deny_location_request`, `refer_location_recipient`. It must NOT expose `create_location_share`, `publish_location_envelope`, `view_location_envelope`, `approve_location_request` (these need a client-crypto handoff — deferred to v2).
- **Encrypted at rest.** Conversation content is persisted only via `AgentChatService` (AES-256-GCM).
- **Opaque errors.** Routes return generic error messages; never leak internal detail.
- **No DB migration.** Reuse `agent_chat_conversations` / `agent_chat_messages` as-is.
- **`user_id` derived from the token**, not the request body (sibling One-location convention).

### Plan-level deviations from the spec (intentional)

1. **`user_id` is token-derived, not in the request body.** The spec mirrored KAI (`user_id` in body + 403 mismatch). The 21 existing One-location routes instead derive `user_id` from the token via `_user_id(token_data)` and use `_CamelModel` camelCase request bodies. We follow the sibling convention — simpler and consistent. No `user_id` field, no 403-mismatch branch.
2. **Conversation `metadata` namespacing deferred.** The spec proposed writing `metadata:{agent:"location"}` on `create_conversation`. That file has no existing JSONB-write pattern (the column relies on its `'{}'` default), making a hand-written JSONB bind driver-risky, and v1 never queries conversations by agent. Per YAGNI we reuse `prepare_turn`/`add_message`/`create_conversation` unchanged and defer namespacing to when conversation listing is actually built.
3. **`stateChanged` is `true` on every successful turn (v1).** `handle_message` does not report which tools ran, so we conservatively signal a refresh whenever the turn succeeds. Harmless (a query turn just triggers one extra state fetch) and guarantees mutations never leave the UI stale. Precise per-tool detection is a v2 concern.

---

### Task 1: Control-plane tool allow-list

Add the 5-tool subset to the location tools module. Pure data; identity-tested so it needs no ADK/runtime.

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/tools.py` (append after `LOCATION_AGENT_TOOLS`, ends line 141)
- Test: `consent-protocol/tests/test_location_chat_tools_allowlist.py`

**Interfaces:**
- Produces: `CONTROL_PLANE_LOCATION_TOOLS: list` — exactly `[list_location_recipients, revoke_location_share, request_location_access, deny_location_request, refer_location_recipient]`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_location_chat_tools_allowlist.py`:

```python
from hushh_mcp.agents.location.tools import (
    CONTROL_PLANE_LOCATION_TOOLS,
    approve_location_request,
    create_location_share,
    deny_location_request,
    list_location_recipients,
    publish_location_envelope,
    refer_location_recipient,
    request_location_access,
    revoke_location_share,
    view_location_envelope,
)


def test_control_plane_is_exactly_the_five_safe_tools():
    assert set(CONTROL_PLANE_LOCATION_TOOLS) == {
        list_location_recipients,
        revoke_location_share,
        request_location_access,
        deny_location_request,
        refer_location_recipient,
    }


def test_control_plane_excludes_crypto_handoff_tools():
    for tool in (
        create_location_share,
        publish_location_envelope,
        view_location_envelope,
        approve_location_request,
    ):
        assert tool not in CONTROL_PLANE_LOCATION_TOOLS
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_allowlist.py -v`
Expected: FAIL — `ImportError: cannot import name 'CONTROL_PLANE_LOCATION_TOOLS'`.

- [ ] **Step 3: Write minimal implementation**

Append to `consent-protocol/hushh_mcp/agents/location/tools.py` (after the existing `LOCATION_AGENT_TOOLS = [...]` list):

```python


# v1 control-plane subset: tools the agent can fully complete server-side with no
# client-side encryption handoff. Excludes create/publish/view/approve, which
# require the client to capture, encrypt, and upload a coordinate envelope.
CONTROL_PLANE_LOCATION_TOOLS = [
    list_location_recipients,
    revoke_location_share,
    request_location_access,
    deny_location_request,
    refer_location_recipient,
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_allowlist.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/tools.py consent-protocol/tests/test_location_chat_tools_allowlist.py
git commit -m "feat(one-location): add control-plane tool allow-list for chat v1"
```

---

### Task 2: Control-plane chat agent factory

Let `LocationAgent` accept a tool override and store it, and add a singleton factory that builds the agent with only the control-plane tools.

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/agent.py`
- Test: `consent-protocol/tests/test_location_chat_agent_factory.py`

**Interfaces:**
- Consumes: `CONTROL_PLANE_LOCATION_TOOLS`, `LOCATION_AGENT_TOOLS` (from Task 1 / existing).
- Produces:
  - `LocationAgent.__init__(self, tools: list | None = None)` — defaults to full `LOCATION_AGENT_TOOLS`; stores the chosen list as `self.hushh_tools`.
  - `get_location_chat_agent() -> LocationAgent` — singleton built with `tools=CONTROL_PLANE_LOCATION_TOOLS`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_location_chat_agent_factory.py`:

```python
from hushh_mcp.agents.location.agent import get_location_chat_agent
from hushh_mcp.agents.location.tools import CONTROL_PLANE_LOCATION_TOOLS


def test_chat_agent_exposes_only_control_plane_tools():
    agent = get_location_chat_agent()
    assert agent.hushh_tools == CONTROL_PLANE_LOCATION_TOOLS


def test_chat_agent_is_singleton():
    assert get_location_chat_agent() is get_location_chat_agent()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_agent_factory.py -v`
Expected: FAIL — `ImportError: cannot import name 'get_location_chat_agent'`.

- [ ] **Step 3: Write minimal implementation**

In `consent-protocol/hushh_mcp/agents/location/agent.py`:

Change the import line (currently `from .tools import LOCATION_AGENT_TOOLS`) to:

```python
from .tools import CONTROL_PLANE_LOCATION_TOOLS, LOCATION_AGENT_TOOLS
```

Replace the `__init__` method (currently lines 20-30) with:

```python
    def __init__(self, tools: list[Any] | None = None) -> None:
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        selected_tools = tools if tools is not None else LOCATION_AGENT_TOOLS
        self.hushh_tools = selected_tools

        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            system_prompt=self.manifest.system_instruction,
            tools=selected_tools,
            required_scopes=self.manifest.required_scopes,
        )
```

Append after the existing `get_location_agent()` function (ends line 59):

```python


_location_chat_agent: LocationAgent | None = None


def get_location_chat_agent() -> LocationAgent:
    """Singleton LocationAgent restricted to v1 control-plane tools (no crypto handoff)."""
    global _location_chat_agent
    if _location_chat_agent is None:
        _location_chat_agent = LocationAgent(tools=CONTROL_PLANE_LOCATION_TOOLS)
    return _location_chat_agent
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_agent_factory.py -v`
Expected: PASS (2 passed). If `ManifestLoader.load` requires optional deps and errors in your env, run the full suite's existing location tests first to confirm baseline; this factory uses the same manifest path as the already-working `get_location_agent`.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/agent.py consent-protocol/tests/test_location_chat_agent_factory.py
git commit -m "feat(one-location): control-plane chat agent factory with tool override"
```

---

### Task 3: LocationChatService (turn orchestration)

Orchestrate one chat turn: persist via `AgentChatService`, fold history, run the agent off the event loop, persist the reply, return a camelCase payload. Dependency-injected for testing.

**Files:**
- Create: `consent-protocol/hushh_mcp/services/location_chat_service.py`
- Test: `consent-protocol/tests/test_location_chat_service.py`

**Interfaces:**
- Consumes: `get_location_chat_agent()` (Task 2); `get_agent_chat_service()`, `AgentChatService.prepare_turn(...) -> PreparedAgentChatTurn` (has `.conversation_id`, `.history`), `AgentChatService.add_message(...)`.
- Produces:
  - `LocationChatService(agent=None, chat_store=None)`
  - `async handle_turn(*, user_id: str, message: str, consent_token: str, conversation_id: str | None = None) -> dict` returning keys `conversationId, response, isComplete, stateChanged`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_location_chat_service.py`:

```python
import pytest

from hushh_mcp.services.location_chat_service import LocationChatService


class _Msg:
    def __init__(self, role: str, content: str) -> None:
        self.role = role
        self.content = content


class _Turn:
    def __init__(self, conversation_id: str, history: list) -> None:
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None) -> None:
        self.history = history or []
        self.added: list[dict] = []
        self.prepare_calls: list[dict] = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        self.prepare_calls.append(
            {"user_id": user_id, "message": message, "conversation_id": conversation_id}
        )
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append(
            {"conversation_id": conversation_id, "role": role, "content": content, "status": status}
        )


class _FakeAgent:
    def __init__(self, result) -> None:
        self.result = result
        self.calls: list[tuple] = []

    def handle_message(self, message, user_id, consent_token=""):
        self.calls.append((message, user_id, consent_token))
        return self.result


@pytest.mark.asyncio
async def test_handle_turn_returns_camelcase_payload_and_persists_reply():
    store = _FakeStore()
    agent = _FakeAgent({"response": "Stopped sharing with Mom.", "is_complete": True})
    service = LocationChatService(agent=agent, chat_store=store)

    out = await service.handle_turn(
        user_id="user_123",
        message="stop sharing with Mom",
        consent_token="vault-token",
        conversation_id=None,
    )

    assert out == {
        "conversationId": "conv-new",
        "response": "Stopped sharing with Mom.",
        "isComplete": True,
        "stateChanged": True,
    }
    # consent token reaches the agent
    assert agent.calls[0][1] == "user_123"
    assert agent.calls[0][2] == "vault-token"
    # assistant reply persisted as complete
    assert store.added[0]["role"] == "assistant"
    assert store.added[0]["status"] == "complete"
    assert store.added[0]["content"] == "Stopped sharing with Mom."


@pytest.mark.asyncio
async def test_handle_turn_folds_history_into_prompt():
    store = _FakeStore(history=[_Msg("user", "who can see me"), _Msg("assistant", "Mom and Dad.")])
    agent = _FakeAgent({"response": "ok", "is_complete": True})
    service = LocationChatService(agent=agent, chat_store=store)

    await service.handle_turn(
        user_id="u", message="stop the first one", consent_token="t", conversation_id="c1"
    )

    composed = agent.calls[0][0]
    assert "User: who can see me" in composed
    assert "Assistant: Mom and Dad." in composed
    assert "Latest user message:\nstop the first one" in composed


@pytest.mark.asyncio
async def test_handle_turn_marks_error_without_state_change():
    store = _FakeStore()
    agent = _FakeAgent({"response": "I cannot complete that.", "error": "PermissionError"})
    service = LocationChatService(agent=agent, chat_store=store)

    out = await service.handle_turn(
        user_id="u", message="do something", consent_token="t"
    )

    assert out["stateChanged"] is False
    assert out["isComplete"] is False
    assert store.added[0]["status"] == "error"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hushh_mcp.services.location_chat_service'`.

- [ ] **Step 3: Write minimal implementation**

Create `consent-protocol/hushh_mcp/services/location_chat_service.py`:

```python
"""Control-plane chat orchestration for the One Location agent (v1).

Reuses AgentChatService ONLY for durable, encrypted conversation persistence.
The LLM turn runs through LocationAgent.handle_message (the consent-gated ADK
path) restricted to control-plane tools — never through the Gemini-direct
streaming path, which would bypass consent enforcement.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from hushh_mcp.agents.location.agent import get_location_chat_agent
from hushh_mcp.services.agent_chat_service import get_agent_chat_service

logger = logging.getLogger(__name__)

_MAX_HISTORY_CHARS = 2000


def _format_history(history: list[Any]) -> str:
    lines: list[str] = []
    for message in history:
        role = getattr(message, "role", "")
        if role not in ("user", "assistant"):
            continue
        speaker = "User" if role == "user" else "Assistant"
        content = (getattr(message, "content", "") or "")[:_MAX_HISTORY_CHARS]
        lines.append(f"{speaker}: {content}")
    return "\n".join(lines)


class LocationChatService:
    def __init__(self, *, agent: Any = None, chat_store: Any = None) -> None:
        self._agent = agent if agent is not None else get_location_chat_agent()
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str,
        consent_token: str,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        turn = await self._chat_store.prepare_turn(
            user_id=user_id,
            message=message,
            conversation_id=conversation_id,
        )

        preamble = _format_history(turn.history)
        composed = (
            f"{preamble}\n\nLatest user message:\n{message}" if preamble else message
        )

        # handle_message is synchronous (wraps a blocking LLM call); run it off
        # the event loop so the async route stays responsive.
        result = await asyncio.to_thread(
            self._agent.handle_message,
            composed,
            user_id,
            consent_token,
        )

        reply = result.get("response", "")
        errored = "error" in result

        await self._chat_store.add_message(
            conversation_id=turn.conversation_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )

        return {
            "conversationId": turn.conversation_id,
            "response": reply,
            "isComplete": bool(result.get("is_complete", not errored)),
            # v1: refresh on every successful turn (handle_message does not report
            # which tools ran). Precise per-tool detection is a v2 concern.
            "stateChanged": not errored,
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_service.py -v`
Expected: PASS (3 passed).

If `pytest.mark.asyncio` is unsupported, confirm `pytest-asyncio` is configured (it is used elsewhere in this suite — check `consent-protocol/pyproject.toml` / `pytest.ini` for `asyncio_mode`). If `asyncio_mode = auto`, remove the `@pytest.mark.asyncio` decorators.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/location_chat_service.py consent-protocol/tests/test_location_chat_service.py
git commit -m "feat(one-location): LocationChatService turn orchestration (v1 control-plane)"
```

---

### Task 4: Chat route + router wiring

Expose `POST /api/one/location/chat` and mount it under the existing `one` router.

**Files:**
- Create: `consent-protocol/api/routes/one/location_chat.py`
- Modify: `consent-protocol/api/routes/one/__init__.py`
- Test: `consent-protocol/tests/test_location_chat_routes.py`

**Interfaces:**
- Consumes: `require_vault_owner_token` (returns `{"user_id", "token", ...}`); `LocationChatService.handle_turn(...)` (Task 3).
- Produces: `router` (APIRouter, prefix `/api/one`) with `POST /location/chat`; `_service()` factory (monkeypatch point); `LocationChatRequest` model.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_location_chat_routes.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location_chat


def _build_app(user_id: str = "user_123") -> TestClient:
    app = FastAPI()
    app.include_router(location_chat.router)
    app.dependency_overrides[location_chat.require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "scope": "vault.owner",
        "token": "vault-token",
    }
    return TestClient(app)


def test_chat_route_happy_path(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(self, *, user_id, message, consent_token, conversation_id=None):
            captured.update(
                {
                    "user_id": user_id,
                    "message": message,
                    "consent_token": consent_token,
                    "conversation_id": conversation_id,
                }
            )
            return {
                "conversationId": "conv-1",
                "response": "Stopped sharing with Mom.",
                "isComplete": True,
                "stateChanged": True,
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app(user_id="user_123")

    response = client.post(
        "/api/one/location/chat",
        json={"message": "stop sharing with Mom"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["conversationId"] == "conv-1"
    assert body["stateChanged"] is True
    # user_id comes from the token, consent token is forwarded
    assert captured["user_id"] == "user_123"
    assert captured["consent_token"] == "vault-token"
    assert captured["message"] == "stop sharing with Mom"


def test_chat_route_accepts_conversation_id_camel_alias(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(self, *, user_id, message, consent_token, conversation_id=None):
            captured["conversation_id"] = conversation_id
            return {"conversationId": conversation_id, "response": "ok", "isComplete": True, "stateChanged": True}

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post(
        "/api/one/location/chat",
        json={"message": "hi", "conversationId": "conv-9"},
    )

    assert response.status_code == 200
    assert captured["conversation_id"] == "conv-9"


def test_chat_route_rejects_empty_message(monkeypatch):
    monkeypatch.setattr(location_chat, "_service", lambda: object())
    client = _build_app()

    response = client.post("/api/one/location/chat", json={"message": ""})

    assert response.status_code == 422


def test_chat_route_returns_opaque_error_on_failure(monkeypatch):
    class _Service:
        async def handle_turn(self, **kwargs):
            raise RuntimeError("secret internal detail")

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post("/api/one/location/chat", json={"message": "do it"})

    assert response.status_code == 500
    assert "secret internal detail" not in response.text
    assert response.json()["detail"] == "Location chat could not be processed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_routes.py -v`
Expected: FAIL — `ImportError: cannot import name 'location_chat' from 'api.routes.one'`.

- [ ] **Step 3: Write minimal implementation**

Create `consent-protocol/api/routes/one/location_chat.py`:

```python
"""One Location agent chat endpoint (v1, control-plane, non-streaming)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.location_chat_service import LocationChatService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Location Agent Chat"])


def _service() -> LocationChatService:
    return LocationChatService()


class LocationChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = Field(
        default=None, alias="conversationId", max_length=128
    )


@router.post("/location/chat")
async def location_chat(
    request: LocationChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        return await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
        )
    except Exception:
        logger.exception("Location chat turn failed")
        raise HTTPException(
            status_code=500, detail="Location chat could not be processed"
        )
```

Modify `consent-protocol/api/routes/one/__init__.py` to include the new router:

```python
"""One product-shell API routes."""

from fastapi import APIRouter

from .email import router as email_router
from .location import router as location_router
from .location_chat import router as location_chat_router

router = APIRouter()
router.include_router(email_router)
router.include_router(location_router)
router.include_router(location_chat_router)

__all__ = ["router"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_routes.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full new-file suite + import the server to confirm wiring**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_allowlist.py tests/test_location_chat_agent_factory.py tests/test_location_chat_service.py tests/test_location_chat_routes.py -v`
Expected: all PASS.

Run: `cd consent-protocol && python -c "import server"`
Expected: no error (router mounts cleanly).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/api/routes/one/location_chat.py consent-protocol/api/routes/one/__init__.py consent-protocol/tests/test_location_chat_routes.py
git commit -m "feat(one-location): POST /api/one/location/chat route (v1 control-plane)"
```

---

### Task 5: Frontend service method

Add `OneLocationService.chat(...)` and its response type.

**Files:**
- Modify: `hushh-webapp/lib/one-location/types.ts` (add `LocationChatResponse`)
- Modify: `hushh-webapp/lib/one-location/service.ts` (add `chat` + import the type)
- Test: `hushh-webapp/__tests__/services/location-chat-service.test.ts`

**Interfaces:**
- Produces:
  - `interface LocationChatResponse { conversationId: string; response: string; isComplete: boolean; stateChanged: boolean }`
  - `OneLocationService.chat(params: { vaultOwnerToken: string; message: string; conversationId?: string | null }): Promise<LocationChatResponse>`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/services/location-chat-service.test.ts`:

```ts
import { OneLocationService } from "@/lib/one-location/service";
import { apiJson } from "@/lib/services/api-client";

jest.mock("@/lib/services/api-client", () => ({
  apiJson: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockApiJson = apiJson as jest.MockedFunction<typeof apiJson>;

describe("OneLocationService.chat", () => {
  beforeEach(() => mockApiJson.mockReset());

  it("posts message + conversationId to the chat endpoint with auth header", async () => {
    mockApiJson.mockResolvedValue({
      conversationId: "conv-1",
      response: "Stopped sharing with Mom.",
      isComplete: true,
      stateChanged: true,
    });

    const result = await OneLocationService.chat({
      vaultOwnerToken: "vault-token",
      message: "stop sharing with Mom",
      conversationId: "conv-1",
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/location/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "stop sharing with Mom", conversationId: "conv-1" }),
    });
    expect(result.stateChanged).toBe(true);
  });

  it("sends null conversationId when not provided", async () => {
    mockApiJson.mockResolvedValue({
      conversationId: "conv-new",
      response: "ok",
      isComplete: true,
      stateChanged: true,
    });

    await OneLocationService.chat({ vaultOwnerToken: "t", message: "hi" });

    const body = JSON.parse((mockApiJson.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ message: "hi", conversationId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npm test -- location-chat-service`
Expected: FAIL — `OneLocationService.chat is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `hushh-webapp/lib/one-location/types.ts`:

```ts
export interface LocationChatResponse {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
}
```

In `hushh-webapp/lib/one-location/service.ts`, add `LocationChatResponse` to the existing type import block (the `import type { ... } from "@/lib/one-location/types"` list, lines 3-17), then add this static method inside the `OneLocationService` class (e.g. directly after `getState`, around line 142):

```ts
  static async chat(params: {
    vaultOwnerToken: string;
    message: string;
    conversationId?: string | null;
  }): Promise<LocationChatResponse> {
    return apiJson<LocationChatResponse>("/api/one/location/chat", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        message: params.message,
        conversationId: params.conversationId ?? null,
      }),
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npm test -- location-chat-service`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/one-location/types.ts hushh-webapp/lib/one-location/service.ts hushh-webapp/__tests__/services/location-chat-service.test.ts
git commit -m "feat(one-location): OneLocationService.chat client method"
```

---

### Task 6: Chat panel component

A self-contained presentational+stateful panel: holds messages + conversationId, calls `OneLocationService.chat`, and invokes `onStateChanged` when the response says state changed.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`
- Test: `hushh-webapp/__tests__/components/location-chat-panel.test.tsx`

**Interfaces:**
- Consumes: `OneLocationService.chat` (Task 5).
- Produces: `export function LocationChatPanel(props: { vaultOwnerToken: string; onStateChanged?: () => void })` — default export not required; named export.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/components/location-chat-panel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocationChatPanel } from "@/components/one-location/redesign/location-chat-panel";
import { OneLocationService } from "@/lib/one-location/service";

jest.mock("@/lib/one-location/service", () => ({
  OneLocationService: { chat: jest.fn() },
}));

const mockChat = OneLocationService.chat as jest.MockedFunction<typeof OneLocationService.chat>;

describe("LocationChatPanel", () => {
  beforeEach(() => mockChat.mockReset());

  it("sends a message and renders the assistant reply", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-1",
      response: "Stopped sharing with Mom.",
      isComplete: true,
      stateChanged: true,
    });

    render(<LocationChatPanel vaultOwnerToken="vault-token" />);

    fireEvent.change(screen.getByTestId("location-chat-input"), {
      target: { value: "stop sharing with Mom" },
    });
    fireEvent.click(screen.getByTestId("location-chat-send"));

    await waitFor(() =>
      expect(screen.getByText("Stopped sharing with Mom.")).toBeInTheDocument(),
    );
    expect(mockChat).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      message: "stop sharing with Mom",
      conversationId: null,
    });
  });

  it("calls onStateChanged when the response reports a state change", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-1",
      response: "Done.",
      isComplete: true,
      stateChanged: true,
    });
    const onStateChanged = jest.fn();

    render(<LocationChatPanel vaultOwnerToken="t" onStateChanged={onStateChanged} />);
    fireEvent.change(screen.getByTestId("location-chat-input"), {
      target: { value: "revoke all" },
    });
    fireEvent.click(screen.getByTestId("location-chat-send"));

    await waitFor(() => expect(onStateChanged).toHaveBeenCalledTimes(1));
  });

  it("reuses the conversationId returned by the first turn", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-42",
      response: "ok",
      isComplete: true,
      stateChanged: false,
    });

    render(<LocationChatPanel vaultOwnerToken="t" />);
    const input = screen.getByTestId("location-chat-input");
    const send = screen.getByTestId("location-chat-send");

    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.click(send);
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.click(send);
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));

    expect(mockChat.mock.calls[1][0].conversationId).toBe("conv-42");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npm test -- location-chat-panel`
Expected: FAIL — cannot find module `location-chat-panel`.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`:

```tsx
"use client";

import { useCallback, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";

interface ChatLine {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function LocationChatPanel(props: {
  vaultOwnerToken: string;
  onStateChanged?: () => void;
}) {
  const { vaultOwnerToken, onStateChanged } = props;
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;

    setBusy(true);
    setError(null);
    setInput("");
    setLines((prev) => [
      ...prev,
      { id: `u-${prev.length}`, role: "user", text: message },
    ]);

    try {
      const result = await OneLocationService.chat({
        vaultOwnerToken,
        message,
        conversationId,
      });
      setConversationId(result.conversationId);
      setLines((prev) => [
        ...prev,
        { id: `a-${prev.length}`, role: "assistant", text: result.response },
      ]);
      if (result.stateChanged) onStateChanged?.();
    } catch {
      setError("Sorry — that location command could not be processed.");
    } finally {
      setBusy(false);
    }
  }, [input, busy, vaultOwnerToken, conversationId, onStateChanged]);

  return (
    <div data-testid="location-chat-panel">
      <div data-testid="location-chat-log">
        {lines.map((line) => (
          <p key={line.id} data-role={line.role}>
            {line.text}
          </p>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <input
          data-testid="location-chat-input"
          value={input}
          disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder="Ask: who can see me? / stop sharing with…"
          aria-label="Ask the location assistant"
        />
        <button
          type="button"
          data-testid="location-chat-send"
          disabled={busy}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npm test -- location-chat-panel`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-panel.tsx hushh-webapp/__tests__/components/location-chat-panel.test.tsx
git commit -m "feat(one-location): location chat panel component"
```

---

### Task 7: Wire the panel into the location page

Render `LocationChatPanel` on `/one/location`, passing the page's vault owner token and an `onStateChanged` that refreshes page state and notifies the consent surface.

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx`
- Verify: existing page test `hushh-webapp/__tests__/components/one-location-agent-page.test.tsx` still passes.

**Interfaces:**
- Consumes: `LocationChatPanel` (Task 6); the page's existing `refresh()` callback and its vault-owner-token value (already used by the page's other `OneLocationService` calls).

- [ ] **Step 1: Add the import**

Near the other component imports at the top of `hushh-webapp/app/one/location/page.tsx`, add:

```tsx
import { LocationChatPanel } from "@/components/one-location/redesign/location-chat-panel";
```

- [ ] **Step 2: Render the panel**

Inside the page's main authenticated content (where the hub / compose surface is rendered — locate the existing `OneLocationService.getState`/`refresh` usage to find the token variable name and the `refresh` callback), add the panel. Use the exact token variable and `refresh` function already present in the component (commonly `vaultOwnerToken` and `refresh`):

```tsx
<LocationChatPanel
  vaultOwnerToken={vaultOwnerToken}
  onStateChanged={() => {
    void refresh();
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("consent-state-changed", {
          detail: { source: "one_location_chat" },
        }),
      );
    }
  }}
/>
```

Notes for the implementer:
- If the token is held under a different identifier in this file, use that identifier — grep the file for `vaultOwnerToken` / `getState(` to confirm the exact name before editing.
- `"consent-state-changed"` is the literal value of `CONSENT_STATE_CHANGED_EVENT` from `hushh-webapp/lib/consent/consent-events.ts`; the consent center and this page already listen for it. If that module exports a dispatch helper, prefer importing and calling it over the raw `window.dispatchEvent`.

- [ ] **Step 3: Typecheck + run the existing page test**

Run: `cd hushh-webapp && npm test -- one-location-agent-page`
Expected: PASS (existing page test still green — the panel addition must not break it).

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no type errors in `app/one/location/page.tsx` (resolve any unresolved identifier by matching the real token/refresh names).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the app per the repo's run instructions, open `/one/location`, type "who can see me?" and confirm a reply renders; type "stop sharing with <name>" and confirm the active-shares list refreshes.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/app/one/location/page.tsx
git commit -m "feat(one-location): surface chat panel on /one/location with refresh-on-change"
```

---

## Final Verification

- [ ] Backend: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_allowlist.py tests/test_location_chat_agent_factory.py tests/test_location_chat_service.py tests/test_location_chat_routes.py -v` — all green.
- [ ] Backend wiring: `cd consent-protocol && python -c "import server"` — no error.
- [ ] Frontend: `cd hushh-webapp && npm test -- location-chat` — service + panel suites green.
- [ ] Frontend: existing `one-location-agent-page` test still green; `npx tsc --noEmit` clean.
- [ ] Constraint audit: confirm no file added here imports `AgentChatService.stream_response`/`plan_action`; confirm the chat agent is built only from `CONTROL_PLANE_LOCATION_TOOLS`; confirm no coordinate keys appear anywhere in the new code.

## Self-Review Notes (author)

- **Spec coverage:** endpoint (T4), consent-gated turn (T3), control-plane restriction (T1+T2), multi-turn persistence reuse (T3), frontend panel + service (T5/T6), page wiring + refresh/consent sync (T7), testing strategy (every task). Coordinate-safety & opaque errors enforced in T3/T4 and the final audit.
- **Deferred vs spec:** `metadata` namespacing and `user_id`-in-body+403 — both documented under "Plan-level deviations" with rationale.
- **Type consistency:** `handle_turn` returns `{conversationId, response, isComplete, stateChanged}` consumed identically by the route (T4), the TS `LocationChatResponse` (T5), and the panel (T6). Agent factory `hushh_tools` attribute defined in T2 and asserted in T2's test.
