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


@pytest.mark.parametrize("updating", [True, False])
async def test_pod_update_refusal_is_terminal_without_running_the_model(monkeypatch, updating):
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from ag_ui.core import RunAgentInput

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
    from hushh_mcp.services.pod_upgrade_admission import (
        PodUpgradeAdmissionRefused,
        PodUpgradeInProgress,
    )

    refusal = PodUpgradeInProgress if updating else PodUpgradeAdmissionRefused
    monkeypatch.setattr(
        pod.ADMISSION, "acquire_turn", AsyncMock(side_effect=refusal("private details"))
    )
    sdk = AsyncMock()
    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)
    request = RunAgentInput(
        thread_id="synthetic-update-turn",
        run_id="synthetic-run",
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )
    if updating:
        events = [event async for event in agent.run(request)]
        assert len(events) == 1
        assert events[0].code == "POD_CHAT_UPDATING"
        assert "private details" not in events[0].message
    else:
        with pytest.raises(PodUpgradeAdmissionRefused):
            await anext(agent.run(request))
    sdk.assert_not_called()
    assert request.thread_id not in pod._ACTIVE_THREADS
