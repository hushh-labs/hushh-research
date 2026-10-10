from datetime import datetime, timezone
from types import SimpleNamespace

from hushh_mcp.services import chat_notification_state as state


def test_unread_counts_are_bounded_and_do_not_include_message_content(monkeypatch):
    monkeypatch.setattr(
        state,
        "get_db",
        lambda: SimpleNamespace(
            execute_raw=lambda *_args: SimpleNamespace(
                data=[{"badge_count": 12000, "thread_count": 3}]
            )
        ),
    )
    result = state.chat_notification_counts("alice", "circle:c1")
    assert result["chat_badge_count"] == "9999"
    assert result["chat_unread_count"] == "3"
    assert len(result["chat_owner"]) == 64
    assert "alice" not in str(result)


def test_count_failure_keeps_owner_fence_without_claiming_zero_unread(monkeypatch):
    def unavailable():
        raise RuntimeError("unavailable")

    monkeypatch.setattr(state, "get_db", unavailable)
    assert set(state.chat_notification_counts("alice")) == {"chat_owner"}


def test_direct_read_sync_uses_retained_frontier_without_raw_recipient_in_payload(monkeypatch):
    calls = []
    monkeypatch.setattr(
        state,
        "chat_notification_counts",
        lambda *_args, **_kwargs: {
            "chat_badge_count": "0",
            "chat_badge_version": "100",
            "chat_owner": "opaque",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.push_notifications.send_user_data_push",
        lambda user, **kwargs: calls.append((user, kwargs)),
    )
    before = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert state.sync_chat_read("alice", conversation="c1", read_at=before, message_id="m1") == {
        "chatBadgeCount": 0,
        "chatBadgeVersion": 100,
    }
    assert calls[0][1]["include_user_id"] is False
    assert calls[0][1]["data"]["chat_read_before"] == str(int(before.timestamp() * 1000) - 1)
    assert calls[0][1]["show_alert"] is False

    assert calls[0][1]["platforms"] == frozenset({"ios", "android"})

    assert calls[0][1]["data"]["chat_read_message_id"] == "direct-message:m1"
