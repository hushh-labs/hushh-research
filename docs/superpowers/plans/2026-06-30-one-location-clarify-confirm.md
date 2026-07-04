# One Location Clarify-and-Confirm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the One Location agent ask structured clarify/confirm questions (multi-select + Yes/No + free-text) when a command is underspecified or destructive, with the server supplying the real ids so the agent acts on exact references.

**Architecture:** Reuse the v2 directive pattern. New server-side `request_*_choice` / `request_confirmation` `@hushh_tool`s load options (with real ids) and return a prompt payload; the service translates it into a coordinate-free `clientPrompt` on the response. The browser renders a `ClarificationCard`; the user's pick returns as a `selectionResult` follow-up turn; the service seeds the Gemini loop with the chosen refs so the agent runs the real action tools (`revoke_location_share(grantId)`, `create_location_share(...)`, …) or emits the existing v2 `clientAction`.

**Tech Stack:** Python (FastAPI, google.genai function-calling, pytest via `uv run python -m pytest`), TypeScript/React (Next.js, Vitest, existing `lib/one-location/encryption.ts`).

## Global Constraints

- **Branch:** `feat/one-location-agent-chat-v2` (already checked out; do NOT create a new branch).
- **Coordinate-free:** `clientPrompt`, every `PromptOption.ref`, and `selectionResult` carry only ids/labels — never lat/lng. Refs hold `grantId` / `recipientUserId` / `recipientKeyId` / `requestId` / `hours` / `all` / `publicLink`.
- **Consent preserved:** every new tool is an `@hushh_tool` run inside `HushhContext`; the `selectionResult` turn re-enters `HushhContext` to run resolved actions.
- **Service owns real ids:** options are built server-side from DB reads (the model never serializes a `grantId`/`recipientKeyId`).
- **`publish_location_envelope` / `view_location_envelope` stay non-LLM-callable** (not added to `V2_LOCATION_TOOLS` or the v2 declarations).
- **`clientPrompt` and `clientAction` are mutually exclusive on one response** (clarify first, then act); a request carries exactly one of `message` / `actionResult` / `selectionResult`.
- **Backward-compatible:** all v2 fields unchanged; `clientPrompt` / `selectionResult` are additive and optional.
- **Wire JSON is camelCase** via Pydantic aliases (`minSelections`, `allowFreeText`, `freeText`, …); Python internals snake_case; service payloads already camelCase.
- **Backend tests:** `cd consent-protocol && uv run python -m pytest <path> -v`. **Frontend tests (Vitest, NOT Jest):** `cd hushh-webapp && npx vitest run <path>` then `npx tsc --noEmit`. Test snippets below are illustrative — for frontend, translate to Vitest (`import { describe, it, expect, vi } from "vitest"`, `vi.fn()/vi.mock()`), mirroring the existing neighbouring test file. `noUncheckedIndexedAccess` is on.
- **Backend tools tests** invoke `@hushh_tool` callables via `.__wrapped__(...)` inside a `with HushhContext(...)` block (the established pattern in `tests/test_location_chat_tools_behavior.py`).

---

## Visual Map

```text
clarify-and-confirm sits BEFORE the v2 crypto handoff (same directive pattern).

"stop sharing my location" (no whom)
  -> request_active_share_choice() (@hushh_tool, real grantId refs)
  <- { response, clientPrompt:{ kind:"select", options:[grantId refs, "Stop all"] } }
browser: ClarificationCard (checkboxes + Confirm)
  -> POST /chat { selectionResult:{ selected:[{grantId}], status:"answered" } }
  -> service seeds the loop with the chosen ids -> revoke_location_share(g1) ...

For share: recipient choice -> duration -> create_location_share -> publish_share clientAction.
clientPrompt and clientAction are mutually exclusive (prompt wins). All coordinate-free.
```

## File Structure

**Backend (`consent-protocol/`)**
- `hushh_mcp/agents/location/tools.py` — 6 new prompt-builder tools + add to `V2_LOCATION_TOOLS` (Task 1).
- `hushh_mcp/agents/location/agent.yaml` — prompt additions for choice/confirm (Task 2).
- `hushh_mcp/services/location_chat_service.py` — v2 declarations gain the 6 tools; `clientPrompt` translation; `_run_tool_loop` extraction; `selectionResult` turn (Tasks 3 + 4).
- `api/routes/one/location_chat.py` — `selectionResult` request field + one-of validation; `clientPrompt` passes through (Task 5).

**Frontend (`hushh-webapp/`)**
- `lib/one-location/types.ts` — `PromptOption`, `ClientPrompt`, `SelectionResult`; `LocationChatResponse.clientPrompt?` (Task 6).
- `lib/one-location/service.ts` — `chat()` sends `selectionResult` (Task 6).
- `components/one-location/redesign/use-location-chat.ts` — `pendingPrompt`, `answerPrompt`, `confirmPrompt`, `cancelPrompt`, free-text-while-pending (Task 7).
- `components/one-location/redesign/clarification-card.tsx` — **new** (Task 8).
- `components/one-location/redesign/location-chat-panel.tsx` + `location-chat-overlay.tsx` — render the card (Task 8).

---

## Task 1: Prompt-builder tools + allow-list

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/tools.py`
- Test: `consent-protocol/tests/test_location_chat_tools_allowlist.py`, `consent-protocol/tests/test_location_chat_tools_behavior.py`

**Interfaces:**
- Consumes: existing `_ctx`, `_service`, `hushh_tool`, `ConsentScope`; `OneLocationAgentService.list_verified_recipients(owner_user_id=...)` (returns recipients with `userId`, `displayName`, `keyId`, `canReceiveLocation`) and `list_state(user_id=...)` (keys `ownerGrants`, `receivedGrants`, `requests`; grant payload has `id`, `recipientDisplayName`, `ownerDisplayName`, `expiresAt`, `status`; request payload has `id`, `requesterDisplayName`, `ownerUserId`, `status`).
- Produces (each returns `{"prompt": {...}}` when there is something to choose, else a plain data dict so the model can speak):
  - `request_recipient_choice()`, `request_active_share_choice()`, `request_duration_choice()`, `request_request_choice()`, `request_incoming_choice()`, `request_confirmation(summary, destructive=True)`
  - `V2_LOCATION_TOOLS` extended with all six.

- [ ] **Step 1: Write the failing allow-list test**

Append to `consent-protocol/tests/test_location_chat_tools_allowlist.py`:

```python
def test_v2_allowlist_includes_prompt_builder_tools_but_not_raw_envelope_tools():
    from hushh_mcp.agents.location.tools import (
        V2_LOCATION_TOOLS,
        request_recipient_choice,
        request_active_share_choice,
        request_duration_choice,
        request_request_choice,
        request_incoming_choice,
        request_confirmation,
        publish_location_envelope,
        view_location_envelope,
    )

    for tool in (
        request_recipient_choice,
        request_active_share_choice,
        request_duration_choice,
        request_request_choice,
        request_incoming_choice,
        request_confirmation,
    ):
        assert tool in V2_LOCATION_TOOLS

    assert publish_location_envelope not in V2_LOCATION_TOOLS
    assert view_location_envelope not in V2_LOCATION_TOOLS
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_tools_allowlist.py::test_v2_allowlist_includes_prompt_builder_tools_but_not_raw_envelope_tools -v`
Expected: FAIL — `ImportError` (tools don't exist yet).

- [ ] **Step 3: Add the six prompt-builder tools**

In `consent-protocol/hushh_mcp/agents/location/tools.py`, add these functions immediately before the `LOCATION_AGENT_TOOLS = [` list:

```python
def _expiry_hint(expires_at: Any) -> str | None:
    return f"expires {expires_at}" if expires_at else None


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_recipient_choice")
async def request_recipient_choice() -> dict[str, Any]:
    """Ask the user to pick who to share with. Returns a coordinate-free select
    prompt whose options carry real recipient ids. Call this when the user wants to
    share but did not name a (single, unambiguous) recipient."""
    context = _ctx()
    recipients = _service().list_verified_recipients(owner_user_id=context.user_id)
    options = [
        {
            "label": r.get("displayName") or "Someone",
            "ref": {"recipientUserId": r.get("userId"), "recipientKeyId": r.get("keyId")},
            "hint": None if r.get("canReceiveLocation") else "hasn't set up location yet",
        }
        for r in recipients
    ]
    options.append({"label": "Public link (anyone)", "ref": {"publicLink": True}, "hint": None})
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_recipient",
            "question": "Who do you want to share your location with?",
            "options": options,
            "minSelections": 1,
            "maxSelections": None,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REVOKE, name="request_active_share_choice")
async def request_active_share_choice() -> dict[str, Any]:
    """Ask the user which active outgoing share(s) to stop. Returns a coordinate-free
    multi-select prompt whose options carry real grant ids, plus a 'Stop all' option.
    Call this when the user wants to stop sharing but did not name a single share."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    active = [g for g in state.get("ownerGrants", []) if g.get("status") == "active"]
    if not active:
        return {"activeShares": []}
    options = [
        {
            "label": g.get("recipientDisplayName") or "Someone",
            "ref": {"grantId": g.get("id")},
            "hint": _expiry_hint(g.get("expiresAt")),
        }
        for g in active
    ]
    options.append({"label": "Stop all", "ref": {"all": True}, "hint": None})
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_share",
            "question": "Which sharing do you want to stop?",
            "options": options,
            "minSelections": 1,
            "maxSelections": None,
            "allowFreeText": True,
            "confirmLabel": "Stop sharing",
            "destructive": False,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_duration_choice")
async def request_duration_choice() -> dict[str, Any]:
    """Ask the user how long a share should last. Coordinate-free single-select."""
    _ctx()
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_duration",
            "question": "How long should this share last?",
            "options": [
                {"label": "1 hour", "ref": {"hours": 1}, "hint": None},
                {"label": "8 hours", "ref": {"hours": 8}, "hint": None},
                {"label": "24 hours", "ref": {"hours": 24}, "hint": None},
            ],
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REQUEST, name="request_request_choice")
async def request_request_choice() -> dict[str, Any]:
    """Ask the user which pending incoming access request to act on. Coordinate-free
    single-select whose options carry real request ids."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    pending = [
        r
        for r in state.get("requests", [])
        if r.get("status") == "pending" and r.get("ownerUserId") == context.user_id
    ]
    if not pending:
        return {"pendingRequests": []}
    options = [
        {
            "label": r.get("requesterDisplayName") or "Someone",
            "ref": {"requestId": r.get("id")},
            "hint": "wants to see your location",
        }
        for r in pending
    ]
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_request",
            "question": "Which request do you want to act on?",
            "options": options,
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="request_incoming_choice")
async def request_incoming_choice() -> dict[str, Any]:
    """Ask the user whose incoming shared location to view. Coordinate-free
    single-select whose options carry real grant ids."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    incoming = [g for g in state.get("receivedGrants", []) if g.get("status") == "active"]
    if not incoming:
        return {"incomingShares": []}
    options = [
        {
            "label": g.get("ownerDisplayName") or "Someone",
            "ref": {"grantId": g.get("id")},
            "hint": _expiry_hint(g.get("expiresAt")),
        }
        for g in incoming
    ]
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_incoming",
            "question": "Whose location do you want to see?",
            "options": options,
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_confirmation")
async def request_confirmation(summary: str, destructive: bool = True) -> dict[str, Any]:
    """Ask the user to confirm an irreversible or bulk action before it runs. Returns
    a coordinate-free yes/no confirm prompt. Use before creating a public link,
    sharing with everyone, or stopping all shares."""
    _ctx()
    return {
        "prompt": {
            "kind": "confirm",
            "purpose": "confirm_action",
            "question": str(summary or "Are you sure?"),
            "confirmLabel": "Yes",
            "cancelLabel": "Cancel",
            "destructive": bool(destructive),
        }
    }
```

Then extend the `V2_LOCATION_TOOLS` list (add the six at the end, before the closing `]`):

```python
    revoke_public_link,
    request_recipient_choice,
    request_active_share_choice,
    request_duration_choice,
    request_request_choice,
    request_incoming_choice,
    request_confirmation,
]
```

- [ ] **Step 4: Run the allow-list test to verify it passes**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_tools_allowlist.py -v`
Expected: PASS (new + existing).

- [ ] **Step 5: Write behavior tests for the prompt tools**

Append to `consent-protocol/tests/test_location_chat_tools_behavior.py` (mirror the file's existing `.__wrapped__` + `HushhContext` pattern; the service is patched so no DB is needed):

```python
import pytest
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.agents.location import tools as loc_tools


class _FakeSvc:
    def list_verified_recipients(self, *, owner_user_id, limit=50):
        return [
            {"userId": "u-mom", "displayName": "Mom", "keyId": "k-mom", "canReceiveLocation": True},
            {"userId": "u-kid", "displayName": "Kid", "keyId": None, "canReceiveLocation": False},
        ]

    def list_state(self, *, user_id):
        return {
            "ownerGrants": [
                {"id": "g1", "recipientDisplayName": "Mom", "expiresAt": "later", "status": "active"}
            ],
            "receivedGrants": [],
            "requests": [],
        }


async def test_request_recipient_choice_options_carry_real_ids_and_public_link(monkeypatch):
    monkeypatch.setattr(loc_tools, "_service", lambda: _FakeSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_recipient_choice.__wrapped__()
    prompt = out["prompt"]
    assert prompt["kind"] == "select" and prompt["purpose"] == "select_recipient"
    assert prompt["options"][0]["ref"] == {"recipientUserId": "u-mom", "recipientKeyId": "k-mom"}
    assert prompt["options"][1]["hint"] == "hasn't set up location yet"
    assert prompt["options"][-1]["ref"] == {"publicLink": True}
    # coordinate-free
    blob = repr(out).lower()
    assert "latitude" not in blob and "longitude" not in blob and "lat" not in blob.split("late")[0]


async def test_request_active_share_choice_includes_stop_all(monkeypatch):
    monkeypatch.setattr(loc_tools, "_service", lambda: _FakeSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_active_share_choice.__wrapped__()
    refs = [o["ref"] for o in out["prompt"]["options"]]
    assert {"grantId": "g1"} in refs
    assert {"all": True} in refs


async def test_request_confirmation_returns_confirm_prompt():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_confirmation.__wrapped__("Stop sharing with everyone?", True)
    assert out["prompt"]["kind"] == "confirm"
    assert out["prompt"]["destructive"] is True
    assert "everyone" in out["prompt"]["question"]
```

- [ ] **Step 6: Run the behavior tests to verify they pass**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_tools_behavior.py -v`
Expected: PASS. (If the existing file already imports `tools` differently, match its import alias; the `monkeypatch.setattr(<module>, "_service", …)` target must be the module these tools live in.)

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/tools.py consent-protocol/tests/test_location_chat_tools_allowlist.py consent-protocol/tests/test_location_chat_tools_behavior.py
git commit -m "feat(one-location): add clarify/confirm prompt-builder tools"
```

---

## Task 2: Agent prompt additions

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/agent.yaml`
- Test: `consent-protocol/tests/test_location_agent_manifest_v2.py`

**Interfaces:**
- Consumes: `ManifestLoader.load`.
- Produces: a `system_instruction` that instructs the model to call the `request_*_choice` tools when a slot is missing/ambiguous and `request_confirmation` before destructive/bulk actions.

- [ ] **Step 1: Write the failing test**

Append to `consent-protocol/tests/test_location_agent_manifest_v2.py`:

```python
def test_prompt_instructs_choice_and_confirmation_tools():
    text = _manifest().system_instruction.lower()
    assert "request_" in text  # references the choice/confirmation tools
    assert "do not guess" in text or "don't guess" in text
    assert "confirm" in text and ("irreversible" in text or "bulk" in text or "everyone" in text)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_agent_manifest_v2.py::test_prompt_instructs_choice_and_confirmation_tools -v`
Expected: FAIL (the current prompt lacks these phrases).

- [ ] **Step 3: Add the prompt paragraphs**

In `consent-protocol/hushh_mcp/agents/location/agent.yaml`, inside the `system_instruction: |` block, add these two paragraphs immediately before the final "Never invent or guess ids." paragraph (keep all existing text):

```yaml
  When a required detail is missing or ambiguous — who to share with, which share
  to stop, how long, or which incoming request — do NOT guess. Call the matching
  tool to ask the user: request_recipient_choice, request_active_share_choice,
  request_duration_choice, request_request_choice, or request_incoming_choice.
  Then act only on the exact ids the user picks.

  Before any irreversible or bulk action — creating a public link, sharing with
  everyone, or stopping all shares — call request_confirmation with a short
  summary and proceed only if the user confirms.
```

- [ ] **Step 4: Run the test + the v1/v2 regression to verify**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_agent_manifest_v2.py tests/test_location_chat_service.py tests/test_location_chat_service_v2.py -v`
Expected: PASS (the manifest test passes; the service tests still pass — they inject their own prompt/tools, so wording changes don't affect them).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/agent.yaml consent-protocol/tests/test_location_agent_manifest_v2.py
git commit -m "feat(one-location): prompt the agent to clarify and confirm"
```

---

## Task 3: Service — `clientPrompt` translation + loop extraction

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/location_chat_service.py`
- Test: `consent-protocol/tests/test_location_chat_service_v2.py`

**Interfaces:**
- Consumes: prompt-builder tools returning `{"prompt": {...}}` (Task 1).
- Produces: `_run_tool_loop(...) -> tuple[str, bool, bool, list[dict], list[dict]]` (reply, errored, state_changed, directives, prompts); `_prompt_from_tool`; `_build_client_prompt`; `_run_tool` now returns a 4-tuple `(result, mutated, directive, prompt)`; `_finish` accepts `client_prompt`; message turns emit `clientPrompt` when a prompt tool ran. (Task 4 reuses `_run_tool_loop`.)

- [ ] **Step 1: Write the failing test**

Append to `consent-protocol/tests/test_location_chat_service_v2.py` (reuse the file's existing fakes `_FakeStore`, `_fake_tool`, `_fc_response`, `_text_response`, `_service`):

```python
async def test_request_choice_tool_emits_client_prompt():
    store = _FakeStore()
    prompt_payload = {
        "prompt": {
            "kind": "select",
            "purpose": "select_share",
            "question": "Which sharing do you want to stop?",
            "options": [
                {"label": "Mom", "ref": {"grantId": "g1"}},
                {"label": "Stop all", "ref": {"all": True}},
            ],
            "minSelections": 1,
            "maxSelections": None,
            "allowFreeText": True,
        }
    }
    tools = [_fake_tool("request_active_share_choice", [], result=prompt_payload)]
    svc = _service(
        store,
        responses=[
            _fc_response("request_active_share_choice", {}),
            _text_response("Which sharing do you want to stop?"),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="stop sharing", consent_token="t")  # noqa: S106

    cp = out["clientPrompt"]
    assert cp["kind"] == "select" and cp["purpose"] == "select_share"
    assert cp["options"][0]["ref"] == {"grantId": "g1"}
    assert cp["id"].startswith("prm-")
    assert out["stateChanged"] is False
    assert "clientAction" not in out
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_service_v2.py::test_request_choice_tool_emits_client_prompt -v`
Expected: FAIL (`KeyError: 'clientPrompt'`).

- [ ] **Step 3: Add prompt-tool constants + the 6 v2 declarations**

In `consent-protocol/hushh_mcp/services/location_chat_service.py`, add after `_DIRECTIVE_GRANT_TOOLS` (line ~60):

```python
# Prompt-builder tools: their result yields a clientPrompt, and they mutate nothing.
_PROMPT_TOOL_NAMES = {
    "request_recipient_choice",
    "request_active_share_choice",
    "request_duration_choice",
    "request_request_choice",
    "request_incoming_choice",
    "request_confirmation",
}
```

Then add `_PROMPT_TOOL_NAMES` to `_QUERY_TOOL_NAMES` by extending that set literal (add the six names to the existing `_QUERY_TOOL_NAMES = {...}` so prompt tools never set `stateChanged`). Concretely, append these lines inside the existing `_QUERY_TOOL_NAMES` set:

```python
    "request_recipient_choice",
    "request_active_share_choice",
    "request_duration_choice",
    "request_request_choice",
    "request_incoming_choice",
    "request_confirmation",
```

In `_function_declarations_v2`, extend the `decls.extend([...])` list with these six declarations (add before the closing `]`):

```python
            types.FunctionDeclaration(
                name="request_recipient_choice",
                description="Ask the user to choose who to share with (returns selectable options). Call when no single recipient was named.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_active_share_choice",
                description="Ask the user which active share(s) to stop (selectable options incl. 'Stop all'). Call when stopping a share with no single target.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_duration_choice",
                description="Ask the user how long a share should last (1/8/24h or custom).",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_request_choice",
                description="Ask the user which pending incoming request to act on.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_incoming_choice",
                description="Ask the user whose incoming shared location to view.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_confirmation",
                description="Ask the user to confirm an irreversible or bulk action before it runs.",
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "summary": schema(type=kind.STRING, description="What to confirm"),
                        "destructive": schema(type=kind.BOOLEAN),
                    },
                    required=["summary"],
                ),
            ),
```

- [ ] **Step 4: Add `_prompt_from_tool`, `_build_client_prompt`, and 4-tuple `_run_tool`**

Change `_run_tool` to also return a prompt descriptor. Replace its body's return statements and signature:

```python
    async def _run_tool(self, name: str, args: dict) -> tuple[dict, bool, dict | None, dict | None]:
        """Execute one tool inside the active HushhContext.

        Returns (result, mutated, directive, prompt): directive → a clientAction
        descriptor; prompt → a clientPrompt descriptor; either may be None.
        """
        tool = self._dispatch.get(name)
        if tool is None:
            return {"error": "unknown_tool"}, False, None, None
        try:
            result = await tool(**args)
        except PermissionError:
            return {"error": "consent_denied"}, False, None, None
        except ValueError as exc:
            return {"error": "invalid_argument", "message": str(exc)}, False, None, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("Location tool %s failed: %s", name, exc)
            return {"error": "tool_failed"}, False, None, None
        result_dict = _as_response_dict(result)
        directive = self._directive_from_tool(name, result_dict)
        prompt = self._prompt_from_tool(name, result_dict)
        mutated = name not in _QUERY_TOOL_NAMES
        return result_dict, mutated, directive, prompt
```

Add these two methods next to `_build_client_action`:

```python
    @staticmethod
    def _prompt_from_tool(name: str, result: dict) -> dict | None:
        """Extract a coordinate-free prompt payload from a prompt-builder tool result."""
        if name not in _PROMPT_TOOL_NAMES:
            return None
        prompt = result.get("prompt") if isinstance(result, dict) else None
        return prompt if isinstance(prompt, dict) else None

    def _build_client_prompt(self, prompts: list[dict]) -> dict | None:
        """Fold collected prompt payloads into one clientPrompt (first one wins)."""
        if not prompts:
            return None
        return {"id": "prm-" + uuid4().hex[:12], **prompts[0]}
```

- [ ] **Step 5: Extract `_run_tool_loop` and use it in `handle_turn`**

Add this method (it is the body of the current loop, returning prompts too):

```python
    async def _run_tool_loop(
        self, *, user_id: str, consent_token: str, contents: list
    ) -> tuple[str, bool, bool, list[dict], list[dict]]:
        """Run the Gemini function-calling loop inside HushhContext.

        Returns (reply, errored, state_changed, directives, prompts).
        """
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=self._system_prompt,
            tools=[types.Tool(function_declarations=_function_declarations_v2(types))],
            temperature=0.2,
        )
        reply = ""
        errored = False
        state_changed = False
        directives: list[dict] = []
        prompts: list[dict] = []
        with HushhContext(user_id=user_id, consent_token=consent_token, vault_keys={}):
            for _ in range(_MAX_TOOL_STEPS):
                response = await self._model_call(contents, config)
                calls = list(getattr(response, "function_calls", None) or [])
                if not calls:
                    reply = (getattr(response, "text", "") or "").strip()
                    break
                contents.append(response.candidates[0].content)
                for call in calls:
                    result, mutated, directive, prompt = await self._run_tool(
                        call.name, dict(call.args or {})
                    )
                    state_changed = state_changed or mutated
                    if directive is not None:
                        directives.append(directive)
                    if prompt is not None:
                        prompts.append(prompt)
                    contents.append(
                        types.Content(
                            role="tool",
                            parts=[
                                types.Part.from_function_response(name=call.name, response=result)
                            ],
                        )
                    )
            else:
                reply = _GAVE_UP_MESSAGE
                errored = True
        return reply, errored, state_changed, directives, prompts
```

Now replace the body of `handle_turn` from `contents = _history_contents(...)` through the final `return await self._finish(...)` with:

```python
        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored, state_changed, directives, prompts = await self._run_tool_loop(
                user_id=user_id, consent_token=consent_token, contents=contents
            )
        except Exception:
            logger.exception("Location chat turn failed")
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, state_changed=False
            )

        client_prompt = self._build_client_prompt(prompts)
        client_action = None if client_prompt is not None else self._build_client_action(directives)
        if client_action is not None or client_prompt is not None:
            state_changed = False

        if not reply:
            reply = "Done."
        return await self._finish(
            turn,
            reply,
            user_id,
            errored=errored,
            state_changed=state_changed and not errored,
            client_action=client_action,
            client_prompt=client_prompt,
        )
```

(Delete the now-unused inline loop and the old `directives: list[dict] = []` / `with HushhContext...` block in `handle_turn` — `_run_tool_loop` replaces them. Keep the readiness check above this block unchanged.)

Update `_finish` to accept and surface `client_prompt`:

```python
    async def _finish(
        self,
        turn: Any,
        reply: str,
        user_id: str,
        *,
        errored: bool,
        state_changed: bool,
        client_action: dict | None = None,
        client_prompt: dict | None = None,
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
            "stateChanged": state_changed,
        }
        if client_action is not None:
            out["clientAction"] = client_action
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
        return out
```

- [ ] **Step 6: Run the v2 service tests to verify they pass**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_service_v2.py tests/test_location_chat_service.py -v`
Expected: PASS — the new prompt test plus all existing v1/v2 tests (the loop extraction preserves behavior: `clientAction`, `stateChanged`, action-result turns unchanged).

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/services/location_chat_service.py consent-protocol/tests/test_location_chat_service_v2.py
git commit -m "feat(one-location): translate prompt-builder results into clientPrompt"
```

---

## Task 4: Service — `selectionResult` turn

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/location_chat_service.py`
- Test: `consent-protocol/tests/test_location_chat_service_v2.py`

**Interfaces:**
- Consumes: `_run_tool_loop`, `_build_client_action`, `_build_client_prompt` (Task 3); `AgentChatService.get_recent_messages(conversation_id, *, user_id, limit)`.
- Produces: `handle_turn(..., selection_result: dict | None = None)`; `_handle_selection_result(...)`; `_selection_seed_text(selection_result) -> str` (coordinate-free).

- [ ] **Step 1: Write the failing tests**

Append to `consent-protocol/tests/test_location_chat_service_v2.py`:

```python
class _HistoryStore(_FakeStore):
    async def get_recent_messages(self, conversation_id, *, user_id, limit=20):
        return []


async def test_selection_result_seeds_loop_and_acts_on_real_ids():
    store = _HistoryStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_location_share", calls, result={"status": "revoked"})]
    svc = _service(
        store,
        responses=[
            _fc_response("revoke_location_share", {"grant_id": "g1"}),
            _text_response("Stopped sharing with Mom."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        selection_result={
            "id": "prm-1",
            "kind": "select",
            "selected": [{"grantId": "g1"}],
            "status": "answered",
        },
    )

    assert out["conversationId"] == "conv-1"
    assert out["response"] == "Stopped sharing with Mom."
    assert out["stateChanged"] is True
    assert calls[0]["args"] == {"grant_id": "g1"}  # exact id, never guessed


async def test_selection_result_cancelled_makes_no_tool_call():
    store = _HistoryStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_location_share", calls, result={"status": "revoked"})]
    svc = _service(
        store,
        responses=[_text_response("No problem — nothing changed.")],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        selection_result={"id": "prm-1", "kind": "select", "status": "cancelled"},
    )

    assert calls == []
    assert out["stateChanged"] is False
    assert out["isComplete"] is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_service_v2.py::test_selection_result_seeds_loop_and_acts_on_real_ids tests/test_location_chat_service_v2.py::test_selection_result_cancelled_makes_no_tool_call -v`
Expected: FAIL (`handle_turn` has no `selection_result` kwarg).

- [ ] **Step 3: Add the `selection_result` branch + handler + seed**

In `handle_turn`, add the `selection_result` parameter and a branch at the top (right after the `action_result` branch):

```python
    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None = None,
        consent_token: str,
        conversation_id: str | None = None,
        action_result: dict | None = None,
        selection_result: dict | None = None,
    ) -> dict[str, Any]:
        if action_result is not None:
            return await self._handle_action_result(
                user_id=user_id,
                conversation_id=conversation_id,
                action_result=action_result,
            )
        if selection_result is not None:
            return await self._handle_selection_result(
                user_id=user_id,
                consent_token=consent_token,
                conversation_id=conversation_id,
                selection_result=selection_result,
            )
        # ... existing message path unchanged ...
```

Add the seed builder (module-level function, near `_as_response_dict`):

```python
def _selection_seed_text(selection_result: dict) -> str:
    """Coordinate-free instruction the agent acts on for a selection turn."""
    if str(selection_result.get("status")) == "cancelled":
        return "I changed my mind — cancel that, take no action."
    free = selection_result.get("free_text") or selection_result.get("freeText")
    if free:
        return str(free)
    if str(selection_result.get("kind")) == "confirm":
        return "Yes, go ahead." if selection_result.get("confirmed") else "No, do not proceed."
    selected = selection_result.get("selected") or []
    parts = ["; ".join(f"{k}={v}" for k, v in ref.items()) for ref in selected if isinstance(ref, dict)]
    refs = " | ".join(parts)
    return f"I selected: {refs}. Use exactly these ids — do not guess — and proceed."
```

Add the handler (next to `_handle_action_result`):

```python
    async def _handle_selection_result(
        self,
        *,
        user_id: str,
        consent_token: str,
        conversation_id: str | None,
        selection_result: dict,
    ) -> dict[str, Any]:
        """Seed the Gemini loop with the user's choice (resolved refs) and act."""
        conv_id = conversation_id or ""
        if not conv_id:
            return {
                "conversationId": "",
                "response": "Let's start again — what would you like to do with your location sharing?",
                "isComplete": True,
                "stateChanged": False,
            }
        if self._types is None or not self._ready():
            await self._chat_store.add_message(
                conversation_id=conv_id,
                user_id=user_id,
                role="assistant",
                content=_UNAVAILABLE_MESSAGE,
                status="error",
            )
            return {
                "conversationId": conv_id,
                "response": _UNAVAILABLE_MESSAGE,
                "isComplete": False,
                "stateChanged": False,
            }

        types = self._types
        history = await self._chat_store.get_recent_messages(
            conv_id, user_id=user_id, limit=_MAX_HISTORY
        )
        contents = _history_contents(history, types)
        contents.append(
            types.Content(role="user", parts=[types.Part(text=_selection_seed_text(selection_result))])
        )

        try:
            reply, errored, state_changed, directives, prompts = await self._run_tool_loop(
                user_id=user_id, consent_token=consent_token, contents=contents
            )
        except Exception:
            logger.exception("Location chat selection turn failed")
            await self._chat_store.add_message(
                conversation_id=conv_id,
                user_id=user_id,
                role="assistant",
                content=_UNAVAILABLE_MESSAGE,
                status="error",
            )
            return {
                "conversationId": conv_id,
                "response": _UNAVAILABLE_MESSAGE,
                "isComplete": False,
                "stateChanged": False,
            }

        client_prompt = self._build_client_prompt(prompts)
        client_action = None if client_prompt is not None else self._build_client_action(directives)
        if client_action is not None or client_prompt is not None:
            state_changed = False
        if not reply:
            reply = "Done."
        await self._chat_store.add_message(
            conversation_id=conv_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )
        out: dict[str, Any] = {
            "conversationId": conv_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": state_changed and not errored,
        }
        if client_action is not None:
            out["clientAction"] = client_action
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
        return out
```

- [ ] **Step 4: Run the selection tests to verify they pass**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_service_v2.py -v`
Expected: PASS (all, including the two new selection tests).

- [ ] **Step 5: Run the full backend location-chat suite (no regression)**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_service.py tests/test_location_chat_service_v2.py tests/test_location_chat_routes.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/location_chat_service.py consent-protocol/tests/test_location_chat_service_v2.py
git commit -m "feat(one-location): selectionResult turn seeds the loop with chosen ids"
```

---

## Task 5: Route — `selectionResult` field + passthrough

**Files:**
- Modify: `consent-protocol/api/routes/one/location_chat.py`
- Test: `consent-protocol/tests/test_location_chat_routes.py`

**Interfaces:**
- Consumes: `handle_turn(..., selection_result=...)` (Task 4).
- Produces: request gains `selectionResult`; a turn requires one of message/actionResult/selectionResult; `clientPrompt` passes through in the response dict.

- [ ] **Step 1: Write the failing tests**

Append to `consent-protocol/tests/test_location_chat_routes.py`:

```python
def test_chat_route_forwards_selection_result(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(self, *, user_id, message=None, consent_token, conversation_id=None, action_result=None, selection_result=None):
            captured["selection_result"] = selection_result
            return {"conversationId": "c1", "response": "ok", "isComplete": True, "stateChanged": True}

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post(
        "/api/one/location/chat",
        json={
            "conversationId": "c1",
            "selectionResult": {"id": "prm-1", "kind": "select", "selected": [{"grantId": "g1"}], "status": "answered"},
        },
    )

    assert response.status_code == 200
    assert captured["selection_result"] == {"id": "prm-1", "kind": "select", "selected": [{"grantId": "g1"}], "status": "answered"}


def test_chat_route_passes_through_client_prompt(monkeypatch):
    class _Service:
        async def handle_turn(self, **kwargs):
            return {
                "conversationId": "c1",
                "response": "Which sharing do you want to stop?",
                "isComplete": True,
                "stateChanged": False,
                "clientPrompt": {"id": "prm-1", "kind": "select", "purpose": "select_share", "question": "?", "options": [{"label": "Mom", "ref": {"grantId": "g1"}}]},
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()
    response = client.post("/api/one/location/chat", json={"message": "stop sharing"})
    assert response.status_code == 200
    assert response.json()["clientPrompt"]["purpose"] == "select_share"


def test_chat_route_rejects_when_no_input(monkeypatch):
    monkeypatch.setattr(location_chat, "_service", lambda: object())
    client = _build_app()
    response = client.post("/api/one/location/chat", json={})
    assert response.status_code == 422
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_routes.py::test_chat_route_forwards_selection_result -v`
Expected: FAIL (`selectionResult` not accepted / not forwarded).

- [ ] **Step 3: Add the model + wire it**

In `consent-protocol/api/routes/one/location_chat.py`, add the model after `ActionResultModel`:

```python
class SelectionResultModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(max_length=64)
    kind: str = Field(max_length=24)
    selected: list[dict[str, Any]] | None = None
    confirmed: bool | None = None
    free_text: str | None = Field(default=None, alias="freeText", max_length=4000)
    status: str = Field(max_length=24)
```

Add the field to `LocationChatRequest`:

```python
    selection_result: SelectionResultModel | None = Field(default=None, alias="selectionResult")
```

Replace the guard + call in `location_chat`:

```python
    if not request.message and request.action_result is None and request.selection_result is None:
        raise HTTPException(
            status_code=422, detail="message, actionResult, or selectionResult is required"
        )
    try:
        result: dict[str, Any] = await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
            action_result=(
                request.action_result.model_dump(by_alias=True, exclude_none=True)
                if request.action_result is not None
                else None
            ),
            selection_result=(
                request.selection_result.model_dump(by_alias=True, exclude_none=True)
                if request.selection_result is not None
                else None
            ),
        )
        return result
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_routes.py -v`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/api/routes/one/location_chat.py consent-protocol/tests/test_location_chat_routes.py
git commit -m "feat(one-location): chat route accepts selectionResult, passes through clientPrompt"
```

---

## Task 6: Frontend types + `service.chat`

**Files:**
- Modify: `hushh-webapp/lib/one-location/types.ts`, `hushh-webapp/lib/one-location/service.ts`
- Test: `hushh-webapp/__tests__/services/location-chat-service.test.ts`

**Interfaces:**
- Produces: `PromptOption`, `ClientPromptKind`, `ClientPrompt`, `SelectionResult`; `LocationChatResponse.clientPrompt?`; `OneLocationService.chat({ ..., selectionResult? })`.

- [ ] **Step 1: Write the failing test** (Vitest — mirror the existing file's `mockApiJson` pattern)

Append to `hushh-webapp/__tests__/services/location-chat-service.test.ts`:

```ts
it("sends selectionResult and omits message", async () => {
  mockApiJson.mockResolvedValue({ conversationId: "c1", response: "ok", isComplete: true, stateChanged: true });
  await OneLocationService.chat({
    vaultOwnerToken: "tok",
    conversationId: "c1",
    selectionResult: { id: "prm-1", kind: "select", selected: [{ grantId: "g1" }], status: "answered" },
  });
  const body = JSON.parse(mockApiJson.mock.calls[0][1].body as string);
  expect(body.selectionResult).toEqual({ id: "prm-1", kind: "select", selected: [{ grantId: "g1" }], status: "answered" });
  expect(body.message ?? null).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/services/location-chat-service.test.ts -t "selectionResult"`
Expected: FAIL (TS error / not sent).

- [ ] **Step 3: Add the types**

In `hushh-webapp/lib/one-location/types.ts`, add before `LocationChatResponse`:

```ts
export interface PromptOption {
  label: string;
  ref: Record<string, unknown>;
  hint?: string | null;
}

export type ClientPromptKind = "select" | "confirm";

export interface ClientPrompt {
  id: string;
  kind: ClientPromptKind;
  purpose: string;
  question: string;
  options?: PromptOption[];
  minSelections?: number;
  maxSelections?: number | null;
  allowFreeText?: boolean;
  confirmLabel?: string | null;
  cancelLabel?: string | null;
  destructive?: boolean;
}

export interface SelectionResult {
  id: string;
  kind: ClientPromptKind;
  selected?: Record<string, unknown>[];
  confirmed?: boolean;
  freeText?: string;
  status: "answered" | "cancelled";
}
```

Add `clientPrompt?` to `LocationChatResponse`:

```ts
export interface LocationChatResponse {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
  clientAction?: ClientAction;
  clientPrompt?: ClientPrompt;
}
```

- [ ] **Step 4: Update `OneLocationService.chat`**

In `hushh-webapp/lib/one-location/service.ts`, add `SelectionResult` to the type import block, then replace the `chat` method:

```ts
  static async chat(params: {
    vaultOwnerToken: string;
    message?: string;
    conversationId?: string | null;
    actionResult?: ActionResult;
    selectionResult?: SelectionResult;
  }): Promise<LocationChatResponse> {
    return apiJson<LocationChatResponse>("/api/one/location/chat", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        message: params.message ?? null,
        conversationId: params.conversationId ?? null,
        actionResult: params.actionResult ?? null,
        selectionResult: params.selectionResult ?? null,
      }),
    });
  }
```

- [ ] **Step 5: Run the test + typecheck**

Run: `cd hushh-webapp && npx vitest run __tests__/services/location-chat-service.test.ts && npx tsc --noEmit`
Expected: PASS + clean. (Update the 2 existing `chat()` body-shape assertions to expect `selectionResult: null` too, mirroring the prior `actionResult: null` change.)

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/one-location/types.ts hushh-webapp/lib/one-location/service.ts hushh-webapp/__tests__/services/location-chat-service.test.ts
git commit -m "feat(one-location): clientPrompt/selectionResult types + service support"
```

---

## Task 7: Hook — pending prompt + answer/confirm/cancel + free-text fallback

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/use-location-chat.ts`
- Test: `hushh-webapp/__tests__/components/use-location-chat.test.tsx`

**Interfaces:**
- Consumes: `OneLocationService.chat({ selectionResult })`; types from Task 6.
- Produces: `UseLocationChat` gains `pendingPrompt: ClientPrompt | null`, `answerPrompt(refs: Record<string, unknown>[]): Promise<void>`, `confirmPrompt(yes: boolean): Promise<void>`, `cancelPrompt(): Promise<void>`. `send()` routes to a free-text selection when a prompt is pending. `pendingPrompt` and `pendingAction` are mutually exclusive.

- [ ] **Step 1: Write the failing tests** (Vitest — mirror the existing mock setup)

Append to `hushh-webapp/__tests__/components/use-location-chat.test.tsx`:

```tsx
it("sets pendingPrompt from a clientPrompt response", async () => {
  svc.chat.mockResolvedValueOnce({
    conversationId: "c1",
    response: "Which sharing do you want to stop?",
    isComplete: true,
    stateChanged: false,
    clientPrompt: {
      id: "prm-1",
      kind: "select",
      purpose: "select_share",
      question: "Which sharing do you want to stop?",
      options: [{ label: "Mom", ref: { grantId: "g1" } }, { label: "Stop all", ref: { all: true } }],
    },
  });
  const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }));
  await act(async () => { await result.current.send("stop sharing"); });
  expect(result.current.pendingPrompt?.purpose).toBe("select_share");
});

it("answerPrompt sends selected refs and clears the prompt", async () => {
  svc.chat
    .mockResolvedValueOnce({
      conversationId: "c1", response: "?", isComplete: true, stateChanged: false,
      clientPrompt: { id: "prm-1", kind: "select", purpose: "select_share", question: "?", options: [{ label: "Mom", ref: { grantId: "g1" } }] },
    })
    .mockResolvedValueOnce({ conversationId: "c1", response: "Stopped.", isComplete: true, stateChanged: true });
  const onStateChanged = vi.fn();
  const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1", onStateChanged }));
  await act(async () => { await result.current.send("stop sharing"); });
  await act(async () => { await result.current.answerPrompt([{ grantId: "g1" }]); });
  expect(svc.chat).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selectionResult: expect.objectContaining({ id: "prm-1", kind: "select", selected: [{ grantId: "g1" }], status: "answered" }),
    }),
  );
  expect(result.current.pendingPrompt).toBeNull();
  expect(onStateChanged).toHaveBeenCalled();
});

it("free text while a prompt is pending sends a freeText selection", async () => {
  svc.chat
    .mockResolvedValueOnce({
      conversationId: "c1", response: "?", isComplete: true, stateChanged: false,
      clientPrompt: { id: "prm-1", kind: "select", purpose: "select_recipient", question: "?", options: [] },
    })
    .mockResolvedValueOnce({ conversationId: "c1", response: "ok", isComplete: true, stateChanged: false });
  const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }));
  await act(async () => { await result.current.send("share"); });
  await act(async () => { await result.current.send("my coworker Alex"); });
  expect(svc.chat).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectionResult: expect.objectContaining({ freeText: "my coworker Alex", status: "answered" }) }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx -t "pendingPrompt"`
Expected: FAIL (`pendingPrompt` / `answerPrompt` don't exist).

- [ ] **Step 3: Extend the hook**

In `hushh-webapp/components/one-location/redesign/use-location-chat.ts`:

Add `ClientPrompt`, `SelectionResult` to the type import. Add to `UseLocationChat`:

```ts
  pendingPrompt: ClientPrompt | null;
  answerPrompt: (refs: Record<string, unknown>[]) => Promise<void>;
  confirmPrompt: (yes: boolean) => Promise<void>;
  cancelPrompt: () => Promise<void>;
```

Add state (next to `pendingAction`):

```ts
  const [pendingPrompt, setPendingPrompt] = useState<ClientPrompt | null>(null);
```

Add a shared result-applier and use it in `run` and `report` (replace the duplicated "push assistant message + set pending + onStateChanged" blocks in both with a call to `applyResult`):

```ts
  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof OneLocationService.chat>>) => {
      conversationIdRef.current = result.conversationId;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", text: result.response, stateChanged: result.stateChanged },
      ]);
      setPendingAction(result.clientAction ?? null);
      setPendingPrompt(result.clientPrompt ?? null);
      if (result.stateChanged) onStateChanged?.();
    },
    [nextId, onStateChanged],
  );
```

In `run`, replace the success block (`conversationIdRef.current = ...` through `if (result.stateChanged) onStateChanged?.();`) with `applyResult(result);`. Do the same in `report`.

Add a selection reporter + the three handlers (near `report`):

```ts
  const reportSelection = useCallback(
    async (selectionResult: SelectionResult) => {
      setBusy(true);
      setPendingPrompt(null);
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          conversationId: conversationIdRef.current,
          selectionResult,
        });
        applyResult(result);
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: LOCATION_CHAT_ERROR_TEXT, errored: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, applyResult, nextId],
  );

  const answerPrompt = useCallback(
    async (refs: Record<string, unknown>[]) => {
      const prompt = pendingPrompt;
      if (!prompt || busy) return;
      await reportSelection({ id: prompt.id, kind: prompt.kind, selected: refs, status: "answered" });
    },
    [pendingPrompt, busy, reportSelection],
  );

  const confirmPrompt = useCallback(
    async (yes: boolean) => {
      const prompt = pendingPrompt;
      if (!prompt || busy) return;
      await reportSelection({ id: prompt.id, kind: prompt.kind, confirmed: yes, status: "answered" });
    },
    [pendingPrompt, busy, reportSelection],
  );

  const cancelPrompt = useCallback(async () => {
    const prompt = pendingPrompt;
    if (!prompt) return;
    await reportSelection({ id: prompt.id, kind: prompt.kind, status: "cancelled" });
  }, [pendingPrompt, reportSelection]);
```

Modify `send` so free text answers a pending prompt:

```ts
  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setMessages((prev) => [...prev, { id: nextId(), role: "user", text: message }]);
      const prompt = pendingPrompt;
      if (prompt) {
        await reportSelection({ id: prompt.id, kind: prompt.kind, freeText: message, status: "answered" });
        return;
      }
      lastSentRef.current = message;
      await run(message);
    },
    [busy, run, nextId, pendingPrompt, reportSelection],
  );
```

Add `setPendingPrompt(null)` to `clear()`. Add the four new members to the returned object:

```ts
    pendingPrompt,
    answerPrompt,
    confirmPrompt,
    cancelPrompt,
```

- [ ] **Step 4: Run the hook tests to verify they pass**

Run: `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx`
Expected: PASS (new + existing v2 hook tests — `applyResult` preserves the prior `pendingAction` behavior; existing tests that set only `clientAction` still see `pendingAction` set and `pendingPrompt` null).

- [ ] **Step 5: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/use-location-chat.ts hushh-webapp/__tests__/components/use-location-chat.test.tsx
git commit -m "feat(one-location): pending prompt + answer/confirm/cancel + free-text fallback"
```

---

## Task 8: ClarificationCard + render in panel/overlay

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/clarification-card.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`, `location-chat-overlay.tsx`
- Test: `hushh-webapp/__tests__/components/clarification-card.test.tsx` (new)

**Interfaces:**
- Consumes: `ClientPrompt` (Task 6).
- Produces: `ClarificationCard({ prompt, busy, onAnswer, onConfirm, onCancel })` where `onAnswer(refs: Record<string, unknown>[])`, `onConfirm(yes: boolean)`, `onCancel()`.

- [ ] **Step 1: Write the failing component test** (Vitest; mirror `action-confirm-card.test.tsx` — native DOM assertions, no jest-dom)

Create `hushh-webapp/__tests__/components/clarification-card.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";

const selectPrompt = {
  id: "prm-1", kind: "select" as const, purpose: "select_share", question: "Which to stop?",
  options: [
    { label: "Mom", ref: { grantId: "g1" } },
    { label: "Dad", ref: { grantId: "g2" } },
  ],
  maxSelections: null, minSelections: 1,
};

it("multi-select: ticks options and answers with their refs", () => {
  const onAnswer = vi.fn();
  render(<ClarificationCard prompt={selectPrompt} busy={false} onAnswer={onAnswer} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByText("Mom"));
  fireEvent.click(screen.getByText("Dad"));
  fireEvent.click(screen.getByTestId("clarification-confirm"));
  expect(onAnswer).toHaveBeenCalledWith([{ grantId: "g1" }, { grantId: "g2" }]);
});

it("confirm prompt: Yes calls onConfirm(true)", () => {
  const onConfirm = vi.fn();
  render(
    <ClarificationCard
      prompt={{ id: "p", kind: "confirm", purpose: "confirm_action", question: "Stop all?", destructive: true }}
      busy={false} onAnswer={vi.fn()} onConfirm={onConfirm} onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId("clarification-confirm"));
  expect(onConfirm).toHaveBeenCalledWith(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/clarification-card.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Create the component**

Create `hushh-webapp/components/one-location/redesign/clarification-card.tsx`:

```tsx
"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ClientPrompt, PromptOption } from "@/lib/one-location/types";

function sameRef(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ClarificationCard({
  prompt,
  busy,
  onAnswer,
  onConfirm,
  onCancel,
}: {
  prompt: ClientPrompt;
  busy: boolean;
  onAnswer: (refs: Record<string, unknown>[]) => void;
  onConfirm: (yes: boolean) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, unknown>[]>([]);
  const single = prompt.kind === "select" && prompt.maxSelections === 1;

  const toggle = (opt: PromptOption) => {
    if (single) {
      onAnswer([opt.ref]); // single-pick auto-answers
      return;
    }
    setPicked((prev) =>
      prev.some((r) => sameRef(r, opt.ref))
        ? prev.filter((r) => !sameRef(r, opt.ref))
        : [...prev, opt.ref],
    );
  };

  return (
    <div
      data-testid="clarification-card"
      className="rounded-2xl border border-[#b8894d]/40 bg-[#b8894d]/5 p-4"
    >
      <p className="text-sm font-medium">{prompt.question}</p>

      {prompt.kind === "select" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {(prompt.options ?? []).map((opt) => {
            const active = picked.some((r) => sameRef(r, opt.ref));
            return (
              <button
                key={opt.label}
                type="button"
                data-testid="clarification-option"
                disabled={busy}
                onClick={() => toggle(opt)}
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors " +
                  (active
                    ? "border-[#b8894d] bg-[#b8894d]/15 text-[#b8894d]"
                    : "border-[color:var(--app-card-border-standard)] text-foreground hover:border-[#d4a574]/50")
                }
              >
                {opt.label}
                {opt.hint ? <span className="ml-1 opacity-60">· {opt.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        {prompt.kind === "confirm" ? (
          <Button
            data-testid="clarification-confirm"
            size="sm"
            isLoading={busy}
            variant={prompt.destructive ? "destructive" : "default"}
            onClick={() => onConfirm(true)}
          >
            {prompt.confirmLabel ?? "Yes"}
          </Button>
        ) : (
          <Button
            data-testid="clarification-confirm"
            size="sm"
            isLoading={busy}
            disabled={busy || (!single && picked.length < (prompt.minSelections ?? 1))}
            onClick={() => onAnswer(picked)}
          >
            {prompt.confirmLabel ?? "Confirm"}
          </Button>
        )}
        <Button
          data-testid="clarification-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {prompt.cancelLabel ?? "Cancel"}
        </Button>
      </div>
    </div>
  );
}
```

(If `components/ui/button.tsx` has no `"destructive"` variant, use the closest existing variant for the destructive case — check the file and adjust.)

- [ ] **Step 4: Run the component test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/clarification-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Render it in the panel and overlay (mutually exclusive with the action card)**

In `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`: add the import `import { ClarificationCard } from "./clarification-card";`. Replace the existing `{chat.pendingAction ? (...) : null}` block so the prompt takes precedence:

```tsx
{chat.pendingPrompt ? (
  <ClarificationCard
    prompt={chat.pendingPrompt}
    busy={chat.busy}
    onAnswer={chat.answerPrompt}
    onConfirm={chat.confirmPrompt}
    onCancel={chat.cancelPrompt}
  />
) : chat.pendingAction ? (
  <ActionConfirmCard
    action={chat.pendingAction}
    busy={chat.busy}
    onConfirm={chat.confirmAction}
    onCancel={chat.cancelAction}
  />
) : null}
```

(Preserve any wrapping element the current block uses.) Then pass the prompt props through to the overlay alongside the existing action props:

```tsx
        pendingPrompt={chat.pendingPrompt}
        answerPrompt={chat.answerPrompt}
        confirmPrompt={chat.confirmPrompt}
        cancelPrompt={chat.cancelPrompt}
```

In `hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx`: add the same optional props to the component's prop type:

```tsx
  pendingPrompt?: import("@/lib/one-location/types").ClientPrompt | null;
  answerPrompt?: (refs: Record<string, unknown>[]) => Promise<void>;
  confirmPrompt?: (yes: boolean) => Promise<void>;
  cancelPrompt?: () => Promise<void>;
```

and render the card (mirroring how it renders `ActionConfirmCard`), preferring the prompt:

```tsx
{pendingPrompt && answerPrompt && confirmPrompt && cancelPrompt ? (
  <ClarificationCard prompt={pendingPrompt} busy={busy} onAnswer={answerPrompt} onConfirm={confirmPrompt} onCancel={cancelPrompt} />
) : pendingAction && confirmAction && cancelAction ? (
  <ActionConfirmCard action={pendingAction} busy={busy} onConfirm={confirmAction} onCancel={cancelAction} />
) : null}
```

(Add the `import { ClarificationCard } from "./clarification-card";` to the overlay.)

- [ ] **Step 6: Run the chat-surface tests + typecheck**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-panel.test.tsx __tests__/components/location-chat-overlay.test.tsx __tests__/components/clarification-card.test.tsx && npx tsc --noEmit`
Expected: PASS + clean. (Update any panel/overlay test that asserts on the prior single-card block.)

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/clarification-card.tsx hushh-webapp/components/one-location/redesign/location-chat-panel.tsx hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx hushh-webapp/__tests__/components/clarification-card.test.tsx
git commit -m "feat(one-location): ClarificationCard + render in chat surfaces"
```

---

## Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Backend — run the location-chat suite**

Run: `cd consent-protocol && uv run python -m pytest tests/test_location_chat_service.py tests/test_location_chat_service_v2.py tests/test_location_chat_routes.py tests/test_location_chat_tools_allowlist.py tests/test_location_chat_tools_behavior.py tests/test_location_chat_agent_factory.py tests/test_location_agent_manifest_v2.py -v`
Expected: all PASS.

- [ ] **Step 2: Frontend — run the location tests + typecheck**

Run: `cd hushh-webapp && npx vitest run use-location-chat clarification-card action-confirm-card location-chat-panel location-chat-overlay location-chat-suggestions location-chat-service one-location-agent-page && npx tsc --noEmit`
Expected: all PASS + clean.

- [ ] **Step 3: Lint touched frontend files**

Run: `cd hushh-webapp && npx eslint components/one-location/redesign/clarification-card.tsx components/one-location/redesign/use-location-chat.ts components/one-location/redesign/location-chat-panel.tsx components/one-location/redesign/location-chat-overlay.tsx lib/one-location/service.ts lib/one-location/types.ts`
Expected: clean (fix any issues).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "test(one-location): clarify-confirm full-suite verification" || echo "nothing to commit"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §4 architecture (prompt tools → clientPrompt → selectionResult → seeded loop) → Tasks 1, 3, 4. ✓
- §5 contract (`ClientPrompt`/`PromptOption`/`SelectionResult`, camelCase, mutually exclusive) → Tasks 3 (build), 5 (route), 6 (TS). ✓
- §6 tools table (recipient/active-share/duration/request/incoming/confirmation, scopes) → Task 1; prompt wording → Task 2. ✓
- §7 flows (share→duration→publish_share clientAction; stop→revoke each; stop-all→confirm; cancel) → Tasks 1/3/4 + 7/8. ✓
- §8 frontend (ClarificationCard, pendingPrompt, free-text fallback, mutual exclusivity, clear) → Tasks 6, 7, 8. ✓
- §9 invariants (coordinate-free, HushhContext, service-owns-ids, crypto path unchanged, destructive confirm) → enforced across Tasks 1–8 + verified Task 9. ✓
- §10 testing → each task's tests + Task 9. ✓

**Placeholder scan:** No placeholder markers or vague cross-references. Two "check the real Button variant / preserve wrapping element" notes point at concrete in-repo facts the implementer verifies; full code is provided for all new logic.

**Type consistency:** `ClientPrompt`/`PromptOption`/`SelectionResult` field names identical across Task 3 (Python dict keys: `id,kind,purpose,question,options[{label,ref,hint}],minSelections,maxSelections,allowFreeText,confirmLabel,cancelLabel,destructive`) and Task 6 (TS). `selection_result`/`selectionResult` and `free_text`/`freeText` aliasing consistent across Tasks 4, 5, 6. Hook members `pendingPrompt`/`answerPrompt`/`confirmPrompt`/`cancelPrompt` consistent across Tasks 7, 8. `_run_tool` 4-tuple consistent across Task 3 (definition) and `_run_tool_loop` (consumer).
