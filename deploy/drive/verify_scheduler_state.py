#!/usr/bin/env python3
"""Capture and verify the exact UAT Drive scheduler target around worker rollout."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

JOB_SERVICE_ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
DRAIN_PATH = "/api/internal/drive-work/drain"
WORKER_HOST = re.compile(r"consent-protocol-drive-worker-[a-z0-9-]+\.a\.run\.app\Z")


def _https_url(value: object, *, drain_target: bool) -> str:
    if not isinstance(value, str) or any(char in value for char in "\x00\r\n\t"):
        raise ValueError("Drive scheduler URL is missing or malformed")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.query
        or parsed.fragment
        or (parsed.path != DRAIN_PATH if drain_target else parsed.path not in ("", "/"))
        or (
            parsed.hostname != "api.uat.hushh.ai"
            and not WORKER_HOST.fullmatch(parsed.hostname)
        )
    ):
        raise ValueError("Drive scheduler URL is outside the reviewed UAT boundary")
    return value


def _scheduler_state(snapshot: Path) -> tuple[str, str]:
    data = json.loads(snapshot.read_text(encoding="utf-8"))
    target = data.get("httpTarget") or {}
    oidc = target.get("oidcToken") or {}
    if oidc.get("serviceAccountEmail") != JOB_SERVICE_ACCOUNT:
        raise ValueError(
            "Drive scheduler OIDC identity is not the reviewed UAT account"
        )
    return (
        _https_url(target.get("uri"), drain_target=True),
        _https_url(oidc.get("audience"), drain_target=False),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("capture", "verify"))
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    parser.add_argument("--expected-uri")
    parser.add_argument("--expected-audience")
    args = parser.parse_args()

    uri, audience = _scheduler_state(args.snapshot)
    if args.mode == "verify":
        expected_uri = _https_url(args.expected_uri, drain_target=True)
        expected_audience = _https_url(args.expected_audience, drain_target=False)
        if (uri, audience) != (expected_uri, expected_audience):
            raise SystemExit(
                "Drive scheduler target or audience did not return to pre-worker state"
            )
        output = "restored=true\n"
    else:
        output = f"uri={uri}\naudience={audience}\n"

    with args.github_output.open("a", encoding="utf-8") as stream:
        stream.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
