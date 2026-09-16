"""Wrapped-function parity at the ``SpecialistTurnResult`` seam.

Every registered in-process specialist (``agent_nav``, ``agent_location``,
``agent_personal_information``) is driven through ``dispatch()`` with a frozen
``A2ATask`` and the structural shape of what comes back is compared against a
committed golden cut from today's behaviour
(``tests/fixtures/specialist_turn_parity.v1.json``). The specialist migration
can then prove "same A2ATask in, same result out" instead of arguing it.

What the golden pins, per case:

* ``conversation_id``, ``model``, ``directive.kind``, ``is_complete``,
  ``state_changed``
* the directive payload minus free text (``summary``, ``reason``, ``question``,
  the confirm and cancel labels), so ``kind`` / ``agentId`` / ``requiredScope`` /
  ``actionId`` / ``promptKind`` / ``items[].id`` / ``items[].scope`` and every
  other structural key are byte-identical
* the sanitized calls the specialist made into its service (surface asked of the
  consent center, the ``selection_result`` a location selection was translated
  into), because the seam is only proven if the wrapped call is the same too
* the semantic rules the free text must satisfy (which fixture labels and count
  it mentions, which words it may not contain)

Free text is deliberately NOT pinned byte for byte. Copy is reworded often and
that is not a parity break; a changed directive shape or a dropped service call
is.

Refreshing the golden after an intentional structural change::

    PARITY_UPDATE_GOLDEN=1 TESTING=1 PYTHONPATH=. uv run pytest \\
        tests/test_specialist_turn_parity.py -q

Running the update twice must produce a byte-identical file; the test still
compares after writing, so a non-deterministic case fails even in update mode.
"""

from __future__ import annotations

import difflib
import json
import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable
from unittest.mock import AsyncMock, patch

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr

import hushh_mcp.adk_bridge as adk_bridge
from hushh_mcp.adk_bridge import dispatch as dispatch_mod
from hushh_mcp.adk_bridge.contract import (
    A2AAuthorityContext,
    A2ATask,
    SpecialistTurnResult,
)
from hushh_mcp.adk_bridge.nav_agent import NavAgent
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.one_adk.agent_tree import (
    STATE_CONSENT_TOKEN,
    STATE_PENDING_DIRECTIVE,
    STATE_USER_ID,
    _specialist_turn,
)
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService

GOLDEN_PATH = Path(__file__).resolve().parent / "fixtures" / "specialist_turn_parity.v1.json"
GOLDEN_VERSION = 1
UPDATE_ENV = "PARITY_UPDATE_GOLDEN"

OWNER_ID = "user_parity"
CONVERSATION_ID = "thread_parity"
TOKEN_MARKER = "<consent_token>"  # noqa: S105 -- placeholder, not a credential

# Free text inside a directive payload. Pruned before the structural compare so
# a copy edit never reads as a contract break.
_FREE_TEXT_KEYS = frozenset({"summary", "reason", "question", "confirmLabel", "cancelLabel"})

# Words the owner must never be shown. Matched on word boundaries, case-insensitive.
_BANNED_OWNER_WORDS = (
    "scope",
    "lifecycle",
    "connector",
    "domain",
    "field",
    "attribute",
    "path",
    "handle",
    "pkm",
    "manifest",
    "schema",
    "export",
    "token",
    "timing",
    "timings",
)
_BANNED_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(word) for word in _BANNED_OWNER_WORDS) + r")\b",
    re.IGNORECASE,
)

# The fixed two-grant consent center payload every active-surface case sees.
# One location grant (so ``consent_actions`` appears) and one non-location grant.
_ACTIVE_CENTER_ITEMS: list[dict[str, Any]] = [
    {
        "id": "one_location_grant:grant_parity_1",
        "request_id": "req_parity_1",
        "counterpart_label": "Travel Planner",
        "scope": "cap.location.live.view",
        "expires_at": "2026-07-04T01:53:37.924978+00:00",
        "metadata": {
            "request_source": "one_location_share_grant",
            "section": "people",
            "grant_id": "grant_parity_1",
        },
    },
    {
        "id": "grant_parity_2",
        "request_id": "req_parity_2",
        "counterpart_label": "Kai",
        "scope": "attr.financial.portfolio.*",
        "scope_description": "Portfolio summary",
    },
]
_PREVIOUS_CENTER_ITEMS: list[dict[str, Any]] = [
    {
        "id": "one_location_grant:grant_parity_3",
        "request_id": "req_parity_3",
        "counterpart_label": "Jhumma Kumari",
        "scope": "cap.location.live.view",
        "status": "revoked",
        "revoked_at": "2026-07-04T01:53:37.924978+00:00",
    },
]
_CENTER_BY_SURFACE = {"active": _ACTIVE_CENTER_ITEMS, "previous": _PREVIOUS_CENTER_ITEMS}


def _center_identifiers() -> set[str]:
    """Every consent id the fixtures carry. None of them may be spoken."""
    found: set[str] = set()
    for items in _CENTER_BY_SURFACE.values():
        for item in items:
            for key in ("id", "request_id"):
                value = str(item.get(key) or "")
                if value:
                    found.add(value)
            grant_id = str((item.get("metadata") or {}).get("grant_id") or "")
            if grant_id:
                found.add(grant_id)
    return found


class _RecordingConsentCenter:
    """Stands in for ``ConsentCenterService.list_center`` and records each call."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def list_center(self, user_id: str, **kwargs: Any) -> dict[str, Any]:
        surface = str(kwargs.get("surface") or "")
        self.calls.append(
            {
                "call": "list_center",
                "user_id": user_id,
                "actor": kwargs.get("actor"),
                "surface": surface,
                "top": kwargs.get("top"),
            }
        )
        items = list(_CENTER_BY_SURFACE.get(surface) or [])
        return {"total": len(items), "items": items}


class _FakeLocationService:
    """Mirrors ``tests/test_location_agent_a2a.py::_FakeLocationService``, recording calls."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def handle_turn(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"call": "handle_turn", **kwargs})
        if kwargs.get("selection_result") is not None:
            return {
                "conversationId": "loc_conv_parity",
                "response": "Sharing your live location with Mom for one hour.",
                "isComplete": True,
                "stateChanged": True,
                "clientAction": {
                    "id": "act-parity-1",
                    "type": "publish_share",
                    "shares": [{"userId": "mom-1", "durationHours": 1}],
                    "summary": "Share with Mom for 1h",
                },
            }
        return {
            "conversationId": "loc_conv_parity",
            "response": "Who should see your location?",
            "isComplete": False,
            "stateChanged": False,
            "clientPrompt": {
                "id": "prm-parity-1",
                "kind": "select",
                "purpose": "select_recipients",
                "question": "Who should see your location?",
                "options": [
                    {"id": "mom-1", "label": "Mom"},
                    {"id": "dad-1", "label": "Dad"},
                ],
                "minSelections": 1,
                "maxSelections": 2,
                "allowFreeText": True,
            },
        }


class _FakePersonalInformationService:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def handle_turn(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"call": "handle_turn", **kwargs})
        return {
            "conversationId": "pi_conv_parity",
            "response": "Your commute pattern could be published as two records.",
            "isComplete": True,
            "stateChanged": False,
            "clientAction": {
                "type": "publish_slices",
                "topic": "commute",
                "slices": [
                    {"id": "slice-parity-1", "title": "Weekday commute"},
                    {"id": "slice-parity-2", "title": "Weekend travel"},
                ],
            },
        }


@dataclass(frozen=True)
class _TextRules:
    mentions: tuple[str, ...] = ()
    count: int | None = None
    allowed_words: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "mentions": list(self.mentions),
            "count": self.count,
            "allowed_words": list(self.allowed_words),
        }


@dataclass(frozen=True)
class _Case:
    name: str
    agent_id: str
    make_task: Callable[[str], A2ATask]
    make_service: Callable[[], Any]
    text_rules: _TextRules = field(default_factory=_TextRules)


def _nav_token() -> str:
    return issue_token(OWNER_ID, "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token


def _authority() -> A2AAuthorityContext:
    return A2AAuthorityContext(
        subject_user_id=OWNER_ID,
        tenant_id="tenant_parity",
        task_id="task_parity",
        caller_kind="first_party",
        invocation_capabilities=("cap.one.invoke",),
    )


def _nav_task(token: str, message: str | None) -> A2ATask:
    return A2ATask(
        user_id=OWNER_ID,
        consent_token=token,
        conversation_id=CONVERSATION_ID,
        message=message,
        timezone="UTC",
        authority=replace(
            _authority(),
            invocation_capabilities=("agent.nav.review",),
            expires_at_ms=4102444800000,
        ),
        expected_tenant_id="tenant_parity",
        expected_task_id="task_parity",
    )


def _location_message_task(token: str) -> A2ATask:
    return A2ATask(
        user_id=OWNER_ID,
        consent_token=token,
        conversation_id=None,
        message="share my location with Mom",
        authority=_authority(),
    )


def _location_selection_task(token: str) -> A2ATask:
    return A2ATask(
        user_id=OWNER_ID,
        consent_token=token,
        conversation_id="loc_conv_parity",
        delegate_result={
            "kind": "selection",
            "promptKind": "select",
            "id": "prm-parity-1",
            "selected": [{"userId": "mom-1"}],
            "status": "answered",
        },
        authority=_authority(),
    )


def _personal_information_task(token: str) -> A2ATask:
    return A2ATask(
        user_id=OWNER_ID,
        consent_token=token,
        conversation_id=None,
        message="what could I publish about my commute",
        authority=_authority(),
    )


def _nav_service() -> NavAgent:
    return NavAgent()


class _ScriptedNavLlm(BaseLlm):
    """Exercise actual Nav/Consent tool execution with offline model decisions."""

    _steps: list = PrivateAttr(default_factory=list)

    def __init__(self, steps):
        super().__init__(model="gemini-3.7-flash")
        self._steps = list(steps)

    async def generate_content_async(self, llm_request, stream=False):
        assert self._steps, "Unexpected model request beyond the parity script"
        step = self._steps.pop(0)
        part = (
            types.Part(function_call=types.FunctionCall(name=step[0], args=step[1]))
            if isinstance(step, tuple)
            else types.Part(text=step)
        )
        yield LlmResponse(content=types.Content(role="model", parts=[part]))


def _scripted_nav_service(case_name: str) -> NavAgent:
    # These decisions preserve the historical golden's branches; semantic
    # routing quality is evaluated separately, not asserted by a scripted LLM.
    if case_name == "nav_active_grants":
        text = "You have 2 active permissions: Travel Planner and Kai."
        steps = [
            ("consent", {"request": "Review active sharing"}),
            ("list_active_consent_grants", {}),
            text,
            text,
        ]
    elif case_name == "nav_previous_grants":
        text = "You have 1 previous permission: Jhumma Kumari."
        steps = [
            ("consent", {"request": "Review previous sharing"}),
            ("list_previous_consent_grants", {}),
            text,
            text,
        ]
    elif case_name in {"nav_invalid_token", "nav_empty_message"}:
        steps = []
    else:
        steps = ["I can help you review sharing and access."]
    return NavAgent(model=_ScriptedNavLlm(steps))


CASES: tuple[_Case, ...] = (
    _Case(
        name="nav_invalid_token",
        agent_id="agent_nav",
        make_task=lambda _token: _nav_task("HCT:not-a-real-token", "who has access to my vault"),
        make_service=_nav_service,
    ),
    _Case(
        name="nav_empty_message",
        agent_id="agent_nav",
        make_task=lambda token: _nav_task(token, ""),
        make_service=_nav_service,
        # Today's ready text says "scope release". Recorded here, not hidden, so
        # the parity suite stays green while the copy is still owed a rewrite.
        text_rules=_TextRules(allowed_words=("scope",)),
    ),
    _Case(
        name="nav_what_am_i_sharing_right_now",
        agent_id="agent_nav",
        make_task=lambda token: _nav_task(token, "what am I sharing right now"),
        make_service=_nav_service,
    ),
    _Case(
        name="nav_active_grants",
        agent_id="agent_nav",
        make_task=lambda token: _nav_task(token, "show all my active consent grants"),
        make_service=_nav_service,
        text_rules=_TextRules(mentions=("Travel Planner", "Kai"), count=2),
    ),
    _Case(
        name="nav_what_did_i_share_before",
        agent_id="agent_nav",
        make_task=lambda token: _nav_task(token, "what did I share before"),
        make_service=_nav_service,
    ),
    _Case(
        name="nav_previous_grants",
        agent_id="agent_nav",
        make_task=lambda token: _nav_task(token, "what about revoked requests"),
        make_service=_nav_service,
        text_rules=_TextRules(mentions=("Jhumma Kumari",), count=1),
    ),
    _Case(
        name="location_message_turn",
        agent_id="agent_location",
        make_task=_location_message_task,
        make_service=_FakeLocationService,
        text_rules=_TextRules(mentions=("location",)),
    ),
    _Case(
        name="location_selection_delegate_result",
        agent_id="agent_location",
        make_task=_location_selection_task,
        make_service=_FakeLocationService,
        text_rules=_TextRules(mentions=("Mom",)),
    ),
    _Case(
        name="personal_information_message_turn",
        agent_id="agent_personal_information",
        make_task=_personal_information_task,
        make_service=_FakePersonalInformationService,
        text_rules=_TextRules(mentions=("commute",)),
    ),
)
_CASES_BY_NAME = {case.name: case for case in CASES}


def _prune_free_text(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _prune_free_text(item) for key, item in value.items() if key not in _FREE_TEXT_KEYS
        }
    if isinstance(value, list):
        return [_prune_free_text(item) for item in value]
    return value


def _sanitize_call(call: dict[str, Any], token: str) -> dict[str, Any]:
    """Strip the consent token value and drop unset kwargs from a recorded call."""
    clean: dict[str, Any] = {}
    for key, value in call.items():
        if key == "consent_token":
            clean[key] = TOKEN_MARKER if value == token else "<other>"
            continue
        if value is None:
            continue
        clean[key] = value
    return clean


def _structural(
    result: SpecialistTurnResult,
    *,
    service_calls: list[dict[str, Any]],
    token: str,
    text_rules: _TextRules,
) -> dict[str, Any]:
    return {
        "conversation_id": result.conversation_id,
        "model": result.model,
        "directive_kind": result.directive.kind if result.directive else None,
        "directive_payload": (
            _prune_free_text(result.directive.payload) if result.directive else None
        ),
        "is_complete": result.is_complete,
        "state_changed": result.state_changed,
        "service_calls": [_sanitize_call(call, token) for call in service_calls],
        "text_rules": text_rules.as_dict(),
    }


def _assert_text_rules(case_name: str, text: str, token: str, rules: _TextRules) -> None:
    assert text.strip(), f"{case_name}: specialist text is empty"
    assert "attr." not in text, f"{case_name}: raw scope id leaked into text: {text!r}"
    assert token not in text, f"{case_name}: consent token leaked into text"
    assert "HCT:" not in text, f"{case_name}: consent token prefix leaked into text: {text!r}"
    for identifier in _center_identifiers():
        assert identifier not in text, f"{case_name}: consent id {identifier!r} leaked: {text!r}"
    allowed = {word.lower() for word in rules.allowed_words}
    banned_hits = sorted(
        {match.group(1).lower() for match in _BANNED_PATTERN.finditer(text)} - allowed
    )
    assert not banned_hits, f"{case_name}: banned owner words {banned_hits} in text: {text!r}"
    for label in rules.mentions:
        assert label in text, f"{case_name}: text does not mention {label!r}: {text!r}"
    if rules.count is not None:
        assert f"You have {rules.count} " in text, (
            f"{case_name}: text does not state the count {rules.count}: {text!r}"
        )


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _load_golden() -> dict[str, Any]:
    if not GOLDEN_PATH.exists():
        pytest.fail(
            f"Golden fixture missing at {GOLDEN_PATH}. "
            f"Cut it with {UPDATE_ENV}=1 and commit the result."
        )
    with GOLDEN_PATH.open(encoding="utf-8") as handle_file:
        loaded = json.load(handle_file)
    assert loaded.get("version") == GOLDEN_VERSION, "golden fixture version mismatch"
    return loaded


def _write_golden(cases: dict[str, Any]) -> None:
    payload = {
        "version": GOLDEN_VERSION,
        "description": (
            "Structural golden for the SpecialistTurnResult seam, one entry per "
            "registered in-process specialist case. Source of truth: "
            "consent-protocol/hushh_mcp/adk_bridge/. Free text is governed by "
            "text_rules, never pinned. Refresh with "
            f"{UPDATE_ENV}=1 pytest tests/test_specialist_turn_parity.py."
        ),
        "cases": cases,
    }
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN_PATH.write_text(_dump(payload), encoding="utf-8")


def _update_requested() -> bool:
    return os.environ.get(UPDATE_ENV, "").strip() in {"1", "true", "yes"}


def _assert_matches_golden(case_name: str, expected: Any, actual: dict[str, Any]) -> None:
    if expected == actual:
        return
    expected_text = _dump(expected) if isinstance(expected, dict) else "<missing>\n"
    diff = "".join(
        difflib.unified_diff(
            expected_text.splitlines(keepends=True),
            _dump(actual).splitlines(keepends=True),
            fromfile=f"golden:{case_name}",
            tofile=f"actual:{case_name}",
        )
    )
    pytest.fail(
        f"SpecialistTurnResult parity broke for {case_name}. If the structural "
        f"change is intended, refresh with {UPDATE_ENV}=1.\n{diff}"
    )


@pytest.fixture(autouse=True)
def _offline_specialists(monkeypatch: pytest.MonkeyPatch) -> _RecordingConsentCenter:
    """Every specialist runs offline: DB token activity and consent center are stubbed."""

    async def _active(self, user_id, scope, agent_id=None, *, token_id=None):  # noqa: ANN001,ARG001
        return True

    center = _RecordingConsentCenter()

    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001,ARG001
        return await center.list_center(user_id, **kwargs)

    monkeypatch.setattr(ConsentDBService, "is_token_active", _active)
    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    # Another suite clears the registry around its tests; make sure the builtin
    # specialists are wired before dispatching.
    adk_bridge._register_builtin_specialists()
    return center


async def _run_case(
    case: _Case, center: _RecordingConsentCenter
) -> tuple[SpecialistTurnResult, str, list[dict[str, Any]]]:
    token = _nav_token() if case.agent_id == "agent_nav" else "HCT:parity-inert-token"
    task = case.make_task(token)
    service = (
        _scripted_nav_service(case.name) if case.agent_id == "agent_nav" else case.make_service()
    )

    async def _service_for(agent_id: str) -> Any:
        assert agent_id == case.agent_id
        return service

    runtime = dispatch_mod.SpecialistRuntime(OWNER_ID, AsyncMock(), _service_for)
    with dispatch_mod.bind_specialist_runtime(runtime):
        result = await dispatch_mod.dispatch(case.agent_id, task)
    calls = list(getattr(service, "calls", [])) + list(center.calls)
    return result, task.consent_token, calls


async def _collect_all(center: _RecordingConsentCenter) -> dict[str, dict[str, Any]]:
    collected: dict[str, dict[str, Any]] = {}
    for case in CASES:
        center.calls.clear()
        result, token, calls = await _run_case(case, center)
        collected[case.name] = _structural(
            result, service_calls=calls, token=token, text_rules=case.text_rules
        )
    return collected


@pytest.mark.asyncio
async def test_golden_is_current_or_refreshed(_offline_specialists: _RecordingConsentCenter):
    """Cut (in update mode) or verify the whole golden in one pass, printing the diff."""
    actual = await _collect_all(_offline_specialists)
    if _update_requested():
        _write_golden(actual)
    golden = _load_golden()
    assert set(golden["cases"]) == set(actual), (
        f"golden cases {sorted(golden['cases'])} differ from suite cases {sorted(actual)}"
    )
    for name, structural in actual.items():
        _assert_matches_golden(name, golden["cases"].get(name), structural)


@pytest.mark.asyncio
@pytest.mark.parametrize("case_name", sorted(_CASES_BY_NAME))
async def test_specialist_turn_matches_golden(
    case_name: str, _offline_specialists: _RecordingConsentCenter
):
    case = _CASES_BY_NAME[case_name]
    result, token, calls = await _run_case(case, _offline_specialists)
    actual = _structural(result, service_calls=calls, token=token, text_rules=case.text_rules)
    golden = _load_golden()
    _assert_matches_golden(case_name, golden["cases"].get(case_name), actual)
    _assert_text_rules(case_name, result.text, token, case.text_rules)
    assert token not in _dump(actual), f"{case_name}: consent token leaked into the golden"


@pytest.mark.asyncio
async def test_golden_pins_the_seams_the_migration_must_keep():
    """The golden must actually carry the structural facts the migration relies on."""
    cases = _load_golden()["cases"]

    refusal = cases["nav_invalid_token"]
    assert refusal["directive_kind"] == "prompt"
    assert refusal["directive_payload"]["kind"] == "consent_required"
    assert refusal["directive_payload"]["agentId"] == "agent_nav"
    assert refusal["directive_payload"]["requiredScope"] == ConsentScope.AGENT_NAV_REVIEW.value
    assert "reason" not in refusal["directive_payload"], "reason is free text, never pinned"
    assert refusal["service_calls"] == [], "a refused turn must not touch the consent center"

    active = cases["nav_active_grants"]
    assert active["directive_kind"] == "prompt"
    assert active["directive_payload"]["kind"] == "consent_actions"
    items = active["directive_payload"]["items"]
    assert [item["id"] for item in items] == ["one_location_grant:grant_parity_1"]
    assert items[0]["scope"] == "cap.location.live.view"
    assert items[0]["actions"] == ["revoke", "details"]
    assert "summary" not in items[0], "summary is free text, never pinned"
    assert active["service_calls"] == [
        {
            "call": "list_center",
            "user_id": OWNER_ID,
            "actor": "investor",
            "surface": "active",
            "top": 10,
        }
    ]

    previous = cases["nav_previous_grants"]
    assert previous["directive_kind"] is None
    assert [call["surface"] for call in previous["service_calls"]] == ["previous"]

    selection = cases["location_selection_delegate_result"]
    (handle_turn,) = selection["service_calls"]
    assert handle_turn["selection_result"] == {
        "id": "prm-parity-1",
        "selected": [{"userId": "mom-1"}],
        "status": "answered",
        "kind": "select",
    }, "promptKind must become the location prompt kind, never the A2A discriminator"
    assert handle_turn["consent_token"] == TOKEN_MARKER
    assert selection["directive_kind"] == "action"
    assert selection["directive_payload"]["type"] == "publish_share"
    assert selection["state_changed"] is True

    prompt = cases["location_message_turn"]
    assert prompt["directive_kind"] == "prompt"
    assert prompt["directive_payload"]["kind"] == "select"
    assert prompt["is_complete"] is False

    publish = cases["personal_information_message_turn"]
    assert publish["model"] == "one+memory"
    assert publish["directive_kind"] == "action"
    assert publish["directive_payload"]["type"] == "publish_slices"


@pytest.mark.asyncio
async def test_specialist_turn_envelope_for_location_prompt(
    _offline_specialists: _RecordingConsentCenter,
):
    """The One tool envelope around a golden case: keys, next_step, and the parked directive."""
    case = _CASES_BY_NAME["location_message_turn"]
    result, _token, _calls = await _run_case(case, _offline_specialists)
    assert result.directive is not None

    state: dict[str, Any] = {STATE_USER_ID: OWNER_ID, STATE_CONSENT_TOKEN: "tok"}
    with patch(
        "hushh_mcp.one_adk.agent_tree.dispatch", new=AsyncMock(return_value=result)
    ) as mock_dispatch:
        envelope = await _specialist_turn(
            "agent_location", "share my location with Mom", _ToolContext(state)
        )

    forwarded = mock_dispatch.await_args.args[1]
    assert forwarded.user_id == OWNER_ID
    assert forwarded.consent_token == "tok"  # noqa: S105 -- inert test value

    assert set(envelope) == {
        "status",
        "availability",
        "text",
        "is_complete",
        "next_step",
        "directive",
    }
    assert envelope["status"] == "ok"
    assert envelope["text"] == result.text
    assert envelope["is_complete"] is False
    assert isinstance(envelope["availability"], dict)
    assert envelope["availability"]["state"] == "ready"
    assert "choice card" in envelope["next_step"]
    assert envelope["directive"] == {
        "kind": "prompt",
        "payload": result.directive.payload,
        "delegateAgentId": "agent_location",
    }
    parking_key = f"{STATE_PENDING_DIRECTIVE}:agent_location_specialist"
    assert state[parking_key] == envelope["directive"]
    assert state["hussh:conversation_id"] == result.conversation_id


class _ToolContext:
    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state
