"""A transient model failure ends the turn with a retryable message, however it arrives.

UAT, 2026-10-05: five of fourteen One turns ended on a provider 429 yet reached the
person as a generic failure (the log said error_class=other). The mapping only read
two bridge codes and a status that began a line.
"""

from __future__ import annotations

import logging
import time
from types import SimpleNamespace

import pytest
from ag_ui.core import RunErrorEvent

from hushh_mcp.one_adk import agui_turn_timing
from hushh_mcp.one_adk.run_errors import (
    MODEL_CAPACITY_RUN_ERROR,
    MODEL_UNAVAILABLE_RUN_ERROR,
    transient_model_error_for_exception,
    transient_model_run_error,
)

PROVIDER_429 = "429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED'}}"
ADK_ADVICE = "\nOn how to mitigate this issue, please refer to:\n\nhttps://example.test/adk\n\n\n"


def run_error(message: str, code: str = "EXECUTION_ERROR") -> RunErrorEvent:
    return RunErrorEvent(message=message, code=code)


@pytest.mark.parametrize(
    "message",
    [
        PROVIDER_429,
        ADK_ADVICE + PROVIDER_429,
        "Error in node one: " + PROVIDER_429,
        "unhandled error while streaming: 429 RESOURCE_EXHAUSTED. quota",
    ],
    ids=["plain", "adk_advice", "wrapped_in_a_node", "mid_line"],
)
@pytest.mark.parametrize(
    "code",
    ["EXECUTION_ERROR", "BACKGROUND_EXECUTION_ERROR", "AGENT_ERROR", "SOMETHING_ELSE"],
)
def test_a_provider_429_is_capacity_wherever_the_status_sits(message, code):
    assert transient_model_run_error(run_error(message, code)) == MODEL_CAPACITY_RUN_ERROR


@pytest.mark.parametrize(
    "message",
    [
        "503 UNAVAILABLE. {'error': 'x'}",
        "Error in node one: 500 INTERNAL. backend error",
        "504 DEADLINE_EXCEEDED. upstream",
    ],
)
def test_provider_5xx_is_a_brief_unavailability(message):
    assert transient_model_run_error(run_error(message)) == MODEL_UNAVAILABLE_RUN_ERROR


@pytest.mark.parametrize(
    "message",
    [
        "400 INVALID_ARGUMENT. bad request",
        "401 UNAUTHENTICATED. nope",
        "Failed to process tool results: boom",
        "retry after 14290 RESOURCE_EXHAUSTED style counters",  # digits glued to the status
        "the 429 was handled",  # a bare number is not a provider status
        "",
        None,
    ],
)
def test_other_errors_are_left_alone(message):
    assert transient_model_run_error(run_error(message or "")) is None


def test_an_already_authored_error_is_not_mapped_again():
    assert transient_model_run_error(MODEL_CAPACITY_RUN_ERROR) is None
    assert transient_model_run_error(MODEL_UNAVAILABLE_RUN_ERROR) is None


def test_the_mapped_event_never_carries_provider_text():
    mapped = transient_model_run_error(run_error("PRIVATE_PROVIDER_TEXT " + PROVIDER_429))
    assert "PRIVATE_PROVIDER_TEXT" not in mapped.model_dump_json()
    assert "429" not in mapped.model_dump_json()


class ProviderError(Exception):
    def __init__(self, code: int, status: str) -> None:
        super().__init__("provider")
        self.code = code
        self.status = status


def test_a_429_inside_a_task_group_failure_is_still_capacity():
    group = ExceptionGroup(
        "unhandled errors in a TaskGroup", [ProviderError(429, "RESOURCE_EXHAUSTED")]
    )
    assert transient_model_error_for_exception(group) == MODEL_CAPACITY_RUN_ERROR


def test_a_nested_group_is_searched_and_a_non_transient_group_is_not_mapped():
    nested = ExceptionGroup(
        "outer",
        [ValueError("x"), ExceptionGroup("inner", [ProviderError(503, "UNAVAILABLE")])],
    )
    assert transient_model_error_for_exception(nested) == MODEL_UNAVAILABLE_RUN_ERROR
    assert transient_model_error_for_exception(ExceptionGroup("g", [ValueError("x")])) is None


def test_a_plain_provider_exception_is_still_mapped():
    assert transient_model_error_for_exception(ProviderError(429, "RESOURCE_EXHAUSTED")) == (
        MODEL_CAPACITY_RUN_ERROR
    )
    assert transient_model_error_for_exception(RuntimeError("x")) is None


def _timing() -> agui_turn_timing.TurnTiming:
    return agui_turn_timing.TurnTiming(head="one", run="run", started_at=time.perf_counter())


def _fields(caplog) -> dict[str, str]:
    (line,) = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("one_agent_chat_turn_complete")
    ]
    return dict(part.split("=", 1) for part in line.split()[1:] if "=" in part)


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("EXECUTION_ERROR", "execution.error"),
        ("BACKGROUND_EXECUTION_ERROR", "background.execution.error"),
        ("RESOURCE_EXHAUSTED", "resource.exhausted"),
        ("PRIVATE_OWNER_VALUE", "unlisted"),
        (None, "untyped"),
    ],
)
def test_the_timing_line_names_a_known_run_error_code_and_nothing_else(caplog, code, expected):
    timing = _timing()
    timing.observe(RunErrorEvent(message="m", code=code))
    caplog.set_level(logging.INFO, logger=agui_turn_timing.logger.name)
    timing.log()
    fields = _fields(caplog)
    assert fields["error_code"] == expected
    assert "PRIVATE_OWNER_VALUE" not in caplog.text


def test_the_timing_line_counts_the_tools_every_model_step_is_offered(caplog):
    timing = _timing()
    config = SimpleNamespace(
        tools=[
            SimpleNamespace(function_declarations=[object()] * 66),
            SimpleNamespace(function_declarations=[object()] * 61),
            SimpleNamespace(function_declarations=None),
        ]
    )
    timing.begin_model_call(SimpleNamespace(model="gemini-3.6-flash", config=config, contents=[]))
    timing.begin_model_call(
        SimpleNamespace(
            model="gemini-3.6-flash",
            config=SimpleNamespace(tools=[SimpleNamespace(function_declarations=[object()] * 3)]),
            contents=[],
        )
    )
    caplog.set_level(logging.INFO, logger=agui_turn_timing.logger.name)
    timing.log()
    assert _fields(caplog)["tools_peak"] == "127"


def test_a_logged_code_survives_the_log_redactor(caplog):
    """The redactor masks long identifier-like tokens; the code must not look like one."""
    from mcp_modules.log_redaction import REDACTED, redact_log_value

    for code in (
        "BACKGROUND_EXECUTION_ERROR",
        "TOOL_RESULT_PROCESSING_ERROR",
        "TOOL_RESULT_BUFFER_ERROR",
    ):
        logged = agui_turn_timing._error_code(code)
        assert redact_log_value(logged) != REDACTED, code
