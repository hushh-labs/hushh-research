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
    assert cancelled.is_set() and len(requests) == 1 and clients[0].is_closed()


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
    assert PRIVATE not in json.dumps(result) and TOKEN not in json.dumps(result)
    forbidden.assert_not_called()


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
