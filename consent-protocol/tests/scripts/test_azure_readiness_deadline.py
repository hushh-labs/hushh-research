"""Shared Azure qualification cannot outlive its deadline or report cleanup failure as ready."""

import asyncio
import json
import threading
from copy import deepcopy
from unittest.mock import Mock

import httpx
import pytest

from scripts import probe_azure_openai_readiness as probe
from tests.scripts.test_probe_azure_openai_readiness import POLICY, PRIVATE, TOKEN, response, wire

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


async def test_credential_construction_cannot_block_deadline_or_dispatch_late(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(probe, "load_pwm_policy", lambda: deepcopy(POLICY))

    def construct(**kwargs):
        entered.set()
        assert release.wait(2)
        return lambda: TOKEN

    monkeypatch.setattr(probe, "azure_openai_token_provider", construct)
    forbidden = Mock(side_effect=AssertionError("expired authentication must not dispatch"))
    monkeypatch.setattr(probe, "AsyncOpenAI", forbidden)
    try:
        result = await probe.run_probe(timeout_seconds=0.02)
        assert entered.is_set()
        assert result["deadline_expired"] is True
        assert result["error_class"] == "TimeoutError" and result["stage"] == "federation"
        assert 0 < result["phase_ms"]["credential_setup"] < 1000
        assert result["phase_ms"]["token_acquisition"] == result["phase_ms"]["primary_http"] == 0
    finally:
        release.set()
    await asyncio.sleep(0.01)
    forbidden.assert_not_called()


@pytest.mark.parametrize("cleanup", ["error", "timeout"])
async def test_valid_nonce_is_not_ready_when_client_cleanup_fails(monkeypatch, cleanup):
    async def handler(request):
        return httpx.Response(200, json=response())

    requests, clients, *_ = wire(monkeypatch, handler, timeout_seconds=1.0)
    create = probe.AsyncOpenAI

    def client(**kwargs):
        instance = create(**kwargs)
        close = instance.close

        async def fail_close():
            await close()
            if cleanup == "error":
                raise RuntimeError(PRIVATE)
            await asyncio.Event().wait()

        instance.close = fail_close
        return instance

    monkeypatch.setattr(probe, "AsyncOpenAI", client)
    result = await probe.run_probe(timeout_seconds=1.0)
    assert result["status"] == "unavailable" and result["http_status"] == 200
    assert result["error_class"] == ("TimeoutError" if cleanup == "timeout" else "RuntimeError")
    assert result["deadline_expired"] is (cleanup == "timeout")
    assert probe.readiness_event(result, "synthetic-deployment")["result"] == "failed"
    assert len(requests) == 1 and clients[0].is_closed()
    assert PRIVATE not in json.dumps(result)
