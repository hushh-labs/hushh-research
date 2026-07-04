# One → Location over A2A (central chat, slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the central "Ask your agent anything" chat perform the Location specialist's full flow (share / request / view / public-link, with browser-side crypto) by having One delegate the turn to Location over an in-process, A2A-shaped contract and relay Location's coordinate-free directives back into the one chat.

**Architecture:** One (the central `agent_chat_service` stream route) gains a fail-closed *delegation decision*. When a turn classifies as `location`, One skips its local action-planner and calls an in-process A2A **dispatch** seam → a **LocationAgentA2A** handler that wraps Location's *existing* `LocationChatService.handle_turn` loop (unchanged) and returns a generic **directive envelope**. The route relays that envelope as additive SSE frames (`specialist_directive`) and accepts a `delegate_result` follow-up round-trip. Everything non-location keeps its exact current path.

**Tech Stack:** Python 3 / FastAPI / `google.genai` (backend, `consent-protocol/`), `pytest` (`uv run python -m pytest`); Next.js / React / TypeScript (frontend, `hushh-webapp/`), `vitest` (`npm run test`), `tsc --noEmit`.

## Visual Map

```text
Central "Ask your agent anything" chat  →  One (router/relay)  →  Location over in-process A2A

Browser (AgentChatWorkspace)                 │  Server
─────────────────────────────────────────── │  ──────────────────────────────────────────────
"share my location with Mom"                 │  /agent/chat/stream
  POST /agent/chat/stream ───────────────────►  classify → location? (fail-closed)
                                             │     └─ build A2ATask ──► dispatch("agent_location")
                                             │            └─ LocationAgentA2A → LocationChatService
                                             │               (existing tool loop, HushhContext)
       ◄── SSE: specialist_directive ────────┘               returns coordinate-free directive
  render directive card (action | prompt)    │
   confirm ► runLocationDirective (capture+encrypt in browser; JWK from getState)
   POST { delegate_result } ─────────────────►  dispatch → LocationAgentA2A → confirm turn
       ◄── SSE: token + complete ────────────┘

Task map: (1) classifier route → (2) A2A contract+dispatch → (3) LocationAgentA2A →
(4) register agent_location → (5) delegation helpers → (6) route branch →
(7) SSE client → (8) directive runtime → (9) card+workspace → (10) verification.
Non-location turns bypass all of this and keep the existing planner path.
```

## Global Constraints

- **Zero regression:** existing Kai action-plan turns, text turns, and the standalone `/api/one/location/chat` flow must behave identically. Only `location`-classified turns are intercepted; the classifier is **fail-closed** (no match → existing path).
- **Only wired specialists are delegated:** slice 1 wires `agent_location` only. `finance`/`privacy_consent`/`kyc_identity_workflow` classifications must fall through to the existing central planner unchanged.
- **In-process, A2A-shaped:** One→Location is a Python call through `dispatch(agent_id, task)`; the message/consent/directive contract is transport-agnostic so a later network swap changes only `dispatch`.
- **Coordinate-free by construction:** One and every A2A payload (`directive`, `delegate_result`) never carry latitude/longitude. Capture/encrypt/decrypt stay in the browser. No new plaintext coordinates in SSE, logs, or persisted messages.
- **Consent enforcement unchanged:** for in-process slice 1 the real gate stays the per-`@hushh_tool` scope validation inside `HushhContext` (identical to today's working Location chat). No new boundary pre-gate that could reject currently-valid tokens. (A boundary `validate_a2a_consent_token` gate is added later with network A2A — deferred.)
- **Additive SSE only:** existing frames (`start`, `tool_start`, `token`, `tool_waiting`, `tool_result`, `complete`, `error`) are untouched. New frames: `specialist_directive`; new optional request field: `delegate_result`.
- **Spec:** `docs/superpowers/specs/2026-07-02-one-a2a-location-central-chat-design.md`.

---

## File Structure

**Backend (`consent-protocol/`)**
- `hushh_mcp/agents/orchestrator/tools.py` — *modify:* add a `location` route to `_SPECIALIST_ROUTES` (shared classifier).
- `hushh_mcp/adk_bridge/contract.py` — *create:* the transport-agnostic dataclasses `A2ATask`, `A2ADirective`, `SpecialistTurnResult`.
- `hushh_mcp/adk_bridge/location_agent.py` — *create:* `LocationAgentA2A` handler wrapping `LocationChatService`.
- `hushh_mcp/adk_bridge/dispatch.py` — *create:* in-process `dispatch(agent_id, task)` registry + `is_wired_specialist(agent_id)`.
- `hushh_mcp/adk_bridge/delegation.py` — *modify:* register `agent_location` in the agent-card/scope registry.
- `api/routes/kai/agent_chat.py` — *modify:* request model + delegation branch + new SSE frames.
- Tests: `tests/test_orchestrator_location_route.py`, `tests/test_adk_dispatch.py`, `tests/test_location_agent_a2a.py`, `tests/test_agent_chat_delegation.py`.

**Frontend (`hushh-webapp/`)**
- `lib/services/agent-chat-client.ts` — *modify:* `specialist_directive` event + `delegateResult` request field + types.
- `components/agent/specialist-directive-card.tsx` — *create:* presentational action/prompt card.
- `lib/agent/specialist-directive-runtime.ts` — *create:* location directive → browser crypto dispatch (reuses `lib/one-location/*`).
- `components/agent/agent-chat-workspace.tsx` — *modify:* consume `specialist_directive`, render card, run dispatch, post `delegate_result`.
- Tests: `lib/services/__tests__/agent-chat-client.specialist.test.ts`, `lib/agent/__tests__/specialist-directive-runtime.test.ts`.

---

## Task 1: Add a `location` route to the shared classifier

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/orchestrator/tools.py` (`_SPECIALIST_ROUTES`) (`_SPECIALIST_ROUTES`)
- Test: `consent-protocol/tests/test_orchestrator_location_route.py`

**Interfaces:**
- Consumes: existing `classify_specialist_domain(message) -> Optional[tuple[str, str]]`.
- Produces: `classify_specialist_domain("share my location with Mom")` returns `("location", "agent_location")`; unrelated finance/privacy/kyc messages keep their existing targets; general chat returns `None`.

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_orchestrator_location_route.py
"""The shared classifier must route location intents to agent_location
without stealing finance/privacy/kyc/general turns (fail-closed)."""

import pytest

from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.mark.parametrize(
    "message",
    [
        "share my location with Mom for an hour",
        "where is Dad right now",
        "show me my live location sharing",
        "make a public link to my location",
    ],
)
def test_location_intents_route_to_agent_location(message):
    assert classify_specialist_domain(message) == ("location", "agent_location")


@pytest.mark.parametrize(
    "message,expected",
    [
        ("rebalance my portfolio", ("finance", "agent_kai")),
        ("who has access to my vault", ("privacy_consent", "agent_nav")),
        ("upload my passport for kyc", ("kyc_identity_workflow", "agent_kyc")),
    ],
)
def test_non_location_intents_unchanged(message, expected):
    assert classify_specialist_domain(message) == expected


def test_general_chat_stays_with_one():
    assert classify_specialist_domain("good morning, how are you") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_orchestrator_location_route.py -v`
Expected: FAIL — location cases return `None` (no location route yet).

- [ ] **Step 3: Add the location route**

Append a fourth entry to `_SPECIALIST_ROUTES` (after the `kyc_identity_workflow` tuple, before the closing `)` at line 85). Keep cues tight so they cannot collide with finance/privacy/kyc cues:

```python
    (
        "location",
        "agent_location",
        (
            "location",
            "where is",
            "where am i",
            "share my location",
            "live location",
        ),
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_orchestrator_location_route.py -v`
Expected: PASS (all cases).

- [ ] **Step 5: Guard against regressions in existing classifier tests**

Run: `cd consent-protocol && uv run python -m pytest tests/ -k "orchestrator or classify" -q`
Expected: PASS (no existing test asserts the route count).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/orchestrator/tools.py consent-protocol/tests/test_orchestrator_location_route.py
git commit -m "feat(one): route location intents to agent_location in shared classifier"
```

---

## Task 2: Transport-agnostic A2A contract + in-process dispatch

**Files:**
- Create: `consent-protocol/hushh_mcp/adk_bridge/contract.py`
- Create: `consent-protocol/hushh_mcp/adk_bridge/dispatch.py`
- Test: `consent-protocol/tests/test_adk_dispatch.py`

**Interfaces:**
- Produces:
  - `A2ATask(user_id: str, consent_token: str, conversation_id: str | None, message: str | None = None, delegate_result: dict | None = None)`
  - `A2ADirective(kind: Literal["action","prompt"], payload: dict)`
  - `SpecialistTurnResult(conversation_id: str, text: str, directive: A2ADirective | None, is_complete: bool, state_changed: bool, model: str)`
  - `register_specialist(agent_id: str, handler: Callable[[A2ATask], Awaitable[SpecialistTurnResult]]) -> None`
  - `async dispatch(agent_id: str, task: A2ATask) -> SpecialistTurnResult`
  - `is_wired_specialist(agent_id: str) -> bool`

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_adk_dispatch.py
"""In-process A2A dispatch: register a handler, route a task to it, and
fail closed on unknown/unwired specialists."""

import pytest

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult
from hushh_mcp.adk_bridge import dispatch as dispatch_mod


@pytest.fixture(autouse=True)
def _clear_registry():
    dispatch_mod._REGISTRY.clear()
    yield
    dispatch_mod._REGISTRY.clear()


@pytest.mark.asyncio
async def test_dispatch_routes_to_registered_handler():
    async def handler(task: A2ATask) -> SpecialistTurnResult:
        return SpecialistTurnResult(
            conversation_id=task.conversation_id or "c1",
            text=f"echo:{task.message}",
            directive=A2ADirective(kind="action", payload={"type": "publish_share"}),
            is_complete=True,
            state_changed=False,
            model="test-model",
        )

    dispatch_mod.register_specialist("agent_location", handler)
    assert dispatch_mod.is_wired_specialist("agent_location") is True

    task = A2ATask(user_id="u1", consent_token="t", conversation_id=None, message="hi")
    result = await dispatch_mod.dispatch("agent_location", task)
    assert result.text == "echo:hi"
    assert result.directive.kind == "action"


@pytest.mark.asyncio
async def test_dispatch_unknown_specialist_raises():
    assert dispatch_mod.is_wired_specialist("agent_nope") is False
    with pytest.raises(KeyError):
        await dispatch_mod.dispatch("agent_nope", A2ATask(user_id="u", consent_token="t", conversation_id=None))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_adk_dispatch.py -v`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Create the contract dataclasses**

```python
# consent-protocol/hushh_mcp/adk_bridge/contract.py
"""Transport-agnostic A2A delegation contract.

These types are the ONLY thing One and a specialist agree on. For slice 1 the
transport is an in-process function call; a later network A2A swap reuses these
exact shapes over HTTP without touching callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class A2ATask:
    """One → specialist. Coordinate-free by construction."""

    user_id: str
    consent_token: str
    conversation_id: str | None
    message: str | None = None
    delegate_result: dict | None = None


@dataclass(frozen=True)
class A2ADirective:
    """A specialist's client-side instruction. ``payload`` is the specialist's
    existing coordinate-free descriptor (e.g. Location's clientAction/clientPrompt)."""

    kind: Literal["action", "prompt"]
    payload: dict


@dataclass(frozen=True)
class SpecialistTurnResult:
    """specialist → One. Coordinate-free by construction."""

    conversation_id: str
    text: str
    directive: A2ADirective | None
    is_complete: bool
    state_changed: bool
    model: str
```

- [ ] **Step 4: Create the dispatch registry**

```python
# consent-protocol/hushh_mcp/adk_bridge/dispatch.py
"""In-process A2A dispatch seam.

Slice 1: a Python call. To go network-A2A later, replace ``dispatch`` with an
HTTP client keyed by ``agent_id``; the contract (contract.py) is unchanged.
"""

from __future__ import annotations

from typing import Awaitable, Callable

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult

SpecialistHandler = Callable[[A2ATask], Awaitable[SpecialistTurnResult]]

_REGISTRY: dict[str, SpecialistHandler] = {}


def register_specialist(agent_id: str, handler: SpecialistHandler) -> None:
    _REGISTRY[agent_id] = handler


def is_wired_specialist(agent_id: str) -> bool:
    return agent_id in _REGISTRY


async def dispatch(agent_id: str, task: A2ATask) -> SpecialistTurnResult:
    try:
        handler = _REGISTRY[agent_id]
    except KeyError as exc:
        raise KeyError(f"No A2A specialist registered for {agent_id!r}") from exc
    return await handler(task)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_adk_dispatch.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/adk_bridge/contract.py consent-protocol/hushh_mcp/adk_bridge/dispatch.py consent-protocol/tests/test_adk_dispatch.py
git commit -m "feat(a2a): add transport-agnostic delegation contract + in-process dispatch"
```

---

## Task 3: LocationAgentA2A handler wrapping the existing Location loop

**Files:**
- Create: `consent-protocol/hushh_mcp/adk_bridge/location_agent.py`
- Test: `consent-protocol/tests/test_location_agent_a2a.py`

**Interfaces:**
- Consumes: `A2ATask`, `SpecialistTurnResult`, `A2ADirective` (Task 2); `LocationChatService.handle_turn(...) -> dict` returning keys `conversationId`, `response`, `isComplete`, `stateChanged`, optional `clientAction` / `clientPrompt`.
- Produces:
  - `class LocationAgentA2A` with `async handle(task: A2ATask) -> SpecialistTurnResult`.
  - `get_location_a2a() -> LocationAgentA2A` singleton.
  - Mapping rules: `clientPrompt` → `A2ADirective(kind="prompt", payload=clientPrompt)`; else `clientAction` → `A2ADirective(kind="action", payload=clientAction)`; else `directive=None`. `delegate_result` with `kind=="selection"` → `handle_turn(selection_result=...)`; otherwise → `handle_turn(action_result=...)`.

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_location_agent_a2a.py
"""LocationAgentA2A adapts the existing LocationChatService.handle_turn dict
into the generic SpecialistTurnResult envelope, coordinate-free."""

import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.location_agent import LocationAgentA2A


class _FakeLocationService:
    def __init__(self):
        self.calls = []

    async def handle_turn(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("action_result") is not None:
            return {
                "conversationId": "c1",
                "response": "Done — shared for 1h.",
                "isComplete": True,
                "stateChanged": True,
            }
        return {
            "conversationId": "c1",
            "response": "Ready to share with Mom.",
            "isComplete": False,
            "stateChanged": False,
            "clientAction": {"id": "act-1", "type": "publish_share", "shares": [], "summary": "s"},
        }


@pytest.mark.asyncio
async def test_message_turn_maps_client_action_to_directive():
    svc = _FakeLocationService()
    agent = LocationAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(user_id="u", consent_token="t", conversation_id=None, message="share with Mom")
    )
    assert result.text == "Ready to share with Mom."
    assert result.directive is not None
    assert result.directive.kind == "action"
    assert result.directive.payload["type"] == "publish_share"
    assert result.state_changed is False
    # forwarded correctly
    assert svc.calls[0]["message"] == "share with Mom"
    assert svc.calls[0]["user_id"] == "u"
    assert svc.calls[0]["consent_token"] == "t"


@pytest.mark.asyncio
async def test_action_delegate_result_maps_to_action_result_turn():
    svc = _FakeLocationService()
    agent = LocationAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",
            conversation_id="c1",
            delegate_result={"kind": "action", "id": "act-1", "type": "publish_share", "status": "completed"},
        )
    )
    assert result.text == "Done — shared for 1h."
    assert result.state_changed is True
    assert result.directive is None
    assert svc.calls[0]["action_result"] == {"id": "act-1", "type": "publish_share", "status": "completed"}


@pytest.mark.asyncio
async def test_selection_delegate_result_maps_to_selection_turn():
    svc = _FakeLocationService()
    agent = LocationAgentA2A(service=svc)
    await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",
            conversation_id="c1",
            delegate_result={"kind": "selection", "id": "prm-1", "selected": [{"userId": "x"}], "status": "completed"},
        )
    )
    assert "selection_result" in svc.calls[0]
    assert svc.calls[0]["selection_result"]["id"] == "prm-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_agent_a2a.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the handler**

```python
# consent-protocol/hushh_mcp/adk_bridge/location_agent.py
"""In-process A2A handler for the Location specialist.

Wraps the EXISTING LocationChatService.handle_turn loop unchanged and adapts its
dict output into the generic SpecialistTurnResult. Consent is enforced exactly as
today — per-@hushh_tool scope validation inside HushhContext during the loop.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult

# The label surfaced to the client for delegated turns (SSE start/complete "model").
DELEGATED_MODEL = "one+location"

# Keys the location action_result contract accepts (see ActionResultModel).
_ACTION_RESULT_KEYS = ("id", "type", "status", "publicUrl", "detail")
# Keys the location selection_result contract accepts (see SelectionResultModel).
_SELECTION_RESULT_KEYS = ("id", "kind", "selected", "confirmed", "freeText", "status")


def _pick(source: dict, keys: tuple[str, ...]) -> dict:
    return {k: source[k] for k in keys if k in source and source[k] is not None}


class LocationAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.location_chat_service import LocationChatService

            self._service = LocationChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        action_result: dict | None = None
        selection_result: dict | None = None
        if task.delegate_result is not None:
            dr = dict(task.delegate_result)
            if str(dr.get("kind")) == "selection":
                selection_result = _pick(dr, _SELECTION_RESULT_KEYS)
            else:
                action_result = _pick(dr, _ACTION_RESULT_KEYS)

        out: dict = await self._service.handle_turn(
            user_id=task.user_id,
            message=task.message,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
            action_result=action_result,
            selection_result=selection_result,
        )

        directive: A2ADirective | None = None
        if isinstance(out.get("clientPrompt"), dict):
            directive = A2ADirective(kind="prompt", payload=out["clientPrompt"])
        elif isinstance(out.get("clientAction"), dict):
            directive = A2ADirective(kind="action", payload=out["clientAction"])

        return SpecialistTurnResult(
            conversation_id=str(out.get("conversationId") or task.conversation_id or ""),
            text=str(out.get("response") or ""),
            directive=directive,
            is_complete=bool(out.get("isComplete", True)),
            state_changed=bool(out.get("stateChanged", False)),
            model=DELEGATED_MODEL,
        )


_singleton: LocationAgentA2A | None = None


def get_location_a2a() -> LocationAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = LocationAgentA2A()
    return _singleton
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_agent_a2a.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/adk_bridge/location_agent.py consent-protocol/tests/test_location_agent_a2a.py
git commit -m "feat(a2a): add in-process LocationAgentA2A wrapping the existing loop"
```

---

## Task 4: Register `agent_location` + auto-wire the dispatch registry

**Files:**
- Modify: `consent-protocol/hushh_mcp/adk_bridge/delegation.py` (`SPECIALIST_A2A_SCOPE_MAP`) (scope map)
- Create: `consent-protocol/hushh_mcp/adk_bridge/__init__.py` registration (append; file currently empty)
- Test: `consent-protocol/tests/test_adk_dispatch.py` (extend)

**Interfaces:**
- Consumes: `register_specialist` (Task 2), `get_location_a2a` (Task 3), `SPECIALIST_A2A_SCOPE_MAP` (existing).
- Produces: importing `hushh_mcp.adk_bridge` registers `agent_location`; `get_a2a_required_scope("agent_location")` resolves (future network use).

- [ ] **Step 1: Write the failing test (append to tests/test_adk_dispatch.py)**

```python
def test_agent_location_scope_registered():
    from hushh_mcp.adk_bridge.delegation import get_a2a_required_scope
    # Does not raise ValueError → agent_location is a known specialist.
    assert get_a2a_required_scope("agent_location") is not None


@pytest.mark.asyncio
async def test_importing_package_wires_location(monkeypatch):
    # Fresh import wires agent_location into the live registry.
    import importlib
    from hushh_mcp import adk_bridge
    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d
    assert d.is_wired_specialist("agent_location") is True
```

Note: this test reloads the package; keep the `_clear_registry` autouse fixture in mind — place these two tests in a separate file if the reload interferes. If so, create `tests/test_adk_registration.py` with just these two tests and **no** `_clear_registry` fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_adk_dispatch.py -k "agent_location or wires_location" -v`
Expected: FAIL — scope unknown; not wired on import.

- [ ] **Step 3: Add the scope entry**

In `delegation.py`, extend `SPECIALIST_A2A_SCOPE_MAP` (after the `agent_kyc` line):

```python
    "agent_location": ConsentScope.AGENT_ONE_ORCHESTRATE,
```

(Location's per-capability `cap.location.live.*` scopes remain enforced inside the loop; this coarse map entry exists for the future network boundary and for card lookup.)

- [ ] **Step 4: Wire the registry on package import**

Replace the empty `consent-protocol/hushh_mcp/adk_bridge/__init__.py` with:

```python
"""adk_bridge package.

Importing this package registers the in-process A2A specialists so the central
chat's dispatch seam can reach them.
"""

from hushh_mcp.adk_bridge.dispatch import register_specialist
from hushh_mcp.adk_bridge.location_agent import get_location_a2a


def _register_builtin_specialists() -> None:
    register_specialist("agent_location", lambda task: get_location_a2a().handle(task))


_register_builtin_specialists()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_adk_dispatch.py tests/test_adk_registration.py -v`
Expected: PASS. (If you split the reload tests into `test_adk_registration.py`, run both files.)

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/adk_bridge/delegation.py consent-protocol/hushh_mcp/adk_bridge/__init__.py consent-protocol/tests/
git commit -m "feat(a2a): register agent_location specialist + scope entry"
```

---

## Task 5: Central chat delegation helpers (pure, unit-tested)

**Files:**
- Modify: `consent-protocol/api/routes/kai/agent_chat.py` (add request field + helpers near top)
- Test: `consent-protocol/tests/test_agent_chat_delegation.py`

**Interfaces:**
- Consumes: `classify_specialist_domain` (Task 1), `is_wired_specialist` (Task 2), `A2ADirective`, `SpecialistTurnResult`.
- Produces:
  - `AgentChatStreamRequest` gains `delegate_result: Optional[DelegateResultModel]`.
  - `DelegateResultModel(delegate_agent_id: str, kind: str, id: str, type: str | None, status: str | None, public_url: str | None, detail: str | None, selected: list[dict] | None, confirmed: bool | None, free_text: str | None)`.
  - `resolve_delegate_target(message: str) -> str | None` — returns a wired `agent_*` id or `None` (→ existing path).
  - `specialist_result_to_frames(result: SpecialistTurnResult, delegate_agent_id: str) -> list[tuple[str, dict]]` — ordered `(event, data)` SSE tuples: `start`, `token`, optional `specialist_directive`, `complete`.

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_agent_chat_delegation.py
"""Pure helpers for the central chat's location delegation branch."""

from hushh_mcp.adk_bridge.contract import A2ADirective, SpecialistTurnResult
from api.routes.kai.agent_chat import resolve_delegate_target, specialist_result_to_frames


def test_resolve_target_location_is_wired():
    assert resolve_delegate_target("share my location with Mom") == "agent_location"


def test_resolve_target_unwired_specialist_falls_through():
    # finance classifies but is NOT wired in slice 1 → no delegation.
    assert resolve_delegate_target("rebalance my portfolio") is None


def test_resolve_target_general_chat_none():
    assert resolve_delegate_target("hello there") is None


def test_frames_for_action_directive():
    result = SpecialistTurnResult(
        conversation_id="c1",
        text="Ready to share with Mom.",
        directive=A2ADirective(kind="action", payload={"id": "act-1", "type": "publish_share"}),
        is_complete=False,
        state_changed=False,
        model="one+location",
    )
    frames = specialist_result_to_frames(result, "agent_location")
    events = [name for name, _ in frames]
    assert events == ["start", "token", "specialist_directive", "complete"]
    directive_frame = dict(frames)["specialist_directive"]
    assert directive_frame["delegate_agent_id"] == "agent_location"
    assert directive_frame["directive"]["kind"] == "action"
    assert directive_frame["directive"]["payload"]["type"] == "publish_share"


def test_frames_without_directive_skip_specialist_frame():
    result = SpecialistTurnResult(
        conversation_id="c1",
        text="Done — shared for 1h.",
        directive=None,
        is_complete=True,
        state_changed=True,
        model="one+location",
    )
    events = [name for name, _ in specialist_result_to_frames(result, "agent_location")]
    assert events == ["start", "token", "complete"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_agent_chat_delegation.py -v`
Expected: FAIL — helpers/field not defined.

- [ ] **Step 3: Add the request model field + helpers**

In `api/routes/kai/agent_chat.py`, add imports near the existing imports:

```python
from hushh_mcp.adk_bridge.contract import SpecialistTurnResult
from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain
```

Add the model above `AgentChatStreamRequest`:

```python
class DelegateResultModel(BaseModel):
    delegate_agent_id: str = Field(..., max_length=64)
    kind: str = Field(..., max_length=24)  # "action" | "selection"
    id: str = Field(..., max_length=64)
    type: Optional[str] = Field(default=None, max_length=48)
    status: Optional[str] = Field(default=None, max_length=24)
    public_url: Optional[str] = Field(default=None, alias="publicUrl", max_length=2048)
    detail: Optional[str] = Field(default=None, max_length=500)
    selected: Optional[list[dict]] = Field(default=None)
    confirmed: Optional[bool] = Field(default=None)
    free_text: Optional[str] = Field(default=None, alias="freeText", max_length=4000)
```

Add the field to `AgentChatStreamRequest` (message becomes optional when a delegate_result is present):

```python
    message: str = Field(default="", max_length=8000)
    delegate_result: Optional[DelegateResultModel] = Field(default=None)
```

(Keep the other existing fields unchanged.)

Add the pure helpers below the models:

```python
def resolve_delegate_target(message: str) -> str | None:
    """Return a WIRED specialist agent id for this message, else None.

    Fail-closed: no classifier match, or a classified-but-unwired specialist
    (finance/privacy/kyc in slice 1), returns None so the existing central
    planner path runs unchanged.
    """
    classified = classify_specialist_domain(message or "")
    if classified is None:
        return None
    _domain, target_agent = classified
    return target_agent if is_wired_specialist(target_agent) else None


def specialist_result_to_frames(
    result: SpecialistTurnResult, delegate_agent_id: str
) -> list[tuple[str, dict]]:
    """Format a specialist turn as ordered additive SSE (event, data) tuples."""
    frames: list[tuple[str, dict]] = [
        ("start", {"conversation_id": result.conversation_id, "model": result.model}),
        ("token", {"token": result.text}),
    ]
    if result.directive is not None:
        frames.append(
            (
                "specialist_directive",
                {
                    "delegate_agent_id": delegate_agent_id,
                    "directive": {"kind": result.directive.kind, "payload": result.directive.payload},
                    "message": result.text,
                    "state_changed": result.state_changed,
                },
            )
        )
    frames.append(
        (
            "complete",
            {
                "conversation_id": result.conversation_id,
                "status": "complete",
                "model": result.model,
            },
        )
    )
    return frames
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_agent_chat_delegation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/api/routes/kai/agent_chat.py consent-protocol/tests/test_agent_chat_delegation.py
git commit -m "feat(one): add central-chat location delegation helpers + delegate_result model"
```

---

## Task 6: Wire the delegation branch into the stream route

**Files:**
- Modify: `consent-protocol/api/routes/kai/agent_chat.py` (`stream_agent_chat`) (`stream_agent_chat`)
- Test: `consent-protocol/tests/test_agent_chat_delegation_route.py`

**Interfaces:**
- Consumes: `resolve_delegate_target`, `specialist_result_to_frames` (Task 5); `dispatch`, `A2ATask` (Task 2).
- Produces: for a location message or any `delegate_result`, the route emits the specialist frames and **returns before** touching `prepare_agent_runtime` / `plan_action_with_gemini` / `_save_assistant_message` (LocationChatService owns persistence). All other turns are byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test (route-level, async client)**

```python
# consent-protocol/tests/test_agent_chat_delegation_route.py
"""The stream route delegates location turns to dispatch and relays frames,
without invoking the central planner. Non-location turns are untouched."""

import pytest
from httpx import ASGITransport, AsyncClient

from hushh_mcp.adk_bridge import dispatch as dispatch_mod
from hushh_mcp.adk_bridge.contract import A2ADirective, SpecialistTurnResult


def _parse_sse(body: str) -> list[str]:
    return [line[len("event: "):] for line in body.splitlines() if line.startswith("event: ")]


@pytest.fixture
def app_with_stub_location(monkeypatch):
    # Register a stub location specialist so the route delegates deterministically.
    async def stub(task):
        return SpecialistTurnResult(
            conversation_id="c-loc",
            text="Ready to share with Mom.",
            directive=A2ADirective(kind="action", payload={"id": "act-1", "type": "publish_share"}),
            is_complete=False,
            state_changed=False,
            model="one+location",
        )

    dispatch_mod.register_specialist("agent_location", stub)
    from api.server import app  # adjust import to the FastAPI app factory/module
    return app


@pytest.mark.asyncio
async def test_location_turn_is_delegated(app_with_stub_location, monkeypatch):
    # Bypass auth: patch require_vault_owner_token dependency to a fixed user.
    from api import middleware
    monkeypatch.setattr(
        middleware, "require_vault_owner_token",
        lambda: {"user_id": "u1", "token": "tok"}, raising=True,
    )
    transport = ASGITransport(app=app_with_stub_location)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        resp = await client.post(
            "/agent/chat/stream",
            json={"user_id": "u1", "message": "share my location with Mom"},
        )
    events = _parse_sse(resp.text)
    assert events == ["start", "token", "specialist_directive", "complete"]
```

Note: match the real app import (`api.server:app`) and the auth-dependency override style used by the existing agent-chat route tests (search `tests/` for `require_vault_owner_token` overrides and copy that pattern; FastAPI dependency overrides via `app.dependency_overrides` are the robust way). If the suite has no ASGI-client precedent, prefer overriding `app.dependency_overrides[require_vault_owner_token]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_agent_chat_delegation_route.py -v`
Expected: FAIL — route still runs the central planner (events include `tool_start` or `token`-stream, not `specialist_directive`).

- [ ] **Step 3: Add the delegation branch at the top of `stream_agent_chat`**

Immediately after `_assert_user(token_data, body.user_id)` and `service = get_agent_chat_service()` (line ~159), before `prepare_agent_runtime`, insert:

```python
    # --- One → specialist delegation (slice 1: location) --------------------
    # Fail-closed: only a WIRED specialist match (or an explicit delegate_result)
    # is intercepted; everything else falls through to the existing planner.
    import hushh_mcp.adk_bridge  # noqa: F401  (ensures specialists are registered)
    from hushh_mcp.adk_bridge.contract import A2ATask
    from hushh_mcp.adk_bridge.dispatch import dispatch as a2a_dispatch

    delegate_agent_id: str | None = None
    delegate_result_payload: dict | None = None
    if body.delegate_result is not None:
        delegate_agent_id = body.delegate_result.delegate_agent_id
        delegate_result_payload = body.delegate_result.model_dump(by_alias=True, exclude_none=True)
    elif body.message:
        delegate_agent_id = resolve_delegate_target(body.message)

    if delegate_agent_id is not None and is_wired_specialist(delegate_agent_id):
        task = A2ATask(
            user_id=body.user_id,
            consent_token=token_data.get("token", ""),
            conversation_id=body.conversation_id,
            message=body.message or None,
            delegate_result=delegate_result_payload,
        )

        async def generate_delegated():
            try:
                result = await a2a_dispatch(delegate_agent_id, task)
            except Exception as error:  # noqa: BLE001
                logger.exception("agent_chat.delegation_failed user_id=%s: %s", body.user_id, error)
                yield _event(
                    "error",
                    {
                        "message": "Agent chat failed. Please try again.",
                        "conversation_id": body.conversation_id or "",
                    },
                )
                return
            for name, data in specialist_result_to_frames(result, delegate_agent_id):
                yield _event(name, data)

        headers = {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
        }
        return StreamingResponse(
            generate_delegated(), media_type="text/event-stream", headers=headers
        )
    # --- end delegation branch --------------------------------------------
```

(LocationChatService.handle_turn persists both the user and assistant messages for the delegated turn, so the delegation branch deliberately does not call `prepare_turn` / `_save_assistant_message`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_agent_chat_delegation_route.py -v`
Expected: PASS — events are `start, token, specialist_directive, complete`.

- [ ] **Step 5: Prove non-location turns are unchanged**

Add to the same test file a case asserting a finance/general message still hits the planner path (expect `start` then either `tool_start` or streamed `token`/`complete`, and **never** `specialist_directive`):

```python
@pytest.mark.asyncio
async def test_non_location_turn_uses_existing_path(app_with_stub_location, monkeypatch):
    from api import middleware
    monkeypatch.setattr(
        middleware, "require_vault_owner_token",
        lambda: {"user_id": "u1", "token": "tok"}, raising=True,
    )
    transport = ASGITransport(app=app_with_stub_location)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        resp = await client.post(
            "/agent/chat/stream",
            json={"user_id": "u1", "message": "good morning"},
        )
    events = _parse_sse(resp.text)
    assert "specialist_directive" not in events
    assert events and events[0] == "start"
```

Run: `cd consent-protocol && uv run python -m pytest tests/test_agent_chat_delegation_route.py -v`
Expected: PASS (both cases). If the general-chat case needs a live Gemini runtime, mark it to use the existing agent-chat test fakes/mocks (copy the runtime-stub pattern from the current `tests/test_agent_chat*`).

- [ ] **Step 6: Run the broader backend suite for regressions**

Run: `cd consent-protocol && uv run python -m pytest tests/ -k "agent_chat or location or orchestrator or adk" -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/api/routes/kai/agent_chat.py consent-protocol/tests/test_agent_chat_delegation_route.py
git commit -m "feat(one): delegate location turns through the central chat over in-process A2A"
```

---

## Task 7: Frontend — SSE client handles `specialist_directive` + `delegateResult`

**Files:**
- Modify: `hushh-webapp/lib/services/agent-chat-client.ts`
- Test: `hushh-webapp/lib/services/__tests__/agent-chat-client.specialist.test.ts`

**Interfaces:**
- Consumes: existing `consumeAgentChatStream` frame dispatcher and `AgentChatStreamHandlers`.
- Produces:
  - New type `SpecialistDirectiveEvent = { delegateAgentId: string; directive: { kind: "action" | "prompt"; payload: Record<string, unknown> }; message: string; stateChanged: boolean }`.
  - `AgentChatStreamHandlers` gains `onSpecialistDirective?(event: SpecialistDirectiveEvent): void`.
  - `handleFrame` routes `event: specialist_directive` to it.
  - The stream request body accepts an optional `delegateResult` object passed through to the backend as `delegate_result`.

- [ ] **Step 1: Write the failing test**

```ts
// hushh-webapp/lib/services/__tests__/agent-chat-client.specialist.test.ts
import { describe, expect, it, vi } from "vitest";
import { consumeAgentChatStream } from "@/lib/services/agent-chat-client";

function sse(...frames: Array<[string, unknown]>): Response {
  const body = frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("specialist_directive", () => {
  it("routes the frame to onSpecialistDirective", async () => {
    const onSpecialistDirective = vi.fn();
    await consumeAgentChatStream(
      sse(
        ["start", { conversation_id: "c1", model: "one+location" }],
        ["token", { token: "Ready to share with Mom." }],
        [
          "specialist_directive",
          {
            delegate_agent_id: "agent_location",
            directive: { kind: "action", payload: { id: "act-1", type: "publish_share" } },
            message: "Ready to share with Mom.",
            state_changed: false,
          },
        ],
        ["complete", { conversation_id: "c1", status: "complete", model: "one+location" }],
      ),
      { onSpecialistDirective },
    );
    expect(onSpecialistDirective).toHaveBeenCalledWith(
      expect.objectContaining({
        delegateAgentId: "agent_location",
        directive: expect.objectContaining({ kind: "action" }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npm run test -- lib/services/__tests__/agent-chat-client.specialist.test.ts`
Expected: FAIL — `onSpecialistDirective` never called / not a handler.

- [ ] **Step 3: Add the type, handler, and frame routing**

In `agent-chat-client.ts`, add the type near the other event types:

```ts
export type SpecialistDirectiveEvent = {
  delegateAgentId: string;
  directive: { kind: "action" | "prompt"; payload: Record<string, unknown> };
  message: string;
  stateChanged: boolean;
};
```

Add to `AgentChatStreamHandlers`:

```ts
  onSpecialistDirective?: (event: SpecialistDirectiveEvent) => void;
```

In `handleFrame`, add a case for the new event (mirror the existing `onToolWaiting` case):

```ts
    case "specialist_directive": {
      const p = payload as Record<string, unknown>;
      const directive = (p.directive ?? {}) as Record<string, unknown>;
      handlers.onSpecialistDirective?.({
        delegateAgentId: String(p.delegate_agent_id ?? ""),
        directive: {
          kind: (directive.kind === "prompt" ? "prompt" : "action"),
          payload: (directive.payload ?? {}) as Record<string, unknown>,
        },
        message: String(p.message ?? ""),
        stateChanged: Boolean(p.state_changed),
      });
      break;
    }
```

In the request-building function (`streamAgentChat`), add an optional `delegateResult` param and include it in the POST body as `delegate_result` (snake_case for the backend). Match the existing body-assembly style:

```ts
  if (params.delegateResult) {
    body.delegate_result = params.delegateResult;
  }
```

Add `delegateResult?: Record<string, unknown>` to the `streamAgentChat` params type.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npm run test -- lib/services/__tests__/agent-chat-client.specialist.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/services/agent-chat-client.ts hushh-webapp/lib/services/__tests__/agent-chat-client.specialist.test.ts
git commit -m "feat(agent-chat): consume specialist_directive SSE + send delegate_result"
```

---

## Task 8: Frontend — location directive runtime (browser crypto dispatch)

**Files:**
- Create: `hushh-webapp/lib/agent/specialist-directive-runtime.ts`
- Test: `hushh-webapp/lib/agent/__tests__/specialist-directive-runtime.test.ts`

**Interfaces:**
- Consumes: existing location crypto — `OneLocationService` (`captureCurrentPosition`, `storeEnvelope`, `createPublicInvite`, envelope fetch), `encryptLocationForRecipient` (`lib/one-location/encryption.ts`). Reuse the exact logic from `components/one-location/redesign/use-location-chat.ts` `confirmAction` (lines ~206-260).
- Produces:
  - `runLocationDirective(directive: { kind, payload }): Promise<DelegateResult>` where `DelegateResult = { delegate_agent_id: "agent_location"; kind: "action" | "selection"; id: string; type?: string; status: "completed" | "cancelled" | "failed"; publicUrl?: string; detail?: string; selected?: unknown[]; confirmed?: boolean; freeText?: string }`.
  - For `kind:"action"` payloads: `publish_share` → capture+encrypt per recipient+store envelopes; `create_public_link` → capture+createPublicInvite; `view_envelope` → fetch+decrypt+render. Returns a coordinate-free result.
  - For `kind:"prompt"` payloads: returns a `selection` result once the user answers (the card provides the answer; this function serializes it).

- [ ] **Step 1: Write the failing test**

```ts
// hushh-webapp/lib/agent/__tests__/specialist-directive-runtime.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    captureCurrentPosition: vi.fn(async () => ({ latitude: 1, longitude: 2, capturedAt: "t" })),
    storeEnvelope: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(async () => ({ ciphertext: "x", iv: "y" })),
}));

import { runLocationDirective } from "@/lib/agent/specialist-directive-runtime";
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";

describe("runLocationDirective publish_share", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures once, encrypts per recipient, stores envelopes, returns completed", async () => {
    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-1",
        type: "publish_share",
        shares: [
          { grantId: "g1", recipientKeyId: "k1", label: "Mom" },
          { grantId: "g2", recipientKeyId: "k2", label: "Dad" },
        ],
        summary: "Share with Mom, Dad",
      },
    });
    expect(OneLocationService.captureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(encryptLocationForRecipient).toHaveBeenCalledTimes(2);
    expect(OneLocationService.storeEnvelope).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "act-1",
      type: "publish_share",
      status: "completed",
    });
    // Coordinate-free result
    expect(JSON.stringify(result)).not.toContain("latitude");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npm run test -- lib/agent/__tests__/specialist-directive-runtime.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the runtime**

Port the crypto sequence from `use-location-chat.ts` `confirmAction`. Concretely:

```ts
// hushh-webapp/lib/agent/specialist-directive-runtime.ts
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";

export type SpecialistDirective = {
  kind: "action" | "prompt";
  payload: Record<string, unknown>;
};

export type DelegateResult = {
  delegate_agent_id: "agent_location";
  kind: "action" | "selection";
  id: string;
  type?: string;
  status: "completed" | "cancelled" | "failed";
  publicUrl?: string;
  detail?: string;
  selected?: unknown[];
  confirmed?: boolean;
  freeText?: string;
};

type Share = { grantId: string; recipientKeyId: string; recipientUserId?: string; label: string };

export async function runLocationDirective(directive: SpecialistDirective): Promise<DelegateResult> {
  const payload = directive.payload as Record<string, any>;
  const id = String(payload.id ?? "");
  const type = String(payload.type ?? "");

  try {
    if (type === "publish_share") {
      const shares = (payload.shares ?? []) as Share[];
      const position = await OneLocationService.captureCurrentPosition();
      for (const share of shares) {
        const envelope = await encryptLocationForRecipient(position, share.recipientKeyId);
        await OneLocationService.storeEnvelope(share.grantId, envelope);
      }
      return { delegate_agent_id: "agent_location", kind: "action", id, type, status: "completed" };
    }
    if (type === "create_public_link") {
      const position = await OneLocationService.captureCurrentPosition();
      const invite = await OneLocationService.createPublicInvite({
        durationHours: Number(payload.durationHours ?? 1),
        publicLocation: position,
      });
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        publicUrl: invite.publicUrl,
      };
    }
    if (type === "view_envelope") {
      await OneLocationService.viewGrantEnvelope(String(payload.grantId ?? ""));
      return { delegate_agent_id: "agent_location", kind: "action", id, type, status: "completed" };
    }
    return {
      delegate_agent_id: "agent_location",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: "unsupported directive",
    };
  } catch (error) {
    return {
      delegate_agent_id: "agent_location",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: error instanceof Error ? error.message : "action failed",
    };
  }
}
```

Note: confirm the exact method names against `lib/one-location/service.ts` (`captureCurrentPosition`, `storeEnvelope`, `createPublicInvite`, `viewGrantEnvelope`) and `lib/one-location/encryption.ts` (`encryptLocationForRecipient`) — the parity check in Task 10 covers any drift. If a name differs, adapt the call (do not invent a new location API).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npm run test -- lib/agent/__tests__/specialist-directive-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/agent/specialist-directive-runtime.ts hushh-webapp/lib/agent/__tests__/specialist-directive-runtime.test.ts
git commit -m "feat(agent-chat): location directive runtime reusing browser crypto"
```

---

## Task 9: Frontend — specialist directive card + workspace wiring

**Files:**
- Create: `hushh-webapp/components/agent/specialist-directive-card.tsx`
- Modify: `hushh-webapp/components/agent/agent-chat-workspace.tsx` (SSE handler wiring near lines ~2172-2208; frontend-tool section near `executeFrontendTool` ~1816-1861)

**Interfaces:**
- Consumes: `SpecialistDirectiveEvent` (Task 7), `runLocationDirective` / `DelegateResult` (Task 8), the existing `streamAgentChat(..., { delegateResult })` follow-up (Task 7).
- Produces: an inline confirm/select card in the message stream; on confirm → `runLocationDirective` → follow-up `streamAgentChat` with the returned `DelegateResult`; never auto-fires for `kind:"action"`.

- [ ] **Step 1: Build the presentational card**

```tsx
// hushh-webapp/components/agent/specialist-directive-card.tsx
"use client";

import React from "react";

export type SpecialistCardProps = {
  summary: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
};

export function SpecialistDirectiveCard({
  summary,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: SpecialistCardProps) {
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3">
      <p className="text-sm font-medium text-foreground/90">{summary}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full bg-black/5 px-4 py-1.5 text-sm dark:bg-white/10"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the SSE handler in the workspace**

Where the workspace builds its `AgentChatStreamHandlers` (near the `onToolWaiting` wiring, ~line 2192), add:

```tsx
        onSpecialistDirective: (event) => {
          // Store the directive as a pending card in the current message stream.
          // Security-sensitive: never auto-run an "action"; require an explicit click.
          setPendingSpecialistDirective(event);
        },
```

Add `const [pendingSpecialistDirective, setPendingSpecialistDirective] = useState<SpecialistDirectiveEvent | null>(null);` with the other state hooks, and import `SpecialistDirectiveEvent` from the client and `runLocationDirective` from `@/lib/agent/specialist-directive-runtime`.

- [ ] **Step 3: Render the card + confirm handler**

In the message-stream render (beside where a pending `pkm.add` review renders), render the card when `pendingSpecialistDirective` is set:

```tsx
{pendingSpecialistDirective ? (
  <SpecialistDirectiveCard
    summary={String(
      (pendingSpecialistDirective.directive.payload as Record<string, unknown>).summary ??
        pendingSpecialistDirective.message,
    )}
    confirmLabel="Share"
    busy={specialistBusy}
    onConfirm={async () => {
      setSpecialistBusy(true);
      try {
        const result = await runLocationDirective(pendingSpecialistDirective.directive);
        setPendingSpecialistDirective(null);
        // Follow-up turn: report the result back so One confirms in words.
        await sendDelegateResult(result); // wraps streamAgentChat({ delegateResult: result, ... })
      } finally {
        setSpecialistBusy(false);
      }
    }}
    onCancel={async () => {
      const directive = pendingSpecialistDirective;
      setPendingSpecialistDirective(null);
      await sendDelegateResult({
        delegate_agent_id: directive.delegateAgentId,
        kind: "action",
        id: String((directive.directive.payload as Record<string, unknown>).id ?? ""),
        status: "cancelled",
      });
    }}
  />
) : null}
```

Add `const [specialistBusy, setSpecialistBusy] = useState(false);` and a `sendDelegateResult(result)` helper that calls the existing stream-start path with `delegateResult` set and no `message`, reusing the same SSE handlers (so One's confirmation text renders as a normal assistant turn). Model the helper on the existing "send a message" function in this component.

- [ ] **Step 4: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: clean. Fix any prop/type mismatches (e.g. `delegateResult` typing on the stream params).

- [ ] **Step 5: Run the frontend agent + location suites for regressions**

Run: `cd hushh-webapp && npm run test -- agent one-location`
Expected: PASS (existing agent-workspace and location-chat tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/components/agent/specialist-directive-card.tsx hushh-webapp/components/agent/agent-chat-workspace.tsx
git commit -m "feat(agent-chat): render location directive card + report delegate_result"
```

---

## Task 10: End-to-end verification + parity checks

**Files:** none (verification only)

- [ ] **Step 1: Backend full suite (touched areas)**

Run: `cd consent-protocol && uv run python -m pytest tests/ -k "agent_chat or location or orchestrator or adk" -q`
Expected: PASS.

- [ ] **Step 2: Frontend types + touched suites**

Run: `cd hushh-webapp && npx tsc --noEmit && npm run test -- agent one-location`
Expected: clean typecheck; PASS.

- [ ] **Step 3: Confirm the location API names used in Task 8 exist**

Run: `cd hushh-webapp && grep -nE "captureCurrentPosition|storeEnvelope|createPublicInvite|viewGrantEnvelope" lib/one-location/service.ts`
Expected: each method resolves. If any differs, update `specialist-directive-runtime.ts` to the real name and re-run Task 8's test.

- [ ] **Step 4: Manual smoke (real app)**

Use the `run` skill (or the project's dev command) to launch the app. From any authenticated screen, open the "Ask your agent anything" bar and:
1. Type "share my location with <a verified recipient> for an hour" → expect a directive card in the central chat → click Share → expect the location to encrypt+store (no coordinates in network payloads to `/agent/chat/stream`) and One to confirm "Done…".
2. Type "rebalance my portfolio" → expect the **existing** Kai behavior (no directive card), proving no regression.

- [ ] **Step 5: Coordinate-free assertion (manual)**

In browser devtools Network, confirm no request to `/api/kai/agent/chat/stream` (or its SSE frames) contains `latitude`/`longitude`. Coordinates appear only in the `/grants/{id}/envelopes` ciphertext body.

- [ ] **Step 6: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test(one): e2e verification for location delegation in central chat"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §3 router/relay → Tasks 5–6; §4 contract → Tasks 2–4; §5 backend files → Tasks 1–6; §6 SSE frames → Tasks 5–7; §7 frontend → Tasks 7–9; §9 invariants → Global Constraints + Task 10 Steps 4–5; §10 tests → each task's TDD steps + Task 10.
- **Deferred items** (network A2A, unified `agent_one`, real ADK Runner) are correctly absent from tasks.
- **Type consistency:** `SpecialistTurnResult` / `A2ADirective` / `A2ATask` names match across Tasks 2/3/5/6; `SpecialistDirectiveEvent` / `DelegateResult` match across Tasks 7/8/9; SSE event name `specialist_directive` and request field `delegate_result`/`delegateResult` are consistent backend↔frontend.
- **Open verification flagged inline:** the FastAPI app import + auth-override pattern (Task 6 Step 1) and the exact `lib/one-location` method names (Task 8 Step 3 / Task 10 Step 3) must be confirmed against the codebase during execution — noted in-task rather than guessed.
