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
sys.path.insert(0, str(REPO_ROOT / "scripts" / "ci"))
sys.path.insert(0, str(REPO_ROOT / "deploy" / "observability"))
from auth_health_read_diagnostics import (  # noqa: E402
    HealthOutcomeReason,
    HealthOutcomeStatus,
    HealthRuntimeStatus,
    validate_health_outcome,
)


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
    project: str,
    status: str,
    checked: int,
    *,
    runtime_status: str | None = None,
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
    reason_codes: tuple[str, ...] = ()

    @property
    def status(self) -> str:
        if self.failures:
            return "failed"
        return "unavailable" if self.unavailable else "healthy"


class CheckSummary(NamedTuple):
    failures: list[str]
    unchecked: list[str]
    phone_results: list[str]
    reason_codes: set[str]


def check_list(spec: ProtectedListSpec) -> ListCheck:
    name, project = spec["name"], spec["project"]
    label = f"{project}/{name}"
    vs = versions(name, project)
    if not vs:
        return ListCheck(
            None,
            [],
            [f"{label}: cannot list versions (missing, or no access)"],
            (HealthOutcomeReason.VERSION_LIST_UNAVAILABLE.value,),
        )
    current_raw = read(name, project, vs[0])
    if current_raw is None:
        return ListCheck(
            None,
            [],
            [f"{label}: cannot read version {vs[0]}"],
            (HealthOutcomeReason.CURRENT_VERSION_UNAVAILABLE.value,),
        )
    current = entries(current_raw)
    failures: list[str] = []
    unavailable: list[str] = []
    reason_codes: list[str] = []
    line = f"  {label:46s} v{vs[0]:<4s} {len(current):4d} entries"
    if len(current) < spec["min_entries"]:
        reason_codes.append(HealthOutcomeReason.PROTECTED_LIST_FAILED.value)
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
            reason_codes.append(HealthOutcomeReason.PREVIOUS_VERSION_UNAVAILABLE.value)
            unavailable.append(f"{label}: cannot verify previous enabled version")
        else:
            prev = entries(prev_raw)
            current_set = set(current)
            lost = [entry for entry in prev if entry not in current_set]
            line += f"   (prev v{vs[1]}: {len(prev)}, lost {len(lost)})"
            if len(lost) > spec["max_shrink"]:
                reason_codes.append(HealthOutcomeReason.PROTECTED_LIST_FAILED.value)
                failures.append(
                    f"{label}: {len(lost)} entries present in v{vs[1]} are gone from "
                    f"v{vs[0]} (limit {spec['max_shrink']}). A write replaced the list "
                    f"instead of adding to it. Restore with: "
                    f"scripts/ops/secret_list_edit.py --secret {name} "
                    f"--project {project} --restore-from {vs[1]} --apply"
                )
                line += "   *** ENTRIES LOST ***"
    return ListCheck(line, failures, unavailable, tuple(sorted(set(reason_codes))))


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


def _checked_phone_list_count(tracked: list[ProtectedListSpec]) -> int:
    phone_lists = {"HUSHH_UAT_PHONE_TEST_NUMBERS", "HUSHH_PROD_PHONE_TEST_NUMBERS"}
    return sum(spec["name"] in phone_lists for spec in tracked)


def _collect_list_checks(
    tracked: list[ProtectedListSpec], *, quiet: bool
) -> CheckSummary:
    summary = CheckSummary([], [], [], set())
    for spec in tracked:
        result = check_list(spec)
        summary.failures.extend(result.failures)
        summary.unchecked.extend(result.unavailable)
        summary.reason_codes.update(result.reason_codes)
        if result.summary is not None and not quiet:
            print(result.summary)
        if spec["name"] in {
            "HUSHH_UAT_PHONE_TEST_NUMBERS",
            "HUSHH_PROD_PHONE_TEST_NUMBERS",
        }:
            summary.phone_results.append(result.status)
    return summary


def _record_missing_phone_list(
    tracked: list[ProtectedListSpec], summary: CheckSummary
) -> None:
    if _checked_phone_list_count(tracked):
        return
    if "unavailable" not in summary.phone_results:
        summary.phone_results.append("unavailable")
    summary.unchecked.append(
        "No protected phone list configured for health observation"
    )
    summary.reason_codes.add(HealthOutcomeReason.PHONE_LIST_UNCONFIGURED.value)


def _observe_phone_runtime(project: str, summary: CheckSummary, *, quiet: bool) -> str:
    runtime_status = check_phone_runtime(project)
    summary.phone_results.append(runtime_status)
    if not quiet:
        print(f"Phone test runtime observation: {runtime_status}")
    if runtime_status != "healthy":
        summary.reason_codes.add(HealthOutcomeReason.PHONE_RUNTIME_UNAVAILABLE.value)
        summary.unchecked.append(
            "Serving phone-test runtime readiness unavailable; inspect deployed configuration"
        )
    return runtime_status


def _publish_phone_health(
    project: str,
    tracked: list[ProtectedListSpec],
    summary: CheckSummary,
    runtime_status: str | None,
) -> None:
    status = (
        "failed"
        if "failed" in summary.phone_results
        else "unavailable"
        if not summary.phone_results or "unavailable" in summary.phone_results
        else "healthy"
    )
    if status == "failed":
        summary.reason_codes.add(HealthOutcomeReason.PROTECTED_LIST_FAILED.value)
    published = publish_phone_health(
        project,
        status,
        _checked_phone_list_count(tracked),
        runtime_status=runtime_status,
    )
    if not published:
        summary.reason_codes.add(HealthOutcomeReason.HEALTH_PUBLICATION_UNAVAILABLE.value)
        summary.unchecked.append(
            "Auth phone-list health publication unavailable; check logging writer permission"
        )


def _emit_health_result(
    tracked: list[ProtectedListSpec],
    summary: CheckSummary,
    runtime_status: str | None,
) -> int:
    status = (
        HealthOutcomeStatus.FAILED.value
        if summary.failures
        else HealthOutcomeStatus.UNAVAILABLE.value
        if summary.unchecked
        else HealthOutcomeStatus.HEALTHY.value
    )
    outcome = validate_health_outcome(
        {
            "status": status,
            "reason_codes": sorted(summary.reason_codes),
            "checked_lists": _checked_phone_list_count(tracked),
            "runtime_status": runtime_status
            or HealthRuntimeStatus.NOT_REQUESTED.value,
        }
    )
    print(json.dumps(outcome, separators=(",", ":")))
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
    ap.add_argument(
        "--health-result-json",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = ap.parse_args()
    if (args.publish_health or args.check_phone_runtime) and args.project not in {
        "hushh-pda",
        "hushh-pda-uat",
    }:
        ap.error("phone-health options require one governed --project")
    if args.health_result_json and not args.publish_health:
        ap.error("health result output requires governed phone-health publication")

    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    tracked = [s for s in config["secrets"] if not args.project or s["project"] == args.project]
    if not tracked and not args.check_phone_runtime and not args.publish_health:
        print("No tracked secrets for that project.")
        return 0

    summary = _collect_list_checks(tracked, quiet=args.health_result_json)
    runtime_status = None
    if args.publish_health or args.check_phone_runtime:
        _record_missing_phone_list(tracked, summary)
    if args.check_phone_runtime:
        runtime_status = _observe_phone_runtime(
            args.project, summary, quiet=args.health_result_json
        )
    if args.publish_health:
        _publish_phone_health(args.project, tracked, summary, runtime_status)
    if args.health_result_json:
        return _emit_health_result(tracked, summary, runtime_status)
    return report_results(len(tracked), summary.failures, summary.unchecked)


if __name__ == "__main__":
    raise SystemExit(main())
