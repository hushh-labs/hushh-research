from __future__ import annotations

import pytest

from hushh_mcp.services.pod_upgrade_handoff import (
    PodUpgradeHandoffClient,
    PodUpgradeHandoffUnavailable,
    service_incarnation,
)


def test_service_incarnation_uses_ready_revision_then_traffic() -> None:
    assert service_incarnation({"status": {"latestReadyRevisionName": "rev-a"}}) == "rev-a"
    assert service_incarnation({"status": {"traffic": [{"revisionName": "rev-b"}]}}) == "rev-b"
    assert service_incarnation({"status": {}}) is None


@pytest.mark.parametrize("method", ["POST", "GET"])
def test_handoff_rejects_non_success_responses(monkeypatch, method: str) -> None:
    class Response:
        status_code = 401

        def json(self):
            return {"detail": "denied"}

    class Session:
        def post(self, *_args, **_kwargs):
            return Response()

        def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(
        "google.oauth2.id_token.fetch_id_token", lambda *_args, **_kwargs: "identity"
    )
    client = PodUpgradeHandoffClient(
        url="https://pod.example", hushh_id="ha1-test", session=Session()
    )
    with pytest.raises(PodUpgradeHandoffUnavailable, match="HTTP 401"):
        client._request(method, "/api/one/pod/upgrade/status")


def test_handoff_waits_for_idle_receipt_and_releases(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    responses = iter(
        [
            {"state": "draining", "operationId": "op_12345678"},
            {
                "state": "idle",
                "operationId": "op_12345678",
                "incarnation": "rev-a",
                "idleReceipt": {
                    "operationId": "op_12345678",
                    "incarnation": "rev-a",
                    "activeWork": 0,
                    "committedState": "state",
                    "runtimeEpoch": "epoch-a",
                },
            },
            {"state": "accepting"},
        ]
    )

    class Response:
        status_code = 200

        def json(self):
            return next(responses)

    class Session:
        def post(self, url, **_kwargs):
            calls.append(("POST", url))
            return Response()

        def get(self, url, **_kwargs):
            calls.append(("GET", url))
            return Response()

    monkeypatch.setattr(
        "google.oauth2.id_token.fetch_id_token", lambda *_args, **_kwargs: "identity"
    )
    client = PodUpgradeHandoffClient(
        url="https://pod.example", hushh_id="ha1-test", session=Session()
    )
    receipt = client.prepare_and_wait(
        operation_id="op_12345678", incarnation="rev-a", timeout_seconds=1
    )
    assert receipt["incarnation"] == "rev-a"
    client.release(operation_id="op_12345678", incarnation="rev-a")
    assert calls == [
        ("POST", "https://pod.example/api/one/pod/upgrade/prepare"),
        ("GET", "https://pod.example/api/one/pod/upgrade/status"),
        ("POST", "https://pod.example/api/one/pod/upgrade/release"),
    ]
