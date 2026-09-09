#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Fail closed unless UAT advertises reviewed, matching local voice packs.

Only public pack metadata is read. The verifier intentionally never downloads
model bytes, logs artifact URLs, or accepts a private registry object name.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Iterable
from typing import Any, NoReturn


SHA = re.compile(r"^[0-9a-f]{7,64}$", re.IGNORECASE)
FORBIDDEN_KEYS = {"bucket", "object_name", "registry_secret", "credential", "token"}


class LocalRuntimeReadinessError(RuntimeError):
    """UAT cannot prove a safe matching local voice runtime."""


def fail(message: str) -> NoReturn:
    print(f"verify-one-voice-local-runtime-readiness: {message}", file=sys.stderr)
    raise SystemExit(1)


def assert_no_private_metadata(value: Any) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if str(key).lower() in FORBIDDEN_KEYS:
                raise LocalRuntimeReadinessError("capability exposed private model registry metadata")
            assert_no_private_metadata(nested)
    elif isinstance(value, list):
        for nested in value:
            assert_no_private_metadata(nested)


def required_pack(
    packs: Iterable[dict[str, Any]], *, runtime: str, task: str
) -> dict[str, Any] | None:
    return next(
        (
            pack
            for pack in packs
            if pack.get("runtime") == runtime
            and isinstance(pack.get("tasks"), list)
            and task in pack["tasks"]
        ),
        None,
    )


def verify_capability(payload: Any, expected_source_sha: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise LocalRuntimeReadinessError("capability response must be an object")
    assert_no_private_metadata(payload)
    packs = payload.get("available_packs")
    if not isinstance(packs, list) or not packs or not all(isinstance(pack, dict) for pack in packs):
        raise LocalRuntimeReadinessError("no active local model packs are available")
    expected = expected_source_sha.strip().lower()
    if not SHA.fullmatch(expected):
        raise LocalRuntimeReadinessError("expected source SHA is malformed")
    required = [
        required_pack(packs, runtime="sherpa_onnx_web", task="stt"),
        required_pack(packs, runtime="onnxruntime_web", task="intent"),
    ]
    if any(pack is None for pack in required):
        raise LocalRuntimeReadinessError("UAT lacks a required local ASR or intent-ranker pack")

    catalog_versions: set[str] = set()
    for pack in required:
        assert pack is not None
        source_sha = str(pack.get("source_sha") or "").strip().lower()
        catalog_version = str(pack.get("catalog_version") or "").strip()
        checksum = str(pack.get("checksum") or "").strip()
        artifact_url = str(pack.get("artifact_url") or "").strip()
        if source_sha != expected:
            raise LocalRuntimeReadinessError("UAT local model pack source SHA does not match release")
        if not catalog_version:
            raise LocalRuntimeReadinessError("UAT local model pack has no catalog version")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
            raise LocalRuntimeReadinessError("UAT local model pack checksum is invalid")
        if not artifact_url.startswith("https://") or "?" not in artifact_url:
            raise LocalRuntimeReadinessError("UAT local model pack does not expose a signed HTTPS URL")
        catalog_versions.add(catalog_version)
    if len(catalog_versions) != 1:
        raise LocalRuntimeReadinessError("UAT ASR and intent packs use different action catalogs")
    return {
        "source_sha": expected,
        "catalog_version": next(iter(catalog_versions)),
        "pack_ids": sorted(str(pack["pack_id"]) for pack in required if pack is not None),
    }


def fetch_capability(base_url: str) -> Any:
    normalized = base_url.strip().rstrip("/")
    if not normalized.startswith("https://"):
        raise LocalRuntimeReadinessError("UAT local-runtime endpoint must use HTTPS")
    url = f"{normalized}/api/kai/local-runtime/capability"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise LocalRuntimeReadinessError(f"UAT local-runtime capability returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise LocalRuntimeReadinessError("UAT local-runtime capability is unavailable") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LocalRuntimeReadinessError("UAT local-runtime capability returned invalid JSON") from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-url", required=True)
    parser.add_argument("--source-sha", required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        result = verify_capability(fetch_capability(args.backend_url), args.source_sha)
    except LocalRuntimeReadinessError as exc:
        fail(str(exc))
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
