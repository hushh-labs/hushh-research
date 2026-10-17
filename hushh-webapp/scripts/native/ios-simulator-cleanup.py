#!/usr/bin/env python3
"""Bounded cleanup of an explicitly selected test app; never reset a simulator."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
import uuid

APP_BUNDLE = "com.hushh.app"
APP_LABEL = f"UIKitApplication:{APP_BUNDLE}["


def app_is_running(output: str) -> bool:
    """Require a complete launchctl table before interpreting app absence."""
    if len(output) > 1_048_576:
        raise ValueError("oversized process inventory")
    lines = [line.split(maxsplit=2) for line in output.splitlines() if line.strip()]
    if len(lines) < 2 or lines[0] != ["PID", "Status", "Label"]:
        raise ValueError("unavailable process inventory")
    running = False
    for row in lines[1:]:
        if (
            len(row) != 3
            or (row[0] != "-" and re.fullmatch(r"[1-9][0-9]*", row[0]) is None)
            or re.fullmatch(r"-?[0-9]+", row[1]) is None
            or not row[2]
        ):
            raise ValueError("malformed process inventory")
        if row[2].startswith(APP_LABEL) and row[0] != "-":
            running = True
    return running


def inventory_unavailable(
    device: str, deadline: float, result: dict[str, object], reason: str
) -> dict[str, object]:
    """Record a distinct failure and independently inspect the selected device."""
    observation = {**result, "reason": reason, "simulator_state": "unavailable"}
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return observation
    try:
        devices = subprocess.run(
            ["xcrun", "simctl", "list", "devices", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=min(5, remaining),
        )
        if devices.returncode != 0 or len(devices.stdout) > 1_048_576:
            return observation
        payload = json.loads(devices.stdout)
        groups = payload["devices"]
        if not isinstance(groups, dict) or any(
            not isinstance(group, list) for group in groups.values()
        ):
            return observation
        entries = [entry for group in groups.values() for entry in group]
        if any(not isinstance(entry, dict) for entry in entries):
            return observation
        matches = [entry for entry in entries if str(entry.get("udid", "")).lower() == device]
        if len(matches) != 1:
            return observation
        state = matches[0].get("state")
        if state == "Shutdown":
            return {
                **result,
                "status": "verified_app_absent",
                "evidence": "simulator_shutdown",
                "simulator_state": "Shutdown",
                "inventory_failure": reason,
            }
        observation["simulator_state"] = "Booted" if state == "Booted" else "unresolved"
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        pass
    return observation


def cleanup(device_id: str) -> dict[str, object]:
    result: dict[str, object] = {
        "status": "unverified",
        "scope": "exact test app launchd process; not WebKit children or XCTest runner",
    }
    try:
        device = str(uuid.UUID(device_id))
    except ValueError:
        return {**result, "reason": "explicit_simulator_uuid_required"}

    deadline = time.monotonic() + 20
    try:
        terminated = subprocess.run(  # noqa: S603 - parsed UUID, fixed executable/operation, no shell
            ["xcrun", "simctl", "terminate", device, APP_BUNDLE],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
        result["termination"] = "accepted" if terminated.returncode == 0 else "refused"
    except subprocess.TimeoutExpired:
        result["termination"] = "timed_out"
    except OSError:
        return {**result, "reason": "simctl_unavailable"}

    # A refused/timed-out terminate is not evidence of either presence or
    # absence. Query launchd independently, scoped to this exact simulator.
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            inventory = subprocess.run(  # noqa: S603 - parsed UUID, fixed executable/operation, no shell
                ["xcrun", "simctl", "spawn", device, "launchctl", "list"],
                capture_output=True,
                text=True,
                check=False,
                timeout=min(10, remaining),
            )
            if inventory.returncode != 0:
                return inventory_unavailable(device, deadline, result, "process_inventory_refused")
            if not app_is_running(inventory.stdout):
                return {**result, "status": "verified_app_absent", "evidence": "launchd_app_absent"}
        except subprocess.TimeoutExpired:
            return inventory_unavailable(device, deadline, result, "process_inventory_timed_out")
        except OSError:
            return inventory_unavailable(device, deadline, result, "process_inventory_unavailable")
        except ValueError:
            return inventory_unavailable(device, deadline, result, "process_inventory_invalid")
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    return {**result, "reason": "app_still_running"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("device_id", help="Explicit UUID of the authorized test simulator.")
    report = cleanup(parser.parse_args().device_id)
    print(json.dumps(report))
    return 0 if report["status"] == "verified_app_absent" else 1


if __name__ == "__main__":
    raise SystemExit(main())
