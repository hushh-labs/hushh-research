"""Trusted-device liveness heartbeat (migration 186).

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

    payload = account.TrustedDeviceHeartbeatRequest(
        machine_id="gw-studio", current_model="gemini-3.6-flash", busy=False
    )
    result = await account.trusted_device_heartbeat(
        device_id=DEVICE_ID, payload=payload, firebase_uid="u1"
    )
    assert result["recorded"] is True
    assert isinstance(result["server_time_ms"], int)
    assert seen[0]["snapshot"]["current_model"] == "gemini-3.6-flash"
