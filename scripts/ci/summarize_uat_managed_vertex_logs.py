#!/usr/bin/env python3
"""Summarize scoped Cloud Logging JSON without exposing provider error prose.

Read the unique candidate job's logging JSON from a path or stdin. Optionally
read the same build's logging JSON with --build-logs. This is diagnostic output only;
the release receipt validator retains all admission authority.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

MAX_INPUT_CHARS = 1024 * 1024
RESULT_PREFIX = "managed_vertex_probe_result "
CLASSIFICATIONS = frozenset(
    {
        "dependency_ok",
        "provider_unavailable",
        "candidate_misconfigured",
        "application_broken",
    }
)
ERROR_TYPES = frozenset(
    {
        "ClientError",
        "ServerError",
        "APIError",
        "ResourceExhausted",
        "ResourceExhaustedError",
        "TimeoutError",
        "ConnectionError",
        "RuntimeError",
        "ValueError",
        "KeyError",
        "LookupError",
        "AttributeError",
        "PermissionDenied",
        "Unauthenticated",
        "NotFound",
        "InvalidArgument",
        "GoogleAPICallError",
        "ServiceUnavailable",
        "DeadlineExceeded",
    }
)
PROBE_NAME = re.compile(
    r"(?:text|adk|one_chat|one_voice_live):gemini-[a-z0-9][a-z0-9._-]{0,95}"
    r"@[a-z][a-z0-9-]{0,39}(?:,[a-z][a-z0-9-]{0,39}){0,7}\Z"
)
FIXED_PROBES = frozenset(
    {"embedding", "location_command:audio", "location_command:semantics"}
)
GATE_PREFIXES = (
    "Required UAT runtime probe",
    "Required UAT runtime-identity probe",
    "One chat Vertex",
    "One voice Vertex",
    "Candidate image managed AI",
    "No probe verdict",
    "Managed Vertex candidate probe FAILED",
)
BUILD_WRAPPER = re.compile(r'^Step #[0-9]+(?: - "[a-zA-Z0-9_-]+")?:\s*')


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _decode(raw: str) -> Any:
    return json.loads(raw, object_pairs_hook=_unique_object)


def _entries(raw: str) -> list[dict[str, Any]]:
    if len(raw) > MAX_INPUT_CHARS:
        raise ValueError("Oversized log input")
    entries = _decode(raw)
    if not isinstance(entries, list) or len(entries) > 1000:
        raise ValueError("Invalid log entries")
    if any(not isinstance(entry, dict) for entry in entries):
        raise ValueError("Invalid log entry")
    return entries


def _decision_fields(value: dict[str, Any]) -> dict[str, Any]:
    if (
        type(value.get("ok")) is not bool
        or value.get("classification") not in CLASSIFICATIONS
    ):
        raise ValueError("Invalid decision fields")
    return {"ok": value["ok"], "classification": value["classification"]}


def _attempt_receipts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        raise ValueError("Invalid probe attempts")
    result = []
    for attempt in value:
        if not isinstance(attempt, dict):
            raise ValueError("Invalid probe attempt")
        elapsed = attempt.get("elapsed_ms")
        if type(elapsed) is not int or not 0 <= elapsed <= 420000:
            raise ValueError("Invalid probe duration")
        clean = {**_decision_fields(attempt), "elapsed_ms": elapsed}
        if "dispatched" in attempt:
            if type(attempt["dispatched"]) is not bool:
                raise ValueError("Invalid dispatch flag")
            clean["dispatched"] = attempt["dispatched"]
        if "resource_exhausted" in attempt:
            if type(attempt["resource_exhausted"]) is not bool:
                raise ValueError("Invalid attempt exhaustion flag")
            clean["resource_exhausted"] = attempt["resource_exhausted"]
        if "error_type" in attempt:
            error_type = attempt["error_type"]
            clean["error_type"] = (
                error_type
                if isinstance(error_type, str) and error_type in ERROR_TYPES
                else "OtherError"
            )
        result.append(clean)
    return result


def summarize_receipt(raw: str) -> dict[str, Any]:
    receipts = []
    for entry in _entries(raw):
        text = entry.get("textPayload")
        if isinstance(text, str) and RESULT_PREFIX in text:
            receipts.append(_decode(text.split(RESULT_PREFIX, 1)[1]))
        payload = entry.get("jsonPayload")
        if (
            isinstance(payload, dict)
            and payload.get("check") == "managed_vertex_runtime"
        ):
            receipts.append(payload)
    if len(receipts) != 1 or not isinstance(receipts[0], dict):
        raise ValueError("Missing or ambiguous receipt")
    receipt = receipts[0]
    if receipt.get("check") != "managed_vertex_runtime":
        raise ValueError("Invalid receipt check")
    result = {"check": "managed_vertex_runtime", **_decision_fields(receipt)}
    if "resource_exhausted" in receipt:
        if type(receipt["resource_exhausted"]) is not bool:
            raise ValueError("Invalid resource exhaustion flag")
        result["resource_exhausted"] = receipt["resource_exhausted"]
    if "error_type" in receipt:
        error_type = receipt["error_type"]
        result["error_type"] = (
            error_type
            if isinstance(error_type, str) and error_type in ERROR_TYPES
            else "OtherError"
        )
    if "config_hash" in receipt:
        digest = receipt["config_hash"]
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid config hash")
        result["config_hash"] = digest
    probes = receipt.get("probes")
    if not isinstance(probes, list) or len(probes) > 128:
        raise ValueError("Invalid probes")
    clean_probes = []
    seen = set()
    for probe in probes:
        if not isinstance(probe, dict):
            raise ValueError("Invalid probe")
        name = probe.get("probe")
        if (
            not isinstance(name, str)
            or name in seen
            or (name not in FIXED_PROBES and not PROBE_NAME.fullmatch(name))
        ):
            raise ValueError("Invalid probe name")
        seen.add(name)
        clean = {"probe": name, **_decision_fields(probe)}
        if "attempts" in probe:
            clean["attempts"] = _attempt_receipts(probe["attempts"])
        if "resource_exhausted" in probe:
            if type(probe["resource_exhausted"]) is not bool:
                raise ValueError("Invalid resource exhaustion flag")
            clean["resource_exhausted"] = probe["resource_exhausted"]
        if "error_type" in probe:
            clean["error_type"] = (
                probe["error_type"]
                if probe["error_type"] in ERROR_TYPES
                else "OtherError"
            )
        clean_probes.append(clean)
    result["probes"] = clean_probes
    return result


def summarize_build(raw: str) -> list[str]:
    found = set()
    for entry in _entries(raw):
        text = entry.get("textPayload")
        if not isinstance(text, str):
            continue
        for line in text.splitlines():
            message = BUILD_WRAPPER.sub("", line.strip())
            found.update(
                prefix for prefix in GATE_PREFIXES if message.startswith(prefix)
            )
    return [prefix for prefix in GATE_PREFIXES if prefix in found]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe_logs", type=Path, nargs="?")
    parser.add_argument("--build-logs", type=Path)
    args = parser.parse_args()
    summary: dict[str, Any] = {"receipt": None, "gate_failures": []}
    failed = False
    try:
        if args.probe_logs is None:
            raw = sys.stdin.read(MAX_INPUT_CHARS + 1)
        else:
            with args.probe_logs.open(encoding="utf-8") as stream:
                raw = stream.read(MAX_INPUT_CHARS + 1)
        summary["receipt"] = summarize_receipt(raw)
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        failed = True
    if args.build_logs is not None:
        try:
            with args.build_logs.open(encoding="utf-8") as stream:
                summary["gate_failures"] = summarize_build(
                    stream.read(MAX_INPUT_CHARS + 1)
                )
        except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
            failed = True
    print(json.dumps(summary, separators=(",", ":"), sort_keys=True))
    if failed:
        print(
            "Managed Vertex diagnostic logs are missing or malformed.", file=sys.stderr
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
