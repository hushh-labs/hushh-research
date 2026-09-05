#!/usr/bin/env python3
"""Resolve the single revision that actually serves a Cloud Run service.

Cloud Run's ``status.traffic`` can contain zero-percent tagged revisions and its
array order is not a serving-authority contract.  Release and rollback code must
therefore select the one positive, 100-percent traffic target explicitly.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class ServingState:
    revision: str
    url: str


def _traffic_percent(entry: Mapping[str, Any]) -> int:
    raw_percent = entry.get("percent", 0)
    if isinstance(raw_percent, bool):
        raise ValueError("Cloud Run traffic percent must be an integer")
    try:
        percent = int(raw_percent)
    except (TypeError, ValueError) as exc:
        raise ValueError("Cloud Run traffic percent must be an integer") from exc
    if percent < 0 or percent > 100:
        raise ValueError("Cloud Run traffic percent must be between 0 and 100")
    return percent


def resolve_serving_state(
    service: Mapping[str, Any], *, allow_missing: bool = False
) -> ServingState:
    status = service.get("status")
    if not isinstance(status, Mapping):
        if allow_missing:
            return ServingState(revision="", url="")
        raise ValueError("Cloud Run service status is missing")

    traffic = status.get("traffic")
    if not isinstance(traffic, list) or not traffic:
        if allow_missing:
            return ServingState(revision="", url=str(status.get("url") or "").strip())
        raise ValueError("Cloud Run service traffic is missing")

    positive: list[Mapping[str, Any]] = []
    for entry in traffic:
        if not isinstance(entry, Mapping):
            raise ValueError("Cloud Run traffic entry must be an object")
        if _traffic_percent(entry) > 0:
            positive.append(entry)

    if len(positive) != 1 or _traffic_percent(positive[0]) != 100:
        raise ValueError("Expected exactly one Cloud Run revision serving 100% traffic")

    serving = positive[0]
    revision = str(serving.get("revisionName") or "").strip()
    if not revision and serving.get("latestRevision") is True:
        revision = str(status.get("latestReadyRevisionName") or "").strip()
    if not revision:
        raise ValueError("Cloud Run serving revision is missing")

    url = str(status.get("url") or "").strip()
    if url and not url.startswith("https://"):
        raise ValueError("Cloud Run service URL is not HTTPS")
    return ServingState(revision=revision, url=url)


def _read_service(path: Path, *, allow_missing: bool) -> Mapping[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        if allow_missing:
            return {}
        raise ValueError(f"Cloud Run service JSON is unavailable: {path}") from exc
    if not isinstance(payload, Mapping):
        raise ValueError("Cloud Run service JSON must be an object")
    return payload


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-json", required=True, type=Path)
    parser.add_argument("--allow-missing", action="store_true")
    parser.add_argument("--expected-revision", default="")
    parser.add_argument("--github-output", default="")
    parser.add_argument("--output-prefix", default="")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        service = _read_service(args.service_json, allow_missing=args.allow_missing)
        state = resolve_serving_state(service, allow_missing=args.allow_missing)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    expected_revision = str(args.expected_revision or "").strip()
    if expected_revision and state.revision != expected_revision:
        print(
            f"Cloud Run serving revision mismatch: expected {expected_revision}, "
            f"got {state.revision or '<missing>'}",
            file=sys.stderr,
        )
        return 1

    prefix = str(args.output_prefix or "").strip()
    if prefix and not prefix.endswith("_"):
        prefix = f"{prefix}_"
    result = {"revision": state.revision, "url": state.url}
    if args.github_output:
        with Path(args.github_output).open("a", encoding="utf-8") as output:
            output.write(f"{prefix}revision={state.revision}\n")
            output.write(f"{prefix}url={state.url}\n")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
