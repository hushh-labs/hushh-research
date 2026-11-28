# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Uniform YY.M.N release version resolver, immutable bundle manifest, and ring control engine."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

STRICT_YYMN_RE = re.compile(r"^(?P<yy>[1-9][0-9])\.(?P<month>[1-9]|1[0-2])\.(?P<seq>[1-9][0-9]{0,3})$")
LEGACY_TRAIN_TAG_RE = re.compile(
    r"^(?:refs/tags/)?train/20(?P<yy>[2-9][0-9])\.(?P<month>0?[1-9]|1[0-2])\.(?P<seq>[1-9][0-9]{0,3})$"
)
UNIFIED_TAG_RE = re.compile(
    r"^(?:refs/tags/)?(?:v|train/)(?P<yy>[1-9][0-9])\.(?P<month>[1-9]|1[0-2])\.(?P<seq>[1-9][0-9]{0,3})$"
)
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SNAPSHOT_MARKER_PREFIX = "<!-- hussh-release-control-snapshot:v1\n"
SNAPSHOT_MARKER_SUFFIX = "\n-->"
MAX_PLAY_VERSION_CODE = 2_100_000_000
NOV_2026_CUTOVER_FLOOR = 50


class UnsafeReleaseBundle(ValueError):
    """Raised when a release version, mobile build code, or multi-step switch contract fails validation."""


@dataclass(frozen=True, order=True)
class ReleaseVersion:
    yy: int
    month: int
    seq: int

    def __str__(self) -> str:
        return f"{self.yy}.{self.month}.{self.seq}"

    @property
    def git_tag(self) -> str:
        return f"v{self}"

    @property
    def train_tag(self) -> str:
        return f"train/{self}"


def require(condition: Any, message: str) -> None:
    if not condition:
        raise UnsafeReleaseBundle(message)


def parse_yymn(value: str) -> ReleaseVersion:
    cleaned = str(value or "").strip()
    match = STRICT_YYMN_RE.fullmatch(cleaned)
    require(
        match is not None,
        f"Invalid YY.M.N version '{cleaned}'; expected strict SemVer without leading zeros (for example 26.11.50).",
    )
    assert match is not None
    return ReleaseVersion(int(match.group("yy")), int(match.group("month")), int(match.group("seq")))


def parse_release_tag(tag: str) -> ReleaseVersion | None:
    cleaned = str(tag or "").strip()
    for pattern in (UNIFIED_TAG_RE, LEGACY_TRAIN_TAG_RE):
        match = pattern.fullmatch(cleaned)
        if match:
            return ReleaseVersion(
                int(match.group("yy")),
                int(match.group("month")),
                int(match.group("seq")),
            )
    return None


def next_yymn_version(
    existing_tags: list[str],
    today: dt.date | None = None,
    *,
    nov_2026_floor: int = NOV_2026_CUTOVER_FLOOR,
) -> ReleaseVersion:
    ref_date = today or dt.datetime.now(dt.UTC).date()
    require(2000 <= ref_date.year <= 2099, f"Unsupported release year: {ref_date.year}")
    yy = ref_date.year % 100
    month = ref_date.month

    same_month_seqs = [
        parsed.seq
        for raw in existing_tags
        if (parsed := parse_release_tag(raw)) is not None and (parsed.yy, parsed.month) == (yy, month)
    ]
    next_seq = (max(same_month_seqs) + 1) if same_month_seqs else 1
    if (yy, month) == (26, 11):
        next_seq = max(next_seq, nov_2026_floor)
    require(1 <= next_seq <= 9999, f"Monthly release sequence {next_seq} exceeds 9999.")
    return ReleaseVersion(yy=yy, month=month, seq=next_seq)


def format_dev_nightly_version(upcoming: ReleaseVersion | str, build_seq: int, short_sha: str = "") -> str:
    parsed = upcoming if isinstance(upcoming, ReleaseVersion) else parse_yymn(upcoming)
    require(isinstance(build_seq, int) and build_seq >= 1, "Dev nightly build_seq must be >= 1.")
    suffix = f"{parsed}-dev.{build_seq}"
    if short_sha:
        cleaned_sha = short_sha.strip().lower()
        require(bool(re.fullmatch(r"[0-9a-f]{7,12}", cleaned_sha)), f"Invalid short SHA '{short_sha}'.")
        return f"{suffix}+{cleaned_sha}"
    return suffix


def compute_android_version_code(
    version: ReleaseVersion | str,
    *,
    resubmit_slot: int = 0,
    previous_version_code: int | None = None,
) -> int:
    """Compute monotonic Play Store versionCode: YY * 10_000_000 + M * 100_000 + N * 10 + R.

    Supports up to 9,999 release cuts per month and 10 native Store submissions (R = 0..9)
    on the same YY.M.N marketing version without burning the next web/backend train number.
    """
    parsed = version if isinstance(version, ReleaseVersion) else parse_yymn(version)
    require(
        isinstance(resubmit_slot, int) and not isinstance(resubmit_slot, bool) and 0 <= resubmit_slot <= 9,
        "Android Store resubmit_slot must be an integer between 0 and 9.",
    )
    require(1 <= parsed.seq <= 9999, f"Release sequence {parsed.seq} out of Play versionCode bounds (1..9999).")
    code = parsed.yy * 10_000_000 + parsed.month * 100_000 + parsed.seq * 10 + resubmit_slot
    require(code < MAX_PLAY_VERSION_CODE, f"Computed Android versionCode {code} exceeds Google Play limit.")
    if previous_version_code is not None:
        require(
            code > previous_version_code,
            f"Android versionCode {code} must strictly exceed previous versionCode {previous_version_code}.",
        )
    return code


def validate_partial_plan_switches(plans: list[dict[str, Any]]) -> list[str]:
    """Verify every incomplete multi-step Project 79 plan is switched OFF outside Dev."""
    verified_switches: list[str] = []
    for plan in plans:
        issue = str(plan.get("issue") or plan.get("title") or "unknown-plan").strip()
        completed = int(plan.get("completed_steps", 0))
        total = int(plan.get("total_steps", 0))
        require(total >= 1 and 0 <= completed <= total, f"Invalid step counts ({completed}/{total}) on plan {issue}.")
        if completed == total or completed == 0:
            continue
        if bool(plan.get("backend_internal_only", False)):
            continue
        switch_name = str(plan.get("switch_name") or "").strip()
        disabled_outside_dev = plan.get("disabled_outside_dev") is True
        require(
            bool(switch_name) and disabled_outside_dev,
            f"Incomplete multi-step plan {issue} ({completed}/{total} steps) cannot promote without an active "
            f"off-by-default runtime switch in UAT and Production.",
        )
        if switch_name not in verified_switches:
            verified_switches.append(switch_name)
    return sorted(verified_switches)


def build_release_bundle_manifest(
    *,
    version: ReleaseVersion | str,
    source_sha: str,
    web_image_digest: str,
    backend_image_digest: str,
    pod_image_digest: str,
    db_schema_version: int,
    ios_min_version: str,
    android_min_version_code: int,
    plans: list[dict[str, Any]] | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    parsed = version if isinstance(version, ReleaseVersion) else parse_yymn(version)
    require(bool(SHA40_RE.fullmatch(source_sha)), f"Invalid 40-char source SHA '{source_sha}'.")
    for label, digest in (
        ("web_image_digest", web_image_digest),
        ("backend_image_digest", backend_image_digest),
        ("pod_image_digest", pod_image_digest),
    ):
        require(bool(DIGEST_RE.fullmatch(digest)), f"Invalid immutable {label} '{digest}'.")
    require(isinstance(db_schema_version, int) and db_schema_version >= 1, "db_schema_version must be >= 1.")
    parse_yymn(ios_min_version) if STRICT_YYMN_RE.fullmatch(ios_min_version) else require(
        bool(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", ios_min_version)),
        f"Invalid ios_min_version '{ios_min_version}'.",
    )
    require(isinstance(android_min_version_code, int) and android_min_version_code >= 1, "Invalid Android floor.")
    verified_switches = validate_partial_plan_switches(plans or [])

    core_payload = {
        "schema": "hussh-release-bundle-v1",
        "version": str(parsed),
        "git_tag": parsed.git_tag,
        "train_tag": parsed.train_tag,
        "source_sha": source_sha,
        "artifacts": {
            "web_image_digest": web_image_digest,
            "backend_image_digest": backend_image_digest,
            "pod_image_digest": pod_image_digest,
        },
        "compatibility": {
            "db_schema_version": db_schema_version,
            "ios_min_version": ios_min_version,
            "android_min_version_code": android_min_version_code,
            "android_release_version_code": compute_android_version_code(parsed, resubmit_slot=0),
        },
        "verified_off_switches": verified_switches,
        "created_at": created_at or dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    digest = hashlib.sha256(json.dumps(core_payload, sort_keys=True).encode("utf-8")).hexdigest()
    return {**core_payload, "bundle_sha256": digest}


def classify_ring_status(ring: dict[str, Any]) -> str:
    """Compute honest ring status across Web, Backend, Pod, branch tip, and traffic posture."""
    posture = str(ring.get("posture") or "live")
    web_sha = str(ring.get("web_sha") or "")
    backend_sha = str(ring.get("backend_sha") or "")
    target_sha = str(ring.get("branch_sha") or "")
    if posture == "stage_dark":
        if int(ring.get("warm_pods", 0)) == 0 and int(ring.get("public_traffic_percent", 0)) == 0:
            return "DARK_STAGE_COLD_READY"
        return "DARK_STAGE_WARM"
    if web_sha and backend_sha and web_sha != backend_sha:
        return "SPLIT_SERVICE"
    if bool(ring.get("hotfix_diverged", False)):
        return "HOTFIX_DIVERGED"
    if bool(ring.get("hold_active", False)) and target_sha and web_sha and web_sha != target_sha:
        return "HELD_ON_BASELINE"
    if target_sha and web_sha and web_sha != target_sha:
        return "DEPLOY_PENDING"
    return "IN_SYNC"


def render_control_center_markdown(snapshot: dict[str, Any]) -> str:
    """Render the human-first Pinned GitHub Release Control Center body + embedded JSON snapshot."""
    updated_at = snapshot.get("updated_at") or dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    next_version = snapshot.get("next_version", "26.11.50")
    rings: list[dict[str, Any]] = snapshot.get("rings", [])
    stores: list[dict[str, Any]] = snapshot.get("mobile_stores", [])
    plans: list[dict[str, Any]] = snapshot.get("active_plans", [])
    rehearsal: dict[str, Any] = snapshot.get("production_rehearsal", {})

    lines = [
        "# Hussh Release Control Center",
        "",
        f"**Last Updated:** `{updated_at}` · **Upcoming Bundle Cut:** `v{next_version}` · "
        f"**Live Metrics View:** [metrics.hussh.si/releases](https://metrics.hussh.si/releases) · "
        f"**Active Board:** [Hussh Action Items (Project 79)](https://github.com/orgs/hushh-labs/projects/79)",
        "",
        "> [!IMPORTANT]",
        "> **Immutable Bundle & Dark-Stage Contract:** Cutting `vYY.M.N` freezes one signed bundle across Web, "
        "Backend, and Private Pods. Live Production promotes strictly by verified bundle pointer, while Cold Dark "
        "Stage (`stage.one.hussh.ai`) holds `0%` public traffic and `0` idle warm pods until cutover approval.",
        "",
        "## 1. Live Environment Ring Matrix",
        "",
        "| Ring | Serving Version | Status | Web Revision | Backend Revision | Sandbox Warm Pods | DB Schema |",
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
    ]
    for ring in rings:
        status = ring.get("status") or classify_ring_status(ring)
        lines.append(
            f"| **{ring.get('name', 'Unknown')}** | `{ring.get('version', 'n/a')}` | `{status}` | "
            f"`{ring.get('web_revision', 'n/a')}` | `{ring.get('backend_revision', 'n/a')}` | "
            f"`{ring.get('warm_pods', 'n/a')}` | `v{ring.get('db_schema', 'n/a')}` |"
        )

    lines.extend(
        [
            "",
            "## 2. Mobile Store Channels",
            "",
            "| Store Channel | Marketing Version | Build / Version Code | Floor Status | Notes |",
            "| :--- | :--- | :--- | :--- | :--- |",
        ]
    )
    for store in stores:
        lines.append(
            f"| **{store.get('channel', 'Store')}** | `{store.get('version', 'n/a')}` | "
            f"`{store.get('build_code', 'n/a')}` | `{store.get('status', 'ACTIVE')}` | "
            f"{store.get('notes', 'Aligned')} |"
        )

    lines.extend(
        [
            "",
            "## 3. Active Milestone Initiatives (Project 79)",
            "",
            "| Initiative | Target Milestone | Progress | Multi-Step Switch Outside Dev |",
            "| :--- | :--- | :--- | :--- |",
        ]
    )
    if plans:
        for plan in plans:
            done = plan.get("completed_steps", 0)
            total = plan.get("total_steps", 1)
            switch_state = (
                f"`{plan['switch_name']}` = OFF"
                if plan.get("switch_name") and done < total
                else ("Ready (`N/N`)" if done == total else "Internal / Gated")
            )
            lines.append(
                f"| {plan.get('title', 'Plan')} | `{plan.get('milestone', next_version)}` | "
                f"`{done}/{total}` | {switch_state} |"
            )
    else:
        lines.append(f"| Release Control & `v{next_version}` Baseline | `{next_version}` | `Ready` | `N/A` |")

    if rehearsal:
        lines.extend(
            [
                "",
                "## 4. Read-Only Production Convergence Rehearsal",
                "",
                f"- **Live Production Posture:** `{rehearsal.get('live_posture', 'Untouched on verified baseline')}`",
                f"- **Database Contract Alignment:** `{rehearsal.get('db_alignment', 'Converged')}`",
                f"- **Dark-Stage Hold Guardrail:** `{rehearsal.get('dark_stage_hold', 'Active (zero click-gates)')}`",
                f"- **Cutover Readiness:** {rehearsal.get('summary', 'Ready for explicit bundle promotion.')}",
            ]
        )

    normalized = {
        **snapshot,
        "updated_at": updated_at,
        "next_version": next_version,
        "rings": [{**r, "status": r.get("status") or classify_ring_status(r)} for r in rings],
    }
    lines.extend(
        [
            "",
            SNAPSHOT_MARKER_PREFIX + json.dumps(normalized, indent=2, sort_keys=True) + SNAPSHOT_MARKER_SUFFIX,
        ]
    )
    return "\n".join(lines) + "\n"


def extract_snapshot_from_markdown(body: str) -> dict[str, Any] | None:
    start = body.find(SNAPSHOT_MARKER_PREFIX)
    if start < 0:
        return None
    content_start = start + len(SNAPSHOT_MARKER_PREFIX)
    end = body.find(SNAPSHOT_MARKER_SUFFIX, content_start)
    if end < 0:
        return None
    return json.loads(body[content_start:end])


def _git_tags(repo_root: Path) -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(repo_root), "tag", "-l"],
        text=True,
        capture_output=True,
        check=True,
    )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hussh YY.M.N Release Version & Ring Control CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_next = sub.add_parser("next-version", help="Compute the next sequential YY.M.N release version")
    p_next.add_argument("--date", help="ISO date override (YYYY-MM-DD)")
    p_next.add_argument("--json", action="store_true", help="Output JSON")

    p_code = sub.add_parser("android-code", help="Compute deterministic Android Play Store versionCode")
    p_code.add_argument("version", help="YY.M.N version string (for example 26.11.50)")
    p_code.add_argument("--resubmit-slot", type=int, default=0, help="Native Store resubmit slot (0..9)")
    p_code.add_argument("--previous-code", type=int, default=None, help="Optional prior Play versionCode floor")

    p_render = sub.add_parser("render-control-center", help="Render Release Control Center Markdown from snapshot JSON")
    p_render.add_argument("--snapshot", required=True, help="Path to input snapshot JSON")
    p_render.add_argument("--output", help="Optional output markdown file path")

    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[2]

    if args.command == "next-version":
        ref_date = dt.date.fromisoformat(args.date) if args.date else None
        ver = next_yymn_version(_git_tags(repo_root), today=ref_date)
        if args.json:
            print(
                json.dumps(
                    {
                        **asdict(ver),
                        "version": str(ver),
                        "git_tag": ver.git_tag,
                        "train_tag": ver.train_tag,
                        "android_version_code": compute_android_version_code(ver),
                    }
                )
            )
        else:
            print(str(ver))
        return 0

    if args.command == "android-code":
        print(
            compute_android_version_code(
                args.version,
                resubmit_slot=args.resubmit_slot,
                previous_version_code=args.previous_code,
            )
        )
        return 0

    if args.command == "render-control-center":
        snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
        rendered = render_control_center_markdown(snapshot)
        if args.output:
            Path(args.output).write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
