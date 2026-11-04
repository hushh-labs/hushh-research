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
import subprocess
import tempfile
import sys
from pathlib import Path
from typing import Any

from managed_capability_proof import (
    CAPABILITY_PROBES,
    ERROR_TYPES,
    FIXED_PROBES,
    PROBE_NAME,
    _attempt_receipts,
    _decision_fields,
)

MAX_INPUT_CHARS = 1024 * 1024
RESULT_PREFIX = "managed_vertex_probe_result "
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
            or (
                name not in FIXED_PROBES | CAPABILITY_PROBES
                and not PROBE_NAME.fullmatch(name)
            )
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



def read_build_logs(build_id: str) -> tuple[str, str]:
    """Read one UAT build only; never emit raw provider output or change resources."""
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", build_id):
        raise ValueError("A Cloud Build UUID is required")
    filters = (
        (f'resource.type="cloud_run_job" AND resource.labels.job_name="genai-ready-{build_id}" AND textPayload:"managed_vertex_probe_result"', 20),
        (f'resource.type="build" AND resource.labels.build_id="{build_id}"', 200),
    )
    results = []
    for expression, limit in filters:
        with tempfile.TemporaryFile(mode="w+b") as output:
            subprocess.run(
                ["gcloud", "logging", "read", expression, "--project=hushh-pda-uat",
                 "--freshness=24h", f"--limit={limit}", "--format=json", "--quiet"],
                stdout=output, stderr=subprocess.DEVNULL, check=True, timeout=60,
            )
            if output.tell() > MAX_INPUT_CHARS:
                raise ValueError("Scoped log output exceeds diagnostic bound")
            output.seek(0)
            results.append(output.read(MAX_INPUT_CHARS + 1).decode("utf-8"))
    return results[0], results[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe_logs", type=Path, nargs="?")
    parser.add_argument("--build-logs", type=Path)
    parser.add_argument("--build-id", help="Read and sanitize this exact UAT Cloud Build UUID (no mutation)")
    args = parser.parse_args()
    if args.build_id and (args.probe_logs is not None or args.build_logs is not None):
        parser.error("--build-id cannot be combined with log files")
    fetched = None
    if args.build_id:
        try:
            fetched = read_build_logs(args.build_id)
        except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
            print("Could not read scoped UAT logs; verify the build UUID and authorized logging access.", file=sys.stderr)
            return 1
    summary: dict[str, Any] = {"receipt": None, "gate_failures": []}
    failed = False
    try:
        if fetched is not None:
            raw = fetched[0]
        elif args.probe_logs is None:
            raw = sys.stdin.read(MAX_INPUT_CHARS + 1)
        else:
            with args.probe_logs.open(encoding="utf-8") as stream:
                raw = stream.read(MAX_INPUT_CHARS + 1)
        summary["receipt"] = summarize_receipt(raw)
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        failed = True
    if fetched is not None or args.build_logs is not None:
        try:
            if fetched is not None:
                summary["gate_failures"] = summarize_build(fetched[1])
            else:
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
