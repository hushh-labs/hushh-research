#!/usr/bin/env python3
"""Detect a list-valued secret that has been wiped.

`gcloud secrets versions add` replaces the entire value. Editing a list without
reading it first deletes every other entry, silently, with no error and no
alert. On 2026-09-03 HUSHH_UAT_PHONE_TEST_NUMBERS went from 59 entries to 1
that way. Nobody noticed for five days, and when it surfaced it looked like
phone verification was broken rather than like configuration had been deleted.

Old versions are the only record that anything was lost, and nothing reads them.
This does.

For each secret declared in config/protected-lists.json it fails when:

  * the current value has fewer entries than `min_entries` -- a floor no
    legitimate edit crosses; or
  * more than `max_shrink` entries disappeared between the previous version and
    the current one -- removing a departed tester is normal, losing 58 is not.

It prints counts only, never values.

Exit 0 = healthy, 1 = a list was wiped or shrank suspiciously, 2 = could not check.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple, TypedDict

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG = REPO_ROOT / "config" / "protected-lists.json"
SPLIT = re.compile(r"[,;\n]+")


def entries(raw: str) -> list[str]:
    out = []
    for part in SPLIT.split(raw):
        part = part.strip()
        if not part:
            continue
        digits = re.sub(r"[^0-9+@._a-zA-Z-]", "", part)
        if digits:
            out.append(digits)
    return out


def gcloud(args: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(  # noqa: S603 - fixed CLI argv, never shell interpolation
            ["gcloud", *args], capture_output=True, text=True, check=False, timeout=45
        )
    except (OSError, subprocess.TimeoutExpired):
        return 124, ""
    return proc.returncode, proc.stdout


def versions(secret: str, project: str) -> list[str]:
    code, out = gcloud(
        ["secrets", "versions", "list", secret, f"--project={project}",
         "--filter=state:ENABLED", "--sort-by=~createTime", "--format=value(name)", "--limit=2"]
    )
    return out.split() if code == 0 else []


def read(secret: str, project: str, version: str) -> str | None:
    code, out = gcloud(
        ["secrets", "versions", "access", version,
         f"--secret={secret}", f"--project={project}"]
    )
    return out if code == 0 else None


def publish_phone_health(
    project: str, status: str, checked: int, *, runtime_status: str | None = None
) -> bool:
    """Publish only bounded status/count metadata, never a secret or provider error."""
    fields = {
        "message": "auth.test_allowlist.health",
        "status": status,
        "checked_lists": checked,
    }
    if runtime_status is not None:
        fields["runtime_status"] = runtime_status
    payload = json.dumps(fields, separators=(",", ":"))
    code, _ = gcloud(
        [
            "logging",
            "write",
            "obs-auth-health",
            payload,
            f"--project={project}",
            "--payload-type=json",
            "--severity=INFO" if status == "healthy" else "--severity=ERROR",
        ]
    )
    return code == 0


def phone_runtime_authority(project: str) -> tuple[str, str] | None:
    """Resolve only the governed service's authenticated, unambiguous serving origin."""
    if project not in {"hushh-pda", "hushh-pda-uat"}:
        return None
    code, raw = gcloud(
        [
            "run",
            "services",
            "describe",
            "consent-protocol",
            f"--project={project}",
            "--region=us-central1",
            "--format=json(metadata.name,status.url,status.traffic)",
        ]
    )
    if code or len(raw) > 65536:
        return None
    try:
        payload = json.loads(raw)
        status = payload["status"]
        traffic = status["traffic"]
        if not isinstance(traffic, list) or any(
            type(row.get("percent", 0)) is not int or not 0 <= row.get("percent", 0) <= 100
            for row in traffic
        ):
            return None
        active = [row for row in traffic if row.get("percent", 0) > 0]
        from urllib.parse import urlsplit

        address = urlsplit(status["url"])
        if (
            payload["metadata"]["name"] != "consent-protocol"
            or len(active) != 1
            or active[0]["percent"] != 100
            or not re.fullmatch(r"consent-protocol-[a-z0-9-]{1,46}", active[0]["revisionName"])
            or address.scheme != "https"
            or address.username
            or address.password
            or address.port
            or not re.fullmatch(
                r"consent-protocol-[a-z0-9]+(?:-[a-z0-9]+)*[.][a-z0-9]+(?:-[a-z0-9]+)*[.]run[.]app",
                address.hostname or "",
            )
            or len(address.hostname) > 253
            or address.path
            or address.query
            or address.fragment
        ):
            return None
        return status["url"], active[0]["revisionName"]
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def read_phone_runtime(origin: str) -> str:
    """A bounded unauthenticated GET; curl configuration, proxies and redirects are off."""
    try:
        result = subprocess.run(  # noqa: S603 - only the authenticated service's validated origin
            [
                "curl",
                "--disable",
                "--silent",
                "--show-error",
                "--fail",
                "--max-time",
                "10",
                "--max-filesize",
                "16384",
                "--max-redirs",
                "0",
                "--proto",
                "=https",
                "--noproxy",
                "*",
                "--write-out",
                "\n%{http_code}",
                origin + "/health/ready",
            ],
            capture_output=True,
            check=False,
            timeout=15,
        )
        if result.returncode or len(result.stdout) > 16388:
            return "unavailable"
        body, status = result.stdout.rsplit(b"\n", 1)
        payload = json.loads(body)
        if (
            status == b"200"
            and payload["status"] == "ready"
            and payload["checks"]["phone_test_transport"] == "healthy"
        ):
            return "healthy"
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError):
        pass
    return "unavailable"


def check_phone_runtime(project: str) -> str:
    authority = phone_runtime_authority(project)
    if authority is None:
        return "unavailable"
    status = read_phone_runtime(authority[0])
    # A changed serving target cannot inherit the previous process's observation.
    return status if phone_runtime_authority(project) == authority else "unavailable"


class ProtectedListSpec(TypedDict):
    name: str
    project: str
    min_entries: int
    max_shrink: int


class ListCheck(NamedTuple):
    """A secret check retains only counts and sanitized operational diagnostics."""

    summary: str | None
    failures: list[str]
    unavailable: list[str]

    @property
    def status(self) -> str:
        if self.failures:
            return "failed"
        return "unavailable" if self.unavailable else "healthy"


def check_list(spec: ProtectedListSpec) -> ListCheck:
    name, project = spec["name"], spec["project"]
    label = f"{project}/{name}"
    vs = versions(name, project)
    if not vs:
        return ListCheck(None, [], [f"{label}: cannot list versions (missing, or no access)"])
    current_raw = read(name, project, vs[0])
    if current_raw is None:
        return ListCheck(None, [], [f"{label}: cannot read version {vs[0]}"])
    current = entries(current_raw)
    failures: list[str] = []
    unavailable: list[str] = []
    line = f"  {label:46s} v{vs[0]:<4s} {len(current):4d} entries"
    if len(current) < spec["min_entries"]:
        failures.append(
            f"{label}: {len(current)} entries is below the floor of "
            f"{spec['min_entries']}. This list has been wiped. "
            f"Restore with: scripts/ops/secret_list_edit.py --secret {name} "
            f"--project {project} --restore-from <last good version> --apply"
        )
        line += "   *** BELOW FLOOR ***"
    if len(vs) > 1:
        prev_raw = read(name, project, vs[1])
        if prev_raw is None:
            unavailable.append(f"{label}: cannot verify previous enabled version")
        else:
            prev = entries(prev_raw)
            current_set = set(current)
            lost = [entry for entry in prev if entry not in current_set]
            line += f"   (prev v{vs[1]}: {len(prev)}, lost {len(lost)})"
            if len(lost) > spec["max_shrink"]:
                failures.append(
                    f"{label}: {len(lost)} entries present in v{vs[1]} are gone from "
                    f"v{vs[0]} (limit {spec['max_shrink']}). A write replaced the list "
                    f"instead of adding to it. Restore with: "
                    f"scripts/ops/secret_list_edit.py --secret {name} "
                    f"--project {project} --restore-from {vs[1]} --apply"
                )
                line += "   *** ENTRIES LOST ***"
    return ListCheck(line, failures, unavailable)


def report_results(tracked_count: int, failures: list[str], unchecked: list[str]) -> int:
    if unchecked:
        print("\nCould not check:", file=sys.stderr)
        for item in unchecked:
            print(f"  - {item}", file=sys.stderr)

    if failures:
        print("\nA protected list-valued secret has lost entries:\n", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}\n", file=sys.stderr)
        return 1

    if unchecked and not failures:
        # Never report healthy for something that was not actually read.
        return 2

    print(f"\nAll {tracked_count} tracked list secrets are intact.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="only check secrets in this project")
    ap.add_argument(
        "--publish-health",
        "--emit-health-log",
        action="store_true",
        help="Publish content-free phone-list status to Cloud Logging (explicit opt-in)",
    )
    ap.add_argument(
        "--check-phone-runtime",
        action="store_true",
        help="Also observe the governed serving phone-test readiness (explicit opt-in)",
    )
    args = ap.parse_args()
    if (args.publish_health or args.check_phone_runtime) and args.project not in {
        "hushh-pda",
        "hushh-pda-uat",
    }:
        ap.error("phone-health options require one governed --project")

    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    tracked = [s for s in config["secrets"] if not args.project or s["project"] == args.project]
    if not tracked and not args.check_phone_runtime:
        print("No tracked secrets for that project.")
        return 0

    failures: list[str] = []
    unchecked: list[str] = []
    phone_results: list[str] = []

    for spec in tracked:
        result = check_list(spec)
        failures.extend(result.failures)
        unchecked.extend(result.unavailable)
        if result.summary is not None:
            print(result.summary)
        if spec["name"] in {"HUSHH_UAT_PHONE_TEST_NUMBERS", "HUSHH_PROD_PHONE_TEST_NUMBERS"}:
            phone_results.append(result.status)

    runtime_status = None
    if args.check_phone_runtime:
        if not phone_results:
            phone_results.append("unavailable")
            unchecked.append("No protected phone list configured for runtime observation")
        runtime_status = check_phone_runtime(args.project)
        phone_results.append(runtime_status)
        print(f"Phone test runtime observation: {runtime_status}")
        if runtime_status != "healthy":
            unchecked.append(
                "Serving phone-test runtime readiness unavailable; inspect deployed configuration"
            )

    if args.publish_health:
        status = (
            "failed"
            if "failed" in phone_results
            else "unavailable"
            if not phone_results or "unavailable" in phone_results
            else "healthy"
        )
        checked_lists = sum(
            spec["name"] in {"HUSHH_UAT_PHONE_TEST_NUMBERS", "HUSHH_PROD_PHONE_TEST_NUMBERS"}
            for spec in tracked
        )
        if not publish_phone_health(
            args.project, status, checked_lists, runtime_status=runtime_status
        ):
            unchecked.append(
                "Auth phone-list health publication unavailable; check logging writer permission"
            )

    return report_results(len(tracked), failures, unchecked)


if __name__ == "__main__":
    raise SystemExit(main())
