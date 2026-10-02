"""Only the pod can say whether its own identity reaches the person's Azure deployment.

The hub holds no data-plane role in the person's subscription by design, so the
receipt "this agent can use its model" has to be produced by one minimal request made
as the pod's own identity. The answer is a named outcome, never a raised error, and
the request only ever goes to the rendered resource.
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.runtime_providers import azure_openai
from hushh_mcp.runtime_providers.azure_openai import AzureOpenAITopology

# A fake bearer for scripted HTTP; nothing here talks to a real API.
_TOKEN = "t"  # noqa: S105
HOST = "hussh-agent-test.openai.azure.com"
TOPOLOGY = AzureOpenAITopology(endpoint=f"https://{HOST}/", deployment="gpt-5-mini")

# The production entrypoint sets pod mode on import. Collection must not switch
# unrelated shared-runtime tests into the private authority lane.
with pytest.MonkeyPatch.context() as _pod_import_env:
    _pod_import_env.setenv("HUSSH_POD_MODE", "1")
    import pod_server


class _Resp:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> Any:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _Http:
    def __init__(self, resp: Any) -> None:
        self.resp = resp
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, **kw: Any) -> Any:
        self.calls.append({"url": url, **kw})
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


def _probe(resp: Any, deployment: str = "gpt-5-mini") -> tuple[dict, _Http]:
    http = _Http(resp)
    out = azure_openai.probe_azure_openai_deployment(
        deployment, topology=TOPOLOGY, session=http, token=_TOKEN
    )
    return out, http


def _error(code: str, message: str = "") -> dict:
    return {"error": {"code": code, "message": message}}


@pytest.mark.parametrize(
    ("status", "body", "outcome"),
    [
        (200, {"choices": []}, "reachable"),
        (404, _error("DeploymentNotFound", "The API deployment does not exist"), "not_deployed"),
        (403, _error("PermissionDenied"), "role_missing"),
        (401, _error("PermissionDenied", "lacks the required data action"), "role_missing"),
        (401, _error("401", "audience is incorrect"), "identity_rejected"),
        (429, _error("429", "Rate limit"), "quota_exhausted"),
        (400, _error("unsupported_parameter"), "request_refused"),
        (500, ValueError("not json"), "unavailable"),
    ],
)
def test_each_answer_is_a_named_outcome_and_only_a_200_is_reachable(status, body, outcome) -> None:
    out, _ = _probe(_Resp(status, body))
    assert out["status"] == status
    assert out["outcome"] == outcome
    assert out["reachable"] is (status == 200)
    assert out["provider"] == "azure_openai" and out["endpoint"] == HOST


def test_the_probe_is_one_bounded_request_as_the_pod_to_the_rendered_resource() -> None:
    _, http = _probe(_Resp(200, {"choices": []}))
    call = http.calls[0]
    assert call["url"] == f"https://{HOST}/openai/v1/chat/completions"
    assert call["headers"] == {"Authorization": f"Bearer {_TOKEN}"}
    assert call["json"]["model"] == "gpt-5-mini"
    assert call["json"]["max_completion_tokens"] <= 16
    assert call["timeout"] == 20


def test_a_network_failure_is_reported_not_raised() -> None:
    out, _ = _probe(ConnectionError("reset"))
    assert out["reachable"] is None and out["outcome"] == "unavailable"
    assert out["detail"] == "ConnectionError"


def test_no_token_means_no_request(monkeypatch) -> None:
    def _no_identity() -> str:
        raise azure_openai.AzureOpenAICredentialUnavailable("no identity")

    monkeypatch.setattr(azure_openai, "workload_token_provider", lambda: _no_identity)
    http = _Http(_Resp(200, {}))
    out = azure_openai.probe_azure_openai_deployment("gpt-5-mini", topology=TOPOLOGY, session=http)
    assert out["outcome"] == "identity_unavailable" and out["reachable"] is None
    assert http.calls == []


def test_a_half_rendered_topology_is_reported_without_a_request(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", f"https://{HOST}/")
    monkeypatch.delenv("AZURE_OPENAI_DEPLOYMENT", raising=False)
    http = _Http(_Resp(200, {}))
    out = azure_openai.probe_azure_openai_deployment("gpt-5-mini", session=http, token=_TOKEN)
    assert out["outcome"] == "topology_invalid" and out["reachable"] is None
    assert http.calls == []


async def test_an_azure_pod_answers_with_the_azure_probe(monkeypatch) -> None:
    monkeypatch.setattr(pod_server, "pod_mode", lambda: True)
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", f"https://{HOST}/")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")
    asked: list[str] = []

    def _azure(deployment: str) -> dict:
        asked.append(deployment)
        return {"outcome": "reachable"}

    def _vertex(*_a: Any, **_k: Any) -> dict:
        raise AssertionError("an Azure pod asked Vertex")

    monkeypatch.setattr(azure_openai, "probe_azure_openai_deployment", _azure)
    monkeypatch.setattr(pod_server, "probe_model_reachability", _vertex)

    assert await pod_server.pod_model_diagnostic(model="gpt-5-mini") == {"outcome": "reachable"}
    assert asked == ["gpt-5-mini"]


async def test_a_gcp_pod_still_answers_with_vertex_negative_control(monkeypatch) -> None:
    monkeypatch.setattr(pod_server, "pod_mode", lambda: True)
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_DEPLOYMENT", raising=False)

    def _azure(*_a: Any, **_k: Any) -> dict:
        raise AssertionError("a GCP pod asked Azure")

    monkeypatch.setattr(azure_openai, "probe_azure_openai_deployment", _azure)
    monkeypatch.setattr(
        pod_server,
        "probe_model_reachability",
        lambda model, *, location="": {"model": model, "location": location},
    )

    out = await pod_server.pod_model_diagnostic(model="gemini-3.7-flash", location="global")
    assert out == {"model": "gemini-3.7-flash", "location": "global"}
