# Connections Agent One Tool-Loop Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `ConnectionsChatService` from a brittle regex handler into a Gemini function-calling tool-loop (parity with the Location/Gmail specialists) that supports the full connection CRUD conversationally — send / list / find / accept / reject / remove — with confirm-before-write on every graph mutation.

**Architecture:** Message turns run an LLM tool-loop over read tools (`list_my_connections`, `list_pending_requests`, `find_people`) and non-mutating *propose* tools. A propose tool emits a `clientPrompt` (a single-option `select` = "confirm") whose `ref` carries the operation + target id. The user's confirmation round-trips back as a `selection_result`, which a deterministic completion path (`_complete_action`, no LLM) executes by calling the already-real `ConnectionsService`. This reuses the exact `select` round-trip the current code and the shared frontend pick-card already support, and keeps writes off the message turn entirely.

**Tech Stack:** Python 3, FastAPI, `google.genai` (Gemini) types, pytest (async auto-mode). Backend only — no frontend, no DB schema, no new REST routes.

## Global Constraints

- **Confirm-before-write:** no graph mutation (`create_request`, `accept_request`, `reject_request`, `remove_connection`) may execute on a message turn. Every write is first proposed as a `clientPrompt` and executed only on the confirming `selection_result` turn.
- **Reuse the existing round-trip:** confirmations use `clientPrompt` `kind: "select"` (single option = confirm; multiple = disambiguation). Do NOT invent a new prompt kind — the frontend pick-card and the `ConnectionsAgentA2A` selection mapping already handle `select`.
- **No per-tool consent scopes in v1.** The One route already validates `AGENT_ONE_ORCHESTRATE` before dispatch; that plus confirm-before-write is the safety boundary. Fine-grained `cap.connections.*` scopes are explicitly out of scope.
- **Model unready → degrade like the reference specialists:** when Gemini types are absent or `ready()` is false, return the unavailable message (do NOT keep a second regex code path).
- **All writes go through `ConnectionsService`** (`consent-protocol/hushh_mcp/services/connections_service.py`) — the chat service never touches the DB directly.
- **Test runner:** all pytest commands run from `consent-protocol/` as `./.venv/bin/python -m pytest ...` (the project venv — the bare `python` on PATH lacks `yaml`/`google.genai`). Every `python -m pytest` in the steps below means `./.venv/bin/python -m pytest`.
- **Commit messages:** conventional style, DCO sign-off required — commit with `git commit -s` so a `Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>` trailer is added. **No** `Co-Authored-By: Claude` trailer. Every `git commit -m "..."` step below means `git commit -s -m "..."`.
- **Ref schema (used by every propose tool and by `_complete_action`):**
  ```
  {"op": "send_request"|"accept"|"reject"|"remove",
   "label": "<display name>",
   # exactly one id key, keyed by op:
   "addresseeUserId": "<uid>",   # op == send_request
   "requestId": "<uuid>",        # op == accept | reject
   "connectionId": "<uuid>"}     # op == remove
  ```

---

## File Structure

- **Modify (major rewrite):** `consent-protocol/hushh_mcp/services/connections_chat_service.py` — becomes the tool-loop service. Keeps `handle_turn(...)` signature-compatible with `ConnectionsAgentA2A` (`consent-protocol/hushh_mcp/adk_bridge/connections_agent.py:43-49`).
- **Modify:** `consent-protocol/hushh_mcp/agents/orchestrator/tools.py` — broaden the `agent_connections` classifier cues (`_SPECIALIST_ROUTES`, connections entry at ~`:137-146`) so natural phrasings reach the agent.
- **Create:** `consent-protocol/hushh_mcp/agents/connections/agent.yaml` + `consent-protocol/hushh_mcp/agents/connections/__init__.py` — declarative manifest (parity artifact + system-prompt source).
- **Rewrite/expand tests:** `consent-protocol/tests/services/test_connections_chat_service.py` (tool-loop behavior), `consent-protocol/tests/test_connections_classifier.py` (new cues), and a new `consent-protocol/tests/services/test_connections_manifest_sync.py`.
- **Unchanged (verify still green):** `consent-protocol/hushh_mcp/adk_bridge/connections_agent.py` and `consent-protocol/tests/test_connections_a2a.py` — the A2A wrapper already maps `clientPrompt` → `A2ADirective(kind="prompt")` and `delegate_result` selection → `selection_result`.

**Reference files (read, do not modify):**
- `consent-protocol/hushh_mcp/services/gmail_chat_service.py` — the clean tool-loop template (constructor model seam, `_run_tool_loop`, `_build_tools`, `_finish`).
- `consent-protocol/hushh_mcp/services/location_chat_service.py:509-723` — the loop that collects `prompts` from tools and surfaces `clientPrompt`; `_selection_seed_text`/`_selection_display_text` for reference.
- `consent-protocol/tests/test_gmail_chat_service.py` — the fake-store + scripted-model test harness this plan copies.

---

## Task 1: Deterministic completion path `_complete_action` (all four ops)

Replace the current `_complete_selection` (which stubs remove and only does add) with a general executor covering send/accept/reject/remove. Pure service-call logic, no LLM — unit-testable with a mock `ConnectionsService`. Also removes the dead `_remove`/`_add`/regex members in a later task; here we only add the executor + a helper the loop will reuse.

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_chat_service.py`
- Test: `consent-protocol/tests/services/test_connections_chat_service.py`

**Interfaces:**
- Consumes: `ConnectionsService.create_request(requester_user_id, *, addressee_user_id=..., query=...)`, `.accept_request(user_id, request_id)`, `.reject_request(user_id, request_id)`, `.remove_connection(user_id, connection_id)`, and `ConnectionsError` (all in `connections_service.py`).
- Produces: `ConnectionsChatService._complete_action(user_id: str, selection_result: dict, conv: str) -> dict` and `ConnectionsChatService._reply(response, conv, *, state_changed, client_prompt=None) -> dict` (keep the existing `_reply` shape from `connections_chat_service.py:180-198`).

- [ ] **Step 1: Write the failing tests**

Add to `consent-protocol/tests/services/test_connections_chat_service.py` (keep the existing import line; add `MagicMock` usage):

```python
import asyncio
from unittest.mock import MagicMock

from hushh_mcp.services.connections_chat_service import ConnectionsChatService


def _svc_with_mock():
    fake = MagicMock()
    return ConnectionsChatService(service=fake), fake


def test_complete_action_send_request_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}],
        "display": "Priya Rao",
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.create_request.assert_called_once_with("u1", addressee_user_id="u2")
    assert out["stateChanged"] is True
    assert "Priya Rao" in out["response"]


def test_complete_action_accept_executes():
    svc, fake = _svc_with_mock()
    sel = {"status": "answered",
           "selected": [{"op": "accept", "requestId": "r1", "label": "Sam Lee"}]}
    out = svc._complete_action("u1", sel, "c1")
    fake.accept_request.assert_called_once_with("u1", "r1")
    assert out["stateChanged"] is True
    assert "Sam Lee" in out["response"]


def test_complete_action_reject_executes():
    svc, fake = _svc_with_mock()
    sel = {"status": "answered",
           "selected": [{"op": "reject", "requestId": "r2", "label": "Sam Lee"}]}
    out = svc._complete_action("u1", sel, "c1")
    fake.reject_request.assert_called_once_with("u1", "r2")
    assert out["stateChanged"] is True


def test_complete_action_remove_executes():
    svc, fake = _svc_with_mock()
    sel = {"status": "answered",
           "selected": [{"op": "remove", "connectionId": "cx", "label": "Alex T"}]}
    out = svc._complete_action("u1", sel, "c1")
    fake.remove_connection.assert_called_once_with("u1", "cx")
    assert out["stateChanged"] is True
    assert "Alex T" in out["response"]


def test_complete_action_cancelled_is_noop():
    svc, fake = _svc_with_mock()
    out = svc._complete_action("u1", {"status": "cancelled", "selected": []}, "c1")
    fake.create_request.assert_not_called()
    fake.accept_request.assert_not_called()
    assert out["stateChanged"] is False


def test_complete_action_service_error_is_surfaced():
    from hushh_mcp.services.connections_service import ConnectionsError
    svc, fake = _svc_with_mock()
    fake.accept_request.side_effect = ConnectionsError("X", "Request is no longer pending.")
    sel = {"status": "answered",
           "selected": [{"op": "accept", "requestId": "r9", "label": "Sam"}]}
    out = svc._complete_action("u1", sel, "c1")
    assert out["response"] == "Request is no longer pending."
    assert out["stateChanged"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: FAIL — `_complete_action` does not exist (`AttributeError`).

- [ ] **Step 3: Implement `_complete_action`**

In `connections_chat_service.py`, replace the body of `_complete_selection` (lines `153-178`) with a call to a new `_complete_action`, and add `_complete_action`. Keep `_reply` (lines `180-198`) as-is. Add these methods to the `ConnectionsChatService` class:

```python
    _SUCCESS_TEXT = {
        "send_request": "Sent a connection request to {label}.",
        "accept": "You're now connected with {label}.",
        "reject": "Declined the request from {label}.",
        "remove": "Removed {label} from your connections.",
    }

    def _complete_action(self, user_id: str, selection_result: dict[str, Any], conv: str) -> dict[str, Any]:
        if str(selection_result.get("status")) == "cancelled":
            return self._reply("Okay, I won't change anything.", conv, state_changed=False)

        selected = selection_result.get("selected") or []
        chosen = selected[0] if selected and isinstance(selected[0], dict) else {}
        op = str(chosen.get("op") or "")
        label = str(chosen.get("label") or selection_result.get("display") or "them")

        try:
            if op == "send_request":
                addressee = str(chosen.get("addresseeUserId") or "")
                if not addressee:
                    return self._reply("I didn't catch who to connect with — try again?", conv, state_changed=False)
                self._service.create_request(user_id, addressee_user_id=addressee)
            elif op == "accept":
                rid = str(chosen.get("requestId") or "")
                if not rid:
                    return self._reply("I didn't catch which request — try again?", conv, state_changed=False)
                self._service.accept_request(user_id, rid)
            elif op == "reject":
                rid = str(chosen.get("requestId") or "")
                if not rid:
                    return self._reply("I didn't catch which request — try again?", conv, state_changed=False)
                self._service.reject_request(user_id, rid)
            elif op == "remove":
                cid = str(chosen.get("connectionId") or "")
                if not cid:
                    return self._reply("I didn't catch which connection — try again?", conv, state_changed=False)
                self._service.remove_connection(user_id, cid)
            else:
                return self._reply("I didn't catch what to do — try again?", conv, state_changed=False)
        except ConnectionsError as exc:
            return self._reply(exc.message, conv, state_changed=False)

        return self._reply(self._SUCCESS_TEXT[op].format(label=label), conv, state_changed=True)
```

Then point the old completion entrypoint at it — replace `_complete_selection` (lines `153-178`) with:

```python
    def _complete_selection(self, user_id: str, selection_result: dict[str, Any], conv: str) -> dict[str, Any]:
        return self._complete_action(user_id, selection_result, conv)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: PASS (all six new tests).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_chat_service.py consent-protocol/tests/services/test_connections_chat_service.py
git commit -m "feat(connections): deterministic _complete_action for send/accept/reject/remove"
```

---

## Task 2: Tool-loop scaffolding + read tools

Add the Gemini model seam and function-calling loop, and the three read tools. After this task, `handle_turn` answers read questions ("who are my connections", "any pending requests", "find people named X") through the LLM. Writes are not yet reachable (added in Task 3).

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_chat_service.py`
- Test: `consent-protocol/tests/services/test_connections_chat_service.py`

**Interfaces:**
- Consumes: `ConnectionsService.list_connections(user_id)`, `.list_requests(user_id, direction=...)`, `.search_directory(user_id, query=...)`; `get_agent_chat_service()` (from `hushh_mcp.services.agent_chat_service`); `hushh_mcp.operons.kai.llm` (`types`, `_require_gemini_ready`, `agent_chat_model_call`).
- Produces: `ConnectionsChatService(__init__(*, service=None, chat_store=None, model_call=None, genai_types=None, ready=None))`; `handle_turn(*, user_id, message=None, consent_token="", conversation_id=None, selection_result=None) -> dict`; `_run_tool_loop(user_id, contents) -> tuple[str, bool, dict|None]`; `_build_tools(user_id) -> dict[str, Callable]`; `_function_declarations(types) -> list`.

- [ ] **Step 1: Write the failing tests**

Add to `consent-protocol/tests/services/test_connections_chat_service.py` — copy the harness from `tests/test_gmail_chat_service.py`:

```python
from types import SimpleNamespace
from google.genai import types

_TOKEN = "tok"  # noqa: S105


class _Turn:
    def __init__(self, conversation_id, history):
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None):
        self.history = history or []
        self.added = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


def _fc_response(name, args):
    return SimpleNamespace(
        function_calls=[SimpleNamespace(name=name, args=args)],
        text="",
        candidates=[SimpleNamespace(content=types.Content(role="model", parts=[types.Part(text="")]))],
    )


def _text_response(text):
    return SimpleNamespace(function_calls=[], text=text, candidates=[])


def _scripted_model_call(responses):
    seq = iter(responses)

    async def _call(contents, config):
        return next(seq)

    return _call


def _loop_service(*, service, store, responses, ready=True):
    return ConnectionsChatService(
        service=service,
        chat_store=store,
        model_call=_scripted_model_call(responses),
        genai_types=types,
        ready=lambda: ready,
    )


async def test_list_my_connections_tool_flow():
    fake = MagicMock()
    fake.list_connections.return_value = [
        {"connectionId": "cx", "userId": "u2", "displayName": "Priya Rao"}
    ]
    store = _FakeStore()
    svc = _loop_service(
        service=fake, store=store,
        responses=[_fc_response("list_my_connections", {}),
                   _text_response("You're connected with Priya Rao.")],
    )
    out = await svc.handle_turn(user_id="u1", message="who are my connections", consent_token=_TOKEN)
    fake.list_connections.assert_called_once_with("u1")
    assert out["response"] == "You're connected with Priya Rao."
    assert out["stateChanged"] is False
    assert out["isComplete"] is True


async def test_find_people_tool_flow():
    fake = MagicMock()
    fake.search_directory.return_value = {"items": [{"userId": "u9", "displayName": "Sam Lee", "relationship": "none"}], "hasMore": False}
    svc = _loop_service(
        service=fake, store=_FakeStore(),
        responses=[_fc_response("find_people", {"query": "Sam"}),
                   _text_response("I found Sam Lee.")],
    )
    out = await svc.handle_turn(user_id="u1", message="find people named Sam", consent_token=_TOKEN)
    fake.search_directory.assert_called_once_with("u1", query="Sam")
    assert out["response"] == "I found Sam Lee."


async def test_list_pending_requests_tool_flow():
    fake = MagicMock()
    fake.list_requests.return_value = [
        {"id": "r1", "counterpartUserId": "u2", "counterpartDisplayName": "Sam Lee", "status": "pending"}
    ]
    svc = _loop_service(
        service=fake, store=_FakeStore(),
        responses=[_fc_response("list_pending_requests", {"direction": "incoming"}),
                   _text_response("Sam Lee asked to connect.")],
    )
    out = await svc.handle_turn(user_id="u1", message="any pending requests", consent_token=_TOKEN)
    fake.list_requests.assert_called_once_with("u1", direction="incoming")
    assert "Sam Lee" in out["response"]


async def test_unready_model_returns_unavailable():
    svc = _loop_service(service=MagicMock(), store=_FakeStore(), responses=[], ready=False)
    out = await svc.handle_turn(user_id="u1", message="who are my connections", consent_token=_TOKEN)
    assert "unavailable" in out["response"].lower()
    assert out["isComplete"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -k "tool_flow or unready" -v`
Expected: FAIL — constructor rejects `chat_store`/`model_call` kwargs (`TypeError`).

- [ ] **Step 3: Implement the loop and read tools**

At the top of `connections_chat_service.py`, add imports and module constants (below the existing imports):

```python
from typing import Any, Awaitable, Callable

from hushh_mcp.services.agent_chat_service import get_agent_chat_service

_MAX_HISTORY = 12
_MAX_TOOL_STEPS = 4
_LLM_TIMEOUT_S = 30.0
_HISTORY_CHARS = 2000
_UNAVAILABLE_MESSAGE = "The connections assistant is temporarily unavailable. Please try again."
_GAVE_UP_MESSAGE = "I couldn't finish that — please try rephrasing."
_QUERY_TOOL_NAMES = {"list_my_connections", "list_pending_requests", "find_people"}

ModelCall = Callable[[Any, Any], Awaitable[Any]]

_SYSTEM_PROMPT = (
    "You are the user's Connections assistant inside hushh One. You manage the "
    "account holder's two-way connection graph. Tools: `list_my_connections` "
    "lists active connections; `list_pending_requests` lists pending requests "
    "(direction 'incoming' or 'outgoing'); `find_people` searches the user's "
    "directory by name (returns userId, displayName, relationship). To CONNECT "
    "with someone, first `find_people` to resolve them, then call "
    "`propose_send_request` with their userId. If a name matches more than one "
    "person, call `request_person_choice` so the USER picks — never guess. To "
    "ACCEPT or REJECT a request, first `list_pending_requests` to get its id, "
    "then `propose_accept_request` / `propose_reject_request`. To REMOVE a "
    "connection, first `list_my_connections` to get its connectionId, then "
    "`propose_remove_connection`. You NEVER change the graph directly: every "
    "add/accept/reject/remove goes through a propose_* tool, which asks the user "
    "to confirm before anything happens. Be concise and reference the real names "
    "you saw in tool results. Never invent people."
)
```

Add module-level helpers (after the constants, before the class):

```python
def _history_contents(history: list[Any], types: Any) -> list:
    contents: list = []
    for message in history[-_MAX_HISTORY:]:
        role = getattr(message, "role", "")
        if role not in ("user", "assistant"):
            continue
        genai_role = "user" if role == "user" else "model"
        text = (getattr(message, "content", "") or "")[:_HISTORY_CHARS]
        contents.append(types.Content(role=genai_role, parts=[types.Part(text=text)]))
    return contents


def _as_response_dict(result: Any) -> dict:
    return result if isinstance(result, dict) else {"result": result}


def _function_declarations(types: Any) -> list:
    schema = types.Schema
    kind = types.Type
    return [
        types.FunctionDeclaration(
            name="list_my_connections",
            description="List the user's active connections (connectionId, userId, displayName). Read-only.",
            parameters=schema(type=kind.OBJECT, properties={}, required=[]),
        ),
        types.FunctionDeclaration(
            name="list_pending_requests",
            description="List pending connection requests. direction='incoming' (received) or 'outgoing' (sent). Read-only.",
            parameters=schema(
                type=kind.OBJECT,
                properties={"direction": schema(type=kind.STRING, description="'incoming' or 'outgoing'")},
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="find_people",
            description="Search the user's directory by display-name fragment. Returns userId, displayName, relationship. Read-only.",
            parameters=schema(
                type=kind.OBJECT,
                properties={"query": schema(type=kind.STRING, description="Name fragment to search")},
                required=["query"],
            ),
        ),
    ]
```

Now replace the constructor and add the loop. Change `__init__` (currently `connections_chat_service.py:52-53`) to:

```python
    def __init__(
        self,
        service: ConnectionsService | None = None,
        *,
        chat_store: Any = None,
        model_call: ModelCall | None = None,
        genai_types: Any = None,
        ready: Callable[[], bool] | None = None,
    ) -> None:
        self._service = service or ConnectionsService()
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()
        if model_call is not None:
            self._model_call = model_call
            self._types = genai_types
            self._ready = ready or (lambda: True)
        else:
            from hushh_mcp.operons.kai import llm as _llm

            self._types = genai_types or _llm.types
            self._ready = ready or _llm._require_gemini_ready

            async def _default_call(contents: Any, config: Any) -> Any:
                return await _llm.agent_chat_model_call(
                    contents, config, total_timeout_s=_LLM_TIMEOUT_S
                )

            self._model_call = _default_call
```

Replace `handle_turn` (currently `connections_chat_service.py:55-83`) with the branch-on-selection + tool-loop version:

```python
    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None,
        consent_token: str | None = None,
        conversation_id: str | None = None,
        selection_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        conv = conversation_id or ""

        if selection_result is not None:
            return self._complete_action(user_id, selection_result, conv)

        if not (message or "").strip():
            return self._reply(
                "Tell me who you'd like to connect with, or ask who your connections are.",
                conv,
                state_changed=False,
            )

        turn = await self._chat_store.prepare_turn(
            user_id=user_id, message=message, conversation_id=conversation_id
        )

        if self._types is None or not self._ready():
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, prompt=None)

        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored, prompt = await self._run_tool_loop(user_id=user_id, contents=contents)
        except Exception:
            logger.exception("Connections chat turn failed")
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, prompt=None)

        return await self._finish(turn, reply or "Done.", user_id, errored=errored, prompt=prompt)

    async def _run_tool_loop(self, *, user_id: str, contents: list) -> tuple[str, bool, dict | None]:
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            tools=[types.Tool(function_declarations=_function_declarations(types))],
            temperature=0.2,
        )
        tools = self._build_tools(user_id)
        reply = ""
        errored = False
        prompt: dict | None = None
        for _ in range(_MAX_TOOL_STEPS):
            response = await self._model_call(contents, config)
            calls = list(getattr(response, "function_calls", None) or [])
            if not calls:
                reply = (getattr(response, "text", "") or "").strip()
                break
            contents.append(response.candidates[0].content)
            tool_parts = []
            for call in calls:
                result, call_prompt = await self._run_tool(tools, call.name, dict(call.args or {}))
                if call_prompt is not None and prompt is None:
                    prompt = call_prompt
                tool_parts.append(types.Part.from_function_response(name=call.name, response=result))
            contents.append(types.Content(role="tool", parts=tool_parts))
            if prompt is not None:
                # A confirmation/disambiguation was requested; stop and surface it.
                reply = ""
                break
        else:
            reply = _GAVE_UP_MESSAGE
            errored = True
        return reply, errored, prompt

    async def _run_tool(self, tools: dict[str, Callable], name: str, args: dict) -> tuple[dict, dict | None]:
        tool = tools.get(name)
        if tool is None:
            logger.warning("connections_chat.tool_dispatch_miss name=%s", name)
            return {"error": "unknown_tool"}, None
        try:
            result = tool(**args)
        except ConnectionsError as exc:
            return {"error": "tool_failed", "message": exc.message}, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("connections_chat.tool_failed name=%s err=%s", name, exc, exc_info=True)
            return {"error": "tool_failed"}, None
        result_dict = _as_response_dict(result)
        prompt = self._prompt_from_tool(name, result_dict)
        return result_dict, prompt

    def _build_tools(self, user_id: str) -> dict[str, Callable]:
        service = self._service

        def list_my_connections() -> dict:
            return {"items": service.list_connections(user_id)}

        def list_pending_requests(direction: str = "incoming") -> dict:
            direction = "outgoing" if str(direction).lower() == "outgoing" else "incoming"
            return {"items": service.list_requests(user_id, direction=direction)}

        def find_people(query: str) -> dict:
            return service.search_directory(user_id, query=query)

        return {
            "list_my_connections": list_my_connections,
            "list_pending_requests": list_pending_requests,
            "find_people": find_people,
        }

    def _prompt_from_tool(self, name: str, result: dict) -> dict | None:
        # Propose/choice tools attach their prompt payload in Task 3/4. Reads never prompt.
        return None

    async def _finish(
        self, turn: Any, reply: str, user_id: str, *, errored: bool, prompt: dict | None
    ) -> dict[str, Any]:
        await self._chat_store.add_message(
            conversation_id=turn.conversation_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )
        out: dict[str, Any] = {
            "conversationId": turn.conversation_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": False,
        }
        if prompt is not None:
            out["clientPrompt"] = prompt
            out["isComplete"] = False
        return out
```

Delete the now-dead regex members: `_ADD_RE`, `_REMOVE_RE`, `_LIST_RE`, `_HELP` (lines `32-48`), and the `_add`, `_remove`, `_list` methods (lines `86-111`). Keep `_selection_prompt` (lines `114-151`) for now — Task 4 replaces it. Keep `_reply` and `_complete_action`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: PASS (Task 1 tests + the four new loop/read tests). The old `test_add_intent_sends_request` test is removed as part of this rewrite (its regex behavior no longer exists; send is covered by Task 3).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_chat_service.py consent-protocol/tests/services/test_connections_chat_service.py
git commit -m "feat(connections): Gemini tool-loop with read tools (list/find/pending)"
```

---

## Task 3: Propose tools — confirm-before-write for send/accept/reject/remove

Add the four non-mutating `propose_*` tools. Each returns a proposal payload; `_prompt_from_tool` turns it into a single-option `select` `clientPrompt` (= confirm) whose `ref` carries the op + id + label. No DB write happens on this turn.

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_chat_service.py`
- Test: `consent-protocol/tests/services/test_connections_chat_service.py`

**Interfaces:**
- Consumes: the Task 2 loop (`_run_tool`, `_prompt_from_tool`, `_build_tools`).
- Produces: tools `propose_send_request`, `propose_accept_request`, `propose_reject_request`, `propose_remove_connection`; each result carries `{"proposal": {ref..., "summary": str, "verb": str}}`. `_prompt_from_tool` emits a `select` prompt (`kind: "select"`, one option whose `ref` is the Global-Constraints ref schema).

- [ ] **Step 1: Write the failing tests**

Add to `consent-protocol/tests/services/test_connections_chat_service.py`:

```python
async def test_propose_send_request_emits_confirm_prompt_no_write():
    fake = MagicMock()
    svc = _loop_service(
        service=fake, store=_FakeStore(),
        responses=[
            _fc_response("propose_send_request", {"addressee_user_id": "u2", "label": "Priya Rao"}),
            _text_response("Want me to send Priya Rao a connection request?"),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="connect me with Priya", consent_token=_TOKEN)
    fake.create_request.assert_not_called()          # confirm-before-write
    assert out["isComplete"] is False
    prompt = out["clientPrompt"]
    assert prompt["kind"] == "select"
    assert len(prompt["options"]) == 1
    ref = prompt["options"][0]["ref"]
    assert ref == {"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}


async def test_propose_remove_emits_confirm_prompt():
    fake = MagicMock()
    svc = _loop_service(
        service=fake, store=_FakeStore(),
        responses=[_fc_response("propose_remove_connection", {"connection_id": "cx", "label": "Alex T"}),
                   _text_response("Remove Alex T?")],
    )
    out = await svc.handle_turn(user_id="u1", message="remove Alex", consent_token=_TOKEN)
    fake.remove_connection.assert_not_called()
    ref = out["clientPrompt"]["options"][0]["ref"]
    assert ref == {"op": "remove", "connectionId": "cx", "label": "Alex T"}


async def test_propose_accept_emits_confirm_prompt():
    svc = _loop_service(
        service=MagicMock(), store=_FakeStore(),
        responses=[_fc_response("propose_accept_request", {"request_id": "r1", "label": "Sam Lee"}),
                   _text_response("Accept Sam Lee?")],
    )
    out = await svc.handle_turn(user_id="u1", message="accept Sam's request", consent_token=_TOKEN)
    ref = out["clientPrompt"]["options"][0]["ref"]
    assert ref == {"op": "accept", "requestId": "r1", "label": "Sam Lee"}


async def test_confirm_roundtrip_executes_send(monkeypatch):
    # The prompt from turn 1 round-trips as a selection_result → _complete_action writes.
    fake = MagicMock()
    svc = ConnectionsChatService(service=fake)
    sel = {"status": "answered",
           "selected": [{"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}]}
    out = await svc.handle_turn(user_id="u1", message="", selection_result=sel)
    fake.create_request.assert_called_once_with("u1", addressee_user_id="u2")
    assert out["stateChanged"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -k "propose or roundtrip" -v`
Expected: FAIL — propose tools not in dispatch; `clientPrompt` is `None`.

- [ ] **Step 3: Implement propose tools + prompt builder**

Add `from uuid import uuid4` is already imported (line `22`). In `_build_tools`, add the four propose tools to the returned dict (they only echo a structured proposal — no service call):

```python
        def propose_send_request(addressee_user_id: str, label: str = "them") -> dict:
            return {"proposal": {"op": "send_request", "addresseeUserId": str(addressee_user_id),
                                 "label": str(label), "verb": "send a request to",
                                 "summary": f"Send a connection request to {label}?"}}

        def propose_accept_request(request_id: str, label: str = "them") -> dict:
            return {"proposal": {"op": "accept", "requestId": str(request_id),
                                 "label": str(label), "verb": "accept the request from",
                                 "summary": f"Accept the connection request from {label}?"}}

        def propose_reject_request(request_id: str, label: str = "them") -> dict:
            return {"proposal": {"op": "reject", "requestId": str(request_id),
                                 "label": str(label), "verb": "decline the request from",
                                 "summary": f"Decline the connection request from {label}?"}}

        def propose_remove_connection(connection_id: str, label: str = "them") -> dict:
            return {"proposal": {"op": "remove", "connectionId": str(connection_id),
                                 "label": str(label), "verb": "remove",
                                 "summary": f"Remove {label} from your connections?"}}
```

Add each to the returned dict alongside the read tools:

```python
        return {
            "list_my_connections": list_my_connections,
            "list_pending_requests": list_pending_requests,
            "find_people": find_people,
            "propose_send_request": propose_send_request,
            "propose_accept_request": propose_accept_request,
            "propose_reject_request": propose_reject_request,
            "propose_remove_connection": propose_remove_connection,
        }
```

Replace the stub `_prompt_from_tool` body with:

```python
    def _prompt_from_tool(self, name: str, result: dict) -> dict | None:
        if not isinstance(result, dict) or result.get("error"):
            return None
        proposal = result.get("proposal")
        if not (name.startswith("propose_") and isinstance(proposal, dict)):
            return None
        ref = {k: v for k, v in proposal.items() if k not in ("verb", "summary")}
        label = str(proposal.get("label") or "them")
        verb = str(proposal.get("verb") or "do this with")
        return {
            "id": "prm-" + uuid4().hex[:12],
            "kind": "select",
            "purpose": f"confirm_{proposal.get('op')}",
            "question": str(proposal.get("summary") or "Confirm?"),
            "options": [{"label": f"Yes, {verb} {label}", "ref": ref, "hint": None}],
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": False,
        }
```

Add the propose tool declarations to `_function_declarations(types)` (append to the returned list):

```python
        types.FunctionDeclaration(
            name="propose_send_request",
            description="Propose sending a connection request to a resolved userId. Asks the user to confirm before sending. Call after find_people resolves exactly one person.",
            parameters=schema(type=kind.OBJECT, properties={
                "addressee_user_id": schema(type=kind.STRING, description="Target userId from find_people"),
                "label": schema(type=kind.STRING, description="Their display name"),
            }, required=["addressee_user_id"]),
        ),
        types.FunctionDeclaration(
            name="propose_accept_request",
            description="Propose accepting a pending incoming request by its id (from list_pending_requests). Asks the user to confirm.",
            parameters=schema(type=kind.OBJECT, properties={
                "request_id": schema(type=kind.STRING, description="Request id"),
                "label": schema(type=kind.STRING, description="Requester display name"),
            }, required=["request_id"]),
        ),
        types.FunctionDeclaration(
            name="propose_reject_request",
            description="Propose declining a pending incoming request by its id (from list_pending_requests). Asks the user to confirm.",
            parameters=schema(type=kind.OBJECT, properties={
                "request_id": schema(type=kind.STRING, description="Request id"),
                "label": schema(type=kind.STRING, description="Requester display name"),
            }, required=["request_id"]),
        ),
        types.FunctionDeclaration(
            name="propose_remove_connection",
            description="Propose removing an active connection by its connectionId (from list_my_connections). Asks the user to confirm.",
            parameters=schema(type=kind.OBJECT, properties={
                "connection_id": schema(type=kind.STRING, description="connectionId"),
                "label": schema(type=kind.STRING, description="Their display name"),
            }, required=["connection_id"]),
        ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: PASS (all Task 1–3 tests).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_chat_service.py consent-protocol/tests/services/test_connections_chat_service.py
git commit -m "feat(connections): propose_* tools emit confirm-before-write prompts"
```

---

## Task 4: Disambiguation via `request_person_choice`

When a name matches more than one directory person, hand the choice to the user as a multi-option `select` (each option's `ref` carries `op: send_request` + `addresseeUserId`). Picking a person round-trips to `_complete_action` and sends. Replaces the old `_selection_prompt`.

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_chat_service.py`
- Test: `consent-protocol/tests/services/test_connections_chat_service.py`

**Interfaces:**
- Consumes: `ConnectionsService.search_directory(user_id, query=...)` (returns `{"items": [{"userId","displayName","relationship"}...]}`).
- Produces: tool `request_person_choice(name)`; when ≥2 candidates, its result carries `{"candidates": [...]}` and `_prompt_from_tool` builds a multi-option `select` (`purpose: "send_trusted_connection"`).

- [ ] **Step 1: Write the failing test**

```python
async def test_request_person_choice_multi_candidate_prompt():
    fake = MagicMock()
    fake.search_directory.return_value = {"items": [
        {"userId": "u2", "displayName": "Priya Rao", "relationship": "none"},
        {"userId": "u3", "displayName": "Priya Shah", "relationship": "none"},
    ], "hasMore": False}
    svc = _loop_service(
        service=fake, store=_FakeStore(),
        responses=[_fc_response("request_person_choice", {"name": "Priya"}),
                   _text_response("Which Priya?")],
    )
    out = await svc.handle_turn(user_id="u1", message="connect me with Priya", consent_token=_TOKEN)
    prompt = out["clientPrompt"]
    assert prompt["kind"] == "select"
    assert [o["ref"]["addresseeUserId"] for o in prompt["options"]] == ["u2", "u3"]
    assert all(o["ref"]["op"] == "send_request" for o in prompt["options"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -k person_choice -v`
Expected: FAIL — `request_person_choice` not in dispatch.

- [ ] **Step 3: Implement the tool + multi-option prompt + declaration**

In `_build_tools`, add:

```python
        def request_person_choice(name: str) -> dict:
            items = (service.search_directory(user_id, query=name) or {}).get("items") or []
            people = [p for p in items if p.get("userId")]
            if not people:
                return {"status": "not_found", "name": name}
            if len(people) == 1:
                p = people[0]
                return {"status": "resolved", "addresseeUserId": str(p.get("userId")),
                        "label": str(p.get("displayName") or "them")}
            return {"status": "ambiguous", "name": name, "candidates": [
                {"userId": str(p.get("userId")), "displayName": str(p.get("displayName") or "Someone")}
                for p in people
            ]}
```

Add it to the returned dict: `"request_person_choice": request_person_choice,`.

Extend `_prompt_from_tool` — before the `propose_` block, handle the choice tool:

```python
        if name == "request_person_choice" and result.get("status") == "ambiguous":
            options = [
                {"label": c["displayName"],
                 "ref": {"op": "send_request", "addresseeUserId": c["userId"], "label": c["displayName"]},
                 "hint": None}
                for c in (result.get("candidates") or []) if c.get("userId")
            ]
            return {
                "id": "prm-" + uuid4().hex[:12],
                "kind": "select",
                "purpose": "send_trusted_connection",
                "question": f"Which “{result.get('name')}”?",
                "options": options,
                "minSelections": 1,
                "maxSelections": 1,
                "allowFreeText": False,
            }
```

Add the declaration to `_function_declarations(types)`:

```python
        types.FunctionDeclaration(
            name="request_person_choice",
            description="When connecting and a name is ambiguous, ask the user to pick which person. Returns status 'resolved' (one match: then call propose_send_request), 'ambiguous' (shows a picker), or 'not_found'.",
            parameters=schema(type=kind.OBJECT, properties={
                "name": schema(type=kind.STRING, description="Name fragment the user gave"),
            }, required=["name"]),
        ),
```

Delete the now-unused `_selection_prompt` method (old lines `114-151`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_chat_service.py consent-protocol/tests/services/test_connections_chat_service.py
git commit -m "feat(connections): request_person_choice disambiguation picker"
```

---

## Task 5: Broaden classifier cues so natural phrasings route to `agent_connections`

Today only "trusted connection(s)", "who do i trust", "people i trust" route to the connections specialist (`orchestrator/tools.py:137-146`). Add cues for the new conversational surface so the tool-loop is actually reached.

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/orchestrator/tools.py` (the connections entry in `_SPECIALIST_ROUTES`, ~`:137-146`)
- Test: `consent-protocol/tests/test_connections_classifier.py`

**Interfaces:**
- Consumes: `classify_specialist_domain(message) -> (domain, agent_id)` and the existing `_SPECIALIST_ROUTES` table.
- Produces: expanded cue tuple for `agent_connections`.

- [ ] **Step 1: Write the failing tests**

Add to `consent-protocol/tests/test_connections_classifier.py` (match the file's existing assertion style — read it first to mirror how it calls the classifier):

```python
import pytest
from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.mark.parametrize("msg", [
    "connect me with Priya",
    "who are my connections",
    "accept Priya's request",
    "reject Sam's connection request",
    "remove Alex from my connections",
    "show my pending connection requests",
])
def test_connection_phrasings_route_to_connections(msg):
    _domain, agent_id = classify_specialist_domain(msg)
    assert agent_id == "agent_connections"
```

> Note: if `classify_specialist_domain` returns a single value or a different tuple shape in this repo, adapt the unpacking to match `tools.py:150`; keep the assertion that the resolved specialist is `agent_connections`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/test_connections_classifier.py -v`
Expected: FAIL — phrasings like "connect me with Priya" / "who are my connections" don't match the current narrow cues.

- [ ] **Step 3: Add cues**

In `orchestrator/tools.py`, extend the `agent_connections` cue tuple in `_SPECIALIST_ROUTES` (keep existing cues; add these), matching the surrounding tuple style:

```python
        "connect me with", "connect with", "add a connection", "my connections",
        "who are my connections", "list my connections", "remove connection",
        "remove from my connections", "accept" + " request", "accept request",
        "reject request", "decline request", "pending request", "pending requests",
        "connection request", "connection requests",
```

> Keep cues lowercased if the table matches on a lowercased message (verify against neighboring entries). Avoid a bare `"accept"`/`"reject"`/`"remove"` cue (too broad — would steal location/email turns); require the `connection`/`request` qualifier as shown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/test_connections_classifier.py -v`
Expected: PASS. Also run the location/email classifier tests to confirm no regressions:
`cd consent-protocol && python -m pytest tests/ -k "classifier or classify" -v`

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/orchestrator/tools.py consent-protocol/tests/test_connections_classifier.py
git commit -m "feat(connections): route natural connection phrasings to agent_connections"
```

---

## Task 6: Declarative manifest `agents/connections/agent.yaml` (parity artifact)

Add the manifest the parity audit called out. It documents the connections specialist's identity, required scope, and tool set. To keep it honest (not dead config), add a test asserting the yaml tool names stay in sync with the service's tool dispatch.

**Files:**
- Create: `consent-protocol/hushh_mcp/agents/connections/__init__.py` (empty)
- Create: `consent-protocol/hushh_mcp/agents/connections/agent.yaml`
- Test: `consent-protocol/tests/services/test_connections_manifest_sync.py`

**Interfaces:**
- Consumes: `ConnectionsChatService(...)._build_tools("u")` keys (the runtime tool set) and `PyYAML` (already a backend dependency — verify with `python -c "import yaml"`).
- Produces: the manifest file + a sync guard test.

- [ ] **Step 1: Write the failing test**

```python
from pathlib import Path
import yaml
from unittest.mock import MagicMock
from hushh_mcp.services.connections_chat_service import ConnectionsChatService

_MANIFEST = Path(__file__).resolve().parents[2] / "hushh_mcp" / "agents" / "connections" / "agent.yaml"


def test_manifest_tools_match_service_dispatch():
    manifest = yaml.safe_load(_MANIFEST.read_text())
    yaml_tools = {t["name"] for t in manifest["tools"]}
    runtime_tools = set(ConnectionsChatService(service=MagicMock())._build_tools("u").keys())
    assert yaml_tools == runtime_tools


def test_manifest_identity():
    manifest = yaml.safe_load(_MANIFEST.read_text())
    assert manifest["id"] == "agent_connections"
    assert "agent.one.orchestrate" in manifest["required_scopes"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_manifest_sync.py -v`
Expected: FAIL — manifest file does not exist.

- [ ] **Step 3: Create the manifest + package init**

Create empty `consent-protocol/hushh_mcp/agents/connections/__init__.py`.

Create `consent-protocol/hushh_mcp/agents/connections/agent.yaml`:

```yaml
id: agent_connections
name: Connections Agent
version: 0.1.0
description: Two-way connection graph specialist under One — send, list, find, accept, reject, and remove connections, with confirm-before-write on every mutation.
model: gemini-3-flash-preview
system_instruction: |
  You are the user's Connections assistant inside hushh One. You manage the
  account holder's two-way connection graph. Reads run directly; every graph
  mutation (send request, accept, reject, remove) is proposed first and executed
  only after the user confirms. Resolve people via find_people; if a name is
  ambiguous, use request_person_choice so the user picks — never guess. Reference
  the real names you saw in tool results; never invent people.
required_scopes:
  - agent.one.orchestrate
tools:
  - name: list_my_connections
    description: List the user's active connections (read-only).
  - name: list_pending_requests
    description: List pending incoming/outgoing connection requests (read-only).
  - name: find_people
    description: Search the user's directory by display name (read-only).
  - name: request_person_choice
    description: Ask the user to pick which person when a name is ambiguous.
  - name: propose_send_request
    description: Propose sending a connection request; user confirms before it sends.
  - name: propose_accept_request
    description: Propose accepting a pending request; user confirms before it accepts.
  - name: propose_reject_request
    description: Propose declining a pending request; user confirms before it declines.
  - name: propose_remove_connection
    description: Propose removing a connection; user confirms before it removes.
```

> Keep `system_instruction` here in sync with `_SYSTEM_PROMPT` in the service. (v1 uses the inline `_SYSTEM_PROMPT` at runtime, like the Gmail specialist; the manifest is the declarative record. A future task may load the prompt from the manifest.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_manifest_sync.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/connections/
git commit -m "feat(connections): declarative agent.yaml manifest + sync guard"
```

---

## Task 7: Full-suite regression + A2A round-trip verification

Confirm the whole connections surface is green end-to-end and the A2A wrapper still maps prompts/selections correctly against the rewritten service.

**Files:**
- Test only (no source changes expected).

- [ ] **Step 1: Run the connections test suite**

Run:
```bash
cd consent-protocol && python -m pytest \
  tests/services/test_connections_chat_service.py \
  tests/test_connections_a2a.py \
  tests/test_connections_classifier.py \
  tests/services/test_connections_manifest_sync.py \
  tests/services/test_connections_service.py \
  tests/routes/test_connections_route.py -v
```
Expected: PASS. `test_connections_a2a.py` must still pass unchanged (the wrapper contract is unchanged).

- [ ] **Step 2: Fix any fallout**

If `test_connections_a2a.py::test_handle_translates_delegate_selection_into_selection_result` fails, it means the wrapper→service selection contract drifted. Verify `ConnectionsAgentA2A.handle` (`connections_agent.py:33-49`) still passes `selection_result={"status","selected","display"}` and that `_complete_action` reads `selected[0]["op"]` + id keys. Adjust the service (not the wrapper) to honor the existing contract.

- [ ] **Step 3: Run the broader backend suite for the touched modules**

Run: `cd consent-protocol && python -m pytest tests/ -k "connections or classifier or orchestrator" -v`
Expected: PASS (no regressions in orchestrator routing).

- [ ] **Step 4: Commit any test adjustments**

```bash
git add consent-protocol/tests
git commit -m "test(connections): green full connections suite after tool-loop rewrite"
```

---

## Manual verification (after all tasks)

Use the `verify` skill / run the app to drive the real flow through Agent One chat:
1. "who are my connections" → lists real connections (read, no prompt).
2. "connect me with <name>" → confirm card appears; confirm → request sent; cancel → nothing changes.
3. "any pending requests" → lists incoming; "accept <name>" → confirm → connected.
4. "remove <name> from my connections" → confirm → removed.
5. Ambiguous name → picker appears; pick → request sent.

---

## Self-Review

**Spec coverage (against the findings doc's recommended increment):**
- "Rebuild ConnectionsChatService as a Location-style LLM tool-loop" → Tasks 2–4.
- "all CRUD (add/list/accept/reject/remove) live" → send (T3), list (T2), accept/reject (T3), remove (T3), find (T2).
- "directory-backed disambiguation" → Task 4.
- "confirm-before-write on every mutation" → Global Constraints + Tasks 1, 3 (propose→confirm→`_complete_action`).
- "agent.yaml manifest" → Task 6.
- "keep working phrasings green" → superseded by intended behavior change (send now confirms first); covered by Task 3's send tests + Task 5 phrasing routing. Documented as a deliberate change.
- Classifier reachability for new phrasings → Task 5.

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The `_prompt_from_tool` stub in Task 2 is intentional (returns `None`) and is fully implemented in Tasks 3–4.

**Type consistency:** `_complete_action` (T1) reads refs with keys `op`, `addresseeUserId`/`requestId`/`connectionId`, `label` — exactly what the `propose_*` proposals (T3) and `request_person_choice` options (T4) produce. `handle_turn` signature stays compatible with `ConnectionsAgentA2A.handle` (`connections_agent.py:43-49`), which passes `user_id`, `message`, `consent_token`, `conversation_id`, `selection_result`. Read-tool return shapes (`{"items": [...]}`) match what `list_connections`/`list_requests` return and what `search_directory` returns (`{"items","page","hasMore"}`).

**Open risk to watch during execution:** `classify_specialist_domain`'s exact return arity and the `_SPECIALIST_ROUTES` cue-matching semantics — Task 5 Step 1's note says to adapt the test unpacking to the real signature at `tools.py:150`.
