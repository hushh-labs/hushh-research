"""Native reply payload, device-owner race and compatibility delivery contracts."""

import hashlib
import importlib
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from hushh_mcp.services import push_notifications as push_module


def _provider_session(monkeypatch, credential):
    import firebase_admin
    import requests

    monkeypatch.setattr(
        firebase_admin,
        "get_app",
        lambda: SimpleNamespace(
            project_id="synthetic", credential=SimpleNamespace(get_credential=lambda: credential)
        ),
    )
    session = MagicMock()
    session.__enter__.return_value = session
    session.post.return_value = SimpleNamespace(status_code=200)
    monkeypatch.setattr(requests, "Session", lambda: session)
    return session


@pytest.mark.parametrize("platform", ["ios", "android"])
def test_reply_transport_has_visible_native_alert_and_rechecks_claim_before_send(
    monkeypatch, platform
):
    from hushh_mcp.services.one_reply_transport import send_reply

    credential = SimpleNamespace(valid=True, token="synthetic", refresh=MagicMock())  # noqa: S106
    session = _provider_session(monkeypatch, credential)
    kwargs = dict(
        token="device",  # noqa: S106
        platform=platform,
        data={"conversation_id": "opaque"},
        title="Hussh One",
        body="Your reply is ready.",
        tag="one_reply:opaque",
        expires_at=int(time.time()) + 100,
        deadline=time.monotonic() + 30,
    )
    send_reply(**kwargs, before_send=lambda: True)
    payload = session.post.call_args.kwargs["json"]["message"]
    assert payload["notification"] == {"title": "Hussh One", "body": "Your reply is ready."}
    assert "user_id" not in payload["data"]
    if platform == "ios":
        assert payload["apns"]["headers"]["apns-push-type"] == "alert"
        assert payload["apns"]["payload"]["aps"]["sound"] == "default"
    else:
        assert payload["android"]["priority"] == "HIGH"
        assert payload["android"]["notification"]["tag"] == "one_reply:opaque"
    session.post.reset_mock()
    with pytest.raises(RuntimeError, match="claim changed"):
        send_reply(**kwargs, before_send=lambda: False)
    session.post.assert_not_called()


def test_partial_reply_delivery_retains_receipts_and_refuses_transferred_device(monkeypatch):

    from hushh_mcp.services import one_reply_transport

    monkeypatch.setattr("api.utils.firebase_admin.ensure_firebase_admin", lambda: (True, None))
    monkeypatch.setattr("hushh_mcp.runtime_settings.personal_agent_enabled", lambda: True)
    owners = {"phone-a": "owner", "phone-b": "owner"}

    def query(sql, params):
        if "to_regclass" in sql:
            return SimpleNamespace(data=[{"available": True}])
        if "AS owned" in sql:
            return SimpleNamespace(
                data=[{"owned": 1}] if owners[params["token"]] == params["user_id"] else []
            )
        return SimpleNamespace(data=[{"token": token, "platform": "ios"} for token in owners])

    monkeypatch.setattr("db.db_client.get_db", lambda: SimpleNamespace(execute_raw=query))
    monkeypatch.setattr("api.utils.fcm_messages.build_push_message", lambda *_, **__: object())
    sent = []

    def send(**kwargs):
        if kwargs["token"] == "phone-b":
            owners["phone-b"] = "other"  # Transfer during credential refresh.
            assert not kwargs["before_send"]()
            raise RuntimeError("claim changed")
        sent.append(kwargs["token"])

    monkeypatch.setattr(one_reply_transport, "send_reply", send)
    report = push_module.PushDeliveryReport(
        deadline=time.monotonic() + 30, before_send=lambda: True, expires_at=int(time.time()) + 100
    )
    kwargs = dict(
        notification_type="one_reply",
        title="Hussh One",
        body="Ready",
        deep_link="/one/feed",
        notification_tag="event",
        notification_category="ONE_CHAT",
        include_user_id=False,
        delivery=report,
        platforms=frozenset({"ios", "android"}),
    )
    assert push_module.send_user_data_push("owner", **kwargs) == 1
    assert len(report.accepted) == 1 and report.retryable and sent == ["phone-a"]
    assert push_module.send_user_data_push("owner", **kwargs) == 0
    assert sent == ["phone-a"]


def test_missing_additive_registry_preserves_existing_push_delivery(monkeypatch):
    monkeypatch.setattr("api.utils.firebase_admin.ensure_firebase_admin", lambda: (True, None))
    monkeypatch.setattr("hushh_mcp.runtime_settings.personal_agent_enabled", lambda: True)

    def query(sql, _):
        if "to_regclass" in sql:
            return SimpleNamespace(data=[{"available": False}])
        assert "user_push_devices" not in sql
        return SimpleNamespace(data=[{"token": "existing", "platform": "ios"}])

    monkeypatch.setattr("db.db_client.get_db", lambda: SimpleNamespace(execute_raw=query))
    monkeypatch.setattr("api.utils.fcm_messages.build_push_message", lambda *_, **__: object())
    monkeypatch.setattr("firebase_admin.messaging.send", lambda _: "accepted")
    assert (
        push_module.send_user_data_push(
            "owner",
            notification_type="existing",
            title="One",
            body="Ready",
            deep_link="/one/feed",
            notification_tag="existing",
            notification_category="ONE_CHAT",
        )
        == 1
    )


@pytest.mark.parametrize("change", ["unchanged", "key", "pod", "erasure"])
async def test_hub_rechecks_serving_admission_after_fcm_credential_refresh(monkeypatch, change):
    from api.routes.one import pod_reply_notifications as route

    # Load the installed bridge before replacing its provider's HTTP session.
    importlib.import_module("hushh_mcp.one_adk.turn_completion")
    row = {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "pod_signing_key_id": "key",
        "deployment_target": "user_gcp",
        "status": "provisioned",
    }
    registry = SimpleNamespace(
        get_by_hushh_id=AsyncMock(side_effect=lambda _: dict(row)),
        get=AsyncMock(side_effect=lambda _: dict(row)),
    )
    monkeypatch.setattr(route, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr("hushh_mcp.runtime_settings.personal_agent_enabled", lambda: True)
    monkeypatch.setattr("api.utils.firebase_admin.ensure_firebase_admin", lambda: (True, None))
    monkeypatch.setattr("api.utils.fcm_messages.build_push_message", lambda *_, **__: object())

    def query(sql, _):
        if "to_regclass" in sql:
            return SimpleNamespace(data=[{"available": False}])
        if "AS owned" in sql:
            return SimpleNamespace(data=[{"owned": 1}])
        return SimpleNamespace(data=[{"token": "phone", "platform": "ios"}])

    monkeypatch.setattr("db.db_client.get_db", lambda: SimpleNamespace(execute_raw=query))

    def refresh(_):
        if change == "key":
            row["pod_signing_key_id"] = "replacement"
        elif change == "pod":
            row["hushh_id"] = "ha1_replacement"
        elif change == "erasure":
            row["backend_metadata"] = {"erasure": {"state": "reserved"}}

    credential = SimpleNamespace(
        valid=False,
        token="synthetic",  # noqa: S106
        refresh=MagicMock(side_effect=refresh),
    )
    session = _provider_session(monkeypatch, credential)
    now = int(time.time())
    signal = route.ReplySignal(
        eventId=hashlib.sha256(b"ha1_owner\0conversation_1\0run").hexdigest(),
        conversationId="conversation_1",
        runId="run",
        createdAt=now,
        expiresAt=now + 100,
    )
    ledger = SimpleNamespace(
        accept=lambda **_: ({"attempts": 1, "accepted_devices": []}, "pending"),
        is_sendable=lambda **_: True,
        record_accepted=lambda **_: None,
        finish=lambda **kw: "pending" if kw["report"].retryable else "sent",
    )
    result = await route.accept_reply(
        signal,
        SimpleNamespace(hushh_id="ha1_owner", key_id="key"),
        registry=registry,
        delivery=ledger,
    )
    credential.refresh.assert_called_once()
    if change == "unchanged":
        session.post.assert_called_once()
        assert result["outcome"] == "sent"
    else:
        session.post.assert_not_called()
        assert result["outcome"] == "pending"
