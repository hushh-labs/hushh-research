#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Validate the existing dev offer before a deploy replaces its environment."""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The shared stdlib qualification contract lives in the protocol build context.
sys.path.insert(0, str(ROOT / "consent-protocol"))
SPEC = importlib.util.spec_from_file_location(
    "pod_release_contract", ROOT / "consent-protocol/hushh_mcp/services/pod_release.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("pod release contract is unavailable")
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def serving_revision(service: dict) -> str:
    status = service["status"]
    traffic = [item for item in status["traffic"] if item.get("percent", 0) > 0]
    if len(traffic) != 1 or traffic[0]["percent"] != 100:
        raise ValueError("ambiguous serving traffic")
    revision = traffic[0].get("revisionName")
    if not revision and traffic[0].get("latestRevision") is True:
        revision = status.get("latestReadyRevisionName")
    if not isinstance(revision, str) or not re.fullmatch(
        r"[a-z][a-z0-9-]{0,62}", revision
    ):
        raise ValueError("invalid serving revision")
    return revision


def existing_offer(containers: list) -> str:
    values = {}
    for item in containers[0].get("env", []):
        name = item.get("name")
        if name not in {"HUSSH_ONE_POD_IMAGE", "HUSSH_ONE_POD_RELEASE_B64"}:
            continue
        if (
            name in values
            or "valueFrom" in item
            or not isinstance(item.get("value"), str)
        ):
            raise ValueError("invalid release environment")
        values[name] = item["value"]
    image = values.get("HUSSH_ONE_POD_IMAGE", "")
    encoded = values.get("HUSSH_ONE_POD_RELEASE_B64", "")
    if not image and not encoded:
        return "|"
    if not image or not encoded or len(encoded) > contract.MAX_RELEASE_BYTES * 2:
        raise ValueError("incomplete or oversized release environment")
    release = contract.validate_release(
        json.loads(base64.b64decode(encoded, validate=True)),
        target_image=image,
        environment="dev",
    )
    if release["image"] != image or "|" in image or "\n" in image:
        raise ValueError("release image reference mismatch")
    return image + "|" + encoded


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project")
    parser.add_argument("--region")
    parser.add_argument("--browser-review-image")
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("service observation exceeds its bound")
        if args.browser_review_image is not None:
            if len(raw) > contract.MAX_RELEASE_BYTES * 2:
                raise ValueError("release metadata exceeds its bound")
            if not raw and not args.browser_review_image:
                print("false")
                return 0
            release = contract.validate_release(
                json.loads(base64.b64decode(raw, validate=True)),
                target_image=args.browser_review_image,
                environment="dev",
            )
            # This exposes owner review, not installation or activation. The
            # runtime still checks the exact host, policy, schema and approval.
            print("true" if release.get("browserQualifications") else "false")
            return 0
        if not args.project or not args.region:
            raise ValueError("serving observation requires project and region")
        revision = serving_revision(json.loads(raw))
        observed = subprocess.run(  # noqa: S603 - fixed provider argv and validated revision
            [
                "gcloud",
                "run",
                "revisions",
                "describe",
                revision,
                "--project=" + args.project,
                "--region=" + args.region,
                "--format=json(spec.containers)",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=True,
        )
        if len(observed.stdout) > 1024 * 1024:
            raise ValueError("revision observation exceeds its bound")
        print(existing_offer(json.loads(observed.stdout)["spec"]["containers"]))
    except Exception:
        # The input can contain unrelated private environment values. Never echo it.
        print(
            "Existing dev pod offer is unverifiable; refusing deployment",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
