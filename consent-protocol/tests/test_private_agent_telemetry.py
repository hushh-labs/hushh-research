import logging

import pytest
from google.adk.telemetry.context import ContentCapturingMode

from hushh_mcp.hushh_adk.telemetry import private_telemetry
from mcp_modules.log_redaction import SensitiveLogFilter
from tests.test_agui_turn_timing import _input


def test_effective_legacy_and_modern_content_telemetry_is_off(monkeypatch):
    monkeypatch.setenv("ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS", "true")
    monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "SPAN_AND_EVENT")
    config = private_telemetry()
    assert config.resolved_content_capturing_mode == ContentCapturingMode.NO_CONTENT
    assert not config.should_add_content_to_legacy_spans
    assert not config.should_add_content_to_experimental_spans
    assert not config.should_add_content_to_logs


def test_admin_override_that_captures_private_content_fails_closed(monkeypatch):
    monkeypatch.setenv("ADK_TELEMETRY_IGNORE_RUN_CONFIG", "true")
    monkeypatch.setenv("ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS", "true")
    with pytest.raises(ValueError, match="telemetry must be disabled"):
        private_telemetry()


def test_both_public_heads_apply_the_private_sdk_run_config():
    from api.routes.one.agent_chat import _agent, _intro_agent

    for agent in (_agent, _intro_agent):
        config = agent._run_config_factory(_input())
        assert config.streaming_mode.value == "sse"
        assert not config.save_input_blobs_as_artifacts
        assert not config.telemetry.should_add_content_to_legacy_spans


@pytest.mark.parametrize(
    "name,message,args",
    [
        (
            "ag_ui_adk.adk_agent",
            "[ADK_EVENT] author=one, partial=True, content=PRIVATE_THOUGHT",
            (),
        ),
        ("ag_ui_adk.adk_agent", "[ADK_EVENT] author=one, content=%s", ("PRIVATE_RESULT",)),
        ("google_adk.google.adk.models.google_llm", "\nLLM Request:\n%s", ("PRIVATE_PROMPT",)),
        ("google_adk.google.adk.models.google_llm", "\nLLM Response:\nPRIVATE_RESULT", ()),
        ("ag_ui_adk.endpoint", "HTTP Response: %s", ("PRIVATE_STREAM",)),
    ],
)
def test_sdk_plaintext_content_logs_are_redacted_at_all_levels(name, message, args):
    record = logging.LogRecord(name, logging.INFO, __file__, 1, message, args, None)
    assert SensitiveLogFilter().filter(record)
    assert "PRIVATE_" not in record.getMessage()
    assert "[REDACTED]" in record.getMessage()


def test_sdk_operational_errors_remain_diagnostic():
    record = logging.LogRecord(
        "ag_ui_adk.adk_agent", logging.ERROR, __file__, 1, "session limit exceeded", (), None
    )
    assert SensitiveLogFilter().filter(record)
    assert record.getMessage() == "session limit exceeded"


def test_sdk_exception_records_keep_type_not_prompt_bearing_exception():
    error = ValueError("PRIVATE_PROVIDER_ERROR")
    record = logging.LogRecord(
        "google_adk.google.adk.workflow._node_runner",
        logging.ERROR,
        __file__,
        1,
        "Node execution failed",
        (),
        (ValueError, error, None),
    )
    SensitiveLogFilter().filter(record)
    assert "ValueError" in record.getMessage()
    assert record.exc_info is None and record.exc_text is None
    assert "PRIVATE" not in record.getMessage()


def test_trace_export_never_retains_callback_query_material():
    """Callback state/codes/file IDs must not become durable trace attributes."""
    from api.utils.private_trace_exporter import _safe_attributes

    projected = _safe_attributes(
        {
            "http.route": "/api/connectors/oauth/native/callback",
            "http.url": "https://api.uat.hushh.ai/api/connectors/oauth/native/callback?code=PRIVATE_CODE",
            "http.target": "/api/connectors/oauth/native/callback?state=PRIVATE_STATE",
            "url.full": "https://api.uat.hushh.ai/api/connectors/google_drive/picker/native/callback?picked_file_ids=PRIVATE_IDS",
        }
    )

    assert projected == {"http.route": "/api/connectors/oauth/native/callback"}


def test_opentelemetry_excludes_only_the_two_query_bearing_native_callbacks():
    from opentelemetry.util.http import parse_excluded_urls

    from api.middlewares.observability import _PRIVATE_CALLBACK_TRACE_URLS

    exclusions = parse_excluded_urls(_PRIVATE_CALLBACK_TRACE_URLS)
    assert exclusions.url_disabled(
        "https://api.uat.hushh.ai/api/connectors/oauth/native/callback?code=PRIVATE_CODE"
    )
    assert exclusions.url_disabled(
        "https://api.uat.hushh.ai/api/connectors/google_drive/picker/native/callback?picked_file_ids=PRIVATE_IDS"
    )
    assert not exclusions.url_disabled(
        "https://api.uat.hushh.ai/api/connectors/google_drive/picker/session"
    )


@pytest.mark.parametrize("fail,private_export", [(False, True), (True, True), (True, False)])
async def test_real_sdk_export_excludes_private_content_and_provider_exception(
    monkeypatch, fail, private_export
):
    import json
    import sys

    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from api.utils.private_trace_exporter import PrivateTraceExporter
    from hushh_mcp.agents.email.runtime import load_email_gene
    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError

    class Model(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            if fail:
                raise ValueError("PRIVATE_PROVIDER_ERROR")
            yield LlmResponse(
                content=types.Content(
                    role="model", parts=[types.Part(text='{"answer":"PRIVATE_ANSWER"}')]
                )
            )

    original_provider = trace.get_tracer_provider()
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(
        SimpleSpanProcessor(PrivateTraceExporter(memory) if private_export else memory)
    )
    local_tracer = provider.get_tracer("private-test")
    # Patch only already loaded SDK tracer references. Never change the global
    # provider, install a real exporter, or instrument other test processes.
    for name, module in list(sys.modules.items()):
        if name.startswith("google.adk.") and module and "tracer" in vars(module):
            monkeypatch.setattr(module, "tracer", local_tracer)
    agent = build_single_turn_agent(
        load_email_gene("agent_email_read_interpreter"),
        output_schema=dict,
        model=Model(model="fixture"),
    )
    try:
        if fail:
            with pytest.raises(SpecialistAdkTurnError):
                await run_single_turn(
                    agent,
                    prompt_parts="PRIVATE_PROMPT",
                    user_id="owner",
                    consent_token="fixture",  # noqa: S106
                )
        else:
            result = await run_single_turn(
                agent,
                prompt_parts="PRIVATE_PROMPT",
                user_id="owner",
                consent_token="fixture",  # noqa: S106
            )
            assert result["answer"] == "PRIVATE_ANSWER"
        spans = memory.get_finished_spans()
        assert any(span.name == "call_llm" for span in spans)
        serialized = json.dumps(
            [
                {
                    "attributes": dict(span.attributes),
                    "status": span.status.description,
                    "events": [dict(event.attributes) for event in span.events],
                }
                for span in spans
            ]
        )
        assert "PRIVATE_PROMPT" not in serialized and "PRIVATE_ANSWER" not in serialized
        # Positive control demonstrates NO_CONTENT alone does not remove SDK
        # exception messages; the production export boundary is necessary.
        assert ("PRIVATE_PROVIDER_ERROR" in serialized) is (fail and not private_export)
        assert trace.get_tracer_provider() is original_provider
    finally:
        provider.shutdown()


async def test_gmail_and_drive_http_spans_never_export_queries_or_provider_ids(monkeypatch):
    from unittest.mock import AsyncMock

    import httpx
    from opentelemetry.instrumentation.httpx import AsyncOpenTelemetryTransport
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader
    from hushh_mcp.services.google_drive_adapter import (
        METADATA_FIELDS,
        METADATA_LIMIT,
        GoogleDriveAdapter,
    )

    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    transport = AsyncOpenTelemetryTransport(
        httpx.MockTransport(lambda _: httpx.Response(200, stream=httpx.ByteStream(b"{}"))),
        tracer_provider=provider,
    )
    reader = GmailMetadataReader(gmail=object(), user_id="owner", require_access=AsyncMock())
    monkeypatch.setattr(reader, "require_current", AsyncMock())
    reader._remaining = 262144
    try:
        async with httpx.AsyncClient(transport=transport) as client:
            await client.get("https://synthetic.invalid/control")
            assert memory.get_finished_spans()  # instrumentation is actually recording
            memory.clear()
            await reader._get(client, "synthetic", "/messages/PRIVATE_ID", {"q": "PRIVATE_QUERY"})
            assert not memory.get_finished_spans()

        class Client(httpx.AsyncClient):
            def __init__(self, **kwargs):
                super().__init__(**{**kwargs, "transport": transport})

        monkeypatch.setattr(httpx, "AsyncClient", Client)
        await GoogleDriveAdapter()._get(
            "/files/PRIVATE_ID",
            access_token="synthetic",  # noqa: S106
            params={"fields": METADATA_FIELDS, "supportsAllDrives": "true"},
            limit=METADATA_LIMIT,
        )
        assert not memory.get_finished_spans()
    finally:
        provider.shutdown()
