"""Offline coverage for the AG-UI chat latency driver.

No test here opens a socket. The stream is a fake SSE line generator driven by
a fake clock, the reviewer login is monkeypatched, and the secret-leak check
runs the real ``main`` end to end against those fakes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts import _reviewer_session as reviewer_session
from scripts import measure_agent_chat_latency as driver

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


class FakeClock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _sse(event: dict[str, Any]) -> list[str]:
    return [f"data: {json.dumps(event)}", ""]


def _finished_stream(clock: FakeClock, *, first_visible_s: float, total_s: float):
    """A generator whose frames advance the fake clock as they are consumed."""

    def lines():
        yield ": ping"
        yield ""
        clock.advance(0.05)
        yield from _sse({"type": "RUN_STARTED", "threadId": "t", "runId": "r"})
        clock.advance(first_visible_s - 0.05)
        yield from _sse({"type": "TEXT_MESSAGE_START", "messageId": "m", "role": "assistant"})
        yield from _sse({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "hi"})
        clock.advance(total_s - first_visible_s)
        yield from _sse({"type": "TEXT_MESSAGE_END", "messageId": "m"})
        yield from _sse({"type": "RUN_FINISHED", "threadId": "t", "runId": "r"})

    return lines()


def _report(first_visible_p95: float, total_p95: float, *, outcome: str = "finished") -> dict:
    return {
        "samples": [{"prompt_id": "general_help", "rep": 0, "outcome": outcome}],
        "summary": {
            "client": {
                "first_visible": {
                    "count": 1,
                    "p50": first_visible_p95,
                    "p95": first_visible_p95,
                    "max": first_visible_p95,
                },
                "total": {"count": 1, "p50": total_p95, "p95": total_p95, "max": total_p95},
            },
            "server": {
                "first_visible": {"count": 0, "p50": None, "p95": None, "max": None},
                "elapsed": {"count": 0, "p50": None, "p95": None, "max": None},
            },
        },
    }


# --------------------------------------------------------------------------
# pct
# --------------------------------------------------------------------------


def test_pct_interpolates_between_samples():
    values = [100.0, 200.0, 300.0, 400.0, 500.0]
    assert driver.pct(values, 0.5) == 300.0
    assert driver.pct(values, 0.95) == pytest.approx(480.0)
    assert driver.pct(values, 1.0) == 500.0
    assert driver.pct(values, 0.0) == 100.0


def test_pct_degenerate_inputs():
    assert driver.pct([], 0.95) == 0.0
    assert driver.pct([42.0], 0.95) == 42.0
    assert driver.pct([5.0, 1.0], 1.5) == 5.0


def test_latency_block_reports_null_when_empty():
    assert driver.latency_block([]) == {"count": 0, "p50": None, "p95": None, "max": None}
    block = driver.latency_block([10.0, 20.0, 30.0])
    assert block["count"] == 3 and block["max"] == 30.0 and block["p50"] == 20.0


# --------------------------------------------------------------------------
# request body shape
# --------------------------------------------------------------------------


def test_run_agent_input_matches_browser_shape():
    body = driver.build_run_agent_input(
        "hello", thread_id="thread-1", run_id="run-1", timezone="Asia/Kolkata", message_id="m-1"
    )
    assert set(body) == {
        "threadId",
        "runId",
        "state",
        "messages",
        "tools",
        "context",
        "forwardedProps",
    }
    assert body["threadId"] == "thread-1"
    assert body["runId"] == "run-1"
    assert body["state"] == {}
    assert body["messages"] == [{"id": "m-1", "role": "user", "content": "hello"}]
    assert body["tools"] == [] and body["context"] == []
    assert body["forwardedProps"]["timezone"] == "Asia/Kolkata"
    assert isinstance(body["forwardedProps"]["screenContext"], dict)


def test_run_agent_input_validates_against_ag_ui_model():
    from ag_ui.core import RunAgentInput

    body = driver.build_run_agent_input("hello", thread_id="t", run_id="r", timezone="UTC")
    parsed = RunAgentInput.model_validate(body)
    assert parsed.thread_id == "t" and parsed.run_id == "r"
    assert parsed.messages[0].role == "user"


def test_fixed_prompt_catalog_and_counterpart_substitution():
    assert len(driver.PROMPTS) == 12
    categories = {case.category for case in driver.PROMPTS}
    assert categories == {"general", "consent", "delegation", "finance", "memory"}
    request = next(case for case in driver.PROMPTS if case.prompt_id == "consent_request")
    assert "Priya" in request.render(counterpart="Priya")
    assert len({case.prompt_id for case in driver.PROMPTS}) == 12


def test_select_prompts_rejects_unknown_ids():
    with pytest.raises(ValueError):
        driver.select_prompts(["nope"])
    assert [c.prompt_id for c in driver.select_prompts(["finance_ticker"])] == ["finance_ticker"]


# --------------------------------------------------------------------------
# SSE parsing and timing
# --------------------------------------------------------------------------


def test_iter_sse_events_ignores_comments_and_dispatches_trailing_frame():
    lines = [
        ": keepalive",
        "",
        "event: message",
        'data: {"type": "RUN_STARTED"}',
        "",
        "data: not json",
        "",
        'data: {"type": "RUN_FINISHED"}',
    ]
    events = list(driver.iter_sse_events(lines))
    assert [e["type"] for e in events] == ["RUN_STARTED", "RUN_FINISHED"]


@pytest.mark.parametrize("total_s,expected", [(100.0, "finished"), (121.0, "timeout")])
def test_default_window_allows_slow_turn_but_remains_bounded(total_s, expected):
    clock = FakeClock()
    body = driver.build_run_agent_input("hello", thread_id="t", run_id="r", timezone="UTC")
    sample = driver.drive_turn(
        lambda _body: _finished_stream(clock, first_visible_s=5.0, total_s=total_s),
        body,
        prompt=driver.PROMPTS[0],
        rep=0,
        clock=clock,
    )
    assert sample.outcome == expected
    assert sample.client_total_ms == total_s * 1000


def test_drive_turn_marks_first_visible_and_done():
    clock = FakeClock()
    prompt = driver.PROMPTS[0]
    body = driver.build_run_agent_input("x", thread_id="t", run_id="abcdef12-rest", timezone="UTC")
    sample = driver.drive_turn(
        lambda _body: _finished_stream(clock, first_visible_s=0.8, total_s=2.5),
        body,
        prompt=prompt,
        rep=1,
        clock=clock,
    )
    assert sample.outcome == "finished"
    assert sample.run == "abcdef12"
    assert sample.rep == 1
    assert sample.client_first_visible_ms == pytest.approx(800.0, abs=0.2)
    assert sample.client_first_answer_token_ms == pytest.approx(800.0, abs=0.2)
    assert sample.client_total_ms == pytest.approx(2500.0, abs=0.2)
    assert sample.first_visible_event == "TEXT_MESSAGE_CONTENT"
    assert sample.event_count == 5


def test_drive_turn_tool_call_start_counts_as_first_visible_and_run_error_is_terminal():
    clock = FakeClock()

    def lines():
        clock.advance(0.3)
        yield from _sse({"type": "TOOL_CALL_START", "toolCallId": "c", "toolCallName": "n"})
        clock.advance(0.2)
        yield from _sse({"type": "RUN_ERROR", "message": "boom", "code": "AGENT_ERROR"})

    sample = driver.drive_turn(
        lambda _b: lines(),
        driver.build_run_agent_input("x", thread_id="t", run_id="r", timezone="UTC"),
        prompt=driver.PROMPTS[1],
        rep=0,
        clock=clock,
    )
    assert sample.outcome == "run_error"
    assert sample.detail == "AGENT_ERROR"
    assert sample.first_visible_event == "TOOL_CALL_START"
    assert sample.client_first_visible_ms == pytest.approx(300.0, abs=0.2)
    assert sample.client_first_answer_token_ms is None
    assert sample.client_total_ms == pytest.approx(500.0, abs=0.2)


def test_drive_turn_distinguishes_first_tool_activity_from_answer_token():
    clock = FakeClock()

    def lines():
        clock.advance(0.2)
        yield from _sse({"type": "TOOL_CALL_START", "toolCallId": "c", "toolCallName": "n"})
        clock.advance(0.7)
        yield from _sse({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "ready"})
        clock.advance(0.1)
        yield from _sse({"type": "RUN_FINISHED"})

    sample = driver.drive_turn(
        lambda _b: lines(),
        driver.build_run_agent_input("x", thread_id="t", run_id="r", timezone="UTC"),
        prompt=driver.PROMPTS[0],
        rep=0,
        clock=clock,
    )
    assert sample.outcome == "finished"
    assert sample.client_first_visible_ms == pytest.approx(200.0, abs=0.2)
    assert sample.client_first_answer_token_ms == pytest.approx(900.0, abs=0.2)
    assert driver.summarize([sample])["client"]["first_answer_token"]["p50"] == pytest.approx(900.0)


def test_drive_turn_without_terminal_frame_and_transport_failure():
    clock = FakeClock()

    def truncated():
        clock.advance(0.1)
        yield from _sse({"type": "RUN_STARTED"})

    sample = driver.drive_turn(
        lambda _b: truncated(),
        driver.build_run_agent_input("x", thread_id="t", run_id="r", timezone="UTC"),
        prompt=driver.PROMPTS[0],
        rep=0,
        clock=clock,
    )
    assert sample.outcome == "no_terminal"
    assert sample.client_first_visible_ms is None
    assert sample.client_total_ms == pytest.approx(100.0, abs=0.2)

    def refuse(_body):
        raise driver.TransportFailure("http_error", "HTTP 401")

    failed = driver.drive_turn(
        refuse,
        driver.build_run_agent_input("x", thread_id="t", run_id="r", timezone="UTC"),
        prompt=driver.PROMPTS[0],
        rep=0,
        clock=clock,
    )
    assert failed.outcome == "http_error" and failed.detail == "HTTP 401"


def test_run_suite_is_rep_major_with_fresh_threads_and_gaps():
    clock = FakeClock()
    seen_threads: list[str] = []
    sleeps: list[float] = []

    def opener(body):
        seen_threads.append(body["threadId"])
        return _finished_stream(clock, first_visible_s=0.1, total_s=0.2)

    prompts = driver.select_prompts(["general_help", "memory_preference"])
    samples = driver.run_suite(
        opener,
        prompts,
        reps=2,
        gap_seconds=2.0,
        counterpart="Alice",
        timezone="UTC",
        clock=clock,
        sleep=sleeps.append,
    )
    assert [(s.prompt_id, s.rep) for s in samples] == [
        ("general_help", 0),
        ("memory_preference", 0),
        ("general_help", 1),
        ("memory_preference", 1),
    ]
    assert len(set(seen_threads)) == 4
    assert sleeps == [2.0, 2.0, 2.0]


# --------------------------------------------------------------------------
# server log correlation
# --------------------------------------------------------------------------


def test_server_log_lines_are_matched_on_run_prefix(tmp_path: Path):
    log = tmp_path / "backend.log"
    log.write_text("old line\n", encoding="utf-8")
    offset = driver.log_offset(log)
    with log.open("a", encoding="utf-8") as handle:
        handle.write(
            "INFO one_agent_chat_turn_complete head=one run=abcdef12 "
            "first_visible_ms=640 first_answer_token_ms=910 elapsed_ms=2210\n"
        )
        handle.write(
            "INFO one_agent_chat_turn_complete head=intro run=deadbeef first_visible_ms=None elapsed_ms=90\n"
        )
        handle.write("INFO unrelated run=abcdef12 elapsed_ms=1\n")
    by_run = driver.parse_server_turn_lines(driver.read_log_since(log, offset))
    assert by_run == {
        "abcdef12": {
            "first_visible_ms": 640.0,
            "first_answer_token_ms": 910.0,
            "elapsed_ms": 2210.0,
            "head": 1.0,
        },
        "deadbeef": {
            "first_visible_ms": None,
            "first_answer_token_ms": None,
            "elapsed_ms": 90.0,
            "head": 0.0,
        },
    }
    samples = [
        driver.TurnSample("p", "general", 0, "abcdef12", "finished"),
        driver.TurnSample("q", "general", 0, "00000000", "finished"),
    ]
    assert driver.attach_server_timings(samples, by_run) == 1
    assert samples[0].server_first_visible_ms == 640.0
    assert samples[0].server_first_answer_token_ms == 910.0
    assert samples[0].server_elapsed_ms == 2210.0
    assert samples[1].server_elapsed_ms is None


# --------------------------------------------------------------------------
# bounds
# --------------------------------------------------------------------------


def test_bounds_pass_within_tolerance():
    before = _report(1000.0, 4000.0)
    after = _report(1400.0, 4900.0)  # +500 ms slack wins for first visible, total within 25%
    assert driver.evaluate_bounds(after, before) == []
    assert driver.evaluate_bounds(_report(1200.0, 4000.0), None) == []


def test_bounds_breach_relative_and_ceiling_and_outcome():
    before = _report(1000.0, 4000.0)
    slow_first = driver.evaluate_bounds(_report(1600.0, 4000.0), before)
    assert any("first_visible p95" in b for b in slow_first)
    slow_total = driver.evaluate_bounds(_report(1000.0, 5100.0), before)
    assert any("total p95" in b for b in slow_total)
    ceiling = driver.evaluate_bounds(_report(8001.0, 30001.0), None)
    assert any("ceiling" in b for b in ceiling) and len(ceiling) == 2
    unfinished = driver.evaluate_bounds(_report(100.0, 200.0, outcome="timeout"), None)
    assert any("did not finish" in b for b in unfinished)
    assert driver.evaluate_bounds({"samples": []}, None) == ["no samples were recorded"]


def test_bounds_exit_codes_through_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys):
    _install_fakes(monkeypatch, first_visible_s=0.5, total_s=1.0)
    baseline_ok = tmp_path / "before_ok.json"
    baseline_ok.write_text(json.dumps(_report(500.0, 1000.0)), encoding="utf-8")
    baseline_tight = tmp_path / "before_tight.json"
    baseline_tight.write_text(json.dumps(_report(10.0, 100.0)), encoding="utf-8")
    common = [
        "--reps",
        "1",
        "--gap-seconds",
        "0",
        "--artifact-dir",
        str(tmp_path),
        "--prompt",
        "general_help",
    ]

    assert driver.main([*common, "--label", "ok", "--baseline", str(baseline_ok)]) == 0
    assert driver.main([*common, "--label", "regressed", "--baseline", str(baseline_tight)]) == 1
    out = capsys.readouterr().out
    assert "BREACH" in out
    report = json.loads((tmp_path / "agent_chat_latency_ok.json").read_text(encoding="utf-8"))
    assert report["sample_count"] == 1
    assert report["samples"][0]["outcome"] == "finished"
    assert report["summary"]["client"]["first_visible"]["p95"] == pytest.approx(500.0, abs=0.2)


# --------------------------------------------------------------------------
# secrets never printed
# --------------------------------------------------------------------------

FAKE_SECRETS = {
    "REVIEWER_UID": "uid-SECRET-9f3a7c",
    "REVIEWER_VAULT_PASSPHRASE": "passphrase-SECRET-b2e1",
    "FIREBASE_ADMIN_CREDENTIALS_JSON": json.dumps(
        {
            "client_email": "svc-SECRET@example.invalid",
            "private_key": "-----BEGIN PRIVATE KEY-----\nkey-SECRET-material\n-----END PRIVATE KEY-----\n",
            "private_key_id": "pkid-SECRET-77",
        }
    ),
    "NEXT_PUBLIC_FIREBASE_API_KEY": "apikey-SECRET-4d1",
}
FAKE_ID_TOKEN = "idtoken-SECRET-aa11"
FAKE_VAULT_TOKEN = "vaultowner-SECRET-bb22"  # noqa: S105


def _install_fakes(
    monkeypatch: pytest.MonkeyPatch, *, first_visible_s: float, total_s: float
) -> None:
    for key, value in FAKE_SECRETS.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(driver, "DEFAULT_PROTOCOL_ENV", "/nonexistent/.env")
    monkeypatch.setattr(driver, "DEFAULT_WEB_ENV", "/nonexistent/.env.local")

    def fake_authenticate(base_url, *, config, timeout=45, session=None):
        return reviewer_session.ReviewerSession(
            user_id=config.user_id,
            firebase_id_token=FAKE_ID_TOKEN,
            vault_owner_token=FAKE_VAULT_TOKEN,
            passphrase=config.passphrase,
        )

    monkeypatch.setattr(driver, "authenticate_reviewer", fake_authenticate)
    clock = FakeClock()

    def fake_opener(base_url, session, *, http, turn_timeout_seconds):
        assert session.vault_owner_token == FAKE_VAULT_TOKEN
        return lambda _body: _finished_stream(
            clock, first_visible_s=first_visible_s, total_s=total_s
        )

    monkeypatch.setattr(driver, "make_http_stream_opener", fake_opener)
    monkeypatch.setattr(driver.time, "perf_counter", clock)
    monkeypatch.setattr(driver.time, "sleep", lambda _s: None)


def test_no_secret_value_appears_in_printed_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    _install_fakes(monkeypatch, first_visible_s=0.4, total_s=0.9)
    rc = driver.main(
        ["--reps", "1", "--gap-seconds", "0", "--artifact-dir", str(tmp_path), "--label", "scrub"]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert out.strip()
    leak_values = [
        *FAKE_SECRETS.values(),
        FAKE_ID_TOKEN,
        FAKE_VAULT_TOKEN,
        "svc-SECRET@example.invalid",
        "key-SECRET-material",
        "pkid-SECRET-77",
    ]
    for value in leak_values:
        assert value not in out
    assert "SECRET" not in out
    for case in driver.PROMPTS:
        assert case.prompt_id in out
        assert case.text.split("{")[0].strip() not in out  # no prompt text, only ids
    report_text = (tmp_path / "agent_chat_latency_scrub.json").read_text(encoding="utf-8")
    assert "SECRET" not in report_text


def test_printer_scrubs_known_values():
    emit = driver.Printer(["abcd1234"])
    emit.add("zzzz9999")
    assert emit.scrub("token abcd1234 and zzzz9999 here") == "token [redacted] and [redacted] here"


def test_reviewer_config_reads_environment_and_names_missing_keys(monkeypatch: pytest.MonkeyPatch):
    for key in FAKE_SECRETS:
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError) as excinfo:
        reviewer_session.load_reviewer_config(
            protocol_env="/nonexistent/.env", web_env="/nonexistent/.env"
        )
    assert "REVIEWER_UID" in str(excinfo.value)
    for key, value in FAKE_SECRETS.items():
        monkeypatch.setenv(key, value)
    config = reviewer_session.load_reviewer_config(
        protocol_env="/nonexistent/.env", web_env="/nonexistent/.env"
    )
    assert config.user_id == FAKE_SECRETS["REVIEWER_UID"]
    assert config.firebase_service_account["private_key_id"] == "pkid-SECRET-77"
    assert set(driver.secret_values_of(config)) >= {
        config.user_id,
        config.passphrase,
        config.firebase_api_key,
    }


def test_intro_head_turns_are_refused_not_graded(tmp_path: Path):
    from hushh_mcp.one_adk.agui_turn_timing import HEAD_INTRO, HEAD_ONE

    assert driver.ONE_HEAD_LABEL == HEAD_ONE
    log = tmp_path / "backend.log"
    log.write_text(
        f"INFO one_agent_chat_turn_complete head={HEAD_ONE} run=aaaaaaaa first_visible_ms=1 elapsed_ms=2\n"
        f"INFO one_agent_chat_turn_complete head={HEAD_INTRO} run=bbbbbbbb first_visible_ms=1 elapsed_ms=2\n",
        encoding="utf-8",
    )
    by_run = driver.parse_server_turn_lines(driver.read_log_since(log, 0))
    samples = [
        driver.TurnSample(
            prompt_id="p", category="general", rep=1, run="aaaaaaaa", outcome="finished"
        ),
        driver.TurnSample(
            prompt_id="p", category="general", rep=2, run="bbbbbbbb", outcome="finished"
        ),
    ]
    assert driver.intro_head_runs(samples, by_run) == ["bbbbbbbb"]


def test_settled_read_waits_briefly_for_the_last_line(tmp_path: Path, monkeypatch):
    log = tmp_path / "backend.log"
    log.write_text(
        "INFO one_agent_chat_turn_complete head=one run=aaaaaaaa first_visible_ms=1 elapsed_ms=2\n",
        encoding="utf-8",
    )
    reads = {"n": 0}
    original = driver.read_log_since

    def _late(path, offset):
        reads["n"] += 1
        if reads["n"] == 2:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(
                    "INFO one_agent_chat_turn_complete head=one run=bbbbbbbb first_visible_ms=1 elapsed_ms=2\n"
                )
        return original(path, offset)

    monkeypatch.setattr(driver, "read_log_since", _late)
    lines = driver.read_log_since_settled(log, 0, expected_runs=2, wait_seconds=1.0)
    assert sum(driver.SERVER_LOG_MARK in line for line in lines) == 2
