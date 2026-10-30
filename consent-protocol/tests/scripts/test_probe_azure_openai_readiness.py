"""The real SDK sends one synthetic request; no metadata or Azure is contacted."""

import asyncio
import json
import os
import subprocess
import sys
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from openai import AsyncOpenAI

from scripts import probe_azure_openai_readiness as probe

NONCE = "a" * 32
TOKEN = "SYNTHETIC_TOKEN_PRIVATE"
PRIVATE = "PRIVATE_PROVIDER_OR_RESPONSE_TEXT"
POLICY = {
    "provider": "azure_openai_web_search",
    "azure": {
        "tenant_id": "synthetic-tenant",
        "client_id": "synthetic-client",
        "primary_endpoint": "https://synthetic.openai.azure.com/openai/v1/",
        "primary_deployment": "synthetic-deployment",
    },
}


def test_import_and_credential_leaf_need_no_application_secrets_or_app_tree():
    script = Path(probe.__file__).resolve()
    code = f"""
import importlib.abc
import importlib.util
import os
import sys

class RejectApplicationImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'hushh_mcp.config' or fullname.startswith('hushh_mcp.one_adk'):
            raise AssertionError('probe imported the eager application tree')

sys.meta_path.insert(0, RejectApplicationImports())
spec = importlib.util.spec_from_file_location('synthetic_readiness_probe', {str(script)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
supplier = module.azure_openai_token_provider(
    tenant_id='00000000-0000-4000-8000-000000000000',
    client_id='00000000-0000-4000-8000-000000000001',
)
assert callable(supplier)
assert module.main([]) == 2
assert not any(key in os.environ for key in (
    'APP_SIGNING_KEY', 'VAULT_DATA_KEY', 'DATABASE_URL', 'DB_CONNECTION_STRING'
))
"""
    result = subprocess.run(  # noqa: S603 - fixed synthetic import; supplier is never invoked
        [sys.executable, "-c", code],
        cwd=script.parent.parent,
        env={"ENVIRONMENT": "uat", "PYTHON_DOTENV_DISABLED": "1", "PATH": os.defpath},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "not_run"


def response(**changes):
    return {
        "id": "synthetic-response",
        "object": "response",
        "created_at": 0,
        "model": "synthetic-deployment",
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "output": [
            {
                "id": "synthetic-message",
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": json.dumps({"nonce": NONCE}), "annotations": []}
                ],
            }
        ],
        **changes,
    }


def wire(monkeypatch, handler, *, timeout_seconds=30.0):
    requests, clients = [], []
    loader = Mock(return_value=deepcopy(POLICY))
    identity = Mock(return_value=lambda: TOKEN)
    monkeypatch.setattr(probe, "load_pwm_policy", loader)
    monkeypatch.setattr(probe, "azure_openai_token_provider", identity)
    monkeypatch.setattr(probe.secrets, "token_hex", lambda size: NONCE)

    async def observe(request):
        requests.append(request)
        return await handler(request)

    def client(**kwargs):
        assert kwargs == {
            "api_key": TOKEN,
            "base_url": POLICY["azure"]["primary_endpoint"],
            "timeout": timeout_seconds,
            "max_retries": 0,
        }
        instance = AsyncOpenAI(
            **kwargs,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(observe), trust_env=False),
        )
        clients.append(instance)
        return instance

    monkeypatch.setattr(probe, "AsyncOpenAI", client)
    return requests, clients, loader, identity


async def test_one_real_sdk_request_requires_exact_nonce_and_never_reports_it(monkeypatch):
    async def handler(request):
        assert request.url == "https://synthetic.openai.azure.com/openai/v1/responses"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        payload = json.loads(request.content)
        assert set(payload) == {
            "model",
            "instructions",
            "input",
            "max_output_tokens",
            "store",
            "reasoning",
            "text",
        }
        assert payload["model"] == "synthetic-deployment" and payload["store"] is False
        assert payload["max_output_tokens"] == 256 and payload["reasoning"] == {"effort": "low"}
        assert json.loads(payload["input"]) == {"nonce": NONCE}
        output = payload["text"]["format"]
        assert output["strict"] is True
        assert output["schema"] == {
            "type": "object",
            "properties": {"nonce": {"type": "string", "enum": [NONCE]}},
            "required": ["nonce"],
            "additionalProperties": False,
        }
        return httpx.Response(200, json=response())

    requests, clients, loader, identity = wire(monkeypatch, handler)
    result = await probe.run_probe()
    assert result == {
        "status": "ready",
        "http_status": 200,
        "latency_ms": result["latency_ms"],
        "deployment": "synthetic-deployment",
        "error_class": None,
        "stage": "response_validation",
        "classification": "dependency_ok",
        "phase_ms": result["phase_ms"],
        "deadline_expired": False,
    }
    assert len(requests) == 1 and clients[0].is_closed()
    loader.assert_called_once_with()
    identity.assert_called_once_with(tenant_id="synthetic-tenant", client_id="synthetic-client")
    assert TOKEN not in json.dumps(result) and NONCE not in json.dumps(result)


@pytest.mark.parametrize(
    "defect", ["wrong_nonce", "extra_key", "incomplete", "refusal", "http_201"]
)
async def test_http_success_or_parseable_text_alone_never_proves_readiness(monkeypatch, defect):
    async def handler(request):
        result = response()
        if defect == "wrong_nonce":
            result["output"][0]["content"][0]["text"] = json.dumps({"nonce": PRIVATE})
        elif defect == "extra_key":
            result["output"][0]["content"][0]["text"] = json.dumps(
                {"nonce": NONCE, "extra": PRIVATE}
            )
        elif defect == "incomplete":
            result.update(status="incomplete", incomplete_details={"reason": "max_output_tokens"})
        elif defect == "refusal":
            result["output"][0]["content"].append({"type": "refusal", "refusal": PRIVATE})
        return httpx.Response(201 if defect == "http_201" else 200, json=result)

    requests, clients, *_ = wire(monkeypatch, handler)
    result = await probe.run_probe()
    assert result["status"] == "unavailable" and result["error_class"] == "ReadinessResponseError"
    assert result["http_status"] == (201 if defect == "http_201" else 200)
    assert result["stage"] == "response_validation"
    assert result["classification"] == "candidate_misconfigured"
    assert len(requests) == 1 and clients[0].is_closed()
    assert PRIVATE not in json.dumps(result) and NONCE not in json.dumps(result)


@pytest.mark.parametrize("status", [401, 429, 503])
async def test_provider_rejection_is_never_retried_or_echoed(monkeypatch, status):
    async def handler(request):
        return httpx.Response(status, json={"error": {"message": PRIVATE, "type": "synthetic"}})

    requests, clients, *_ = wire(monkeypatch, handler)
    result = await probe.run_probe()
    assert result["status"] == "unavailable" and result["http_status"] == status
    assert result["error_class"] in {"AuthenticationError", "RateLimitError", "InternalServerError"}
    assert result["stage"] == "primary_http"
    assert result["classification"] == (
        "candidate_misconfigured" if status == 401 else "provider_unavailable"
    )
    assert len(requests) == 1 and clients[0].is_closed()
    assert PRIVATE not in json.dumps(result) and TOKEN not in json.dumps(result)


async def test_total_deadline_cancels_request_and_closes_the_sdk_client(monkeypatch):
    cancelled = asyncio.Event()

    async def handler(request):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    requests, clients, *_ = wire(monkeypatch, handler, timeout_seconds=0.02)
    result = await probe.run_probe(timeout_seconds=0.02)
    assert result["status"] == "unavailable" and result["error_class"] == "TimeoutError"
    assert result["stage"] == "primary_http" and result["classification"] == "provider_unavailable"
    assert 0 < result["latency_ms"] < 1000
    assert cancelled.is_set() and len(requests) == 1 and clients[0].is_closed()
    assert result["deadline_expired"] is True and result["phase_ms"]["primary_http"] > 0


@pytest.mark.parametrize("timeout", [0, 31, True, float("nan"), float("inf")])
async def test_bad_budget_never_resolves_identity_or_builds_a_client(monkeypatch, timeout):
    forbidden = Mock(side_effect=AssertionError("must not perform I/O"))
    monkeypatch.setattr(probe, "load_pwm_policy", forbidden)
    result = await probe.run_probe(timeout_seconds=timeout)
    assert result["error_class"] == "ValueError" and result["status"] == "unavailable"
    forbidden.assert_not_called()


async def test_non_azure_profile_never_resolves_identity(monkeypatch):
    monkeypatch.setattr(probe, "load_pwm_policy", lambda: {"provider": "vertex_google_search"})
    forbidden = Mock(side_effect=AssertionError("must not resolve identity"))
    monkeypatch.setattr(probe, "azure_openai_token_provider", forbidden)
    result = await probe.run_probe()
    assert result["error_class"] == "ReadinessConfigurationError"
    forbidden.assert_not_called()


async def test_workload_identity_failure_never_dispatches_or_exposes_its_message(monkeypatch):
    monkeypatch.setattr(probe, "load_pwm_policy", lambda: deepcopy(POLICY))

    def supplier():
        raise RuntimeError(PRIVATE + TOKEN)

    monkeypatch.setattr(probe, "azure_openai_token_provider", lambda **kwargs: supplier)
    forbidden = Mock(side_effect=AssertionError("must not build a model client"))
    monkeypatch.setattr(probe, "AsyncOpenAI", forbidden)
    result = await probe.run_probe()
    assert result["status"] == "unavailable" and result["error_class"] == "RuntimeError"
    assert result["http_status"] is None
    assert result["stage"] == "federation" and result["classification"] == "candidate_misconfigured"
    assert PRIVATE not in json.dumps(result) and TOKEN not in json.dumps(result)
    forbidden.assert_not_called()


async def test_connection_failure_keeps_transport_classification_without_retry(monkeypatch):
    async def handler(request):
        raise httpx.ConnectError(PRIVATE + TOKEN)

    requests, clients, *_ = wire(monkeypatch, handler)
    result = await probe.run_probe()
    assert result["error_class"] == "APIConnectionError"
    assert result["stage"] == "primary_http" and result["classification"] == "provider_unavailable"
    assert len(requests) == 1 and clients[0].is_closed()
    assert PRIVATE not in json.dumps(result) and TOKEN not in json.dumps(result)


def test_cli_requires_opt_in_and_suppresses_sdk_chatter(monkeypatch, capsys):
    async def forbidden(**kwargs):
        raise AssertionError("default CLI must not contact a provider")

    monkeypatch.setattr(probe, "run_probe", forbidden)
    assert probe.main([]) == 2
    assert json.loads(capsys.readouterr().out)["status"] == "not_run"

    async def succeed(**kwargs):
        print(TOKEN)
        print(PRIVATE, file=probe.sys.stderr)
        return {
            "status": "ready",
            "http_status": 200,
            "latency_ms": 1,
            "deployment": "synthetic-deployment",
            "error_class": None,
        }

    monkeypatch.setattr(probe, "run_probe", succeed)
    assert probe.main(["--live"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out)["status"] == "ready" and captured.err == ""
    assert TOKEN not in captured.out and PRIVATE not in captured.out


@pytest.mark.parametrize(
    ("capability", "error", "expected"),
    [
        (
            "live_audio",
            RuntimeError("Azure Live is not the selected managed processor"),
            "live.binding_unavailable",
        ),
        (
            "one_text_root",
            ValueError("Root qualification did not select its exact admitted model"),
            "root.model_contract",
        ),
        (
            "one_text_root",
            ValueError("Root qualification omitted the production tool roster"),
            "root.tool_roster",
        ),
        (
            "one_text_root",
            ValueError("Root full-roster function selection failed"),
            "root.clock_selection",
        ),
        (
            "one_text_root",
            ValueError("Root structured, media or streaming round trip failed"),
            "root.roundtrip_failed",
        ),
    ],
)
def test_capability_failure_reason_matches_exact_authored_literals(capability, error, expected):
    from scripts.capability_probe_failure import FAILURE_REASONS, failure_reason

    assert failure_reason(capability, error) == expected
    assert expected in FAILURE_REASONS


def test_capability_failure_reason_never_reads_or_returns_private_errors():
    from scripts.capability_probe_failure import failure_reason

    class SdkRuntimeError(RuntimeError):
        pass

    class OpaqueError(Exception):
        def __str__(self):
            raise AssertionError("failure reasons must never stringify an exception")

        @property
        def args(self):
            raise AssertionError("unknown exception attributes must not be read")

    for error in (
        RuntimeError(PRIVATE + TOKEN),
        RuntimeError({"private": TOKEN}),
        RuntimeError("Azure Live transcription failed", TOKEN),
        ValueError("Azure Live transcription failed"),
        SdkRuntimeError("Azure Live transcription failed"),
        OpaqueError(),
    ):
        assert failure_reason("live_audio", error) == "unlisted"
    assert (
        failure_reason("embeddings", RuntimeError("Azure Live transcription failed")) == "unlisted"
    )


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("conversation.item.input_audio_transcription.failed", "live.transcription_failed"),
        ("response.done", "live.response_incomplete"),
        ("error", "live.provider_operation_failed"),
    ],
)
async def test_actual_live_adapter_failures_keep_closed_reason(kind, reason):
    from types import SimpleNamespace

    from scripts.capability_probe_failure import failure_reason
    from tests.one_voice.test_factory_live_client import _azure_event, _azure_session

    session, _ = _azure_session(
        [_azure_event(kind, response=SimpleNamespace(id="synthetic-response", status="failed"))]
    )
    with pytest.raises(RuntimeError) as captured:
        _ = [event async for event in session.events()]
    assert failure_reason("live_audio", captured.value) == reason


@pytest.mark.parametrize("completed", [True, False])
async def test_recording_cleanup_retrieves_failure_and_preserves_primary_error(completed):
    import gc

    from scripts.capability_probe_failure import settle_recording

    loop = asyncio.get_running_loop()
    orphaned = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: orphaned.append(context["message"]))
    settled = asyncio.Event()

    async def recording():
        if completed:
            raise RuntimeError(PRIVATE)
        try:
            await asyncio.Event().wait()
        finally:
            settled.set()

    try:
        producer = asyncio.create_task(recording())
        await asyncio.sleep(0)
        assert producer.done() is completed
        primary = ValueError("existing probe failure")
        with pytest.raises(ValueError) as captured:
            try:
                raise primary
            finally:
                await settle_recording(producer)
        assert captured.value is primary
        assert producer.done()
        if not completed:
            assert producer.cancelled() and settled.is_set()
        del producer
        gc.collect()
        await asyncio.sleep(0)
        assert orphaned == []
    finally:
        loop.set_exception_handler(previous)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("phase_ms", {**dict.fromkeys(probe.TIMING_PHASES, 0), "PRIVATE_PROVIDER_BODY": 1}),
        ("phase_ms", dict.fromkeys(probe.TIMING_PHASES, True)),
        ("phase_ms", dict.fromkeys(probe.TIMING_PHASES, -1)),
        ("deadline_expired", "PRIVATE_PROVIDER_BODY"),
    ],
)
def test_readiness_timings_reject_private_or_invalid_fields(field, value):
    from tests.scripts.test_managed_provider_receipt import _managed_provider_gate

    attempt = {
        "ok": False,
        "classification": "provider_unavailable",
        "elapsed_ms": 30,
        field: value,
    }
    with pytest.raises(ValueError):
        _managed_provider_gate()._capability_proof().sanitize_probe_history(
            [{"probe": "primary_http", "attempts": [attempt]}], provider="azure_openai"
        )
