# tests/agents/kai/providers/test_audit.py
"""Audit telemetry: hash-only invariant + latency capture."""

from __future__ import annotations

import asyncio
import hashlib

import pytest

from hushh_mcp.operons.kai.providers.audit import (
    AuditWriter,
    InferenceAuditRecord,
    TimedDispatch,
    sha256_hex,
)


def test_sha256_hex_matches_python_stdlib():
    text = "the user's portfolio holds AAPL and MSFT"
    assert sha256_hex(text) == hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_audit_record_metadata_contains_no_plaintext():
    """The cardinal BYOK invariant: nothing in `metadata` may be the prompt or output."""
    secret_prompt = "my SSN is 123-45-6789"  # noqa: S105 - test fixture, not a real secret
    secret_output = "Per the user's PKM holdings of $5M in AAPL..."  # noqa: S105 - test fixture
    with TimedDispatch(provider="gemini", scope="agent.kai.inference.cloud.gemini",
                       model="gemini-3", prompt=secret_prompt) as t:
        t.set_output(secret_output, outcome="ok")
    record = t.record
    md = record.to_metadata()
    serialized = repr(md)
    assert secret_prompt not in serialized
    assert secret_output not in serialized
    assert "123-45-6789" not in serialized
    # but hashes ARE present
    assert record.prompt_hash == sha256_hex(secret_prompt)
    assert record.output_hash == sha256_hex(secret_output)


def test_timed_dispatch_captures_positive_latency():
    with TimedDispatch(provider="x", scope="s", model="m", prompt="p") as t:
        # synchronous sleep is fine -- we're testing wall clock
        import time

        time.sleep(0.005)
        t.set_output("o", outcome="ok")
    assert t.record.latency_ms >= 4  # ~5ms with slack
    assert t.record.outcome == "ok"


def test_timed_dispatch_records_error_class_on_exception():
    with pytest.raises(RuntimeError):
        with TimedDispatch(provider="x", scope="s", model="m", prompt="p") as t:
            raise RuntimeError("boom")
    assert t.record.outcome == "error"
    assert t.record.error_class == "RuntimeError"


def test_timed_dispatch_default_outcome_is_error_until_set():
    with TimedDispatch(provider="x", scope="s", model="m", prompt="p") as t:
        pass
    assert t.record.outcome == "error"


def test_audit_writer_default_appends_records():
    writer = AuditWriter()
    record = InferenceAuditRecord(
        kind="kai_inference",
        provider="gemini",
        scope_used="agent.kai.inference.cloud.gemini",
        model="gemini-3",
        prompt_hash="a" * 64,
        prompt_chars=100,
        output_hash="b" * 64,
        output_chars=200,
        latency_ms=42,
        outcome="ok",
        error_class=None,
    )

    asyncio.get_event_loop().run_until_complete(
        writer.write(token_id="tok_1", user_id="u_1", agent_id="agent_kai", record=record)  # noqa: S106 - test fixture
    )
    assert len(writer.records) == 1
    captured_token, captured_record = writer.records[0]
    assert captured_token == "tok_1"  # noqa: S105 - test fixture
    assert captured_record == record


def test_audit_record_zero_chars_when_empty_prompt_or_output():
    with TimedDispatch(provider="x", scope="s", model="m", prompt="") as t:
        t.set_output("", outcome="ok")
    assert t.record.prompt_chars == 0
    assert t.record.output_chars == 0
    assert t.record.prompt_hash == ""  # empty prompt -> empty hash sentinel
    assert t.record.output_hash is None  # empty output -> None
