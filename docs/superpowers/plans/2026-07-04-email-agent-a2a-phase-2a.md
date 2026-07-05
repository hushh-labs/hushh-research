# Email Agent A2A — Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Gmail chat agent reachable from the central One chat by wiring it as an in-process A2A specialist `agent_email`, mirroring the location agent.

**Architecture:** The One route (`api/routes/kai/agent_chat.py`) already delegates generically: it classifies a message to a specialist `agent_id` (`classify_specialist_domain`) and dispatches to it if `is_wired_specialist(agent_id)` is true. We add (1) an email consent-scope entry, (2) an email classifier route, (3) a thin A2A adapter wrapping the unchanged `EmailChatService.handle_turn`, and (4) its registration. The email agent is read-only, so it emits no client directive and needs **no** frontend changes and **no** changes to the route itself.

**Tech Stack:** Python 3, FastAPI, pytest (asyncio), Google GenAI (Gemini), ruff. Reference spec: `docs/superpowers/specs/2026-07-04-email-agent-a2a-design.md`.

## Visual Map

```
Task 1  delegation.py         SPECIALIST_A2A_SCOPE_MAP["agent_email"] = AGENT_ONE_ORCHESTRATE
Task 2  orchestrator/tools.py _SPECIALIST_ROUTES  ("email" cues ▶ "agent_email")
Task 3  adk_bridge/email_agent.py  EmailAgentA2A.handle ▶ wraps EmailChatService.handle_turn
Task 4  adk_bridge/__init__.py     register_specialist("agent_email", …)
Task 5  verification (no code)

Runtime: One route ─ classify ─▶ is_wired ─▶ a2a_dispatch ─▶ EmailAgentA2A (read-only)
```

## Global Constraints

- All backend paths are under `consent-protocol/`. Run every command from `consent-protocol/`.
- Test runner: `.venv/bin/python -m pytest <path> -q`.
- Before every commit: `.venv/bin/python -m ruff format <changed files>` then `.venv/bin/python -m ruff check <changed files>`.
- Ruff `S105`/`S106` fire on literal tokens/consent tokens in tests — append `# noqa: S106` (kwarg) or use a module constant with `# noqa: S105`, matching existing tests.
- If pushing: use `git push --no-verify` (the pre-push subtree-sync hook hangs for minutes).
- Consent scope reused for email: `ConsentScope.AGENT_ONE_ORCHESTRATE` (least-privilege; same as location/marketplace). No email-specific scope exists and none is added.
- Scope is **Phase 2a only** — read-only delegation. No DB, no migration, no frontend, no new OAuth. Phase 2b (durable requests) is documented in the spec and out of scope here.
- Reference files to mirror exactly: `hushh_mcp/adk_bridge/location_agent.py`, `tests/test_location_agent_a2a.py`, `tests/test_orchestrator_location_route.py`, `tests/test_adk_registration.py`.

---

### Task 1: Add the email A2A consent scope

**Files:**
- Modify: `consent-protocol/hushh_mcp/adk_bridge/delegation.py`
- Test: `consent-protocol/tests/test_a2a_delegation_scopes.py` (existing — update the exact-dict assertion)

**Interfaces:**
- Consumes: `ConsentScope.AGENT_ONE_ORCHESTRATE` (existing enum), `SPECIALIST_A2A_SCOPE_MAP` (existing dict), `get_a2a_required_scope` (existing).
- Produces: `SPECIALIST_A2A_SCOPE_MAP["agent_email"] == ConsentScope.AGENT_ONE_ORCHESTRATE`; `get_a2a_required_scope("agent_email")` returns it without raising.

- [ ] **Step 1: Update the exact-dict test to expect `agent_email`**

In `tests/test_a2a_delegation_scopes.py`, in `test_specialist_a2a_scope_map_uses_least_privilege_scopes`, add the `agent_email` line to the expected dict so it reads:

```python
    assert SPECIALIST_A2A_SCOPE_MAP == {
        "agent_one": ConsentScope.AGENT_ONE_ORCHESTRATE,
        "agent_connected_systems": ConsentScope.AGENT_ONE_ORCHESTRATE,
        "agent_kai": ConsentScope.AGENT_KAI_ANALYZE,
        "agent_nav": ConsentScope.AGENT_NAV_REVIEW,
        "agent_kyc": ConsentScope.AGENT_KYC_PROCESS,
        "agent_location": ConsentScope.AGENT_ONE_ORCHESTRATE,
        "agent_personal_information": ConsentScope.AGENT_ONE_ORCHESTRATE,
        "agent_email": ConsentScope.AGENT_ONE_ORCHESTRATE,
    }
    assert ConsentScope.VAULT_OWNER not in SPECIALIST_A2A_SCOPE_MAP.values()
```

Also add a focused test at the end of the file:

```python
def test_agent_email_scope_is_orchestrate() -> None:
    assert get_a2a_required_scope("agent_email") == ConsentScope.AGENT_ONE_ORCHESTRATE
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_a2a_delegation_scopes.py -q`
Expected: FAIL — `AssertionError` on the dict comparison (map has no `agent_email` yet) and `test_agent_email_scope_is_orchestrate` fails with `ValueError: Unknown A2A specialist: 'agent_email'`.

- [ ] **Step 3: Add the email entry to the scope map**

In `hushh_mcp/adk_bridge/delegation.py`, add `agent_email` to `SPECIALIST_A2A_SCOPE_MAP`:

```python
SPECIALIST_A2A_SCOPE_MAP: dict[str, ConsentScope] = {
    "agent_one": ConsentScope.AGENT_ONE_ORCHESTRATE,
    "agent_connected_systems": ConsentScope.AGENT_ONE_ORCHESTRATE,
    "agent_kai": ConsentScope.AGENT_KAI_ANALYZE,
    "agent_nav": ConsentScope.AGENT_NAV_REVIEW,
    "agent_kyc": ConsentScope.AGENT_KYC_PROCESS,
    "agent_location": ConsentScope.AGENT_ONE_ORCHESTRATE,
    "agent_personal_information": ConsentScope.AGENT_ONE_ORCHESTRATE,
    "agent_email": ConsentScope.AGENT_ONE_ORCHESTRATE,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_a2a_delegation_scopes.py -q`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
.venv/bin/python -m ruff format hushh_mcp/adk_bridge/delegation.py tests/test_a2a_delegation_scopes.py
.venv/bin/python -m ruff check hushh_mcp/adk_bridge/delegation.py tests/test_a2a_delegation_scopes.py
git add hushh_mcp/adk_bridge/delegation.py tests/test_a2a_delegation_scopes.py
git commit -m "feat(email-a2a): add agent_email A2A consent scope"
```

---

### Task 2: Add the email classifier route

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/orchestrator/tools.py`
- Test: `consent-protocol/tests/test_orchestrator_email_route.py` (new)

**Interfaces:**
- Consumes: `classify_specialist_domain(message: str) -> Optional[tuple[str, str]]` (existing), `_SPECIALIST_ROUTES` (existing module tuple).
- Produces: `classify_specialist_domain("<inbox phrase>") == ("email", "agent_email")` for inbox-specific phrasing; non-email intents and general chat are unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/test_orchestrator_email_route.py`:

```python
"""The shared classifier must route inbox intents to agent_email without
stealing finance/location/privacy/general turns (fail-closed)."""

import pytest

from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.mark.parametrize(
    "message",
    [
        "what needs a reply in my inbox",
        "search my email for the invoice",
        "any unread email from ravi",
        "check my inbox please",
        "show me emails from acme",
        "summarize my gmail",
    ],
)
def test_email_intents_route_to_agent_email(message):
    assert classify_specialist_domain(message) == ("email", "agent_email")


@pytest.mark.parametrize(
    "message,expected",
    [
        ("rebalance my portfolio", ("finance", "agent_kai")),
        ("share my location with Mom for an hour", ("location", "agent_location")),
        ("who has access to my vault", ("privacy_consent", "agent_nav")),
        ("upload my passport for kyc", ("kyc_identity_workflow", "agent_kyc")),
    ],
)
def test_non_email_intents_unchanged(message, expected):
    assert classify_specialist_domain(message) == expected


def test_general_chat_stays_with_one():
    assert classify_specialist_domain("good morning, how are you") is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_orchestrator_email_route.py -q`
Expected: FAIL — `test_email_intents_route_to_agent_email` returns `None` (no email route yet). The other two tests already pass.

- [ ] **Step 3: Add the email route to `_SPECIALIST_ROUTES`**

In `hushh_mcp/agents/orchestrator/tools.py`, append a new entry to the `_SPECIALIST_ROUTES` tuple (place it after the `location` entry, before the closing `)`). Cues are qualified/possessive so they do not overlap the finance/marketplace/nav/location cues:

```python
    (
        "email",
        "agent_email",
        (
            "needs a reply",
            "my inbox",
            "check my inbox",
            "my email",
            "my emails",
            "unread email",
            "emails from",
            "gmail",
        ),
    ),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_orchestrator_email_route.py -q`
Expected: PASS (all tests green).

- [ ] **Step 5: Run the existing location/delegation classifier tests to confirm no regressions**

Run: `.venv/bin/python -m pytest tests/test_orchestrator_location_route.py tests/agents/test_orchestrator_delegation.py -q`
Expected: PASS (email cues are disjoint from existing routes).

- [ ] **Step 6: Commit**

```bash
.venv/bin/python -m ruff format hushh_mcp/agents/orchestrator/tools.py tests/test_orchestrator_email_route.py
.venv/bin/python -m ruff check hushh_mcp/agents/orchestrator/tools.py tests/test_orchestrator_email_route.py
git add hushh_mcp/agents/orchestrator/tools.py tests/test_orchestrator_email_route.py
git commit -m "feat(email-a2a): route inbox intents to agent_email"
```

---

### Task 3: Add the email A2A adapter

**Files:**
- Create: `consent-protocol/hushh_mcp/adk_bridge/email_agent.py`
- Test: `consent-protocol/tests/test_email_agent_a2a.py` (new)

**Interfaces:**
- Consumes: `A2ATask`, `SpecialistTurnResult` from `hushh_mcp/adk_bridge/contract.py`; `EmailChatService.handle_turn(*, user_id, message, consent_token, conversation_id) -> dict` (existing, returns `{"conversationId", "response", "isComplete", "stateChanged"}`).
- Produces: `EmailAgentA2A(service=None)` with `async handle(task: A2ATask) -> SpecialistTurnResult`; `get_email_a2a() -> EmailAgentA2A` singleton; `DELEGATED_MODEL == "one+email"`. `handle` always returns `directive=None`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_email_agent_a2a.py`:

```python
"""EmailAgentA2A adapts the read-only EmailChatService.handle_turn dict into the
generic SpecialistTurnResult envelope. The email agent emits no client directive."""

import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.email_agent import EmailAgentA2A


class _FakeEmailService:
    def __init__(self):
        self.calls = []

    async def handle_turn(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "conversationId": "c1",
            "response": "You have 1 thread waiting: Q3 plan from Ravi.",
            "isComplete": True,
            "stateChanged": False,
        }


@pytest.mark.asyncio
async def test_message_turn_maps_to_specialist_result():
    svc = _FakeEmailService()
    agent = EmailAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id=None,
            message="what needs a reply",
        )
    )
    assert result.text == "You have 1 thread waiting: Q3 plan from Ravi."
    assert result.conversation_id == "c1"
    assert result.is_complete is True
    assert result.state_changed is False
    assert result.directive is None
    assert result.model == "one+email"
    # forwarded correctly to the underlying service
    assert svc.calls[0]["user_id"] == "u"
    assert svc.calls[0]["message"] == "what needs a reply"
    assert svc.calls[0]["consent_token"] == "t"
    assert svc.calls[0]["conversation_id"] is None


@pytest.mark.asyncio
async def test_read_only_agent_never_emits_directive():
    svc = _FakeEmailService()
    agent = EmailAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id="c1",
            message="search my inbox",
        )
    )
    assert result.directive is None


def test_get_email_a2a_is_singleton():
    from hushh_mcp.adk_bridge.email_agent import get_email_a2a

    assert get_email_a2a() is get_email_a2a()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_email_agent_a2a.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'hushh_mcp.adk_bridge.email_agent'`.

- [ ] **Step 3: Write the adapter**

Create `hushh_mcp/adk_bridge/email_agent.py`:

```python
"""In-process A2A handler for the Email (Gmail inbox) specialist.

Wraps the EXISTING EmailChatService.handle_turn loop unchanged and adapts its
dict output into the generic SpecialistTurnResult. The email agent is read-only
(tools: list_needs_reply, search_inbox), so it emits no client directive.

Consent: EmailChatService reads Gmail via the user's connected gmail.readonly
OAuth connection; the delegation boundary in the One route additionally validates
the A2A consent token against AGENT_ONE_ORCHESTRATE before dispatch.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult

# The label surfaced to the client for delegated turns (SSE start/complete "model").
DELEGATED_MODEL = "one+email"


class EmailAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.email_chat_service import EmailChatService

            self._service = EmailChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        out: dict = await self._service.handle_turn(
            user_id=task.user_id,
            message=task.message,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
        )
        return SpecialistTurnResult(
            conversation_id=str(out.get("conversationId") or task.conversation_id or ""),
            text=str(out.get("response") or ""),
            directive=None,
            is_complete=bool(out.get("isComplete", True)),
            state_changed=bool(out.get("stateChanged", False)),
            model=DELEGATED_MODEL,
        )


_singleton: EmailAgentA2A | None = None


def get_email_a2a() -> EmailAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = EmailAgentA2A()
    return _singleton
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_email_agent_a2a.py -q`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
.venv/bin/python -m ruff format hushh_mcp/adk_bridge/email_agent.py tests/test_email_agent_a2a.py
.venv/bin/python -m ruff check hushh_mcp/adk_bridge/email_agent.py tests/test_email_agent_a2a.py
git add hushh_mcp/adk_bridge/email_agent.py tests/test_email_agent_a2a.py
git commit -m "feat(email-a2a): add EmailAgentA2A adapter over EmailChatService"
```

---

### Task 4: Register the email specialist

**Files:**
- Modify: `consent-protocol/hushh_mcp/adk_bridge/__init__.py`
- Test: `consent-protocol/tests/test_adk_registration.py` (existing — add an email assertion)

**Interfaces:**
- Consumes: `get_email_a2a` from Task 3; `register_specialist` (existing); `is_wired_specialist` (existing).
- Produces: after importing `hushh_mcp.adk_bridge`, `is_wired_specialist("agent_email")` is `True`.

- [ ] **Step 1: Add the failing registration test**

Append to `tests/test_adk_registration.py`:

```python
@pytest.mark.asyncio
async def test_importing_package_wires_email(monkeypatch):
    # Fresh import wires agent_email into the live registry.
    import importlib

    from hushh_mcp import adk_bridge

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    assert d.is_wired_specialist("agent_email") is True
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_adk_registration.py::test_importing_package_wires_email -q`
Expected: FAIL — `assert False is True` (`agent_email` not registered yet).

- [ ] **Step 3: Register the email specialist**

In `hushh_mcp/adk_bridge/__init__.py`, add the import and the registration line:

```python
from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a
from hushh_mcp.adk_bridge.dispatch import register_specialist
from hushh_mcp.adk_bridge.email_agent import get_email_a2a
from hushh_mcp.adk_bridge.location_agent import get_location_a2a
from hushh_mcp.adk_bridge.nav_agent import get_nav_a2a
from hushh_mcp.adk_bridge.personal_information_agent import get_personal_information_a2a


def _register_builtin_specialists() -> None:
    register_specialist(
        "agent_connected_systems", lambda task: get_connected_systems_a2a().handle(task)
    )
    register_specialist("agent_email", lambda task: get_email_a2a().handle(task))
    register_specialist("agent_location", lambda task: get_location_a2a().handle(task))
    register_specialist("agent_nav", lambda task: get_nav_a2a().handle(task))
    register_specialist(
        "agent_personal_information",
        lambda task: get_personal_information_a2a().handle(task),
    )


_register_builtin_specialists()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_adk_registration.py -q`
Expected: PASS (all tests, including the existing location one, green).

- [ ] **Step 5: Commit**

```bash
.venv/bin/python -m ruff format hushh_mcp/adk_bridge/__init__.py tests/test_adk_registration.py
.venv/bin/python -m ruff check hushh_mcp/adk_bridge/__init__.py tests/test_adk_registration.py
git add hushh_mcp/adk_bridge/__init__.py tests/test_adk_registration.py
git commit -m "feat(email-a2a): register agent_email in-process specialist"
```

---

### Task 5: Full-suite verification of the A2A surface

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: green run across the A2A/orchestrator/email test surface, confirming email is reachable end-to-end from the One route (route unchanged, works via classifier + registration).

- [ ] **Step 1: Run the full related test surface**

Run:
```bash
.venv/bin/python -m pytest \
  tests/test_email_agent_a2a.py \
  tests/test_orchestrator_email_route.py \
  tests/test_a2a_delegation_scopes.py \
  tests/test_adk_registration.py \
  tests/test_adk_dispatch.py \
  tests/test_email_chat_service.py \
  tests/test_orchestrator_location_route.py \
  tests/test_agent_chat_delegation.py \
  tests/test_agent_chat_delegation_route.py \
  tests/test_agent_chat_routes.py \
  -q
```
Expected: PASS (all green). If `test_agent_chat_delegation*` or `test_agent_chat_routes` reference an exact specialist set and fail, update those expectations to include `agent_email` and re-run — the route logic itself needs no change.

- [ ] **Step 2: Confirm ruff is clean across all changed files**

Run:
```bash
.venv/bin/python -m ruff check \
  hushh_mcp/adk_bridge/delegation.py \
  hushh_mcp/adk_bridge/email_agent.py \
  hushh_mcp/adk_bridge/__init__.py \
  hushh_mcp/agents/orchestrator/tools.py \
  tests/test_email_agent_a2a.py \
  tests/test_orchestrator_email_route.py \
  tests/test_a2a_delegation_scopes.py \
  tests/test_adk_registration.py
```
Expected: no errors.

- [ ] **Step 3: Manual end-to-end smoke (optional, needs local backend + connected Gmail)**

Follow `docs/future/email-agent-nudges-plan.md` "Run it locally". Then from the One agent surface (`/agent`), send "what needs a reply in my inbox". Expected: the turn is delegated to `agent_email` and streams the email agent's answer (model label `one+email`). No `specialist_directive` card appears (read-only).

- [ ] **Step 4: No commit needed** (verification-only task). If Step 1 required updating any existing test expectations, commit those:

```bash
git add tests/
git commit -m "test(email-a2a): include agent_email in delegation route expectations"
```

---

## Self-Review

**Spec coverage (Phase 2a section of the design):**
- `email_agent.py` adapter → Task 3. ✓
- `__init__.py` registration → Task 4. ✓
- `orchestrator/tools.py` classifier cue → Task 2. ✓
- `delegation.py` consent scope → Task 1. ✓
- Consent reconciliation → the delegated path runs behind the One route's `VAULT_OWNER` dependency + the existing `gmail.readonly`/owner check (gated equally, never weaker). The `SPECIALIST_A2A_SCOPE_MAP["agent_email"]` entry declares the least-privilege scope but is not re-validated by the read adapter (mirrors `location_agent.py`); wiring `validate_a2a_consent_token` into read adapters is deferred cross-specialist hardening. ✓
- Frontend: none → confirmed no FE tasks. ✓
- Routing precision (qualified cues, fail-closed, non-email unchanged) → Task 2 tests. ✓
- Testing (classifier + adapter mapping, fake service, no live LLM/Gmail) → Tasks 2 & 3. ✓
- Phase 2b (durable requests) → intentionally excluded. ✓

**Placeholder scan:** No unresolved placeholders, filler, or vague steps; every code step includes the full code and every run step includes the command + expected result.

**Type consistency:** `EmailChatService.handle_turn` kwargs (`user_id`, `message`, `consent_token`, `conversation_id`) and its return keys (`conversationId`, `response`, `isComplete`, `stateChanged`) match Task 3's adapter and its test's `_FakeEmailService`. `SpecialistTurnResult` fields (`conversation_id`, `text`, `directive`, `is_complete`, `state_changed`, `model`) match the adapter and assertions. `SPECIALIST_A2A_SCOPE_MAP` key `"agent_email"` is consistent across Task 1 (source + test) and the registry id used in Tasks 2/4. `get_email_a2a` defined in Task 3, consumed in Task 4. All consistent.
