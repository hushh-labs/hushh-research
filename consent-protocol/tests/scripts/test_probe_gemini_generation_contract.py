"""Offline guard for the Gemini generation-contract probe.

No provider is called. The tests cover the plan enumeration, the result
classifier, the dry-run path building no client, the two-step function
response legs, and the JSON report shape.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from google.genai import errors, types

from scripts import probe_gemini_generation_contract as probe

MODELS = ("gemini-3.8-flash", "gemini-3.7-flash")


def _fake_client_error(code: int, status: str, message: str) -> errors.ClientError:
    """Shape the SDK raises for a 4xx: ``code``, ``status`` and ``message`` attributes."""
    return errors.ClientError(
        code,
        {"error": {"code": code, "status": status, "message": message}},
    )


def _text_response(finish_reason: str = "STOP") -> SimpleNamespace:
    return SimpleNamespace(
        candidates=[
            SimpleNamespace(
                finish_reason=finish_reason,
                content=types.Content(role="model", parts=[types.Part(text="ready")]),
            )
        ]
    )


def _function_call_response(call_id: str | None) -> SimpleNamespace:
    call = types.FunctionCall(id=call_id, name=probe.TOOL_NAME, args={"city": "Paris"})
    return SimpleNamespace(
        candidates=[
            SimpleNamespace(
                finish_reason="STOP",
                content=types.Content(role="model", parts=[types.Part(function_call=call)]),
            )
        ]
    )


def test_plan_enumerates_every_expected_cell_in_order() -> None:
    plan = probe.build_plan(MODELS)
    assert len(plan) == 16
    expected_checks = [
        "baseline",
        "thinking_level:LOW",
        "thinking_level:MEDIUM",
        "thinking_level:HIGH",
        "thinking_level:MINIMAL",
        "temperature:0.2",
        "function_response:no_id",
        "function_response:with_id",
    ]
    for model in MODELS:
        checks = [cell.check for cell in plan if cell.model == model]
        assert checks == expected_checks
    assert [cell.model for cell in plan[:8]] == ["gemini-3.8-flash"] * 8


def test_classifier_records_400_invalid_argument_without_project_ref() -> None:
    exc = _fake_client_error(
        400,
        "INVALID_ARGUMENT",
        "Field thinking_level is not supported for projects/123456789012/locations/global",
    )
    cell = probe.classify_exception("gemini-3.8-flash", "thinking_level:MINIMAL", exc)
    assert cell.outcome == "reject"
    assert cell.status_code == 400
    assert cell.error_status == "INVALID_ARGUMENT"
    assert cell.error_class == "ClientError"
    assert cell.error_head is not None
    assert "123456789012" not in cell.error_head
    assert "projects/<redacted>" in cell.error_head
    assert len(cell.error_head) <= probe.ERROR_HEAD_CHARS


def test_classifier_records_success_with_finish_reason_only() -> None:
    cell = probe.accept_cell("gemini-3.7-flash", "baseline", _text_response("STOP"))
    assert cell.outcome == "accept"
    assert cell.status_code == 200
    assert cell.error_class is None
    assert cell.detail == {"finish_reason": "STOP"}
    assert "ready" not in json.dumps(
        probe.build_report(
            models=MODELS, location="global", cells=[cell], sdk_version="x", dry_run=False
        )
    )


def test_quota_error_is_retried_then_succeeds() -> None:
    attempts: list[int] = []
    sleeps: list[float] = []

    def _call(model: str, contents: Any, config: Any) -> Any:
        attempts.append(1)
        if len(attempts) < 3:
            raise _fake_client_error(429, "RESOURCE_EXHAUSTED", "quota")
        return _text_response()

    response = probe.call_with_quota_retry(
        _call, "gemini-3.8-flash", "hi", None, call_gap_seconds=0.5, sleep=sleeps.append
    )
    assert response.candidates
    assert len(attempts) == 3
    assert sleeps == [0.5, 1.0]


def test_non_quota_error_is_not_retried() -> None:
    attempts: list[int] = []

    def _call(model: str, contents: Any, config: Any) -> Any:
        attempts.append(1)
        raise _fake_client_error(400, "INVALID_ARGUMENT", "bad field")

    with pytest.raises(errors.ClientError):
        probe.call_with_quota_retry(_call, "gemini-3.8-flash", "hi", None, sleep=lambda _: None)
    assert len(attempts) == 1


def test_dry_run_builds_no_client_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def _forbidden(project: str, location: str) -> Any:
        raise AssertionError("dry-run must not build a client")

    monkeypatch.setattr(probe, "build_client", _forbidden)
    monkeypatch.delenv("GENAI_GOOGLE_CLOUD_PROJECT", raising=False)
    out = tmp_path / "report.json"
    rc = probe.main(["--dry-run", "--out", str(out)])
    assert rc == 0
    assert not out.exists()
    captured = capsys.readouterr().out
    assert "gemini-3.8-flash   thinking_level:MINIMAL" in captured
    assert "no client built" in captured


def test_live_run_without_project_exits_before_any_client(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def _forbidden(project: str, location: str) -> Any:
        raise AssertionError("must not build a client without a project")

    monkeypatch.setattr(probe, "build_client", _forbidden)
    monkeypatch.delenv("GENAI_GOOGLE_CLOUD_PROJECT", raising=False)
    rc = probe.main(["--project", "", "--out", str(tmp_path / "r.json")])
    assert rc == 2


def test_run_probe_measures_every_cell_and_sends_both_function_response_legs() -> None:
    seen: list[tuple[str, Any, Any]] = []
    call_ids_sent: list[str | None] = []

    def _call(model: str, contents: Any, config: Any) -> Any:
        seen.append((model, contents, config))
        if getattr(config, "tools", None):
            if isinstance(contents, str):
                return _function_call_response("call-abc")
            tool_part = contents[-1].parts[0]
            call_ids_sent.append(tool_part.function_response.id)
            if tool_part.function_response.id is None:
                raise _fake_client_error(400, "INVALID_ARGUMENT", "FunctionResponse.id is required")
            return _text_response()
        thinking = getattr(config, "thinking_config", None)
        level = getattr(thinking, "thinking_level", None)
        if level is not None and str(getattr(level, "value", level)).endswith("MINIMAL"):
            raise _fake_client_error(400, "INVALID_ARGUMENT", "thinking_level MINIMAL unsupported")
        return _text_response()

    cells = probe.run_probe(_call, types, ("gemini-3.8-flash",), sleep=lambda _: None)
    by_check = {cell.check: cell for cell in cells}
    assert [cell.check for cell in cells] == [
        cell.check for cell in probe.build_plan(("gemini-3.8-flash",))
    ]
    assert by_check["baseline"].outcome == "accept"
    assert by_check["thinking_level:LOW"].outcome == "accept"
    assert by_check["thinking_level:MINIMAL"].outcome == "reject"
    assert by_check["thinking_level:MINIMAL"].error_status == "INVALID_ARGUMENT"
    assert by_check["temperature:0.2"].outcome == "accept"
    assert by_check["function_response:no_id"].outcome == "reject"
    assert by_check["function_response:with_id"].outcome == "accept"
    assert by_check["function_response:with_id"].detail["call_id_present"] is True
    assert call_ids_sent == [None, "call-abc"]
    # The no-id leg uses the exact builder the location loop uses today.
    no_id_contents = seen[-2][1]
    assert no_id_contents[-1].parts[0].function_response.name == probe.TOOL_NAME
    assert no_id_contents[-1].parts[0].function_response.id is None


def test_run_probe_records_no_call_after_forcing_retry() -> None:
    tool_prompts: list[str] = []

    def _call(model: str, contents: Any, config: Any) -> Any:
        if getattr(config, "tools", None):
            tool_prompts.append(contents)
        return _text_response()

    cells = probe.run_probe(_call, types, ("gemini-3.7-flash",), sleep=lambda _: None)
    by_check = {cell.check: cell for cell in cells}
    assert by_check["function_response:no_id"].outcome == "no_call"
    assert by_check["function_response:with_id"].outcome == "no_call"
    assert tool_prompts == [probe.TOOL_PROMPT, probe.TOOL_FORCING_PROMPT]


def test_run_probe_marks_with_id_leg_when_provider_returns_no_call_id() -> None:
    def _call(model: str, contents: Any, config: Any) -> Any:
        if getattr(config, "tools", None) and isinstance(contents, str):
            return _function_call_response(None)
        return _text_response()

    cells = probe.run_probe(_call, types, ("gemini-3.7-flash",), sleep=lambda _: None)
    by_check = {cell.check: cell for cell in cells}
    assert by_check["function_response:no_id"].outcome == "accept"
    assert by_check["function_response:with_id"].outcome == "no_call_id"


def test_report_shape_and_matrix_render() -> None:
    cells = [
        probe.accept_cell("gemini-3.8-flash", "baseline", _text_response()),
        probe.classify_exception(
            "gemini-3.8-flash",
            "thinking_level:MINIMAL",
            _fake_client_error(400, "INVALID_ARGUMENT", "unsupported"),
        ),
    ]
    report = probe.build_report(
        models=MODELS, location="global", cells=cells, sdk_version="2.10.0", dry_run=False
    )
    assert set(report) == {
        "probe",
        "generated_at",
        "dry_run",
        "vertex_location",
        "google_genai_version",
        "models",
        "plan",
        "cells",
    }
    assert report["probe"] == "gemini_generation_contract"
    assert report["models"] == list(MODELS)
    assert len(report["plan"]) == 16
    assert report["cells"][1] == {
        "model": "gemini-3.8-flash",
        "check": "thinking_level:MINIMAL",
        "outcome": "reject",
        "status_code": 400,
        "error_status": "INVALID_ARGUMENT",
        "error_class": "ClientError",
        "error_head": "unsupported",
        "detail": {},
    }
    json.dumps(report)
    matrix = probe.format_matrix(cells)
    assert "thinking_level:MINIMAL" in matrix
    assert "reject" in matrix
    assert "INVALID_ARGUMENT" in matrix
