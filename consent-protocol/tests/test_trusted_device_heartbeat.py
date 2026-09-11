"""Trusted-device liveness heartbeat (migration 189).

The heartbeat exists because ``last_synced_at`` cannot answer "is this agent
reachable right now?" -- it only advances when the device pulls the sync
channel, so a running-but-idle agent looks stale. These tests pin the two
properties that make the heartbeat safe: it is telemetry only, and a device
cannot use it to push anything but telemetry into the row.
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.services.trusted_device_service import (
    TrustedDeviceService,
    _safe_heartbeat,
)

DEVICE_ID = "tdv_" + ("h" * 32)


class _RecordingStore:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def record_heartbeat(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)


def test_heartbeat_keeps_only_allow_listed_scalar_fields() -> None:
    safe = _safe_heartbeat(
        {
            "machine_id": "gw-studio",
            "current_model": "gemini-3.6-flash",
            "busy": True,
            "active_sessions": 2,
            "next_cron_at": 1_700_000_000_000,
        }
    )
    assert safe == {
        "machine_id": "gw-studio",
        "current_model": "gemini-3.6-flash",
        "busy": True,
        "active_sessions": 2,
        "next_cron_at": 1_700_000_000_000,
    }


def test_heartbeat_drops_everything_outside_the_allow_list() -> None:
    # A device posts this payload, so it is untrusted input written to JSONB.
    # Unknown keys are dropped rather than sanitized: the column can only ever
    # hold telemetry, never vault content, paths, or credentials.
    safe = _safe_heartbeat(
        {
            "machine_id": "gw-studio",
            "vault_key": "super-secret",
            "home_path": "/Users/someone/.hermes",
            "token": "Bearer abc",
            "nested": {"anything": "at all"},
            "list": [1, 2, 3],
        }
    )
    assert safe == {"machine_id": "gw-studio"}


def test_heartbeat_caps_oversized_text_and_rejects_bad_types() -> None:
    safe = _safe_heartbeat(
        {
            "machine_id": "m" * 5000,
            "busy": "yes",  # not a bool
            "active_sessions": -4,  # negative
            "current_model": "",  # empty after strip
        }
    )
    assert len(safe["machine_id"]) == 120
    assert "busy" not in safe
    assert "active_sessions" not in safe
    assert "current_model" not in safe


def test_heartbeat_tolerates_a_missing_or_malformed_payload() -> None:
    assert _safe_heartbeat(None) == {}
    assert _safe_heartbeat("not-a-dict") == {}  # type: ignore[arg-type]


def test_heartbeat_keeps_the_machine_specs_shown_on_connect() -> None:
    # Brand, processor and RAM are what the owner sees when a device connects.
    safe = _safe_heartbeat(
        {
            "brand": "Mac16,5",
            "processor": "Apple M4 Max",
            "ram_total_gb": 128.0,
            "ram_used_pct": 41.7,
        }
    )
    assert safe == {
        "brand": "Mac16,5",
        "processor": "Apple M4 Max",
        "ram_total_gb": 128.0,
        "ram_used_pct": 41.7,
    }


def test_heartbeat_drops_out_of_range_numbers_rather_than_clamping() -> None:
    # A device posts these, so an unbounded float would render as garbage
    # wherever it is shown. Dropping is right and clamping is not: clamping
    # would invent a reading that was never taken.
    safe = _safe_heartbeat(
        {
            "machine_id": "gw-studio",
            "ram_used_pct": 4_000.0,
            "ram_total_gb": -8.0,
        }
    )
    assert safe == {"machine_id": "gw-studio"}


def test_heartbeat_rejects_nan_and_infinity() -> None:
    # These fail every comparison, so the range test excludes them. A NaN is
    # not serializable as standard JSON and must never reach the column.
    safe = _safe_heartbeat(
        {
            "ram_used_pct": float("nan"),
            "ram_total_gb": float("inf"),
        }
    )
    assert safe == {}


def test_heartbeat_keeps_battery_state_for_a_laptop() -> None:
    safe = _safe_heartbeat(
        {
            "battery_pct": 27,
            "battery_charging": False,
            "on_ac": False,
            "battery_minutes_remaining": 102,
        }
    )
    assert safe == {
        "battery_pct": 27,
        "battery_charging": False,
        "on_ac": False,
        "battery_minutes_remaining": 102,
    }


def test_a_desktop_reports_no_battery_rather_than_zero_percent() -> None:
    # A machine with no battery omits the fields entirely. If it sent 0 instead,
    # nothing downstream could tell a desktop from a laptop about to die.
    safe = _safe_heartbeat({"machine_id": "studio", "ram_used_pct": 12.0})
    assert "battery_pct" not in safe
    assert "battery_charging" not in safe


def test_an_out_of_range_battery_reading_is_dropped() -> None:
    safe = _safe_heartbeat({"machine_id": "gw", "battery_pct": 480})
    assert safe == {"machine_id": "gw"}


def test_heartbeat_still_rejects_specs_of_the_wrong_type() -> None:
    safe = _safe_heartbeat(
        {
            "ram_used_pct": True,  # bool is an int subclass; not a reading
            "brand": {"nested": "object"},
        }
    )
    assert safe == {}


def test_record_heartbeat_stamps_a_server_timestamp() -> None:
    store = _RecordingStore()
    TrustedDeviceService(store=store).record_heartbeat(  # type: ignore[arg-type]
        user_id="u1",
        device_id=DEVICE_ID,
        snapshot={"machine_id": "gw-studio", "secret": "nope"},
    )
    assert len(store.calls) == 1
    call = store.calls[0]
    # The server stamps its own time; a device cannot backdate or forward-date.
    assert isinstance(call["now_ms"], int) and call["now_ms"] > 0
    assert call["snapshot"] == {"machine_id": "gw-studio"}


def test_record_heartbeat_ignores_a_malformed_device_id() -> None:
    store = _RecordingStore()
    TrustedDeviceService(store=store).record_heartbeat(  # type: ignore[arg-type]
        user_id="u1",
        device_id="not-a-device-id",
        snapshot={"machine_id": "gw-studio"},
    )
    assert store.calls == []


@pytest.mark.asyncio
async def test_heartbeat_route_returns_503_when_the_store_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    class _RaisingSvc:
        def record_heartbeat(self, **_kwargs: Any) -> None:
            raise RuntimeError("db down")

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _RaisingSvc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    with pytest.raises(HTTPException) as excinfo:
        await account.trusted_device_heartbeat(device_id=DEVICE_ID, payload=None, firebase_uid="u1")
    # Fail-closed: a storage failure is surfaced, never silently reported as a
    # recorded heartbeat that would let the UI claim the agent is reachable.
    assert excinfo.value.status_code == 503


@pytest.mark.asyncio
async def test_heartbeat_route_records_and_acknowledges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    payload = dict(machine_id="gw-studio", current_model="gemini-3.6-flash", busy=False)
    result = await account.trusted_device_heartbeat(
        device_id=DEVICE_ID, payload=payload, firebase_uid="u1"
    )
    assert result["recorded"] is True
    assert isinstance(result["server_time_ms"], int)
    assert seen[0]["snapshot"]["current_model"] == "gemini-3.6-flash"


@pytest.mark.asyncio
async def test_heartbeat_route_forwards_machine_specs_and_power(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The route forwards the whole body; the SERVICE decides what is kept.

    A typed request model used to sit in front of the service, and twice it
    cost the owner a reading: first by dropping undeclared machine-spec
    fields, then by rejecting the entire beat with a 422 whenever one value
    was over its bound. The route now forwards every key and the allow-list
    in _safe_heartbeat keeps, truncates or drops per field.
    """
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    payload = dict(
        {
            "machine_id": "gw-studio",
            "current_model": "google/gemma-4-26b-a4b-qat",
            "brand": "Apple",
            "processor": "Apple M4 Max",
            "ram_total_gb": 128,
            "ram_used_pct": 61.5,
            "battery_pct": 88,
            "battery_charging": True,
            "on_ac": True,
            "battery_minutes_remaining": 240,
            "serial_number": "must-not-pass",
        }
    )
    await account.trusted_device_heartbeat(device_id=DEVICE_ID, payload=payload, firebase_uid="u1")
    snapshot = seen[0]["snapshot"]
    for key in (
        "brand",
        "processor",
        "ram_total_gb",
        "ram_used_pct",
        "battery_pct",
        "battery_charging",
        "on_ac",
        "battery_minutes_remaining",
    ):
        assert key in snapshot, key
    assert snapshot["brand"] == "Apple"
    assert snapshot["ram_total_gb"] == 128
    # The route forwards identifying fields too; the allow-list is what drops
    # them, and it is the one place that decision is made.
    assert "serial_number" not in _safe_heartbeat(snapshot)


@pytest.mark.asyncio
async def test_heartbeat_route_never_rejects_a_beat_for_one_bad_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An over-long or out-of-range value costs that field, never the beat.

    LM Studio model ids can exceed 120 characters. With a bounded request
    model every heartbeat from such a machine was a 422, post_heartbeat on the
    device swallowed it, and One showed a healthy machine as gone. The route
    forwards the body; the service truncates the text and drops the number
    and the beat still stamps last_heartbeat_at.
    """
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    long_model = "lmstudio-community/" + ("x" * 130)
    result = await account.trusted_device_heartbeat(
        device_id=DEVICE_ID,
        payload={"current_model": long_model, "ram_total_gb": 99_999, "busy": True},
        firebase_uid="u1",
    )
    assert result["recorded"] is True
    safe = _safe_heartbeat(seen[0]["snapshot"])
    assert safe["current_model"] == long_model[:120]
    assert safe["busy"] is True
    assert "ram_total_gb" not in safe


@pytest.mark.asyncio
async def test_heartbeat_route_treats_a_non_object_body_as_an_empty_beat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    for body in (None, "busy", 7, ["busy"], {"heartbeat": "not-an-object"}):
        seen.clear()
        result = await account.trusted_device_heartbeat(
            device_id=DEVICE_ID, payload=body, firebase_uid="u1"
        )
        assert result["recorded"] is True, body
        # The beat still lands (liveness), with nothing to say about the machine.
        assert seen[0]["snapshot"] == {}, body


# ---------------------------------------------------------------------------
# Wrapped body: {"heartbeat": {...}}
#
# Hermes builds from 2026-08-28 (when the heartbeat first shipped) to
# 2026-09-03 posted the telemetry wrapped under a "heartbeat" key. The typed
# request model of the time dropped the wrapper at the route boundary and the
# store wrote an empty snapshot (measured on UAT: last_heartbeat_at set,
# heartbeat null). The route reads both shapes until every installed agent
# has updated to the flat body.
# ---------------------------------------------------------------------------


def test_heartbeat_snapshot_unwraps_a_nested_only_body() -> None:
    from api.routes import account

    payload = dict(
        {
            "heartbeat": {
                "machine_id": "gw-studio",
                "current_model": "gemini-3.6-flash",
                "busy": True,
                "ram_used_pct": 41.7,
            }
        }
    )
    assert account._heartbeat_snapshot(payload) == {
        "machine_id": "gw-studio",
        "current_model": "gemini-3.6-flash",
        "busy": True,
        "ram_used_pct": 41.7,
    }


def test_heartbeat_snapshot_flat_wins_over_nested_for_the_same_key() -> None:
    from api.routes import account

    payload = dict(
        {
            "machine_id": "flat-wins",
            "busy": False,
            "heartbeat": {
                "machine_id": "nested-loses",
                "busy": True,
                "current_model": "only-in-nested",
            },
        }
    )
    snapshot = account._heartbeat_snapshot(payload)
    assert snapshot["machine_id"] == "flat-wins"
    assert snapshot["busy"] is False
    # A key present only in the nested block still comes through.
    assert snapshot["current_model"] == "only-in-nested"
    # The wrapper key itself never appears in the snapshot.
    assert "heartbeat" not in snapshot


def test_heartbeat_snapshot_does_not_recurse_into_a_doubly_nested_body() -> None:
    from api.routes import account

    payload = dict(
        {"heartbeat": {"machine_id": "one-level", "heartbeat": {"machine_id": "two-levels"}}}
    )
    assert account._heartbeat_snapshot(payload) == {"machine_id": "one-level"}


def test_heartbeat_snapshot_returns_empty_for_a_missing_body() -> None:
    from api.routes import account

    assert account._heartbeat_snapshot(None) == {}


def test_a_nested_body_cannot_smuggle_a_key_past_the_allow_list() -> None:
    # The wrapper is unwrapped at the route, then the service allow-list runs
    # on the flattened result exactly as it does for a flat body. The route
    # forwards unknown keys; _safe_heartbeat is the one place they are dropped.
    from api.routes import account

    payload = dict(
        {
            "heartbeat": {
                "machine_id": "gw-studio",
                "vault_key": "super-secret",
                "home_path": "/Users/someone/.hermes",
                "serial_number": "must-not-pass",
            }
        }
    )
    flattened = account._heartbeat_snapshot(payload)
    safe = _safe_heartbeat({**flattened, "vault_key": "still-not-allowed"})
    assert safe == {"machine_id": "gw-studio"}


def test_heartbeat_snapshot_does_not_recurse_or_raise_on_a_deep_wrapper() -> None:
    # A wrapper nested a thousand deep used to be validated at every level by
    # a self-referential model and could turn into a 500 in the error
    # renderer. Now it is one level of unwrapping and nothing else.
    from api.routes import account

    body: dict[str, Any] = {"machine_id": "leaf"}
    for _ in range(1000):
        body = {"heartbeat": body}
    snapshot = account._heartbeat_snapshot(body)
    assert "machine_id" not in snapshot
    assert snapshot == {}


@pytest.mark.asyncio
async def test_heartbeat_route_records_a_wrapped_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    payload = dict(
        {
            "heartbeat": {
                "machine_id": "gw-studio",
                "current_model": "google/gemma-4-26b-a4b-qat",
                "brand": "Apple",
                "battery_pct": 88,
            }
        }
    )
    result = await account.trusted_device_heartbeat(
        device_id=DEVICE_ID, payload=payload, firebase_uid="u1"
    )
    assert result["recorded"] is True
    snapshot = seen[0]["snapshot"]
    # Before the wrapper was accepted this snapshot was {} and the store wrote
    # heartbeat null with last_heartbeat_at set.
    assert snapshot["machine_id"] == "gw-studio"
    assert snapshot["current_model"] == "google/gemma-4-26b-a4b-qat"
    assert snapshot["brand"] == "Apple"
    assert snapshot["battery_pct"] == 88
    assert "heartbeat" not in snapshot


# ---------------------------------------------------------------------------
# Summary rows: "scheduled" and "conversations"
#
# These widen the column from scalars to arrays of flat rows, so they widen the
# allow-list without relaxing it: a per-row allow-list, the same coercion and
# capping, ten rows maximum, a row dropped whole when it cannot supply its
# required fields, and a non-list dropping its own key. What must NEVER appear
# is a job's prompt, script, working directory or credentials, any path, URL or
# token, and any message content.
# ---------------------------------------------------------------------------


def test_scheduled_rows_keep_the_permitted_shape() -> None:
    safe = _safe_heartbeat(
        {
            "machine_id": "gw-studio",
            "scheduled": [
                {
                    "name": "doctor page",
                    "when": "every 15m",
                    "paused": False,
                    "next_at": 1_756_000_000,
                    "last": "ok",
                },
                # next_at and last are optional; the row still stands without them.
                {"name": "weekly dream", "when": "0 5 * * 0", "paused": True},
            ],
        }
    )
    assert safe == {
        "machine_id": "gw-studio",
        "scheduled": [
            {
                "name": "doctor page",
                "when": "every 15m",
                "paused": False,
                "next_at": 1_756_000_000,
                "last": "ok",
            },
            {"name": "weekly dream", "when": "0 5 * * 0", "paused": True},
        ],
    }


def test_conversation_rows_keep_the_permitted_shape() -> None:
    safe = _safe_heartbeat(
        {
            "conversations": [
                {"title": "Pod upgrade path", "messages": 42, "at": 1_756_000_000},
                {"title": "Groceries", "messages": 0, "at": 1_755_900_000},
            ]
        }
    )
    assert safe == {
        "conversations": [
            {"title": "Pod upgrade path", "messages": 42, "at": 1_756_000_000},
            {"title": "Groceries", "messages": 0, "at": 1_755_900_000},
        ]
    }


def test_a_scheduled_row_never_carries_the_job_itself() -> None:
    # The prompt, the script, the working directory and the credentials are the
    # reason this is an allow-list and not a filter. A device may send them; the
    # row is rebuilt from permitted names only, so they have no path in.
    safe = _safe_heartbeat(
        {
            "scheduled": [
                {
                    "name": "doctor page",
                    "when": "every 15m",
                    "paused": False,
                    "prompt": "Read the vault and page me about anything urgent",
                    "instruction": "do the thing",
                    "script": "/usr/local/bin/page.sh",
                    "workdir": "/Users/someone/.hermes",
                    "path": "/Users/someone/.hermes/jobs/doctor.json",
                    "url": "https://hooks.example.com/abc",
                    "token": "Bearer abc",
                    "api_key": "sk-live-nope",
                    "model_credentials": {"key": "nope"},
                }
            ]
        }
    )
    assert safe == {"scheduled": [{"name": "doctor page", "when": "every 15m", "paused": False}]}


def test_a_conversation_row_never_carries_message_content() -> None:
    safe = _safe_heartbeat(
        {
            "conversations": [
                {
                    "title": "Pod upgrade path",
                    "messages": 42,
                    "at": 1_756_000_000,
                    "body": "the actual thing I said",
                    "text": "and the reply",
                    "last_message": "and the last one",
                    "tool_output": {"stdout": "secrets"},
                    "path": "/Users/someone/.hermes/sessions/1.json",
                }
            ]
        }
    )
    assert safe == {
        "conversations": [{"title": "Pod upgrade path", "messages": 42, "at": 1_756_000_000}]
    }


def test_an_eleventh_row_is_dropped() -> None:
    safe = _safe_heartbeat(
        {
            "scheduled": [
                {"name": f"job {index}", "when": "every 15m", "paused": False}
                for index in range(11)
            ],
            "conversations": [
                {"title": f"chat {index}", "messages": index, "at": 1_756_000_000 + index}
                for index in range(11)
            ],
        }
    )
    assert len(safe["scheduled"]) == 10
    assert len(safe["conversations"]) == 10
    # Head kept, not tail: the device sends soonest/newest first, so truncating
    # from the end leaves the useful half.
    assert safe["scheduled"][0]["name"] == "job 0"
    assert safe["scheduled"][-1]["name"] == "job 9"
    assert safe["conversations"][-1]["title"] == "chat 9"


def test_an_over_long_row_field_is_truncated_not_rejected() -> None:
    # Costing the extra characters is right; costing the row is not. The same
    # reasoning as the 121-character model id that used to 422 a whole beat.
    safe = _safe_heartbeat(
        {
            "scheduled": [
                {
                    "name": "n" * 500,
                    "when": "w" * 500,
                    "paused": False,
                    "last": "l" * 500,
                }
            ],
            "conversations": [{"title": "t" * 500, "messages": 3, "at": 1_756_000_000}],
        }
    )
    assert len(safe["scheduled"][0]["name"]) == 80
    assert len(safe["scheduled"][0]["when"]) == 40
    assert len(safe["scheduled"][0]["last"]) == 16
    assert len(safe["conversations"][0]["title"]) == 80


def test_a_row_missing_a_required_field_is_dropped_whole() -> None:
    # Never part-filled: a job shown without its schedule, or shown as running
    # while it is paused, misleads the owner more than a job not shown at all.
    safe = _safe_heartbeat(
        {
            "scheduled": [
                {"when": "every 15m", "paused": False},  # no name
                {"name": "no schedule", "paused": False},  # no when
                {"name": "no paused flag", "when": "every 15m"},  # no paused
                {"name": "bad paused", "when": "every 15m", "paused": "no"},  # not a bool
                {"name": "  ", "when": "every 15m", "paused": False},  # blank after strip
                {"name": "kept", "when": "every 15m", "paused": True},
            ],
            "conversations": [
                {"messages": 1, "at": 1_756_000_000},  # no title
                {"title": "no count", "at": 1_756_000_000},  # no messages
                {"title": "no time", "messages": 1},  # no at
                {"title": "float count", "messages": 1.5, "at": 1_756_000_000},
                {"title": "kept", "messages": 1, "at": 1_756_000_000},
            ],
        }
    )
    assert safe["scheduled"] == [{"name": "kept", "when": "every 15m", "paused": True}]
    assert safe["conversations"] == [{"title": "kept", "messages": 1, "at": 1_756_000_000}]


def test_row_numbers_outside_their_range_drop_the_row() -> None:
    safe = _safe_heartbeat(
        {
            "scheduled": [
                {"name": "backdated", "when": "every 15m", "paused": False, "next_at": -1},
            ],
            "conversations": [
                {"title": "too many", "messages": 100_001, "at": 1_756_000_000},
                {"title": "negative", "messages": -1, "at": 1_756_000_000},
                {"title": "backdated", "messages": 1, "at": -1},
                {"title": "bool count", "messages": True, "at": 1_756_000_000},
            ],
        }
    )
    # next_at is optional, so a bad one costs only that field.
    assert safe["scheduled"] == [{"name": "backdated", "when": "every 15m", "paused": False}]
    # messages and at are required, so a bad one costs the row.
    assert safe["conversations"] == []


def test_a_non_list_value_drops_only_its_own_key() -> None:
    for bad in ({"name": "not a list"}, "scheduled", 7, True, None):
        safe = _safe_heartbeat(
            {
                "machine_id": "gw-studio",
                "busy": True,
                "scheduled": bad,
                "conversations": [{"title": "kept", "messages": 1, "at": 1_756_000_000}],
            }
        )
        assert "scheduled" not in safe, bad
        # The rest of the beat is untouched.
        assert safe["machine_id"] == "gw-studio"
        assert safe["busy"] is True
        assert safe["conversations"] == [{"title": "kept", "messages": 1, "at": 1_756_000_000}]


def test_an_empty_list_is_kept_and_a_missing_key_is_not() -> None:
    # "I have no scheduled jobs" and "I do not report scheduled jobs" are
    # different answers, and the column keeps them apart.
    assert _safe_heartbeat({"scheduled": []}) == {"scheduled": []}
    assert _safe_heartbeat({"machine_id": "gw"}) == {"machine_id": "gw"}


def test_a_malformed_row_does_not_damage_the_rest_of_the_beat() -> None:
    safe = _safe_heartbeat(
        {
            "machine_id": "gw-studio",
            "current_model": "gemini-3.6-flash",
            "busy": True,
            "battery_pct": 88,
            "scheduled": [
                "not-a-row",
                None,
                42,
                ["nested", "list"],
                {"name": "kept", "when": "every 15m", "paused": False},
            ],
            "conversations": [None, {"title": "kept", "messages": 2, "at": 1_756_000_000}],
        }
    )
    assert safe["machine_id"] == "gw-studio"
    assert safe["current_model"] == "gemini-3.6-flash"
    assert safe["busy"] is True
    assert safe["battery_pct"] == 88
    assert safe["scheduled"] == [{"name": "kept", "when": "every 15m", "paused": False}]
    assert safe["conversations"] == [{"title": "kept", "messages": 2, "at": 1_756_000_000}]


def test_rows_are_the_only_nesting_the_column_accepts() -> None:
    # A nested object under any other key is still dropped on sight, and a row
    # cannot smuggle one through either.
    safe = _safe_heartbeat(
        {
            "machine_id": "gw-studio",
            "nested": {"anything": "at all"},
            "scheduled": [
                {
                    "name": "kept",
                    "when": "every 15m",
                    "paused": False,
                    "detail": {"prompt": "read the vault"},
                }
            ],
        }
    )
    assert "nested" not in safe
    assert safe["scheduled"] == [{"name": "kept", "when": "every 15m", "paused": False}]


def test_the_read_side_reduction_also_strips_unexpected_row_keys() -> None:
    # A row written before this change, or by any other writer, is re-reduced
    # on read. _safe_device is the read path for the device list and status.
    from hushh_mcp.services.trusted_device_service import _safe_device

    device = _safe_device(
        {
            "device_id": DEVICE_ID,
            "device_name": "Studio",
            "platform": "macos",
            "status": "active",
            "created_at": 1,
            "last_heartbeat_at": 2,
            "heartbeat": {
                "machine_id": "gw-studio",
                "vault_key": "super-secret",
                "scheduled": [
                    {
                        "name": "doctor page",
                        "when": "every 15m",
                        "paused": False,
                        "prompt": "read the vault and page me",
                        "workdir": "/Users/someone/.hermes",
                    },
                    {"name": "no schedule"},
                ],
                "conversations": [
                    {
                        "title": "Pod upgrade path",
                        "messages": 42,
                        "at": 1_756_000_000,
                        "body": "the actual thing I said",
                    }
                ],
            },
        }
    )
    assert device["heartbeat"] == {
        "machine_id": "gw-studio",
        "scheduled": [{"name": "doctor page", "when": "every 15m", "paused": False}],
        "conversations": [{"title": "Pod upgrade path", "messages": 42, "at": 1_756_000_000}],
    }


def test_the_read_side_drops_a_row_array_written_as_something_else() -> None:
    from hushh_mcp.services.trusted_device_service import _safe_device

    device = _safe_device(
        {
            "device_id": DEVICE_ID,
            "heartbeat": {"machine_id": "gw", "scheduled": {"name": "not a list"}},
        }
    )
    assert device["heartbeat"] == {"machine_id": "gw"}


@pytest.mark.asyncio
async def test_the_route_never_rejects_a_beat_over_one_bad_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One malformed row costs that row, never the beat.

    This is the same property a typed request model broke once already: a
    121-character model id turned every heartbeat from that machine into a 422
    and One showed a healthy device as gone. The route still forwards the whole
    body untyped and the service drops per row.
    """
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    result = await account.trusted_device_heartbeat(
        device_id=DEVICE_ID,
        payload={
            "machine_id": "gw-studio",
            "scheduled": [
                {"name": "n" * 500, "when": "every 15m", "paused": "not-a-bool"},
                {"name": "kept", "when": "every 15m", "paused": False, "script": "/bin/sh"},
            ],
            "conversations": "not-a-list",
        },
        firebase_uid="u1",
    )
    assert result["recorded"] is True
    safe = _safe_heartbeat(seen[0]["snapshot"])
    assert safe["machine_id"] == "gw-studio"
    assert safe["scheduled"] == [{"name": "kept", "when": "every 15m", "paused": False}]
    assert "conversations" not in safe


@pytest.mark.asyncio
async def test_the_route_forwards_rows_from_a_wrapped_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    seen: list[dict[str, Any]] = []

    class _Svc:
        def record_heartbeat(self, **kwargs: Any) -> None:
            seen.append(kwargs)

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    await account.trusted_device_heartbeat(
        device_id=DEVICE_ID,
        payload={
            "heartbeat": {
                "machine_id": "gw-studio",
                "scheduled": [{"name": "doctor page", "when": "every 15m", "paused": False}],
            }
        },
        firebase_uid="u1",
    )
    safe = _safe_heartbeat(seen[0]["snapshot"])
    assert safe["scheduled"] == [{"name": "doctor page", "when": "every 15m", "paused": False}]
