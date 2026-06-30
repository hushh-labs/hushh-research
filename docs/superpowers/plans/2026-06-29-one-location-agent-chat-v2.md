# One Location Agent Chat v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the One Location agent drive coordinate-touching actions (share / approve / view / public-link) through a structured agent→client action-handoff, plus platform-aware recipient resolution, without the server or agent ever seeing plaintext coordinates (one bounded exception: owner-confirmed public-link snapshots).

**Architecture:** Every coordinate-touching op splits into a *server-side prep step* (a real `@hushh_tool` in `HushhContext`, scope-validated, coordinate-free) and a *client-side completion step* (capture → encrypt → upload, coords stay in the browser). The backend returns a coordinate-free `clientAction` directive; the browser confirms, runs the existing crypto pipeline, and reports back via an `actionResult` follow-up turn. The action-result confirmation is deterministic (templated text), so no LLM call and no coordinates are involved on that turn.

**Tech Stack:** Python (FastAPI, google.genai function-calling, pytest), TypeScript/React (Next.js, Web Crypto via existing `lib/one-location/encryption.ts`, Jest + React Testing Library).

## Global Constraints

- **Branch:** `feat/one-location-agent-chat-v2` (already checked out; do NOT create a new branch).
- **No new DB migration** — all tables (`061_one_location_agent.sql`, `064`) already exist.
- **Consent enforcement preserved:** all server-side mutations run as `@hushh_tool` inside `HushhContext`; the publish/view REST routes re-validate the HCT.
- **Agent never sees/returns coordinates:** `clientAction` and `actionResult` are coordinate-free by construction; reject any coordinate field in either model.
- **`publish_location_envelope` and `view_location_envelope` are NEVER LLM-callable** (they are impossible server-side). Enforced in the allow-list, asserted in tests — not only in the prompt.
- **Zero server-side plaintext coordinates** holds for per-recipient shares (ciphertext-only). The ONLY relaxed path is the owner-confirmed, ≤24h, revocable **public-link snapshot** (reuses existing `create_public_invite`).
- **Backward-compatible contract:** v1 fields (`conversationId`, `response`, `isComplete`, `stateChanged`) unchanged; new fields are additive and optional.
- **Response keys are camelCase** in API output (`conversationId`, `clientAction`, etc.); Python service internals are snake_case; service payloads (`_grant_payload`) are already camelCase (`id`, `recipientUserId`, `recipientKeyId`, `recipientDisplayName`).
- **Encryption:** `ECDH-P256-AES256-GCM` per recipient, ephemeral sender key, via existing `encryptLocationForRecipient` / `decryptLocationEnvelope`. Do not write new crypto.
- **Run backend tests:** `cd consent-protocol && python -m pytest <path> -v`. **Run frontend tests:** `cd hushh-webapp && npx vitest run <path>` and `npx tsc --noEmit`.
- **Frontend test framework is Vitest, NOT Jest.** The test snippets in this plan are written in Jest syntax for *logic guidance only* — when implementing, translate them to Vitest: `import { describe, it, expect, vi, beforeEach } from "vitest"`, use `vi.fn()` / `vi.mock()` / `vi.spyOn()` (not `jest.*`), and **mirror the conventions of the neighbouring existing test file** (e.g. `__tests__/components/use-location-chat.test.tsx`, which uses top-of-file `vi.mock(...)`). `noUncheckedIndexedAccess` is enabled — Vitest does not full-typecheck, so always run `npx tsc --noEmit` after each frontend task and fix any indexed-access errors.

---

## Visual Map

```text
v2 turn: agent emits a coordinate-free clientAction; the browser does the crypto.

POST /api/one/location/chat (message)
  -> Gemini loop in HushhContext
       create_location_share / approve_location_request  (@hushh_tool, no coords)
  <- { response, clientAction:{ type:"publish_share", grantId, recipients } }
browser: ActionConfirmCard -> capture -> encrypt-per-recipient -> POST envelope (ciphertext)
  -> POST /chat { actionResult: completed }  <- confirmation, stateChanged:true

publish_share / view_envelope / create_public_link travel as clientAction directives;
the agent never sees coordinates. Public links: bounded owner-confirmed snapshot.
```

## File Structure

**Backend (`consent-protocol/`)**
- `hushh_mcp/agents/location/tools.py` — add 5 v2 tools + `V2_LOCATION_TOOLS` allow-list (Task 1).
- `hushh_mcp/agents/location/agent.py` — add `get_location_chat_agent_v2()` factory (Task 2).
- `hushh_mcp/agents/location/agent.yaml` — relax refusal prompt + register new tools (Task 3).
- `hushh_mcp/services/location_chat_service.py` — v2 function declarations, directive collection → `clientAction`, `action_result` confirmation turn (Task 4).
- `api/routes/one/location_chat.py` — extend request model (`message` optional, `actionResult`), pass through (Task 5).

**Frontend (`hushh-webapp/`)**
- `lib/one-location/types.ts` — `ClientAction`, `ActionResult`, `ShareTarget`; extend `LocationChatResponse` (Task 6).
- `lib/one-location/service.ts` — `chat()` accepts/sends `actionResult` (Task 6).
- `components/one-location/redesign/use-location-chat.ts` — pending-action state + dispatcher (Task 7).
- `components/one-location/redesign/action-confirm-card.tsx` — **new** confirm UI (Task 8).
- `components/one-location/redesign/location-chat-panel.tsx` / `location-chat-overlay.tsx` (and the message list) — render the card + new chips (Task 8).
- `app/one/location/page.tsx` — pass `userId` into the hook; render decrypted view result (Task 9).

---

## Task 1: v2 agent tools + allow-list

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/tools.py`
- Test: `consent-protocol/tests/test_location_chat_tools_allowlist.py`, `consent-protocol/tests/test_location_chat_tools_behavior.py`

**Interfaces:**
- Consumes: existing `OneLocationAgentService.list_state`, `revoke_public_invite`, `normalize_duration_hours`; existing `_ctx`, `_service`, `_require_uuid`, `hushh_tool`, `ConsentScope`.
- Produces:
  - `list_incoming_location_shares() -> {"incomingShares": [{grantId, ownerUserId, ownerDisplayName, expiresAt}]}`
  - `list_public_links() -> {"publicLinks": [{inviteId, status, expiresAt, publicUrl}]}`
  - `propose_public_link(duration_hours: float) -> {"proposed": "create_public_link", "durationHours": float}`
  - `propose_location_view(grant_id: str) -> {"proposed": "view_envelope", "grantId": str}`
  - `revoke_public_link(invite_id: str) -> dict` (mutating)
  - `V2_LOCATION_TOOLS: list` (allow-list)

- [ ] **Step 1: Write the failing allow-list tests**

Append to `consent-protocol/tests/test_location_chat_tools_allowlist.py`:

```python
def test_v2_allowlist_adds_prep_and_handoff_tools_but_not_raw_envelope_tools():
    from hushh_mcp.agents.location.tools import (
        V2_LOCATION_TOOLS,
        create_location_share,
        approve_location_request,
        list_incoming_location_shares,
        list_public_links,
        propose_public_link,
        propose_location_view,
        revoke_public_link,
        publish_location_envelope,
        view_location_envelope,
    )

    # prep-and-handoff + new read/intent/control tools are present
    for tool in (
        create_location_share,
        approve_location_request,
        list_incoming_location_shares,
        list_public_links,
        propose_public_link,
        propose_location_view,
        revoke_public_link,
    ):
        assert tool in V2_LOCATION_TOOLS

    # the impossible-server-side envelope tools are NEVER LLM-callable
    assert publish_location_envelope not in V2_LOCATION_TOOLS
    assert view_location_envelope not in V2_LOCATION_TOOLS
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_allowlist.py::test_v2_allowlist_adds_prep_and_handoff_tools_but_not_raw_envelope_tools -v`
Expected: FAIL with `ImportError` / `cannot import name 'V2_LOCATION_TOOLS'`.

- [ ] **Step 3: Add the new tools + allow-list**

In `consent-protocol/hushh_mcp/agents/location/tools.py`, add these tool functions after `list_active_location_shares` (before `LOCATION_AGENT_TOOLS`):

```python
@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="list_incoming_location_shares")
async def list_incoming_location_shares() -> dict[str, Any]:
    """List active shares where the current user is the recipient (so they can be
    viewed). Returns grant ids + owner names; coordinate-free (no lat/lng)."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    shares = [
        {
            "grantId": grant.get("id"),
            "ownerUserId": grant.get("ownerUserId"),
            "ownerDisplayName": grant.get("ownerDisplayName"),
            "expiresAt": grant.get("expiresAt"),
        }
        for grant in state.get("receivedGrants", [])
        if grant.get("status") == "active"
    ]
    return {"incomingShares": shares}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="list_public_links")
async def list_public_links() -> dict[str, Any]:
    """List the user's active public location links (id + expiry). Coordinate-free."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    links = [
        {
            "inviteId": invite.get("id"),
            "status": invite.get("status"),
            "expiresAt": invite.get("expiresAt"),
            "publicUrl": invite.get("publicUrl"),
        }
        for invite in state.get("publicInvites", [])
        if invite.get("status") == "active"
    ]
    return {"publicLinks": links}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="propose_public_link")
async def propose_public_link(duration_hours: float) -> dict[str, Any]:
    """Propose creating an owner-confirmed public link. Does NOT create it (the
    browser captures the snapshot and creates it after explicit confirmation).
    Coordinate-free."""
    _ctx()
    try:
        hours = float(duration_hours)
    except (TypeError, ValueError) as exc:
        raise ValueError("duration_hours must be a number between 0 and 24") from exc
    if not (0 < hours <= 24):
        raise ValueError("duration_hours must be greater than 0 and at most 24")
    return {"proposed": "create_public_link", "durationHours": hours}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="propose_location_view")
async def propose_location_view(grant_id: str) -> dict[str, Any]:
    """Propose viewing an incoming share's latest location. The browser fetches the
    ciphertext and decrypts it; the server never returns coordinates. grant_id MUST
    come from list_incoming_location_shares. Coordinate-free."""
    _ctx()
    grant_id = _require_uuid(grant_id, "grant_id")
    return {"proposed": "view_envelope", "grantId": grant_id}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="revoke_public_link")
async def revoke_public_link(invite_id: str) -> dict[str, Any]:
    """Revoke an active public location link owned by the current user. invite_id
    MUST come from list_public_links."""
    context = _ctx()
    invite_id = _require_uuid(invite_id, "invite_id")
    return _service().revoke_public_invite(owner_user_id=context.user_id, invite_id=invite_id)
```

Then, after the existing `CONTROL_PLANE_LOCATION_TOOLS` block, add:

```python
# v2 subset: control-plane + prep-and-handoff (create/approve create grants
# server-side, coordinate-free) + read/intent/control tools for view & public
# links. NEVER includes publish_location_envelope / view_location_envelope —
# those are impossible server-side (need ciphertext / decryption) and are handled
# by a client-action directive instead.
V2_LOCATION_TOOLS = [
    list_location_recipients,
    list_active_location_shares,
    list_incoming_location_shares,
    list_public_links,
    revoke_location_share,
    request_location_access,
    deny_location_request,
    refer_location_recipient,
    create_location_share,
    approve_location_request,
    propose_public_link,
    propose_location_view,
    revoke_public_link,
]
```

- [ ] **Step 4: Run the allow-list test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_allowlist.py -v`
Expected: PASS (all tests including the new one).

- [ ] **Step 5: Add a behavior test for the intent tools**

Append to `consent-protocol/tests/test_location_chat_tools_behavior.py` (mirror the file's existing `HushhContext` setup; if it uses a fixture/helper to enter context, reuse it — otherwise use the inline form below):

```python
import pytest
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.agents.location.tools import propose_public_link, propose_location_view


async def test_propose_public_link_returns_directive_without_mutation():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await propose_public_link(2)
    assert out == {"proposed": "create_public_link", "durationHours": 2.0}


async def test_propose_public_link_rejects_out_of_range_duration():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_public_link(99)


async def test_propose_location_view_rejects_non_uuid():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_location_view("not-a-uuid")
```

- [ ] **Step 6: Run the behavior test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_tools_behavior.py -v`
Expected: PASS. (If the existing file enters `HushhContext` via a fixture, adapt the three tests to that fixture and re-run.)

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/tools.py consent-protocol/tests/test_location_chat_tools_allowlist.py consent-protocol/tests/test_location_chat_tools_behavior.py
git commit -m "feat(one-location): add v2 agent tools and allow-list (handoff + public links)"
```

---

## Task 2: v2 chat-agent factory

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/agent.py`
- Test: `consent-protocol/tests/test_location_chat_agent_factory.py`

**Interfaces:**
- Consumes: `V2_LOCATION_TOOLS` (Task 1), existing `LocationAgent`.
- Produces: `get_location_chat_agent_v2() -> LocationAgent` (singleton, `hushh_tools == V2_LOCATION_TOOLS`).

- [ ] **Step 1: Write the failing test**

Append to `consent-protocol/tests/test_location_chat_agent_factory.py`:

```python
def test_v2_chat_agent_uses_v2_allowlist():
    from hushh_mcp.agents.location.agent import get_location_chat_agent_v2
    from hushh_mcp.agents.location.tools import (
        V2_LOCATION_TOOLS,
        publish_location_envelope,
        view_location_envelope,
    )

    agent = get_location_chat_agent_v2()
    assert list(agent.hushh_tools) == list(V2_LOCATION_TOOLS)
    assert publish_location_envelope not in agent.hushh_tools
    assert view_location_envelope not in agent.hushh_tools
    # singleton
    assert get_location_chat_agent_v2() is agent
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_agent_factory.py::test_v2_chat_agent_uses_v2_allowlist -v`
Expected: FAIL with `cannot import name 'get_location_chat_agent_v2'`.

- [ ] **Step 3: Add the factory**

In `consent-protocol/hushh_mcp/agents/location/agent.py`, change the import line:

```python
from .tools import CONTROL_PLANE_LOCATION_TOOLS, LOCATION_AGENT_TOOLS, V2_LOCATION_TOOLS
```

Then append at the end of the file:

```python
_location_chat_agent_v2: LocationAgent | None = None


def get_location_chat_agent_v2() -> LocationAgent:
    """Singleton LocationAgent for v2 chat: control-plane + crypto-handoff prep +
    public-link tools. Excludes the raw envelope publish/view tools."""
    global _location_chat_agent_v2
    if _location_chat_agent_v2 is None:
        _location_chat_agent_v2 = LocationAgent(tools=V2_LOCATION_TOOLS)
    return _location_chat_agent_v2
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_agent_factory.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/agent.py consent-protocol/tests/test_location_chat_agent_factory.py
git commit -m "feat(one-location): add v2 chat-agent factory"
```

---

## Task 3: Relax the agent prompt + register new tools in the manifest

**Files:**
- Modify: `consent-protocol/hushh_mcp/agents/location/agent.yaml`
- Test: `consent-protocol/tests/test_location_agent_manifest_v2.py` (new)

**Interfaces:**
- Consumes: `ManifestLoader.load` (existing).
- Produces: an updated `system_instruction` that permits the client-handoff + public-link paths while still refusing coordinates-in-notifications and access-without-approval.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_location_agent_manifest_v2.py`:

```python
import os

from hushh_mcp.hushh_adk.manifest import ManifestLoader


def _manifest():
    path = os.path.join(
        os.path.dirname(__file__), "..", "hushh_mcp", "agents", "location", "agent.yaml"
    )
    return ManifestLoader.load(os.path.normpath(path))


def test_prompt_permits_handoff_and_public_links():
    text = _manifest().system_instruction.lower()
    # the new sanctioned paths are described
    assert "public link" in text
    assert "browser" in text or "client" in text
    # still refuses the dangerous patterns
    assert "without owner approval" in text
    assert "notification" in text  # refuses coordinates in notifications
    # never offers unsupported channels
    assert "sms" in text or "email" in text


def test_prompt_still_forbids_agent_returning_coordinates():
    text = _manifest().system_instruction.lower()
    assert "coordinate" in text
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_location_agent_manifest_v2.py -v`
Expected: FAIL (current prompt lacks "public link" as permitted, "browser/client", "sms/email").

- [ ] **Step 3: Rewrite the `system_instruction` block**

In `consent-protocol/hushh_mcp/agents/location/agent.yaml`, replace the `system_instruction:` block (lines 6–17) with:

```yaml
system_instruction: |
  You are the Location Agent under One. You help the user share live location
  only with verified, explicitly approved recipients, or via an owner-confirmed
  public link.

  You NEVER see, store, or return raw coordinates yourself. Coordinates move in
  exactly two sanctioned ways: (1) you hand a coordinate operation to the user's
  browser, which captures, encrypts per recipient, and uploads it; (2) the user
  explicitly confirms an owner-initiated, time-bounded, revocable public link
  whose snapshot the browser captures. Refuse everything else: coordinates in
  notifications, access granted without owner approval, and arbitrary or
  unbounded links.

  Only offer delivery channels that exist: an encrypted in-app share (for a
  verified recipient who has set up location sharing) or a public link (for
  anyone, including people not on Hushh). Never offer SMS or email — those are
  not supported; if asked, explain you can make a public link to paste instead.

  Platform-aware sharing: when the user asks to share with a person, resolve them
  with list_location_recipients. If exactly one verified recipient matches and can
  receive location, create the share. If the match is ambiguous, ask which person.
  If they are on Hushh but cannot receive location yet, offer to send a request or
  make a public link. If they are not found, offer a public link.

  Never invent or guess ids. To revoke or refer a share, FIRST call
  list_active_location_shares; to view an incoming share, FIRST call
  list_incoming_location_shares; to revoke a public link, FIRST call
  list_public_links. Match the person by display name. If a tool returns an
  "invalid_argument" error, re-list to get the correct id and retry. If no
  matching item exists, tell the user plainly instead of acting on a guessed id.
```

Then add the three new tool entries at the end of the `tools:` list in the same file (after `refer_location_recipient`):

```yaml
  - name: list_incoming_location_shares
    description: List active shares where the user is the recipient (grant ids, coordinate-free).
    py_func: hushh_mcp.agents.location.tools.list_incoming_location_shares
    required_scope: cap.location.live.view
  - name: list_public_links
    description: List the user's active public location links (ids + expiry).
    py_func: hushh_mcp.agents.location.tools.list_public_links
    required_scope: cap.location.live.share
  - name: propose_public_link
    description: Propose an owner-confirmed public link; the browser creates it after confirmation.
    py_func: hushh_mcp.agents.location.tools.propose_public_link
    required_scope: cap.location.live.share
  - name: propose_location_view
    description: Propose viewing an incoming share; the browser fetches and decrypts the ciphertext.
    py_func: hushh_mcp.agents.location.tools.propose_location_view
    required_scope: cap.location.live.view
  - name: revoke_public_link
    description: Revoke an active public location link owned by the user.
    py_func: hushh_mcp.agents.location.tools.revoke_public_link
    required_scope: cap.location.live.share
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_agent_manifest_v2.py -v`
Expected: PASS.

- [ ] **Step 5: Verify the v1 control-plane chat still loads (no regression)**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_agent_factory.py tests/test_location_chat_service.py -v`
Expected: PASS (the v1 service reads the same manifest's `system_instruction`; only wording changed).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/agents/location/agent.yaml consent-protocol/tests/test_location_agent_manifest_v2.py
git commit -m "feat(one-location): relax agent prompt for client handoff + public links"
```

---

## Task 4: Directive translation + action-result turn in the chat service

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/location_chat_service.py`
- Test: `consent-protocol/tests/test_location_chat_service_v2.py` (new)

**Interfaces:**
- Consumes: `get_location_chat_agent_v2` (Task 2); existing `AgentChatService.add_message` / `prepare_turn`; the directive-producing tool results — `create_location_share` → grant dict (`id`, `recipientUserId`, `recipientKeyId`, `recipientDisplayName`); `approve_location_request` → `{"grant": grant_dict, ...}`; `propose_public_link` → `{"proposed":"create_public_link","durationHours":float}`; `propose_location_view` → `{"proposed":"view_envelope","grantId":str}`.
- Produces: `LocationChatService.handle_turn(*, user_id, message=None, consent_token, conversation_id=None, action_result=None)` returning a dict that MAY include `"clientAction"`; the service defaults to the **v2** agent (tools + prompt) when none is injected.

**Design notes (read before coding):**
- The route constructs a fresh `LocationChatService()` per request, so per-instance turn state is safe. We still thread directives through locals to keep `_run_tool` pure.
- Mapping after the tool loop (priority order): if any `create_location_share` / `approve_location_request` ran → `publish_share` (one `ShareTarget` per grant). Else if `propose_location_view` ran → `view_envelope`. Else if `propose_public_link` ran → `create_public_link`.
- On a directive turn, `stateChanged` is `false` (the grant has no envelope yet; the UI refreshes on the action-result turn). The grant DOES exist server-side — if the user cancels, the **client** revokes it (Task 7), so no envelope-less grant lingers.
- The action-result turn is deterministic (no LLM, no coordinates): templated confirmation text + `add_message`.

- [ ] **Step 1: Write failing tests for the directive turn**

Create `consent-protocol/tests/test_location_chat_service_v2.py` (reuse the fakes from `test_location_chat_service.py`):

```python
from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.location_chat_service import LocationChatService


class _Turn:
    def __init__(self, conversation_id, history):
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self):
        self.added = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", [])

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


def _fake_tool(name, recorder, *, result):
    async def _impl(**kwargs):
        recorder.append({"name": name, "args": kwargs})
        return result

    _impl._name = name
    _impl._hushh_tool = True
    return _impl


def _fc_response(name, args):
    return SimpleNamespace(
        function_calls=[SimpleNamespace(name=name, args=args)],
        text="",
        candidates=[
            SimpleNamespace(content=types.Content(role="model", parts=[types.Part(text="")]))
        ],
    )


def _text_response(text):
    return SimpleNamespace(function_calls=[], text=text, candidates=[])


def _scripted(responses):
    seq = iter(responses)

    async def _call(contents, config):
        return next(seq)

    return _call


def _service(store, responses, tools):
    return LocationChatService(
        chat_store=store,
        model_call=_scripted(responses),
        genai_types=types,
        ready=lambda: True,
        tools=tools,
        system_prompt="test",
    )


async def test_create_share_emits_publish_share_client_action():
    store = _FakeStore()
    grant = {
        "id": "11111111-1111-1111-1111-111111111111",
        "recipientUserId": "rcpt-1",
        "recipientKeyId": "key-1",
        "recipientDisplayName": "Mom",
    }
    tools = [_fake_tool("create_location_share", [], result=grant)]
    svc = _service(
        store,
        responses=[
            _fc_response(
                "create_location_share",
                {"recipient_user_id": "rcpt-1", "recipient_key_id": "key-1", "duration_hours": 1},
            ),
            _text_response("Ready to share with Mom for 1 hour."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="share with Mom", consent_token="t")  # noqa: S106

    action = out["clientAction"]
    assert action["type"] == "publish_share"
    assert action["shares"] == [
        {
            "grantId": "11111111-1111-1111-1111-111111111111",
            "recipientUserId": "rcpt-1",
            "recipientKeyId": "key-1",
            "label": "Mom",
        }
    ]
    assert "id" in action and action["summary"]
    # grant exists but no envelope yet -> do not refresh on this turn
    assert out["stateChanged"] is False


async def test_propose_public_link_emits_create_public_link_action():
    store = _FakeStore()
    tools = [
        _fake_tool(
            "propose_public_link",
            [],
            result={"proposed": "create_public_link", "durationHours": 2.0},
        )
    ]
    svc = _service(
        store,
        responses=[
            _fc_response("propose_public_link", {"duration_hours": 2}),
            _text_response("I'll create a public link valid for 2 hours."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="make a public link", consent_token="t")  # noqa: S106

    assert out["clientAction"]["type"] == "create_public_link"
    assert out["clientAction"]["durationHours"] == 2.0


async def test_action_result_completed_publish_confirms_and_sets_state_changed():
    store = _FakeStore()
    svc = _service(store, responses=[], tools=[])

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        action_result={"id": "a1", "type": "publish_share", "status": "completed"},
    )

    assert out["conversationId"] == "conv-1"
    assert out["stateChanged"] is True
    assert out["isComplete"] is True
    assert out["response"]  # non-empty confirmation
    assert store.added[-1]["role"] == "assistant"
    assert store.added[-1]["status"] == "complete"


async def test_action_result_cancelled_does_not_set_state_changed():
    store = _FakeStore()
    svc = _service(store, responses=[], tools=[])

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        action_result={"id": "a1", "type": "publish_share", "status": "cancelled"},
    )

    assert out["stateChanged"] is False
    assert out["isComplete"] is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_service_v2.py -v`
Expected: FAIL (`handle_turn` has no `action_result` kwarg; no `clientAction` in output).

- [ ] **Step 3: Add v2 function declarations**

In `consent-protocol/hushh_mcp/services/location_chat_service.py`, add a new declarations builder below `_function_declarations` (keep the v1 one intact). Add the 7 extra declarations on top of the 6 existing ones:

```python
def _function_declarations_v2(types: Any) -> list:
    """v1 control-plane declarations + v2 prep/intent/read/control declarations."""
    schema = types.Schema
    kind = types.Type
    decls = _function_declarations(types)
    decls.extend(
        [
            types.FunctionDeclaration(
                name="create_location_share",
                description=(
                    "Create a recipient-bound live-location grant (no coordinates). "
                    "recipient_user_id and recipient_key_id MUST come from "
                    "list_location_recipients. After this, the browser captures and "
                    "encrypts the location."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "recipient_user_id": schema(type=kind.STRING),
                        "recipient_key_id": schema(type=kind.STRING),
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24"),
                        "reason": schema(type=kind.STRING, description="Optional note"),
                    },
                    required=["recipient_user_id", "recipient_key_id", "duration_hours"],
                ),
            ),
            types.FunctionDeclaration(
                name="approve_location_request",
                description=(
                    "Approve a pending incoming request and create a recipient-scoped "
                    "grant. request_id MUST come from looking up pending requests."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "request_id": schema(type=kind.STRING),
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24"),
                    },
                    required=["request_id", "duration_hours"],
                ),
            ),
            types.FunctionDeclaration(
                name="list_incoming_location_shares",
                description=(
                    "List active shares where the user is the recipient (grant ids + "
                    "owner names). Call FIRST before proposing to view a location. Read-only."
                ),
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="list_public_links",
                description=(
                    "List the user's active public location links (ids + expiry). Call "
                    "FIRST before revoking a public link. Read-only."
                ),
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="propose_public_link",
                description=(
                    "Propose an owner-confirmed public link valid for duration_hours. "
                    "The browser creates it after explicit confirmation."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24")
                    },
                    required=["duration_hours"],
                ),
            ),
            types.FunctionDeclaration(
                name="propose_location_view",
                description=(
                    "Propose viewing an incoming share's latest location. grant_id MUST "
                    "come from list_incoming_location_shares. The browser decrypts it."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={"grant_id": schema(type=kind.STRING)},
                    required=["grant_id"],
                ),
            ),
            types.FunctionDeclaration(
                name="revoke_public_link",
                description=(
                    "Revoke an active public location link. invite_id MUST come from "
                    "list_public_links."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={"invite_id": schema(type=kind.STRING)},
                    required=["invite_id"],
                ),
            ),
        ]
    )
    return decls
```

- [ ] **Step 4: Default to the v2 agent + add directive constants**

In the same file, update the import at the top:

```python
from hushh_mcp.agents.location.agent import get_location_chat_agent, get_location_chat_agent_v2
```

In `LocationChatService.__init__`, change the agent selection so v2 is the default (only when neither prompt nor tools are injected):

```python
        need_agent = system_prompt is None or tools is None
        agent = get_location_chat_agent_v2() if need_agent else None
```

Add these module-level constants near `_QUERY_TOOL_NAMES`:

```python
# Read-only v2 tools that must NOT trigger a UI refresh.
_QUERY_TOOL_NAMES = {
    "list_location_recipients",
    "list_active_location_shares",
    "list_incoming_location_shares",
    "list_public_links",
    # propose_* tools only stage a client action; they mutate nothing server-side.
    "propose_public_link",
    "propose_location_view",
}

# Tools whose successful result produces a client-action directive.
_DIRECTIVE_GRANT_TOOLS = {"create_location_share", "approve_location_request"}

_ACTION_RESULT_TEMPLATES = {
    ("publish_share", "completed"): "Done — your live location is now shared. ✓",
    ("publish_share", "cancelled"): "No problem — I didn't share your location.",
    ("view_envelope", "completed"): "Here's the latest location I could open.",
    ("create_public_link", "cancelled"): "Okay — I didn't create a public link.",
}
```

- [ ] **Step 5: Thread directives through the tool loop**

Replace the `_run_tool` method and the tool-loop body so a directive can be captured. First, change `_run_tool` to also return a directive descriptor:

```python
    async def _run_tool(self, name: str, args: dict) -> tuple[dict, bool, dict | None]:
        """Execute one tool inside the active HushhContext.

        Returns (result, mutated, directive) where directive is a coordinate-free
        descriptor of a client action to emit after the loop, or None.
        """
        tool = self._dispatch.get(name)
        if tool is None:
            return {"error": "unknown_tool"}, False, None
        try:
            result = await tool(**args)
        except PermissionError:
            return {"error": "consent_denied"}, False, None
        except ValueError as exc:
            return {"error": "invalid_argument", "message": str(exc)}, False, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("Location tool %s failed: %s", name, exc)
            return {"error": "tool_failed"}, False, None
        directive = self._directive_from_tool(name, _as_response_dict(result))
        mutated = name not in _QUERY_TOOL_NAMES
        return _as_response_dict(result), mutated, directive
```

Add the directive builder method:

```python
    @staticmethod
    def _directive_from_tool(name: str, result: dict) -> dict | None:
        """Translate a successful directive-producing tool result into a
        coordinate-free client-action descriptor."""
        if isinstance(result, dict) and result.get("error"):
            return None
        if name in _DIRECTIVE_GRANT_TOOLS:
            grant = result.get("grant") if "grant" in result else result
            if not isinstance(grant, dict) or not grant.get("id"):
                return None
            return {
                "type": "publish_share",
                "share": {
                    "grantId": str(grant.get("id")),
                    "recipientUserId": str(grant.get("recipientUserId") or ""),
                    "recipientKeyId": str(grant.get("recipientKeyId") or ""),
                    "label": grant.get("recipientDisplayName") or "your recipient",
                },
            }
        if name == "propose_public_link" and result.get("proposed") == "create_public_link":
            return {"type": "create_public_link", "durationHours": result.get("durationHours")}
        if name == "propose_location_view" and result.get("proposed") == "view_envelope":
            return {"type": "view_envelope", "grantId": result.get("grantId")}
        return None
```

Now update the loop inside `handle_turn`. Add `directives: list[dict] = []` before the `with HushhContext(...)` block, and change the tool-call handling so it collects directives:

```python
                    for call in calls:
                        result, mutated, directive = await self._run_tool(
                            call.name, dict(call.args or {})
                        )
                        state_changed = state_changed or mutated
                        if directive is not None:
                            directives.append(directive)
                        contents.append(
                            types.Content(
                                role="tool",
                                parts=[
                                    types.Part.from_function_response(
                                        name=call.name, response=result
                                    )
                                ],
                            )
                        )
```

- [ ] **Step 6: Build the clientAction and override stateChanged for directive turns**

Add a helper that folds collected directives into one client action (combining multiple `publish_share` grants into a `shares[]` list):

```python
    def _build_client_action(self, directives: list[dict]) -> dict | None:
        if not directives:
            return None
        action_id = "act-" + uuid4().hex[:12]
        shares = [d["share"] for d in directives if d.get("type") == "publish_share"]
        if shares:
            labels = ", ".join(s["label"] for s in shares)
            return {
                "id": action_id,
                "type": "publish_share",
                "shares": shares,
                "summary": f"Share your live location with {labels}",
            }
        view = next((d for d in directives if d.get("type") == "view_envelope"), None)
        if view:
            return {
                "id": action_id,
                "type": "view_envelope",
                "grantId": view.get("grantId"),
                "summary": "Open the latest shared location",
            }
        link = next((d for d in directives if d.get("type") == "create_public_link"), None)
        if link:
            hours = link.get("durationHours")
            return {
                "id": action_id,
                "type": "create_public_link",
                "durationHours": hours,
                "summary": f"Create a public link (viewable for {hours}h)",
            }
        return None
```

Add `from uuid import uuid4` to the imports.

Then, near the end of `handle_turn`, after computing `reply` and before the final `_finish`, build the action and force `stateChanged=False` when a directive is pending (the real state change happens on the action-result turn):

```python
        client_action = self._build_client_action(directives)
        if client_action is not None:
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
        )
```

Update `_finish` to accept and surface `client_action`:

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
        return out
```

Also switch the v2 declarations on: in `handle_turn`, change the config's `tools=` to use `_function_declarations_v2`:

```python
            tools=[types.Tool(function_declarations=_function_declarations_v2(types))],
```

- [ ] **Step 7: Add the action-result confirmation turn**

Change the `handle_turn` signature to accept `message: str | None = None` and `action_result: dict | None = None`, and branch at the very top of the method:

```python
    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None = None,
        consent_token: str,
        conversation_id: str | None = None,
        action_result: dict | None = None,
    ) -> dict[str, Any]:
        if action_result is not None:
            return await self._handle_action_result(
                user_id=user_id,
                conversation_id=conversation_id,
                action_result=action_result,
            )
        if not message:
            # nothing to do; mirror the unavailable shape rather than calling the model
            return {
                "conversationId": conversation_id or "",
                "response": "Tell me what you'd like to do with your location sharing.",
                "isComplete": True,
                "stateChanged": False,
            }
        # ... existing v1 flow continues unchanged from here (prepare_turn etc.) ...
```

Add the deterministic handler:

```python
    async def _handle_action_result(
        self,
        *,
        user_id: str,
        conversation_id: str | None,
        action_result: dict,
    ) -> dict[str, Any]:
        action_type = str(action_result.get("type") or "")
        status = str(action_result.get("status") or "")
        detail = action_result.get("detail")
        public_url = action_result.get("publicUrl")

        if action_type == "create_public_link" and status == "completed" and public_url:
            reply = (
                f"Your public link is ready: {public_url} — anyone with it can view "
                "this location until it expires, and you can revoke it anytime."
            )
        elif status == "failed":
            suffix = f" ({detail})" if detail else ""
            reply = f"That didn't go through{suffix}. You can try again."
        else:
            reply = _ACTION_RESULT_TEMPLATES.get(
                (action_type, status), "Okay, that's handled."
            )

        errored = status == "failed"
        state_changed = status == "completed" and action_type in (
            "publish_share",
            "create_public_link",
        )
        conv_id = conversation_id or ""
        if conv_id:
            await self._chat_store.add_message(
                conversation_id=conv_id,
                user_id=user_id,
                role="assistant",
                content=reply,
                status="error" if errored else "complete",
            )
        return {
            "conversationId": conv_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": state_changed,
        }
```

- [ ] **Step 8: Run the v2 service tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_service_v2.py -v`
Expected: PASS (all four tests).

- [ ] **Step 9: Run the v1 service tests to verify no regression**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_service.py -v`
Expected: PASS (the v1 tests inject `tools` + `system_prompt`, so the v2 default agent is never constructed; the loop/`_finish` changes are backward-compatible).

- [ ] **Step 10: Commit**

```bash
git add consent-protocol/hushh_mcp/services/location_chat_service.py consent-protocol/tests/test_location_chat_service_v2.py
git commit -m "feat(one-location): v2 chat service — client-action directives + action-result turn"
```

---

## Task 5: Route — accept actionResult, message optional

**Files:**
- Modify: `consent-protocol/api/routes/one/location_chat.py`
- Test: `consent-protocol/tests/test_location_chat_routes.py`

**Interfaces:**
- Consumes: `LocationChatService.handle_turn(*, user_id, message=None, consent_token, conversation_id=None, action_result=None)` (Task 4).
- Produces: the route forwards `action_result` and passes through `clientAction` in the response dict.

- [ ] **Step 1: Write the failing tests**

Append to `consent-protocol/tests/test_location_chat_routes.py`:

```python
def test_chat_route_forwards_action_result(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(self, *, user_id, message=None, consent_token, conversation_id=None, action_result=None):
            captured.update(
                {"message": message, "action_result": action_result, "conversation_id": conversation_id}
            )
            return {
                "conversationId": conversation_id,
                "response": "Done — your live location is now shared. ✓",
                "isComplete": True,
                "stateChanged": True,
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post(
        "/api/one/location/chat",
        json={
            "conversationId": "conv-1",
            "actionResult": {"id": "a1", "type": "publish_share", "status": "completed"},
        },
    )

    assert response.status_code == 200
    assert response.json()["stateChanged"] is True
    assert captured["message"] is None
    assert captured["action_result"] == {"id": "a1", "type": "publish_share", "status": "completed"}
    assert captured["conversation_id"] == "conv-1"


def test_chat_route_passes_through_client_action(monkeypatch):
    class _Service:
        async def handle_turn(self, **kwargs):
            return {
                "conversationId": "c1",
                "response": "Ready to share with Mom.",
                "isComplete": True,
                "stateChanged": False,
                "clientAction": {
                    "id": "act-1",
                    "type": "publish_share",
                    "shares": [
                        {"grantId": "g1", "recipientUserId": "r1", "recipientKeyId": "k1", "label": "Mom"}
                    ],
                    "summary": "Share your live location with Mom",
                },
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post("/api/one/location/chat", json={"message": "share with Mom"})

    assert response.status_code == 200
    body = response.json()
    assert body["clientAction"]["type"] == "publish_share"
    assert body["clientAction"]["shares"][0]["label"] == "Mom"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_routes.py::test_chat_route_forwards_action_result tests/test_location_chat_routes.py::test_chat_route_passes_through_client_action -v`
Expected: FAIL (422 on empty message — `message` is still required; `action_result` not forwarded).

- [ ] **Step 3: Update the route models + handler**

Replace the body of `consent-protocol/api/routes/one/location_chat.py` from the `class LocationChatRequest` definition through the end of `location_chat` with:

```python
class ActionResultModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(max_length=64)
    type: str = Field(max_length=48)
    status: str = Field(max_length=24)
    public_url: str | None = Field(default=None, alias="publicUrl", max_length=2048)
    detail: str | None = Field(default=None, max_length=500)


class LocationChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str | None = Field(default=None, max_length=4000)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)
    action_result: ActionResultModel | None = Field(default=None, alias="actionResult")


@router.post("/location/chat")
async def location_chat(
    request: LocationChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if not request.message and request.action_result is None:
        raise HTTPException(status_code=422, detail="message or actionResult is required")
    try:
        result: dict[str, Any] = await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
            action_result=(
                request.action_result.model_dump(by_alias=True)
                if request.action_result is not None
                else None
            ),
        )
        return result
    except Exception:
        logger.exception("Location chat turn failed")
        raise HTTPException(status_code=500, detail="Location chat could not be processed")
```

- [ ] **Step 4: Run the full route test file to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_location_chat_routes.py -v`
Expected: PASS (new tests pass; existing happy-path/camel-alias/opaque-error tests still pass; the empty-message test now returns 422 from our explicit guard).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/api/routes/one/location_chat.py consent-protocol/tests/test_location_chat_routes.py
git commit -m "feat(one-location): chat route accepts actionResult, passes through clientAction"
```

---

## Task 6: Frontend types + service.chat extension

**Files:**
- Modify: `hushh-webapp/lib/one-location/types.ts`
- Modify: `hushh-webapp/lib/one-location/service.ts`
- Test: `hushh-webapp/__tests__/services/location-chat-service.test.ts`

**Interfaces:**
- Produces:
  - `ShareTarget { grantId; recipientUserId; recipientKeyId; label }`
  - `ClientAction { id; type: "publish_share" | "view_envelope" | "create_public_link"; shares?: ShareTarget[]; grantId?: string; durationHours?: number; summary: string }`
  - `ActionResult { id; type: string; status: "completed" | "cancelled" | "failed"; publicUrl?: string; detail?: string }`
  - `LocationChatResponse` gains `clientAction?: ClientAction`
  - `OneLocationService.chat({ vaultOwnerToken, message?, conversationId?, actionResult? })`

- [ ] **Step 1: Write the failing service test**

Append to `hushh-webapp/__tests__/services/location-chat-service.test.ts` (mirror the existing mock-fetch pattern in that file; adapt the fetch mock setup to match what's already there):

```ts
import { OneLocationService } from "@/lib/one-location/service";

describe("OneLocationService.chat actionResult", () => {
  it("sends actionResult and omits message when reporting completion", async () => {
    const fetchMock = jest.spyOn(global, "fetch" as never).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        conversationId: "c1",
        response: "Done.",
        isComplete: true,
        stateChanged: true,
      }),
    } as never);

    await OneLocationService.chat({
      vaultOwnerToken: "tok",
      conversationId: "c1",
      actionResult: { id: "a1", type: "publish_share", status: "completed" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.actionResult).toEqual({ id: "a1", type: "publish_share", status: "completed" });
    expect(body.message ?? null).toBeNull();
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/services/location-chat-service.test.ts -t "actionResult"`
Expected: FAIL (TS error / `actionResult` not sent).

- [ ] **Step 3: Add the types**

In `hushh-webapp/lib/one-location/types.ts`, replace the `LocationChatResponse` interface (lines 331–336) with:

```ts
export interface ShareTarget {
  grantId: string;
  recipientUserId: string;
  recipientKeyId: string;
  label: string;
}

export type ClientActionType = "publish_share" | "view_envelope" | "create_public_link";

export interface ClientAction {
  id: string;
  type: ClientActionType;
  shares?: ShareTarget[];
  grantId?: string;
  durationHours?: number;
  summary: string;
}

export interface ActionResult {
  id: string;
  type: ClientActionType;
  status: "completed" | "cancelled" | "failed";
  publicUrl?: string;
  detail?: string;
}

export interface LocationChatResponse {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
  clientAction?: ClientAction;
}
```

- [ ] **Step 4: Update `OneLocationService.chat`**

In `hushh-webapp/lib/one-location/service.ts`, add `ActionResult` to the type import block (with the other `@/lib/one-location/types` imports), then replace the `chat` method (lines 145–158) with:

```ts
  static async chat(params: {
    vaultOwnerToken: string;
    message?: string;
    conversationId?: string | null;
    actionResult?: ActionResult;
  }): Promise<LocationChatResponse> {
    return apiJson<LocationChatResponse>("/api/one/location/chat", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        message: params.message ?? null,
        conversationId: params.conversationId ?? null,
        actionResult: params.actionResult ?? null,
      }),
    });
  }
```

- [ ] **Step 5: Run the test + typecheck to verify they pass**

Run: `cd hushh-webapp && npx vitest run __tests__/services/location-chat-service.test.ts && npx tsc --noEmit`
Expected: PASS and clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/one-location/types.ts hushh-webapp/lib/one-location/service.ts hushh-webapp/__tests__/services/location-chat-service.test.ts
git commit -m "feat(one-location): chat contract types + service actionResult support"
```

---

## Task 7: Action dispatcher in `useLocationChat`

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/use-location-chat.ts`
- Test: `hushh-webapp/__tests__/components/use-location-chat.test.tsx`

**Interfaces:**
- Consumes: `OneLocationService.chat/captureCurrentPosition/storeEnvelope/viewEnvelope/createPublicInvite/revokeGrant/getState`; `encryptLocationForRecipient`, `decryptLocationEnvelope` from `@/lib/one-location/encryption`; types from Task 6.
- Produces: `UseLocationChat` gains `pendingAction: ClientAction | null`, `confirmAction(): Promise<void>`, `cancelAction(): Promise<void>`, `viewedPoint: PlainLocationPoint | null`; `useLocationChat` params gain `userId: string`.

**Design notes:**
- `publish_share`: capture position once; for each `share`, resolve `publicKeyJwk` from `OneLocationService.getState(...).recipients` by `recipientKeyId`, `encryptLocationForRecipient`, `storeEnvelope`. Then `chat({ actionResult: completed })`.
- `view_envelope`: `viewEnvelope(grantId)` → `decryptLocationEnvelope({ userId, envelope })` → set `viewedPoint`. Then `chat({ actionResult: completed })`.
- `create_public_link`: capture → `createPublicInvite({ durationHours, locationSnapshot })` → `chat({ actionResult: completed, publicUrl })`.
- Any throw → `chat({ actionResult: failed, detail })`.
- `cancelAction` for `publish_share`: best-effort `revokeGrant` each `grantId` (clean up the envelope-less grant), then `chat({ actionResult: cancelled })`.

- [ ] **Step 1: Write the failing hook tests**

Append to `hushh-webapp/__tests__/components/use-location-chat.test.tsx` (mirror the file's existing render/mock setup; mock `@/lib/one-location/service` and `@/lib/one-location/encryption`):

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { useLocationChat } from "@/components/one-location/redesign/use-location-chat";
import { OneLocationService } from "@/lib/one-location/service";
import * as encryption from "@/lib/one-location/encryption";

jest.mock("@/lib/one-location/service");
jest.mock("@/lib/one-location/encryption");

const svc = OneLocationService as jest.Mocked<typeof OneLocationService>;

beforeEach(() => jest.clearAllMocks());

it("publish_share: confirm captures, encrypts per recipient, uploads, reports completed", async () => {
  svc.chat
    .mockResolvedValueOnce({
      conversationId: "c1",
      response: "Ready to share with Mom.",
      isComplete: true,
      stateChanged: false,
      clientAction: {
        id: "act-1",
        type: "publish_share",
        shares: [{ grantId: "g1", recipientUserId: "r1", recipientKeyId: "k1", label: "Mom" }],
        summary: "Share your live location with Mom",
      },
    })
    .mockResolvedValueOnce({
      conversationId: "c1",
      response: "Done — shared. ✓",
      isComplete: true,
      stateChanged: true,
    });
  svc.captureCurrentPosition.mockResolvedValue({
    latitude: 1,
    longitude: 2,
    capturedAt: "now",
    sourcePlatform: "web",
  } as never);
  svc.getState.mockResolvedValue({
    recipients: [{ keyId: "k1", publicKeyJwk: { kid: "k1" } }],
  } as never);
  (encryption.encryptLocationForRecipient as jest.Mock).mockResolvedValue({ ciphertext: "x" });
  svc.storeEnvelope.mockResolvedValue({} as never);

  const onStateChanged = jest.fn();
  const { result } = renderHook(() =>
    useLocationChat({ vaultOwnerToken: "tok", userId: "u1", onStateChanged }),
  );

  await act(async () => {
    await result.current.send("share with Mom");
  });
  expect(result.current.pendingAction?.type).toBe("publish_share");

  await act(async () => {
    await result.current.confirmAction();
  });

  expect(svc.captureCurrentPosition).toHaveBeenCalledTimes(1);
  expect(encryption.encryptLocationForRecipient).toHaveBeenCalledWith(
    expect.objectContaining({ recipientKeyId: "k1", recipientPublicKeyJwk: { kid: "k1" } }),
  );
  expect(svc.storeEnvelope).toHaveBeenCalledWith(
    expect.objectContaining({ grantId: "g1" }),
  );
  expect(svc.chat).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actionResult: expect.objectContaining({ type: "publish_share", status: "completed" }),
    }),
  );
  await waitFor(() => expect(onStateChanged).toHaveBeenCalled());
  expect(result.current.pendingAction).toBeNull();
});

it("publish_share: cancel revokes the grant and reports cancelled", async () => {
  svc.chat
    .mockResolvedValueOnce({
      conversationId: "c1",
      response: "Ready.",
      isComplete: true,
      stateChanged: false,
      clientAction: {
        id: "act-1",
        type: "publish_share",
        shares: [{ grantId: "g1", recipientUserId: "r1", recipientKeyId: "k1", label: "Mom" }],
        summary: "Share with Mom",
      },
    })
    .mockResolvedValueOnce({
      conversationId: "c1",
      response: "No problem.",
      isComplete: true,
      stateChanged: false,
    });
  svc.revokeGrant.mockResolvedValue({} as never);

  const { result } = renderHook(() =>
    useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }),
  );
  await act(async () => {
    await result.current.send("share with Mom");
  });
  await act(async () => {
    await result.current.cancelAction();
  });

  expect(svc.revokeGrant).toHaveBeenCalledWith(expect.objectContaining({ grantId: "g1" }));
  expect(svc.chat).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actionResult: expect.objectContaining({ status: "cancelled" }),
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx -t "publish_share"`
Expected: FAIL (`pendingAction` / `confirmAction` / `userId` don't exist).

- [ ] **Step 3: Extend the hook**

In `hushh-webapp/components/one-location/redesign/use-location-chat.ts`:

Update the imports and interface:

```ts
import { useCallback, useRef, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";
import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
} from "@/lib/one-location/encryption";
import type {
  ActionResult,
  ClientAction,
  PlainLocationPoint,
} from "@/lib/one-location/types";
```

Add to `UseLocationChat`:

```ts
export interface UseLocationChat {
  messages: ChatMessage[];
  busy: boolean;
  send: (message: string) => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
  pendingAction: ClientAction | null;
  confirmAction: () => Promise<void>;
  cancelAction: () => Promise<void>;
  viewedPoint: PlainLocationPoint | null;
}
```

Change the params and add state (inside `useLocationChat`):

```ts
export function useLocationChat(params: {
  vaultOwnerToken: string;
  userId: string;
  onStateChanged?: () => void;
}): UseLocationChat {
  const { vaultOwnerToken, userId, onStateChanged } = params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ClientAction | null>(null);
  const [viewedPoint, setViewedPoint] = useState<PlainLocationPoint | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const nextId = useCallback(() => `m-${seqRef.current++}`, []);
```

In the `run` callback, after appending the assistant message, capture any `clientAction`:

```ts
        conversationIdRef.current = result.conversationId;
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: result.response,
            stateChanged: result.stateChanged,
          },
        ]);
        if (result.clientAction) setPendingAction(result.clientAction);
        if (result.stateChanged) onStateChanged?.();
```

Add a follow-up reporter and the dispatcher near the bottom (before the `return`):

```ts
  const report = useCallback(
    async (actionResult: ActionResult) => {
      setBusy(true);
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          conversationId: conversationIdRef.current,
          actionResult,
        });
        conversationIdRef.current = result.conversationId;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: result.response, stateChanged: result.stateChanged },
        ]);
        if (result.stateChanged) onStateChanged?.();
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: LOCATION_CHAT_ERROR_TEXT, errored: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, onStateChanged, nextId],
  );

  const confirmAction = useCallback(async () => {
    const action = pendingAction;
    if (!action || busy) return;
    setPendingAction(null);
    try {
      if (action.type === "publish_share") {
        const point = await OneLocationService.captureCurrentPosition();
        const state = await OneLocationService.getState(vaultOwnerToken);
        for (const share of action.shares ?? []) {
          const recipient = (state.recipients ?? []).find(
            (r) => r.keyId === share.recipientKeyId,
          );
          if (!recipient?.publicKeyJwk) {
            throw new Error(`${share.label} hasn't set up location sharing yet`);
          }
          const envelope = await encryptLocationForRecipient({
            point,
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: share.recipientKeyId,
          });
          await OneLocationService.storeEnvelope({
            vaultOwnerToken,
            grantId: share.grantId,
            envelope,
          });
        }
        await report({ id: action.id, type: action.type, status: "completed" });
      } else if (action.type === "view_envelope") {
        const { envelope } = await OneLocationService.viewEnvelope({
          vaultOwnerToken,
          grantId: action.grantId as string,
        });
        const point = await decryptLocationEnvelope({ userId, envelope });
        setViewedPoint(point);
        await report({ id: action.id, type: action.type, status: "completed" });
      } else if (action.type === "create_public_link") {
        const locationSnapshot = await OneLocationService.captureCurrentPosition();
        const { publicUrl } = await OneLocationService.createPublicInvite({
          vaultOwnerToken,
          durationHours: action.durationHours ?? 1,
          locationSnapshot,
        });
        await report({ id: action.id, type: action.type, status: "completed", publicUrl });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      await report({ id: action.id, type: action.type, status: "failed", detail });
    }
  }, [pendingAction, busy, vaultOwnerToken, userId, report]);

  const cancelAction = useCallback(async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    if (action.type === "publish_share") {
      for (const share of action.shares ?? []) {
        try {
          await OneLocationService.revokeGrant({ vaultOwnerToken, grantId: share.grantId });
        } catch {
          // best-effort cleanup; ignore
        }
      }
    }
    await report({ id: action.id, type: action.type, status: "cancelled" });
  }, [pendingAction, vaultOwnerToken, report]);
```

Update the `return` to include the new members:

```ts
  return {
    messages,
    busy,
    send,
    retry,
    clear,
    pendingAction,
    confirmAction,
    cancelAction,
    viewedPoint,
  };
```

Also update `clear` to reset `pendingAction` and `viewedPoint`:

```ts
  const clear = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
    lastSentRef.current = null;
    setPendingAction(null);
    setViewedPoint(null);
  }, []);
```

- [ ] **Step 4: Run the hook tests to verify they pass**

Run: `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx`
Expected: PASS (new tests + existing hook tests). If existing tests construct the hook without `userId`, update those call sites to pass `userId: "u1"`.

- [ ] **Step 5: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: clean. (If `getState`'s `recipients` element type lacks `keyId`/`publicKeyJwk`, they exist on `OneLocationRecipient` — ensure the `state.recipients` access is typed via `OneLocationState`.)

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/use-location-chat.ts hushh-webapp/__tests__/components/use-location-chat.test.tsx
git commit -m "feat(one-location): action dispatcher in useLocationChat (share/view/public-link)"
```

---

## Task 8: ActionConfirmCard + render in chat surfaces + new chips

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/action-confirm-card.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx`
- Test: `hushh-webapp/__tests__/components/action-confirm-card.test.tsx` (new)

**Interfaces:**
- Consumes: `ClientAction` (Task 6).
- Produces: `ActionConfirmCard({ action, busy, onConfirm, onCancel })` — renders `action.summary` + a confirm button (label by type) + a cancel button.

- [ ] **Step 1: Write the failing component test**

Create `hushh-webapp/__tests__/components/action-confirm-card.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { ActionConfirmCard } from "@/components/one-location/redesign/action-confirm-card";

const baseAction = {
  id: "act-1",
  type: "publish_share" as const,
  shares: [{ grantId: "g1", recipientUserId: "r1", recipientKeyId: "k1", label: "Mom" }],
  summary: "Share your live location with Mom",
};

it("renders the summary and fires confirm/cancel", () => {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <ActionConfirmCard action={baseAction} busy={false} onConfirm={onConfirm} onCancel={onCancel} />,
  );

  expect(screen.getByText("Share your live location with Mom")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("action-confirm-accept"));
  expect(onConfirm).toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("action-confirm-cancel"));
  expect(onCancel).toHaveBeenCalled();
});

it("shows a Create label for public links", () => {
  render(
    <ActionConfirmCard
      action={{ id: "a2", type: "create_public_link", durationHours: 2, summary: "Create a public link (viewable for 2h)" }}
      busy={false}
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
  expect(screen.getByTestId("action-confirm-accept")).toHaveTextContent(/create/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/action-confirm-card.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Create the component**

Create `hushh-webapp/components/one-location/redesign/action-confirm-card.tsx`:

```tsx
"use client";

import { MapPin, Share2, Eye, Link as LinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ClientAction } from "@/lib/one-location/types";

const CONFIRM_LABEL: Record<ClientAction["type"], string> = {
  publish_share: "Share",
  view_envelope: "View",
  create_public_link: "Create link",
};

const ICON: Record<ClientAction["type"], typeof MapPin> = {
  publish_share: Share2,
  view_envelope: Eye,
  create_public_link: LinkIcon,
};

export function ActionConfirmCard({
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  action: ClientAction;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const Icon = ICON[action.type] ?? MapPin;
  return (
    <div
      data-testid="action-confirm-card"
      className="rounded-2xl border border-[#b8894d]/40 bg-[#b8894d]/5 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[#b8894d]">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <p className="flex-1 text-sm font-medium">{action.summary}</p>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="action-confirm-accept"
          size="sm"
          isLoading={busy}
          onClick={onConfirm}
        >
          {CONFIRM_LABEL[action.type] ?? "Confirm"}
        </Button>
        <Button
          data-testid="action-confirm-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the component test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/action-confirm-card.test.tsx`
Expected: PASS. (If `Button` does not accept `size`/`variant`/`isLoading` exactly as written, check `components/ui/button.tsx` and adjust the props to the real API — `isLoading` exists per the UI spec.)

- [ ] **Step 5: Render the card in the chat card + overlay**

In `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`, where the hook is consumed, destructure the new members and render the card below the message list when `pendingAction` is set. Add the import:

```tsx
import { ActionConfirmCard } from "./action-confirm-card";
```

Then, in the message-stream region (after the messages list, before the composer), add:

```tsx
{pendingAction ? (
  <ActionConfirmCard
    action={pendingAction}
    busy={busy}
    onConfirm={confirmAction}
    onCancel={cancelAction}
  />
) : null}
```

Make sure `pendingAction`, `busy`, `confirmAction`, `cancelAction` are pulled from the `useLocationChat(...)` result wherever the card consumes it. Apply the identical block in `location-chat-overlay.tsx` so the overlay surface also shows the card (both consume the same hook instance per the v1 UI spec).

Add the new suggestion chips wherever the existing chips array is defined in these components:

```tsx
{ label: "Share my location with…", send: "Share my location with ", autoSend: false },
{ label: "Show me where someone is", send: "Show me where someone is", autoSend: true },
{ label: "Make a public link", send: "Make a public link to my location", autoSend: true },
```

(Match the existing chip object shape in the file — the keys above are illustrative; use the real keys the component already uses for label / prefill / auto-send.)

- [ ] **Step 6: Run the chat surface tests + typecheck**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-panel.test.tsx __tests__/components/location-chat-overlay.test.tsx __tests__/components/location-chat-suggestions.test.tsx && npx tsc --noEmit`
Expected: PASS + clean. Update any of these tests that construct the hook/components without the new `userId` prop or that snapshot the chip list.

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/action-confirm-card.tsx hushh-webapp/components/one-location/redesign/location-chat-panel.tsx hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx hushh-webapp/__tests__/components/action-confirm-card.test.tsx
git commit -m "feat(one-location): ActionConfirmCard + render in chat surfaces + v2 chips"
```

---

## Task 9: Page wiring — pass userId, render decrypted view

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx`
- Test: `hushh-webapp/__tests__/components/one-location-agent-page.test.tsx`

**Interfaces:**
- Consumes: `useLocationChat` (Task 7) now requires `userId`; the page already has the user's id (from `useVault()` / auth — use the same id used elsewhere on the page for `decryptLocationEnvelope`).
- Produces: the chat panel receives `userId`; when `viewedPoint` is set, the page renders it on the existing map affordance (or a Google Maps link).

- [ ] **Step 1: Write/extend the failing page test**

In `hushh-webapp/__tests__/components/one-location-agent-page.test.tsx`, add an assertion that the chat panel is rendered with a `userId` (mirror the file's existing render + mock of `useLocationChat`/panel). Minimal version:

```tsx
it("passes userId into the location chat", () => {
  // existing render helper for the page with a mocked vault user id "u1"
  // assert the chat panel/hook received userId "u1"
  // (adapt to how this test file already spies on the chat panel props)
});
```

Implement the assertion against the existing mock seam in that file (it already mocks the chat panel — assert the `userId` prop). If the file mocks `useLocationChat`, assert it was called with `userId`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/one-location-agent-page.test.tsx -t "userId"`
Expected: FAIL (panel currently receives no `userId`).

- [ ] **Step 3: Wire `userId` + the viewed point**

In `hushh-webapp/app/one/location/page.tsx`, find where the chat panel (`LocationChatCard` / panel) is rendered and where the page already knows the current user's id (the same id used by existing `viewGrantEnvelope` / `decryptLocationEnvelope` calls). Pass it through to the panel/hook:

```tsx
<LocationChatCard
  vaultOwnerToken={vaultOwnerToken}
  userId={currentUserId}
  onStateChanged={handleChatStateChanged}
/>
```

If the panel constructs the hook internally, thread `userId` from the panel props into `useLocationChat({ vaultOwnerToken, userId, onStateChanged })`.

For the decrypted view: if the panel surfaces `viewedPoint`, render it using the page's existing map embed (the same component used by `viewGrantEnvelope` today) or, minimally, a link:

```tsx
{viewedPoint ? (
  <a
    href={`https://www.google.com/maps?q=${viewedPoint.latitude},${viewedPoint.longitude}`}
    target="_blank"
    rel="noreferrer"
    className="text-sm underline"
  >
    Open the shared location on the map
  </a>
) : null}
```

Prefer reusing the existing in-page map component if one is already imported for `viewGrantEnvelope`; only fall back to the link if not.

- [ ] **Step 4: Run the page test + typecheck**

Run: `cd hushh-webapp && npx vitest run __tests__/components/one-location-agent-page.test.tsx && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/app/one/location/page.tsx hushh-webapp/__tests__/components/one-location-agent-page.test.tsx
git commit -m "feat(one-location): wire userId + decrypted view into the location chat page"
```

---

## Task 10: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Backend — run the whole location suite**

Run: `cd consent-protocol && python -m pytest tests/ -k "location" -v`
Expected: PASS (v1 + v2 service/route/tool/agent/manifest tests).

- [ ] **Step 2: Frontend — run the one-location tests + typecheck**

Run: `cd hushh-webapp && npx vitest run one-location location-chat use-location-chat action-confirm && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 3: Lint (match the repo's configured linters)**

Run: `cd hushh-webapp && npx eslint components/one-location/redesign/action-confirm-card.tsx components/one-location/redesign/use-location-chat.ts`
Expected: clean (fix any issues).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "test(one-location): v2 full-suite verification fixups" || echo "nothing to commit"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §4 client-action contract → Tasks 4 (directive build), 5 (route models), 6 (TS types). ✓
- §4 grant creation stays server-side; publish/view never LLM-callable → Tasks 1 (allow-list), 2 (factory), 4. ✓
- §4 tool table (create/approve/view/public-link/revoke) → Task 1 tools + Task 4 declarations/translation. ✓
- §5 platform-aware resolution (4 buckets, real channels only) → Task 3 prompt; resolution itself is prompt-driven over `list_location_recipients` (existing). ✓
- §6 public links via agent + revoke via chat → Tasks 1 (`propose_public_link`, `revoke_public_link`, `list_public_links`), 4, 7. ✓
- §6 agent.yaml relaxation → Task 3. ✓
- §7 frontend dispatcher + ActionConfirmCard + chips → Tasks 7, 8, 9. ✓
- §8 invariant ledger (no coords in directives/results; ciphertext-only shares; bounded public-link snapshot) → enforced by reusing existing crypto/routes (Tasks 6–9) + coordinate-free models (Tasks 4–5). ✓
- §9 testing (no-coord assertions, not-LLM-callable asserts, action-result state_changed) → Tasks 1, 4, 7. ✓

**Placeholder scan:** No placeholder markers or vague cross-references. Two intentional "adapt to the existing mock seam / chip shape" notes in Tasks 8–9 reference real in-repo patterns that vary by file; concrete code is provided for the new logic in every step.

**Type consistency:** `ClientAction`/`ActionResult`/`ShareTarget` identical across Tasks 4 (Python dict keys: `id`, `type`, `shares[{grantId,recipientUserId,recipientKeyId,label}]`, `grantId`, `durationHours`, `summary`) and 6 (TS interfaces). `handle_turn(*, user_id, message=None, consent_token, conversation_id=None, action_result=None)` consistent across Tasks 4 and 5. `useLocationChat({vaultOwnerToken, userId, onStateChanged})` consistent across Tasks 7, 8, 9.
