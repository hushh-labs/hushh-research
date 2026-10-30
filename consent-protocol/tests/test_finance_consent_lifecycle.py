"""Finance object authority exercises the existing real One conversation harness."""

import pytest
import test_consent_redaction as legacy
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from test_consent_redaction import BUNDLE, OWNER, _request_text

from hushh_mcp.one_adk.consent_continuation import (
    STATE_CONSENT_CONTINUATION,
    consent_shared_state_key,
)
from hushh_mcp.one_adk.consent_redaction import (
    consent_access_ended_state_key,
    consent_invocations_state_key,
)


def test_finance_review_config_is_accepted_by_the_shared_azure_adapter():
    from types import SimpleNamespace

    from google.adk.models.llm_request import LlmRequest

    from hushh_mcp.one_adk.consent_redaction import consent_answer_fast_path
    from hushh_mcp.runtime_providers.azure_adk import _request

    request = LlmRequest(
        model="synthetic-azure-chat",
        contents=[types.Content(role="user", parts=[types.Part(text="Review shared Finance")])],
        config=types.GenerateContentConfig(
            tools=[
                types.Tool(function_declarations=[types.FunctionDeclaration(name="synthetic_tool")])
            ]
        ),
    )
    context = SimpleNamespace(
        state={STATE_CONSENT_CONTINUATION: {"kind": "finance", "outcome": "granted"}}
    )
    assert consent_answer_fast_path(context, request, model=request.model)
    # Use the real provider serializer: unsupported effort fails before any HTTP call.
    wire = _request(request, "synthetic-shared-deployment")
    assert wire["reasoning"] == {"effort": "low"}
    assert wire["tool_choice"] == "none"
    assert request.config.thinking_config.include_thoughts is False


@pytest.mark.asyncio
async def test_finance_model_callback_rechecks_authority_before_consent_redaction(monkeypatch):
    from hushh_mcp.one_adk import finance_share_context

    calls = []

    async def recheck(context, *, lookup):
        calls.append("recheck")

    def redact(context, request):
        calls.append("redact")

    monkeypatch.setattr(finance_share_context, "recheck_finance_context", recheck)
    _, callback, _ = finance_share_context.finance_model_callbacks(lookup=None, before_model=redact)
    assert callback.__wrapped__ is redact
    await callback(object(), object())
    assert calls == ["recheck", "redact"]


@pytest.mark.asyncio
@pytest.mark.parametrize("redact", [True, False])
async def test_finance_object_lifecycle_reuses_actual_one_history_redaction(monkeypatch, redact):
    source = f"finance:{BUNDLE}:1"
    original_turn = legacy._turn

    async def finance_turn(runner, message, state_delta=None):
        if state_delta and STATE_CONSENT_CONTINUATION in state_delta:
            state_delta[STATE_CONSENT_CONTINUATION]["kind"] = "finance"
        return await original_turn(runner, message, state_delta)

    monkeypatch.setattr(legacy, "BUNDLE", source)
    monkeypatch.setattr(legacy, "_turn", finance_turn)
    model, sessions = await legacy._conversation(monkeypatch, redact=redact)
    assert ("Nopa" not in _request_text(model._requests[2])) is redact
    session = await sessions.get_session(app_name="one", user_id=OWNER, session_id="chat")
    assert session.state[consent_access_ended_state_key(source)] == "revoked"


@pytest.mark.asyncio
async def test_finance_revocation_during_generation_cannot_publish_the_answer():
    from types import SimpleNamespace

    from hushh_mcp.one_adk.finance_share_context import finance_response_guard

    source = f"finance:{BUNDLE}:1"
    state = {
        consent_invocations_state_key(source): ["run"],
        consent_shared_state_key(source): {"personName": "Owner", "labels": ["Allocation"]},
    }
    callback = SimpleNamespace(state=state, user_id=OWNER, invocation_id="run")
    response = LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text="private-review-sentinel")])
    )

    async def live(*args):
        return {"progress": {"outcome": "granted"}}

    assert await finance_response_guard(callback, response, lookup=live) is None

    async def revoked(*args):
        return {"progress": {"outcome": "revoked"}}

    guarded = await finance_response_guard(callback, response, lookup=revoked)
    assert "private-review-sentinel" not in guarded.content.parts[0].text
