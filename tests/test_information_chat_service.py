"""Tests for the One Personal Information agent chat runner + read model.

The chat runner executes a Gemini function-calling loop INSIDE a HushhContext so
each @hushh_tool enforces consent scope. These tests inject a fake model_call
(the Gemini seam), real google.genai types, and fake tools — no live LLM or DB.

The read-model tests inject a fake PKM service to verify published-slice
filtering and the honesty invariant that earnings are potential-only (nothing is
ever accrued while there is no payment rail).
"""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.information_chat_service import InformationChatService
from hushh_mcp.services.marketplace_information_service import (
    MarketplaceInformationService,
)

# --- chat-runner fakes ------------------------------------------------------


class _Turn:
    def __init__(self, conversation_id: str, history: list) -> None:
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None) -> None:
        self.history = history or []
        self.added: list[dict] = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


def _fake_tool(name: str, recorder: list, *, result: dict | None = None):
    async def _impl(**kwargs):
        ctx = HushhContext.current()
        recorder.append(
            {
                "name": name,
                "args": kwargs,
                "ctx_user": getattr(ctx, "user_id", None),
                "ctx_token": getattr(ctx, "consent_token", None),
            }
        )
        return result if result is not None else {"ok": True}

    _impl._name = name
    _impl._hushh_tool = True
    return _impl


def _fc_response(name: str, args: dict):
    return SimpleNamespace(
        function_calls=[SimpleNamespace(name=name, args=args)],
        text="",
        candidates=[
            SimpleNamespace(content=types.Content(role="model", parts=[types.Part(text="")]))
        ],
    )


def _text_response(text: str):
    return SimpleNamespace(function_calls=[], text=text, candidates=[])


def _scripted_model_call(responses: list, captured: list):
    seq = iter(responses)

    async def _call(contents, config):
        captured.append(list(contents))
        return next(seq)

    return _call


def _build_service(*, store, responses, captured, tools):
    return InformationChatService(
        chat_store=store,
        model_call=_scripted_model_call(responses, captured),
        genai_types=types,
        ready=lambda: True,
        tools=tools,
        system_prompt="test-system-prompt",
    )


# --- chat-runner tests ------------------------------------------------------


async def test_query_tool_runs_in_consent_context_and_never_changes_state():
    store = _FakeStore()
    calls: list[dict] = []
    tools = [_fake_tool("list_published_slices", calls, result={"publishedSlices": [], "count": 0})]
    captured: list = []
    service = _build_service(
        store=store,
        responses=[
            _fc_response("list_published_slices", {}),
            _text_response("You have not published anything yet."),
        ],
        captured=captured,
        tools=tools,
    )

    out = await service.handle_turn(
        user_id="user_123",
        message="what have I published?",
        consent_token="vault-token",  # noqa: S106
    )

    assert out["response"] == "You have not published anything yet."
    assert out["isComplete"] is True
    # Read-only surface: a query turn must never report a state change.
    assert out["stateChanged"] is False
    # The tool executed inside the caller's consent context.
    assert calls[0]["ctx_user"] == "user_123"
    assert calls[0]["ctx_token"] == "vault-token"  # noqa: S105


async def test_approve_tool_sets_state_changed():
    store = _FakeStore()
    calls: list[dict] = []
    # A successful approve is a mutating tool → the turn reports stateChanged so
    # the UI refetches the durable inbox.
    tools = [_fake_tool("approve_access_request", calls, result={"ok": True})]
    captured: list = []
    service = _build_service(
        store=store,
        responses=[
            _fc_response("approve_access_request", {"request_id": "req-1"}),
            _text_response("Approved."),
        ],
        captured=captured,
        tools=tools,
    )

    out = await service.handle_turn(
        user_id="u1",
        message="approve the Insurance request",
        consent_token="vault-token",  # noqa: S106
    )

    assert out["response"] == "Approved."
    assert out["stateChanged"] is True


async def test_empty_message_short_circuits_without_model_call():
    store = _FakeStore()
    captured: list = []
    service = _build_service(store=store, responses=[], captured=captured, tools=[])

    out = await service.handle_turn(user_id="u1", message="", consent_token="t")  # noqa: S106

    assert out["stateChanged"] is False
    assert captured == []  # model never called


# --- read-model fakes + tests ----------------------------------------------


class _FakePkm:
    def __init__(self, *, available_domains, manifests) -> None:
        self._index = SimpleNamespace(available_domains=available_domains)
        self._manifests = manifests

    async def get_index_v2(self, user_id):
        return self._index

    async def get_domain_manifest(self, user_id, domain):
        return self._manifests.get(domain)


def _scope(label, posture, *, tier="confidential", segments=("a",)):
    return {
        "domain": "personal_data",
        "scope_label": label,
        "visibility_posture": posture,
        "sensitivity_tier": tier,
        "scope_kind": "subtree",
        "scope_handle": f"h_{label}",
        "segment_ids": list(segments),
    }


async def test_list_published_slices_returns_only_available():
    pkm = _FakePkm(
        available_domains=["personal_data"],
        manifests={
            "personal_data": {
                "scope_registry": [
                    _scope("Insurance", "default_available"),
                    _scope("SSN", "private"),
                    _scope("Email", "consent_required"),
                ]
            }
        },
    )
    svc = MarketplaceInformationService(pkm_service=pkm)

    slices = await svc.list_published_slices(user_id="u1")

    assert [s["label"] for s in slices] == ["Insurance"]
    assert slices[0]["domainTitle"] == "Personal Data"
    assert slices[0]["attributeCount"] == 1


async def test_earnings_summary_is_potential_only_never_accrued():
    pkm = _FakePkm(
        available_domains=["personal_data"],
        manifests={
            "personal_data": {
                "scope_registry": [
                    _scope(
                        "Insurance", "default_available", tier="restricted", segments=("a", "b")
                    ),
                ]
            }
        },
    )
    svc = MarketplaceInformationService(pkm_service=pkm)

    summary = await svc.earnings_summary(user_id="u1")

    assert summary["sliceCount"] == 1
    assert summary["pricedSliceCount"] == 1
    # The honesty invariant: nothing is ever accrued without a payment rail.
    assert summary["accruedCents"] == 0
    assert summary["hasBuyers"] is False
    assert summary["hasPaymentRail"] is False
    assert summary["totalPotentialMonthlyCents"] > 0
    assert summary["perSlice"][0]["label"] == "Insurance"


async def test_earnings_summary_with_nothing_published():
    pkm = _FakePkm(available_domains=[], manifests={})
    svc = MarketplaceInformationService(pkm_service=pkm)

    summary = await svc.earnings_summary(user_id="u1")

    assert summary["sliceCount"] == 0
    assert summary["totalPotentialMonthlyCents"] == 0
    assert summary["accruedCents"] == 0
