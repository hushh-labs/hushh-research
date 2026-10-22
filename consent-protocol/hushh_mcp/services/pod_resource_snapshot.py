"""Owner-local numeric resource observations; no daemon, telemetry or private contents."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Literal, TypedDict

_CGROUP = Path("/sys/fs/cgroup")
_CPU = ("usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec")
_EVENTS = ("low", "high", "max", "oom", "oom_kill")


class MemorySnapshot(TypedDict):
    currentBytes: int | None
    peakBytes: int | None
    limitBytes: int | None
    unlimited: bool | None
    events: dict[str, int]


class SharedMemorySnapshot(TypedDict):
    capacityBytes: int
    usedBytes: int
    availableBytes: int


class ResourceSnapshot(TypedDict):
    status: Literal["available", "partial", "unavailable"]
    observedAtMs: int
    memory: MemorySnapshot
    cpu: dict[str, int]
    sharedMemory: SharedMemorySnapshot | None


def _read(name: str) -> str | None:
    try:
        with (_CGROUP / name).open(encoding="ascii") as source:
            value = source.read(8193)
        return value.strip() if len(value) <= 8192 else None
    except (OSError, UnicodeError):
        return None


def _integer(value: str | None) -> int | None:
    if value is None or len(value) > 20 or not value.isascii() or not value.isdecimal():
        return None
    number = int(value)
    return number if number <= 2**64 - 1 else None


def _counters(name: str, allowed: tuple[str, ...]) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in (_read(name) or "").splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[0] not in allowed:
            continue
        value = _integer(parts[1])
        if value is not None:
            result[parts[0]] = value
    return result


def _shared_memory() -> SharedMemorySnapshot | None:
    try:
        # Fixed numeric filesystem accounting, without opening or creating files.
        value = os.statvfs("/dev/shm")  # noqa: S108 # nosec B108
        capacity = value.f_blocks * value.f_frsize
        used = (value.f_blocks - value.f_bfree) * value.f_frsize
        available = value.f_bavail * value.f_frsize
        if 0 <= used <= capacity and 0 <= available <= capacity:
            return {"capacityBytes": capacity, "usedBytes": used, "availableBytes": available}
    except OSError:
        pass
    return None


def resource_snapshot() -> ResourceSnapshot:
    """Cumulative cgroup-v2 counters and whole /dev/shm usage, sampled non-atomically."""
    result: ResourceSnapshot = {
        "status": "unavailable",
        "observedAtMs": int(time.time() * 1000),
        "memory": {
            "currentBytes": None,
            "peakBytes": None,
            "limitBytes": None,
            "unlimited": None,
            "events": {},
        },
        "cpu": {},
        "sharedMemory": None,
    }
    if sys.platform != "linux":
        return result
    memory = result["memory"]
    memory["currentBytes"] = _integer(_read("memory.current"))
    memory["peakBytes"] = _integer(_read("memory.peak"))
    maximum = _read("memory.max")
    memory["limitBytes"] = _integer(maximum)
    if maximum == "max" or memory["limitBytes"] is not None:
        memory["unlimited"] = maximum == "max"
    memory["events"] = _counters("memory.events", _EVENTS)
    result["cpu"] = _counters("cpu.stat", _CPU)
    result["sharedMemory"] = _shared_memory()
    if all(
        value is not None
        for value in (memory["currentBytes"], memory["peakBytes"], memory["unlimited"])
    ) and (
        len(memory["events"]) == len(_EVENTS)
        and len(result["cpu"]) == len(_CPU)
        and result["sharedMemory"] is not None
    ):
        result["status"] = "available"
    elif any(
        value is not None
        for value in (memory["currentBytes"], memory["peakBytes"], memory["unlimited"])
    ) or (memory["events"] or result["cpu"] or result["sharedMemory"] is not None):
        result["status"] = "partial"
    return result
