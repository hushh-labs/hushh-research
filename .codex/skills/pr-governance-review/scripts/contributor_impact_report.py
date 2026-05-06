#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any


DEFAULT_REPO = "hushh-labs/hushh-research"
REPORT_PATH = "tmp/contributor-impact-dashboard.md"
LIVE_REPORT_PATH = "tmp/pr-governance-live-report.md"
GH_FIELDS = (
    "number,title,author,mergedAt,closedAt,createdAt,updatedAt,additions,"
    "deletions,changedFiles,labels,url,headRefName,baseRefName,isDraft,"
    "mergeCommit,reviewDecision,files,comments"
)


@dataclass(frozen=True)
class Window:
    label: str
    since: date
    until: date


CURATED_NOTES: dict[int, dict[str, Any]] = {
    527: {
        "cluster": "Hussh / One / Nav ontology and governance",
        "score": 20,
        "note": "Codified the Hussh, One, Kai, and Nav ontology plus governance guardrails.",
    },
    537: {
        "cluster": "One-led multi-agent runtime",
        "score": 18,
        "note": "Moved the agent runtime toward One-led specialist delegation.",
    },
    569: {
        "cluster": "Agent governance and One KYC",
        "score": 16,
        "note": "Hardened agent orchestration, subagent evidence lanes, and One KYC boundaries.",
    },
    522: {
        "cluster": "Auth, token, MCP, and revocation hardening",
        "score": 16,
        "note": "Closed a token-in-URL leak path by accepting Authorization Bearer for remote MCP.",
    },
    515: {
        "cluster": "Auth, token, MCP, and revocation hardening",
        "score": 14,
        "note": "Moved rate-limit identity away from spoofable client headers.",
    },
    428: {
        "cluster": "Auth, token, MCP, and revocation hardening",
        "score": 14,
        "note": "Made Kai stream auth use DB-backed revocation checks.",
    },
    499: {
        "cluster": "Auth, token, MCP, and revocation hardening",
        "score": 13,
        "note": "Standardized route token validation on DB-backed validation.",
    },
    521: {
        "cluster": "Auth, token, MCP, and revocation hardening",
        "score": 13,
        "note": "Brought MCP and ADK tool auth closer to revocation-aware validation.",
    },
    476: {
        "cluster": "Auth, token, MCP, and revocation hardening",
        "score": 12,
        "note": "Centralized token extraction and reduced event-loop blocking in auth middleware.",
    },
    498: {
        "cluster": "Account export and error-safety contract",
        "score": 13,
        "note": "Reduced raw API error leakage on frontend service paths.",
    },
    505: {
        "cluster": "Account export and error-safety contract",
        "score": 15,
        "note": "Added VAULT_OWNER-gated account export across backend and web proxy.",
    },
    530: {
        "cluster": "PKM/vault/local-first boundary",
        "score": 13,
        "note": "Replaced read-modify-write PKM projection with an atomic JSONB merge RPC.",
    },
    554: {
        "cluster": "PKM/vault/local-first boundary",
        "score": 12,
        "note": "Documented that cloud PKM projection is not authoritative memory.",
    },
    555: {
        "cluster": "PKM/vault/local-first boundary",
        "score": 14,
        "note": "Preserved VAULT_OWNER token flow on preference writes.",
    },
    531: {
        "cluster": "Kai chat runtime quality",
        "score": 9,
        "note": "Removed redundant portfolio DB work from chat initialization.",
    },
    529: {
        "cluster": "Kai chat runtime quality",
        "score": 10,
        "note": "Moved attribute learning out of the blocking chat response path.",
    },
    435: {
        "cluster": "Kai chat runtime quality",
        "score": 11,
        "note": "Added response validation, retry, and safe fallback behavior.",
    },
    381: {
        "cluster": "E2E route/test surface",
        "score": 8,
        "note": "Added Playwright smoke, navigation, and accessibility test surface.",
    },
    446: {
        "cluster": "Directional correction",
        "score": -18,
        "note": "Merged voice dictation surface later corrected because it duplicated canonical voice UX.",
        "lifecycle": "merged_then_reverted",
    },
    568: {
        "cluster": "Directional correction",
        "score": 15,
        "note": "Reverted the duplicate command-palette dictation surface and hardened governance.",
    },
    534: {
        "cluster": "RIA voice/action coverage",
        "score": 5,
        "note": "High-potential RIA voice/action expansion, scored with duplicate/high-churn caution.",
    },
    548: {
        "cluster": "RIA voice/action coverage",
        "score": 5,
        "note": "High-potential RIA voice/action expansion, scored with duplicate/high-churn caution.",
    },
}


VECTOR_KEYWORDS: dict[str, tuple[str, ...]] = {
    "trust/security": (
        "security",
        "auth",
        "token",
        "bearer",
        "revocation",
        "secret",
        "leak",
        "permission",
        "rate-limit",
        "session",
        "recaptcha",
    ),
    "consent/vault": (
        "consent",
        "vault",
        "vault_owner",
        "scope",
        "commercial",
        "permission",
        "export",
    ),
    "one/kai/nav": (
        "one",
        "kai",
        "nav",
        "agent",
        "voice",
        "action",
        "ontology",
        "orchestration",
    ),
    "pkm/memory": (
        "pkm",
        "memory",
        "domain summary",
        "projection",
        "cache",
        "preference",
    ),
    "user utility": (
        "ria",
        "profile",
        "dashboard",
        "chart",
        "theme",
        "onboarding",
        "delete account",
    ),
    "runtime quality": (
        "perf",
        "performance",
        "latency",
        "redundant",
        "background",
        "concurrent",
        "validation",
        "retry",
        "fallback",
        "stabilize",
    ),
    "proof/tests": (
        "test",
        "coverage",
        "playwright",
        "smoke",
        "contract",
        "pytest",
        "e2e",
    ),
    "ops/governance": (
        "governance",
        "deploy",
        "uat",
        "codex",
        "skill",
        "docs",
        "observability",
        "analytics",
        "ci",
    ),
}

VECTOR_WEIGHTS = {
    "trust/security": 18,
    "consent/vault": 18,
    "one/kai/nav": 14,
    "pkm/memory": 14,
    "user utility": 10,
    "runtime quality": 10,
    "proof/tests": 8,
    "ops/governance": 7,
}


def _run_gh(args: list[str]) -> Any:
    proc = subprocess.run(
        ["gh", *args],
        cwd=Path(__file__).resolve().parents[4],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return json.loads(proc.stdout or "[]")


def _query_closed_prs(repo: str, state: str, window: Window) -> list[dict[str, Any]]:
    key = "merged" if state == "merged" else "closed"
    search = f"{key}:>={window.since.isoformat()} {key}:<={window.until.isoformat()}"
    return _run_gh(
        [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            state,
            "--search",
            search,
            "--limit",
            "300",
            "--json",
            GH_FIELDS,
        ]
    )


def _records_for_window(repo: str, window: Window) -> list[dict[str, Any]]:
    merged = _query_closed_prs(repo, "merged", window)
    closed = [
        pr
        for pr in _query_closed_prs(repo, "closed", window)
        if not pr.get("mergedAt")
    ]
    return sorted([*merged, *closed], key=lambda pr: pr.get("closedAt") or pr.get("mergedAt") or "")


def _parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def _month_window(value: str | None) -> Window:
    today = date.today()
    if not value or value == "current":
        year, month = today.year, today.month
    else:
        year, month = map(int, value.split("-", 1))
    since = date(year, month, 1)
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    until = min(today, next_month - timedelta(days=1))
    return Window(f"{since:%B %Y} month-to-date", since, until)


def _requested_window(args: argparse.Namespace) -> Window:
    if args.since:
        since = _parse_date(args.since)
        until = _parse_date(args.until) if args.until else date.today()
        return Window(f"{since.isoformat()} to {until.isoformat()}", since, until)
    if args.month is not None:
        return _month_window(args.month)
    days = args.days or 7
    today = date.today()
    since = today - timedelta(days=days)
    return Window(f"last {days} days", since, today)


def _author(pr: dict[str, Any]) -> str:
    author = pr.get("author") or {}
    return author.get("login") or "unknown"


def _label_names(pr: dict[str, Any]) -> list[str]:
    return [label.get("name", "") for label in pr.get("labels") or [] if isinstance(label, dict)]


def _file_paths(pr: dict[str, Any]) -> list[str]:
    return [item.get("path", "") for item in pr.get("files") or [] if isinstance(item, dict)]


def _path_signal(path: str) -> str:
    signal = path
    for prefix in ("consent-protocol/", "hushh-webapp/", "contracts/", "docs/"):
        if signal.startswith(prefix):
            signal = signal[len(prefix) :]
            break
    return signal


def _comments_text(pr: dict[str, Any]) -> str:
    return "\n".join(
        comment.get("body", "")
        for comment in pr.get("comments") or []
        if isinstance(comment, dict)
    )


def _haystack(pr: dict[str, Any]) -> str:
    parts = [
        pr.get("title", ""),
        " ".join(_label_names(pr)),
        " ".join(_path_signal(path) for path in _file_paths(pr)),
    ]
    return " ".join(parts).lower()


def _vectors(pr: dict[str, Any]) -> list[str]:
    haystack = _haystack(pr)
    vectors = [
        vector
        for vector, keywords in VECTOR_KEYWORDS.items()
        if any(keyword in haystack for keyword in keywords)
    ]
    return vectors or ["general"]


def _cluster(pr: dict[str, Any], vectors: list[str]) -> str:
    curated = CURATED_NOTES.get(int(pr["number"]), {})
    if curated.get("cluster"):
        return str(curated["cluster"])
    if "trust/security" in vectors:
        return "Auth, token, and trust hardening"
    if "consent/vault" in vectors:
        return "Consent, vault, and data access"
    if "pkm/memory" in vectors:
        return "PKM, memory, and cache coherence"
    if "one/kai/nav" in vectors:
        return "One, Kai, Nav, and voice/actions"
    if "runtime quality" in vectors:
        return "Runtime quality and performance"
    if "proof/tests" in vectors:
        return "Proof, tests, and CI"
    if "ops/governance" in vectors:
        return "Operations and governance"
    return "General repo hygiene"


def _lifecycle(pr: dict[str, Any]) -> str:
    curated = CURATED_NOTES.get(int(pr["number"]), {})
    if curated.get("lifecycle"):
        return str(curated["lifecycle"])
    title = pr.get("title", "").lower()
    comments = _comments_text(pr).lower()
    if pr.get("mergedAt"):
        if title.startswith("revert") or "revert " in title:
            return "revert_correction"
        if "### maintainer patch" in comments or "approved with maintainer patch" in comments:
            return "patched_then_merged"
        return "merged"
    if "duplicate" in comments or "superseded" in comments or "duplicate" in title:
        return "closed_duplicate"
    if "drift" in comments or "not up to founder" in comments or "doesn't add value" in comments:
        return "closed_drift"
    if (pr.get("reviewDecision") or "").upper() == "CHANGES_REQUESTED":
        return "changes_requested"
    return "closed_unmerged"


def _impact_reason(pr: dict[str, Any], vectors: list[str], lifecycle: str) -> str:
    curated = CURATED_NOTES.get(int(pr["number"]), {})
    if curated.get("note"):
        return str(curated["note"])
    if lifecycle == "revert_correction":
        return "Corrected a prior surface that was no longer aligned with the current architecture."
    if "trust/security" in vectors:
        return "Improves a trust, token, auth, or security boundary."
    if "consent/vault" in vectors:
        return "Improves consent, vault, export, or scoped access behavior."
    if "pkm/memory" in vectors:
        return "Improves PKM, memory projection, cache, or vault-adjacent data flow."
    if "one/kai/nav" in vectors:
        return "Improves agent, voice, or One/Kai/Nav runtime direction."
    if "runtime quality" in vectors:
        return "Improves runtime latency, reliability, fallback, or performance."
    if "proof/tests" in vectors:
        return "Adds proof that reduces future regression risk."
    return "Resolved repo work with limited north-star signal from available metadata."


def _impact_score(pr: dict[str, Any]) -> int:
    lifecycle = _lifecycle(pr)
    vectors = _vectors(pr)
    base = {
        "merged": 10,
        "patched_then_merged": 14,
        "revert_correction": 18,
        "merged_then_reverted": -8,
        "closed_duplicate": 8,
        "closed_drift": 5,
        "changes_requested": 3,
        "closed_unmerged": 2,
    }.get(lifecycle, 0)
    score = base + sum(VECTOR_WEIGHTS.get(vector, 0) for vector in vectors)
    score += int(CURATED_NOTES.get(int(pr["number"]), {}).get("score", 0))

    haystack = _haystack(pr)
    churn = int(pr.get("additions") or 0) + int(pr.get("deletions") or 0)
    if churn < 200:
        score += 4
    elif churn > 3000:
        score -= 8
    if int(pr.get("changedFiles") or 0) > 40:
        score -= 5
    if "buy" in haystack or "not-buy" in haystack or "sell" in haystack:
        score -= 14
    if "duplicate" in haystack or "superseded" in haystack:
        score -= 6
    if "ipl" in haystack or "arena" in haystack:
        score -= 18
    if _author(pr) == "app/dependabot":
        score -= 4
    return score


def _analysis(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    analyzed = []
    for pr in records:
        vectors = _vectors(pr)
        lifecycle = _lifecycle(pr)
        analyzed.append(
            {
                "number": int(pr["number"]),
                "title": pr.get("title", ""),
                "author": _author(pr),
                "url": pr.get("url", ""),
                "createdAt": pr.get("createdAt"),
                "mergedAt": pr.get("mergedAt"),
                "closedAt": pr.get("closedAt"),
                "lifecycle": lifecycle,
                "score": _impact_score(pr),
                "vectors": vectors,
                "cluster": _cluster(pr, vectors),
                "reason": _impact_reason(pr, vectors, lifecycle),
                "additions": int(pr.get("additions") or 0),
                "deletions": int(pr.get("deletions") or 0),
                "changedFiles": int(pr.get("changedFiles") or 0),
            }
        )
    return analyzed


def _leaderboard(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    authors: dict[str, dict[str, Any]] = {}
    for item in records:
        row = authors.setdefault(
            item["author"],
            {
                "author": item["author"],
                "score": 0,
                "resolved": 0,
                "merged": 0,
                "patched": 0,
                "closed": 0,
                "reverted": 0,
                "top": [],
            },
        )
        row["score"] += item["score"]
        row["resolved"] += 1
        row["merged"] += 1 if item["mergedAt"] else 0
        row["patched"] += 1 if item["lifecycle"] == "patched_then_merged" else 0
        row["closed"] += 1 if not item["mergedAt"] else 0
        row["reverted"] += 1 if item["lifecycle"] in {"revert_correction", "merged_then_reverted"} else 0
        row["top"].append(item)
    rows = []
    for row in authors.values():
        row["top"] = sorted(row["top"], key=lambda item: item["score"], reverse=True)[:3]
        rows.append(row)
    return sorted(rows, key=lambda row: (row["score"], row["merged"], row["resolved"]), reverse=True)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2


def _resolution_days(item: dict[str, Any]) -> float | None:
    created = _parse_datetime(item.get("createdAt"))
    finished = _parse_datetime(item.get("mergedAt") or item.get("closedAt"))
    if not created or not finished:
        return None
    return max((finished - created).total_seconds() / 86400, 0.0)


def _percent(part: int, whole: int) -> str:
    if whole <= 0:
        return "0%"
    return f"{round((part / whole) * 100)}%"


def _kpis(records: list[dict[str, Any]]) -> dict[str, Any]:
    lifecycle_counts = Counter(item["lifecycle"] for item in records)
    vectors = Counter(vector for item in records for vector in item["vectors"])
    resolved = len(records)
    merged = sum(1 for item in records if item["mergedAt"])
    resolution_days = [
        value for value in (_resolution_days(item) for item in records) if value is not None
    ]
    corrected = lifecycle_counts["revert_correction"] + lifecycle_counts["merged_then_reverted"]
    governance_interventions = lifecycle_counts["closed_duplicate"] + lifecycle_counts["closed_drift"] + corrected
    return {
        "resolved_prs": resolved,
        "merged_prs": merged,
        "merge_rate": _percent(merged, resolved),
        "median_resolution_days": round(_median(resolution_days), 1),
        "contributors_represented": len({item["author"] for item in records}),
        "patched_then_merged_prs": lifecycle_counts["patched_then_merged"],
        "closed_duplicate_or_drift_prs": lifecycle_counts["closed_duplicate"] + lifecycle_counts["closed_drift"],
        "reverted_or_corrected_prs": corrected,
        "governance_intervention_load": _percent(governance_interventions, resolved),
        "trust_security_prs": vectors["trust/security"],
        "consent_vault_prs": vectors["consent/vault"],
        "one_kai_nav_alignment_prs": vectors["one/kai/nav"],
        "user_value_prs": vectors["user utility"],
        "proof_test_prs": vectors["proof/tests"],
        "high_churn_prs": sum(1 for item in records if item["additions"] + item["deletions"] > 3000),
        "duplicate_avoided_prs": lifecycle_counts["closed_duplicate"],
        "regression_corrections": corrected,
    }


def _cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


def _link(item: dict[str, Any]) -> str:
    return f"[#{item['number']}]({item['url']})"


def _topper_lines(records: list[dict[str, Any]], window: Window, limit: int = 10) -> list[str]:
    rows = _leaderboard(records)[:limit]
    if not rows:
        return [f"- Window: {window.label} ({window.since.isoformat()} to {window.until.isoformat()})", "- No resolved PRs in this window."]
    lines = [
        f"- Window: {window.label} ({window.since.isoformat()} to {window.until.isoformat()})",
        "",
        "| Rank | Contributor | Impact Score | Resolved | Merged | Patched | Closed | Corrected | Top PRs |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for idx, row in enumerate(rows, start=1):
        lines.append(
            f"| {idx} | `{_cell(row['author'])}` | {row['score']} | {row['resolved']} | "
            f"{row['merged']} | {row['patched']} | {row['closed']} | {row['reverted']} | "
            f"{', '.join(_link(item) for item in row['top'])} |"
        )
    return lines


def _cluster_lines(records: list[dict[str, Any]], limit: int = 8) -> list[str]:
    by_cluster: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in records:
        by_cluster[item["cluster"]].append(item)
    lines = [
        "| Contract Cluster | PRs | Score | Representative PRs |",
        "| --- | ---: | ---: | --- |",
    ]
    ranked = sorted(
        by_cluster,
        key=lambda key: sum(item["score"] for item in by_cluster[key]),
        reverse=True,
    )
    for cluster in ranked[:limit]:
        items = sorted(by_cluster[cluster], key=lambda item: item["score"], reverse=True)
        lines.append(
            f"| {_cell(cluster)} | {len(items)} | {sum(item['score'] for item in items)} | "
            f"{', '.join(_link(item) for item in items[:5])} |"
        )
    remaining = ranked[limit:]
    if remaining:
        remaining_prs = sum(len(by_cluster[cluster]) for cluster in remaining)
        remaining_score = sum(
            item["score"] for cluster in remaining for item in by_cluster[cluster]
        )
        lines.append(f"| Other clusters | {remaining_prs} | {remaining_score} | _Grouped to keep the report compact._ |")
    return lines


def _kpi_lines(kpis: dict[str, Any]) -> list[str]:
    labels = {
        "resolved_prs": "Resolved PRs",
        "merged_prs": "Merged PRs",
        "merge_rate": "Merge rate",
        "median_resolution_days": "Median PR resolution time (days)",
        "contributors_represented": "Contributors represented",
        "patched_then_merged_prs": "Patched-then-merged PRs",
        "closed_duplicate_or_drift_prs": "Closed duplicate/drift PRs",
        "reverted_or_corrected_prs": "Reverted/corrected PRs",
        "governance_intervention_load": "Governance intervention load",
        "trust_security_prs": "Trust/security PRs",
        "consent_vault_prs": "Consent/vault PRs",
        "one_kai_nav_alignment_prs": "One/Kai/Nav alignment PRs",
        "user_value_prs": "User-value PRs",
        "proof_test_prs": "Proof/test PRs",
        "high_churn_prs": "High-churn PRs",
        "duplicate_avoided_prs": "Duplicate avoided PRs",
        "regression_corrections": "Regression corrections",
    }
    lines = ["| KPI | Value |", "| --- | ---: |"]
    for key, label in labels.items():
        lines.append(f"| {_cell(label)} | {kpis.get(key, 0)} |")
    return lines


def _most_impactful(records: list[dict[str, Any]], limit: int = 10) -> list[str]:
    lines = []
    for item in sorted(records, key=lambda row: (row["score"], row["number"]), reverse=True)[:limit]:
        lines.append(
            f"- {_link(item)} by `{item['author']}` - score `{item['score']}`: "
            f"{item['reason']}"
        )
    return lines or ["- No resolved PRs in this window."]


def _corrections(records: list[dict[str, Any]], limit: int = 10) -> list[str]:
    corrections = [
        item
        for item in records
        if item["lifecycle"] in {"revert_correction", "merged_then_reverted", "closed_duplicate", "closed_drift"}
        or "Directional correction" in item["cluster"]
    ]
    lines = []
    for item in sorted(corrections, key=lambda row: (row["score"], row["number"]), reverse=True)[:limit]:
        lines.append(
            f"- {_link(item)} by `{item['author']}` - `{item['lifecycle']}`: {item['reason']}"
        )
    return lines or ["- No directional corrections or closure signals detected in this window."]


def _report_text(
    repo: str,
    window: Window,
    records: list[dict[str, Any]],
    weekly_window: Window,
    weekly_records: list[dict[str, Any]],
    two_week_window: Window,
    two_week_records: list[dict[str, Any]],
    monthly_window: Window,
    monthly_records: list[dict[str, Any]],
) -> str:
    refreshed = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    kpis = _kpis(records)
    lines = [
        "# Temporary Contributor Impact Dashboard",
        "",
        "Status: rolling operational record",
        f"Last refreshed: {refreshed}",
        f"Repo: https://github.com/{repo}",
        f"Primary window: {window.label} ({window.since.isoformat()} to {window.until.isoformat()})",
        "",
        f"This file is ignored under `tmp/`. It complements `{LIVE_REPORT_PATH}`; it does not replace the live open-PR report.",
        "",
        "## Index",
        "",
        "- [Executive Summary](#executive-summary)",
        "- [KPI Board](#kpi-board)",
        "- [Weekly Top 10](#weekly-top-10)",
        "- [Two-Week Top 10](#two-week-top-10)",
        "- [Monthly Top 10](#monthly-top-10)",
        "- [Most Impactful PRs](#most-impactful-prs)",
        "- [Directional Corrections](#directional-corrections)",
        "- [Contract Clusters](#contract-clusters)",
        "",
        "## Executive Summary",
        "",
        f"- Resolved PRs in primary window: `{len(records)}`.",
        f"- Merged PRs: `{kpis['merged_prs']}`.",
        f"- Merge rate: `{kpis['merge_rate']}` with median PR resolution time `{kpis['median_resolution_days']}` days.",
        f"- Contributors represented: `{kpis['contributors_represented']}`.",
        f"- Governance intervention load: `{kpis['governance_intervention_load']}` across duplicate, drift, and revert/correction work.",
        "- KPI model: combines DORA-style throughput/stability, SPACE-style multidimensional productivity, and Hussh north-star impact. Raw PR count is never the winner by itself.",
        "",
        "## KPI Board",
        "",
        *_kpi_lines(kpis),
        "",
        "## Weekly Top 10",
        "",
        *_topper_lines(weekly_records, weekly_window),
        "",
        "## Two-Week Top 10",
        "",
        *_topper_lines(two_week_records, two_week_window),
        "",
        "## Monthly Top 10",
        "",
        *_topper_lines(monthly_records, monthly_window),
        "",
        "## Most Impactful PRs",
        "",
        *_most_impactful(records),
        "",
        "## Directional Corrections",
        "",
        *_corrections(records),
        "",
        "## Contract Clusters",
        "",
        *_cluster_lines(records),
        "",
    ]
    return "\n".join(lines)


def _json_payload(
    repo: str,
    window: Window,
    records: list[dict[str, Any]],
    weekly_window: Window,
    weekly_records: list[dict[str, Any]],
    two_week_window: Window,
    two_week_records: list[dict[str, Any]],
    monthly_window: Window,
    monthly_records: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "repo": repo,
        "window": {
            "label": window.label,
            "since": window.since.isoformat(),
            "until": window.until.isoformat(),
        },
        "kpis": _kpis(records),
        "leaderboard": _leaderboard(records),
        "weekly_top_10": {
            "window": {
                "label": weekly_window.label,
                "since": weekly_window.since.isoformat(),
                "until": weekly_window.until.isoformat(),
            },
            "contributors": _leaderboard(weekly_records)[:10],
        },
        "two_week_top_10": {
            "window": {
                "label": two_week_window.label,
                "since": two_week_window.since.isoformat(),
                "until": two_week_window.until.isoformat(),
            },
            "contributors": _leaderboard(two_week_records)[:10],
        },
        "monthly_top_10": {
            "window": {
                "label": monthly_window.label,
                "since": monthly_window.since.isoformat(),
                "until": monthly_window.until.isoformat(),
            },
            "contributors": _leaderboard(monthly_records)[:10],
        },
        "records": records,
    }


def _cached_records(repo: str, windows: list[Window]) -> dict[tuple[date, date], list[dict[str, Any]]]:
    cache: dict[tuple[date, date], list[dict[str, Any]]] = {}
    for window in windows:
        key = (window.since, window.until)
        if key not in cache:
            cache[key] = _analysis(_records_for_window(repo, window))
    return cache


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Hussh contributor impact dashboard.")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--days", type=int, default=None, help="Primary rolling window in days. Default: 7.")
    parser.add_argument("--month", nargs="?", const="current", help="Use a calendar month window, optionally YYYY-MM.")
    parser.add_argument("--since", help="Explicit primary window start date, YYYY-MM-DD.")
    parser.add_argument("--until", help="Explicit primary window end date, YYYY-MM-DD. Defaults to today when --since is used.")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON.")
    parser.add_argument("--text", action="store_true", help="Output markdown text. Default unless --json is set.")
    args = parser.parse_args()

    if sum(bool(value) for value in (args.days, args.month is not None, args.since)) > 1:
        parser.error("use only one of --days, --month, or --since/--until")
    if args.until and not args.since:
        parser.error("--until requires --since")

    primary = _requested_window(args)
    today = date.today()
    weekly = Window("last 7 days", today - timedelta(days=7), today)
    two_week = Window("last 14 days", today - timedelta(days=14), today)
    monthly = Window("last 30 days", today - timedelta(days=30), today)
    cache = _cached_records(args.repo, [primary, weekly, two_week, monthly])
    records = cache[(primary.since, primary.until)]
    weekly_records = cache[(weekly.since, weekly.until)]
    two_week_records = cache[(two_week.since, two_week.until)]
    monthly_records = cache[(monthly.since, monthly.until)]

    if args.json:
        print(json.dumps(_json_payload(args.repo, primary, records, weekly, weekly_records, two_week, two_week_records, monthly, monthly_records), indent=2))
    else:
        print(_report_text(args.repo, primary, records, weekly, weekly_records, two_week, two_week_records, monthly, monthly_records))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
