#!/usr/bin/env python3
"""Operator CLI for the allowlisted One Location event pilot.

Admission passes are written only to an explicitly named new local file. They
are never printed, logged, accepted as command-line arguments, or committed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROTOCOL_ROOT.parent
REPO_TMP_ROOT = (REPO_ROOT / "tmp").resolve()
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from hushh_mcp.services.one_location_event_admission_service import (  # noqa: E402
    OneLocationEventAdmissionService,
)


def _datetime(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("use an ISO-8601 timestamp with timezone") from exc


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create-event")
    create.add_argument("--name", required=True)
    create.add_argument("--venue-place-id", required=True)
    create.add_argument("--venue-label", required=True)
    create.add_argument("--venue-latitude", type=float, required=True)
    create.add_argument("--venue-longitude", type=float, required=True)
    create.add_argument("--starts-at", type=_datetime, required=True)
    create.add_argument("--ends-at", type=_datetime, required=True)
    create.add_argument("--created-by-user-id")
    create.add_argument("--activate", action="store_true")

    for command in ("activate-event", "pause-event", "close-event"):
        event_status = commands.add_parser(command)
        event_status.add_argument("--event-id", required=True)

    issue = commands.add_parser("issue-admissions")
    issue.add_argument("--event-id", required=True)
    issue.add_argument("--count", type=int, required=True)
    issue.add_argument(
        "--output",
        type=Path,
        required=True,
        help="New local JSON file; the command refuses to overwrite it.",
    )
    return parser


def _required_pass_output(path: Path) -> Path:
    target = path.expanduser().resolve()
    if target.is_relative_to(REPO_ROOT) and not target.is_relative_to(REPO_TMP_ROOT):
        raise ValueError(
            f"Admission passes must be written outside the repository or under {REPO_TMP_ROOT}."
        )
    return target


def _write_passes(path: Path, *, event_id: str, passes: list[str]) -> None:
    target = _required_pass_output(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    descriptor = os.open(target, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                {
                    "eventId": event_id,
                    "passes": [
                        {"number": index, "admissionPass": token}
                        for index, token in enumerate(passes, start=1)
                    ],
                },
                handle,
                indent=2,
            )
            handle.write("\n")
    except Exception:
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    service = OneLocationEventAdmissionService()
    if args.command == "create-event":
        event = service.create_event(
            display_name=args.name,
            venue_place_id=args.venue_place_id,
            venue_label=args.venue_label,
            venue_latitude=args.venue_latitude,
            venue_longitude=args.venue_longitude,
            starts_at=args.starts_at,
            ends_at=args.ends_at,
            created_by_user_id=args.created_by_user_id,
            activate=args.activate,
        )
        print(f"Event created: {event['event_id']} ({event['status']})")
        return 0
    if args.command in {"activate-event", "pause-event", "close-event"}:
        status = {
            "activate-event": "active",
            "pause-event": "paused",
            "close-event": "closed",
        }[args.command]
        event = service.set_event_status(event_id=args.event_id, status=status)
        print(f"Event {event['event_id']} is now {event['status']}.")
        return 0
    if args.command == "issue-admissions":
        try:
            output = _required_pass_output(args.output)
        except ValueError as exc:
            parser.error(str(exc))
        if output.exists():
            parser.error("Admission pass output already exists.")
        passes = service.issue_admissions(event_id=args.event_id, count=args.count)
        _write_passes(output, event_id=args.event_id, passes=passes)
        print(f"Wrote {len(passes)} one-time passes to the requested local file.")
        return 0
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
