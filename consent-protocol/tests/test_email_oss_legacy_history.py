"""Actual Azure-codec regression for retained receipt continuations."""

from types import SimpleNamespace

import pytest
from google.genai import types


def test_receipt_resume_repairs_unknown_name_before_azure_codec_and_is_repeatable():
    # Nov 2 RCA: SDK result ID survived but its function name became unknown.
    from hushh_mcp.one_adk.output_privacy import drop_replayed_tool_placeholders
    from hushh_mcp.runtime_providers.azure_adk import _history

    call = types.Part.from_function_call(name="receipt_spending", args={})
    call.function_call.id = "receipt-call"
    response = types.Part.from_function_response(name="unknown", response={"status": "ok"})
    response.function_response.id = "receipt-call"
    stored = [
        types.Content(role="model", parts=[call]),
        types.Content(role="user", parts=[response]),
        types.Content(role="user", parts=[types.Part(text="why did it fail")]),
    ]
    with pytest.raises(ValueError):
        _history(stored)
    for _ in range(20):
        request = SimpleNamespace(contents=stored)
        drop_replayed_tool_placeholders(request)
        wire = _history(request.contents)
        assert any(item.get("type") == "function_call_output" for item in wire)
        assert request.contents[1].parts[0].function_response.name == "receipt_spending"
        assert stored[1].parts[0].function_response.name == "unknown"


def test_tool_history_never_matches_a_future_call_or_keeps_duplicate_results():
    from hushh_mcp.one_adk.output_privacy import drop_replayed_tool_placeholders
    from hushh_mcp.runtime_providers.azure_adk import _history

    call = types.Part.from_function_call(name="receipt_spending", args={})
    call.function_call.id = "c"
    result = types.Part.from_function_response(name="unknown", response={"status": "ok"})
    result.function_response.id = "c"
    request = SimpleNamespace(
        contents=[
            types.Content(role="user", parts=[result]),
            types.Content(role="model", parts=[call]),
            types.Content(role="user", parts=[result, result]),
            types.Content(role="user", parts=[types.Part(text="continue")]),
        ]
    )
    assert drop_replayed_tool_placeholders(request) == 2
    assert len([p for c in request.contents for p in c.parts if p.function_response]) == 1
    _history(request.contents)
