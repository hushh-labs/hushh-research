"""Only the pod can say whether the person's project reaches a model; the owner may ask it.

Verified live 2026-09-03: the bootstrap account is denied `aiplatform.endpoints.predict`
and the hub cannot mint as the pod, so the receipt Pillar 6 needs ("the live model is
reachable from the person's own project") must be produced by the pod's own identity.
"""

from __future__ import annotations

import pytest

import pod_server
from api.routes.one import pod_relay

# A fake bearer for scripted HTTP; nothing here talks to a real API.
_TOKEN = "t"  # noqa: S105


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Http:
    def __init__(self, resp):
        self.resp = resp
        self.urls: list[str] = []

    def post(self, url, **kw):
        self.urls.append(url)
        return self.resp


def test_a_reachable_model_and_a_bidi_only_live_model_both_count_as_reachable(monkeypatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hussh-one-test")
    ok = pod_server.probe_model_reachability(
        "gemini-3.7-flash",
        location="global",
        session=_Http(_Resp(200, {"totalTokens": 1})),
        token=_TOKEN,
    )
    assert ok["reachable"] is True and ok["status"] == 200
    live = pod_server.probe_model_reachability(
        "gemini-live-2.5-flash-native-audio",
        location="us-central1",
        session=_Http(
            _Resp(400, {"error": {"message": "countTokens is not supported for this model"}})
        ),
        token=_TOKEN,
    )
    assert live["reachable"] is True, "a typed 'not supported' proves the model exists"


def test_a_missing_model_or_missing_role_is_reported_not_raised(monkeypatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hussh-one-test")
    http = _Http(_Resp(404, {"error": {"message": "Publisher Model not found"}}))
    out = pod_server.probe_model_reachability(
        "gemini-nope", location="us-central1", session=http, token=_TOKEN
    )
    assert out["reachable"] is False and out["status"] == 404
    assert http.urls[0].startswith(
        "https://us-central1-aiplatform.googleapis.com/v1/projects/hussh-one-test/locations/us-central1/publishers/google/models/gemini-nope:countTokens"
    )
    denied = pod_server.probe_model_reachability(
        "gemini-3.7-flash",
        session=_Http(_Resp(403, {"error": {"message": "Permission denied"}})),
        token=_TOKEN,
    )
    assert denied["reachable"] is False and denied["status"] == 403


def test_the_probe_answers_the_global_host_for_global(monkeypatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "p")
    http = _Http(_Resp(200, {"totalTokens": 1}))
    pod_server.probe_model_reachability("m", location="global", session=http, token=_TOKEN)
    assert http.urls[0].startswith(
        "https://aiplatform.googleapis.com/v1/projects/p/locations/global/"
    )


def test_model_names_are_validated_before_they_reach_a_url() -> None:
    assert pod_server._model_name_ok("gemini-live-2.5-flash-native-audio")
    assert not pod_server._model_name_ok("../x")
    assert not pod_server._model_name_ok("a b")
    assert not pod_server._model_name_ok("")


class _Auditor:
    def __init__(self, deny=False):
        self.deny = deny
        self.calls: list[dict] = []

    async def authorize_owner_read(self, **kw):
        self.calls.append(kw)
        if self.deny:
            raise pod_relay.PodAccessDenied("not yours")


class _Registry:
    def __init__(self, row):
        self.row = row

    async def get(self, user_id):
        return self.row


@pytest.mark.asyncio
async def test_the_relay_uses_the_same_owner_door_and_forwards_the_query(monkeypatch) -> None:
    monkeypatch.setattr(pod_relay, "_require_enabled", lambda: None)
    monkeypatch.setattr(pod_relay, "_pod_url", lambda row: "https://pod.example")
    seen: dict = {}

    async def _proxy(url, path, *, session=None):
        seen["url"], seen["path"] = url, path
        return 200, {"reachable": True}

    monkeypatch.setattr(pod_relay, "_proxy_get", _proxy)
    auditor = _Auditor()
    out = await pod_relay.relay_pod_model_diagnostic(
        hushh_id="ha1_x",
        user_id="uid",
        model="gemini-live-2.5-flash-native-audio",
        location="us-central1",
        registry=_Registry({"external_agent_id": "one-pod-x"}),
        audit=auditor,
    )
    assert out["diagnostic"] == {"reachable": True}
    assert (
        seen["path"]
        == "/pod/diagnostics/model?model=gemini-live-2.5-flash-native-audio&location=us-central1"
    )
    assert auditor.calls[0]["hushh_id"] == "ha1_x"
    assert auditor.calls[0]["request_id"] == "relay-diag-model:ha1_x"


@pytest.mark.asyncio
async def test_a_stranger_gets_the_same_403_as_for_info(monkeypatch) -> None:
    from fastapi import HTTPException

    monkeypatch.setattr(pod_relay, "_require_enabled", lambda: None)
    with pytest.raises(HTTPException) as exc:
        await pod_relay.relay_pod_model_diagnostic(
            hushh_id="ha1_x",
            user_id="stranger",
            model="m",
            registry=_Registry(None),
            audit=_Auditor(deny=True),
        )
    assert exc.value.status_code == 403
