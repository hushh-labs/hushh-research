"""Direct push identity and durable bounded Gmail history regression contracts."""

from __future__ import annotations

import base64
import json

import pytest

from api.routes.one import pod_gmail_push
from hushh_mcp.services import pod_gmail_doorbell as bell
from hushh_mcp.services.pod_wall import POD_WALL_NOT_FOUND_BODY
from hushh_mcp.services.user_gcp_backend import pod_service_account_id
from tests import pod_connector_harness as h

HOST = "one-pod-ha1-l6owner-123.us-central1.run.app"
PUSH_EMAIL = f"{pod_service_account_id(h.OWNER_HUSHH)}@owner-project.iam.gserviceaccount.com"


@pytest.fixture
def agent(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch, tmp_path, connectors={"gmail": h.credential("gmail", h.SCOPES["gmail"])}
    )
    google.on("GET", f"{h.GMAIL}/profile", {"emailAddress": h.EMAIL, "historyId": "100"})
    monkeypatch.setenv("POD_GMAIL_TOPIC", "projects/oauth-project/topics/one-mail-ha1-l6owner")
    monkeypatch.setenv("POD_GMAIL_PUSH_SERVICE_ACCOUNT", PUSH_EMAIL)
    monkeypatch.setenv("POD_GMAIL_PUSH_AUDIENCE", f"https://{HOST}")
    monkeypatch.setenv(
        "POD_GMAIL_PUSH_SUBSCRIPTION",
        "projects/owner-project/subscriptions/one-mail-ha1-l6owner-sub",
    )
    import os

    from hushh_mcp.services.pod_gmail_push_config import notification_config_generation

    monkeypatch.setenv(
        "POD_GMAIL_CONFIG_GENERATION", notification_config_generation(dict(os.environ))
    )
    seen: list[list[str]] = []

    async def listener(ids: list[str]) -> None:
        seen.append(ids)

    monkeypatch.setattr(bell, "_LISTENERS", [listener])
    yield log, tokens, google, seen
    h.uninstall()


async def _baseline(doorbell):
    await doorbell.stored_point()
    await doorbell._store(100, h.EMAIL)


def _push(data: str) -> dict:
    return {
        "subscription": "projects/owner-project/subscriptions/one-mail-ha1-l6owner-sub",
        "message": {"data": base64.b64encode(data.encode()).decode(), "messageId": "1"},
    }


def _verifier(email: str = PUSH_EMAIL, audience: str = f"https://{HOST}"):
    def verify(token: str, candidate: str) -> dict:
        if token != "oidc" or candidate != audience:
            raise ValueError("bad token")
        return {"email": email, "email_verified": True}

    return verify


async def test_a_ring_lists_history_from_the_stored_point_and_dedupes(agent):
    _log, tokens, google, seen = agent
    google.on(
        "GET",
        f"{h.GMAIL}/history",
        {
            "historyId": "130",
            "history": [{"messagesAdded": [{"message": {"id": "n1"}}, {"message": {"id": "n2"}}]}],
        },
    )
    doorbell = bell.PodGmailDoorbell()
    await _baseline(doorbell)

    armed = await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "100"})
    processed = await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "120"})
    duplicate = await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "110"})

    assert [armed["status"], processed["status"], duplicate["status"]] == [
        "duplicate",
        "processed",
        "duplicate",
    ]
    assert seen == [["n1", "n2"]]
    (history,) = google.calls("GET", f"{h.GMAIL}/history")
    assert h.query(history)["startHistoryId"] == ["100"]
    assert (await doorbell.stored_point())["historyId"] == "130"
    assert set(tokens.asks) == {("gmail", "read")}


async def test_a_ring_for_another_mailbox_is_ignored(agent):
    _log, _tokens, google, seen = agent
    result = await bell.PodGmailDoorbell().ring(
        {"emailAddress": "someone@else.com", "historyId": "500"}
    )
    assert result["status"] == "ignored" and seen == []
    assert google.calls("GET", f"{h.GMAIL}/history") == []


async def test_expired_history_requires_recovery_without_silent_cursor_advance(agent):
    _log, _tokens, google, _seen = agent
    google.on("GET", f"{h.GMAIL}/history", {"error": "gone"}, status=404)
    doorbell = bell.PodGmailDoorbell()
    await _baseline(doorbell)
    await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "100"})
    with pytest.raises(bell.GmailDoorbellUnavailable, match="HISTORY_GAP_REQUIRES_RECOVERY"):
        await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "900"})
    point = await doorbell.stored_point()
    assert point["historyId"] == "100" and point["pending"]["target"] == "900"


async def test_renew_watch_arms_the_owners_own_topic(agent):
    _log, _tokens, google, _seen = agent
    google.on("POST", f"{h.GMAIL}/watch", {"historyId": "77", "expiration": "1760000000000"})
    result = await bell.PodGmailDoorbell().renew_watch()
    assert result["status"] == "watching"
    (watch,) = google.calls("POST", f"{h.GMAIL}/watch")
    assert h.body(watch)["topicName"] == "projects/oauth-project/topics/one-mail-ha1-l6owner"


async def test_the_push_door_admits_only_this_agents_own_identity_and_url(agent, monkeypatch):
    calls: list[str] = []

    class _Bell:
        async def renew_watch(self) -> dict:
            calls.append("renew")
            return {"status": "watching"}

        async def ring(self, message: dict) -> dict:
            calls.append(message["historyId"])
            return {"status": "processed"}

    async def push(verifier, body=None, host=HOST):
        return await pod_gmail_push.run_gmail_push(
            authorization="Bearer oidc",
            host=host,
            body=body or _push(json.dumps({"emailAddress": h.EMAIL, "historyId": "5"})),
            doorbell=_Bell(),
            verifier=verifier,
        )

    ok = await push(_verifier())
    renew = await push(_verifier(), body=_push("renew-watch"))
    wrong_email = await push(_verifier(email="attacker@evil.iam.gserviceaccount.com"))
    wrong_audience = await push(_verifier(audience="https://hub.example"), host=HOST)
    tick_audience = await push(_verifier(audience="https://tick.example"), host="tick.example")

    assert (ok.status_code, renew.status_code) == (204, 204)
    for refused in (wrong_email, wrong_audience, tick_audience):
        assert refused.status_code == 404 and refused.body == POD_WALL_NOT_FOUND_BODY
    assert calls == ["5", "renew"], "only verified deliveries reach the doorbell"


async def test_azure_owner_uses_the_same_direct_verified_push(agent, monkeypatch):
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    monkeypatch.setenv("HUSSH_POD_KEY_VAULT_KEY", "https://vault/keys/k/1")

    class _Bell:
        async def ring(self, message):
            return {"status": "processed"}

    response = await pod_gmail_push.run_gmail_push(
        authorization="Bearer oidc",
        host=HOST,
        body=_push('{"emailAddress":"owner@example.com","historyId":"100"}'),
        verifier=_verifier(),
        doorbell=_Bell(),
    )
    assert response.status_code == 204


async def test_provider_failure_requests_redelivery(agent):
    class _Down:
        async def ring(self, message: dict) -> dict:
            raise bell.GmailDoorbellUnavailable("PROVIDER_UNREACHABLE")

    response = await pod_gmail_push.run_gmail_push(
        authorization="Bearer oidc",
        host=HOST,
        body=_push(json.dumps({"emailAddress": h.EMAIL, "historyId": "9"})),
        doorbell=_Down(),
        verifier=_verifier(),
    )
    assert response.status_code == 503


def test_push_bodies_decode_to_a_notification_renew_or_nothing():
    assert bell.decode_push(_push("renew-watch")) == bell.RENEW_WATCH
    assert bell.decode_push(_push('{"historyId": "1"}')) == {"historyId": "1"}
    assert bell.decode_push({"message": {"data": "%%%"}}) is None
    assert bell.decode_push(None) is None


async def test_neither_owner_cloud_starts_a_polling_fallback(agent, monkeypatch):
    assert bell.start_mail_poller() is None, "a Google agent is pushed, never polled"
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    monkeypatch.setenv("HUSSH_POD_KEY_VAULT_KEY", "https://vault/keys/k/1")

    assert bell.start_mail_poller() is None


async def test_failed_listener_replays_durable_batch_after_restart(agent, monkeypatch):
    log, _tokens, google, seen = agent
    google.on(
        "GET",
        f"{h.GMAIL}/history",
        {"historyId": "130", "history": [{"messagesAdded": [{"message": {"id": "n1"}}]}]},
    )
    doorbell = bell.PodGmailDoorbell()
    await _baseline(doorbell)
    await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "100"})

    async def down(ids):
        assert (await bell.PodGmailDoorbell().stored_point())["pending"]["batch"]["ids"] == ids
        raise RuntimeError("sink unavailable")

    monkeypatch.setattr(bell, "_LISTENERS", [down])
    with pytest.raises(RuntimeError):
        await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "120"})
    assert (await doorbell.stored_point())["historyId"] == "100"

    async def recovered(ids):
        seen.append(ids)

    monkeypatch.setattr(bell, "_LISTENERS", [recovered])
    restarted = bell.PodGmailDoorbell()
    assert (await restarted.ring({"emailAddress": h.EMAIL, "historyId": "120"}))[
        "status"
    ] == "processed"
    assert seen == [["n1"]] and len(google.calls("GET", f"{h.GMAIL}/history")) == 1
    assert (await restarted.stored_point())["historyId"] == "130"


async def test_pagination_checkpoints_without_advancing_global_cursor(agent, monkeypatch):
    _log, _tokens, google, seen = agent

    def page(request):
        index = int(h.query(request).get("pageToken", ["0"])[0])
        body = {
            "historyId": "900",
            "history": [{"messagesAdded": [{"message": {"id": f"n{index}"}}]}],
        }
        if index < 6:
            body["nextPageToken"] = str(index + 1)
        return body

    google.on("GET", f"{h.GMAIL}/history", page)
    doorbell = bell.PodGmailDoorbell()
    await _baseline(doorbell)
    await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "100"})
    first = await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "800"})
    point = await doorbell.stored_point()
    assert first["status"] == "pending" and point["historyId"] == "100"
    assert point["pending"]["page"] == "5"
    restarted = bell.PodGmailDoorbell()
    assert (await restarted.ring({"emailAddress": h.EMAIL, "historyId": "850"}))[
        "status"
    ] == "processed"
    assert (await restarted.stored_point())["historyId"] == "900"
    assert seen == [[f"n{i}"] for i in range(7)]


async def test_push_pending_or_unbound_subscription_never_false_acks(agent):
    class _Bell:
        async def ring(self, message):
            return {"status": "pending"}

    body = _push('{"emailAddress":"owner@example.com","historyId":"100"}')
    pending = await pod_gmail_push.run_gmail_push(
        authorization="Bearer oidc",
        host="attacker.example",
        body=body,
        verifier=_verifier(),
        doorbell=_Bell(),
    )
    assert pending.status_code == 503
    body["subscription"] = "projects/other/subscriptions/other"
    refused = await pod_gmail_push.run_gmail_push(
        authorization="Bearer oidc", host=HOST, body=body, verifier=_verifier(), doorbell=_Bell()
    )
    assert refused.status_code == 404


async def test_missing_baseline_never_silently_skips_a_notification(agent):
    doorbell = bell.PodGmailDoorbell()
    with pytest.raises(bell.GmailDoorbellUnavailable, match="WATCH_BASELINE_REQUIRED"):
        await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "120"})
    assert await doorbell.stored_point() is None


async def test_concurrent_commit_cannot_advance_a_listener_snapshot(agent, monkeypatch):
    from hushh_mcp.services.pod_commit_log import PodLogConflict

    log, _tokens, google, _seen = agent
    google.on(
        "GET",
        f"{h.GMAIL}/history",
        {"historyId": "130", "history": [{"messagesAdded": [{"message": {"id": "n1"}}]}]},
    )
    doorbell = bell.PodGmailDoorbell()
    await _baseline(doorbell)

    async def concurrent(ids):
        await log.append("other_owner_job", {"status": "queued"})
        await doorbell.notification_status()  # a concurrent reader refreshes the projection

    monkeypatch.setattr(bell, "_LISTENERS", [concurrent])
    with pytest.raises(PodLogConflict):
        await doorbell.ring({"emailAddress": h.EMAIL, "historyId": "120"})
    point = await doorbell.stored_point()
    assert point["historyId"] == "100" and point["pending"]["batch"]["ids"] == ["n1"]


async def test_watch_renewal_is_daily_durable_and_config_revision_bound(agent, monkeypatch):
    _log, _tokens, google, _seen = agent
    google.on("POST", f"{h.GMAIL}/watch", {"historyId": "100", "expiration": "1760000000000"})
    now = [100000.0]
    doorbell = bell.PodGmailDoorbell(clock=lambda: now[0])
    assert (await doorbell.renew_if_due())["status"] == "watching"
    restarted = bell.PodGmailDoorbell(clock=lambda: now[0])
    assert (await restarted.renew_if_due())["status"] == "watch_current"
    monkeypatch.setenv("POD_GMAIL_CONFIG_GENERATION", "next-config")
    assert (await restarted.renew_if_due())["status"] == "watching"
    now[0] += 86400
    assert (await restarted.renew_if_due())["status"] == "watching"
    assert len(google.calls("POST", f"{h.GMAIL}/watch")) == 3
    assert (await restarted.stored_point())["historyId"] == "100"


async def test_incomplete_authority_generation_refuses_before_dispatch(agent, monkeypatch):
    monkeypatch.setenv("POD_GMAIL_PUSH_AUDIENCE", "https://different.example")
    response = await pod_gmail_push.run_gmail_push(
        authorization="Bearer oidc", host=HOST, body=_push("renew-watch"), verifier=_verifier()
    )
    assert response.status_code == 404
