#!/usr/bin/env python3
from __future__ import annotations

import argparse
import functools
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo


DEFAULT_REPO = "hushh-labs/hushh-research"
DEFAULT_PRIMARY_DAYS = 14
PR_FETCH_LIMIT = 1000
GRAPH_WIDTH = 24
REPORT_TZ = ZoneInfo("America/Los_Angeles")
REPO_ROOT = Path(__file__).resolve().parents[4]
DISCUSSION_FETCH_WORKERS = 8
GH_FIELDS = (
    "number,title,author,mergedAt,closedAt,createdAt,updatedAt,additions,"
    "deletions,changedFiles,labels,url,headRefName,baseRefName,isDraft,"
    "mergeCommit,mergedBy,reviewDecision,files"
)

DEFAULT_MAINTAINER_USERS = {"kushaltrivedi5"}
OPERATOR_EVENT_CAP_PER_PR_ACTOR = 64
BALANCED_OPERATOR_CAP_MATERIAL = 28
BALANCED_OPERATOR_CAP_ROUTINE = 14
OPERATOR_EVENT_WEIGHTS = {
    "maintainer_patch": 30,
    "maintainer_harvest": 26,
    "governance_closure": 20,
    "changes_requested": 14,
    "merge_stewardship": 10,
    "owner_bypass_stewardship": 8,
    "review_comment": 7,
}
BALANCED_OPERATOR_EVENT_FACTORS = {
    "maintainer_patch": 0.55,
    "maintainer_harvest": 0.50,
    "governance_closure": 0.30,
    "changes_requested": 0.25,
    "merge_stewardship": 0.15,
    "owner_bypass_stewardship": 0.15,
    "review_comment": 0.12,
}
_PR_DISCUSSION_CACHE: dict[tuple[str, int], dict[str, list[dict[str, Any]]]] = {}


HARVEST_CREDITS: dict[int, list[dict[str, str | int]]] = {
    1013: [
        {
            "source_pr": 808,
            "author": "imsharukhan",
            "accepted_value": "Top app bar back affordance touch target.",
        },
        {
            "source_pr": 810,
            "author": "imsharukhan",
            "accepted_value": "Settings drawer safe-area bottom padding.",
        },
        {
            "source_pr": 809,
            "author": "imsharukhan",
            "accepted_value": "RIA status panel responsive grid.",
        },
        {
            "source_pr": 811,
            "author": "imsharukhan",
            "accepted_value": "Onboarding carousel accessible labels.",
        },
        {
            "source_pr": 942,
            "author": "smirthi-dharma",
            "accepted_value": "Shared UI accessibility regression coverage.",
        },
        {
            "source_pr": 967,
            "author": "smirthi-dharma",
            "accepted_value": "Diagnostic observability log redaction helper.",
        },
        {
            "source_pr": 1001,
            "author": "smirthi-dharma",
            "accepted_value": "Reachable observability client redaction attach point.",
        },
        {
            "source_pr": 931,
            "author": "anshul23102",
            "accepted_value": "Bounded Kai market-data cache growth control.",
        },
        {
            "source_pr": 924,
            "author": "anshul23102",
            "accepted_value": "Bounded Kai market-data lock growth control.",
        },
        {
            "source_pr": 1002,
            "author": "anshul23102",
            "accepted_value": "Bounded Kai provider cooldown growth control.",
        },
        {
            "source_pr": 943,
            "author": "suyashkumar102",
            "accepted_value": "UID-safe Kai chat auth-mismatch logging.",
        },
        {
            "source_pr": 913,
            "author": "anshul23102",
            "accepted_value": "Kai chat pagination query bounds.",
        },
        {
            "source_pr": 934,
            "author": "anshul23102",
            "accepted_value": "Marketplace public query filter bounds.",
        },
        {
            "source_pr": 926,
            "author": "anshul23102",
            "accepted_value": "RIA client query filter bounds.",
        },
    ],
}

HARVEST_SOURCE_INDEX: dict[int, dict[str, str | int]] = {
    int(source["source_pr"]): {"landing_pr": landing_pr, **source}
    for landing_pr, sources in HARVEST_CREDITS.items()
    for source in sources
}


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
        "pathway",
        "runtime",
    ),
    "ria/advisor": (
        "ria",
        "advisor",
        "adviser",
        "firm",
        "practice",
        "crd",
        "verification",
        "workspace",
    ),
    "onboarding/profile": (
        "onboarding",
        "profile",
        "persona",
        "getting started",
        "safe-area",
        "responsive",
        "tablet",
        "desktop",
    ),
    "portfolio/import": (
        "portfolio",
        "plaid",
        "import",
        "statement",
        "account",
        "holdings",
        "positions",
    ),
    "pkm/memory": (
        "pkm",
        "memory",
        "domain summary",
        "projection",
        "cache",
        "preference",
    ),
    "frontend/design": (
        "frontend",
        "webapp",
        "design",
        "morphy",
        "button",
        "modal",
        "popover",
        "privacy",
        "terms",
        "logo",
        "top bar",
        "safe area",
    ),
    "backend/api": (
        "backend",
        "api",
        "route",
        "proxy",
        "service",
        "endpoint",
        "schema",
        "contract",
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
    "one/kai/nav": 16,
    "ria/advisor": 13,
    "portfolio/import": 12,
    "pkm/memory": 14,
    "onboarding/profile": 10,
    "frontend/design": 8,
    "backend/api": 10,
    "user utility": 8,
    "runtime quality": 10,
    "proof/tests": 8,
    "ops/governance": 5,
}


def _run_gh(args: list[str]) -> Any:
    proc = subprocess.run(
        ["gh", *args],
        cwd=REPO_ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return json.loads(proc.stdout or "[]")


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


@functools.lru_cache(maxsize=1)
def _codeowners_users() -> frozenset[str]:
    path = REPO_ROOT / ".github" / "CODEOWNERS"
    try:
        text = path.read_text()
    except FileNotFoundError:
        return frozenset()
    users: set[str] = set()
    for match in re.finditer(r"@([A-Za-z0-9-]+)", text):
        users.add(match.group(1))
    return frozenset(users)


@functools.lru_cache(maxsize=1)
def _maintainer_users() -> frozenset[str]:
    config = _load_json(REPO_ROOT / "config" / "ci-governance.json")
    main = config.get("main") if isinstance(config.get("main"), dict) else {}
    uat = config.get("uat") if isinstance(config.get("uat"), dict) else {}
    production = config.get("production") if isinstance(config.get("production"), dict) else {}
    users = set(DEFAULT_MAINTAINER_USERS) | _codeowners_users()
    for section in (main, uat, production):
        for key in (
            "review_bypass_users",
            "merge_queue_bypass_users",
            "protected_pipeline_edit_users",
            "manual_dispatch_users",
        ):
            users.update(str(user) for user in section.get(key, []) if user)
    return frozenset(users)


@functools.lru_cache(maxsize=1)
def _merge_queue_bypass_users() -> frozenset[str]:
    config = _load_json(REPO_ROOT / "config" / "ci-governance.json")
    main = config.get("main") if isinstance(config.get("main"), dict) else {}
    return frozenset(str(user) for user in main.get("merge_queue_bypass_users", []) if user)


def _actor_login(value: Any) -> str:
    if isinstance(value, dict):
        login = value.get("login")
        return str(login) if login else ""
    return ""


def _comment_author(comment: dict[str, Any]) -> str:
    return _actor_login(comment.get("author") or comment.get("user"))


def _review_author(review: dict[str, Any]) -> str:
    return _actor_login(review.get("author") or review.get("user"))


def _body(value: dict[str, Any]) -> str:
    body = value.get("body")
    return str(body) if body else ""


def _query_closed_prs(repo: str, state: str, window: Window | None) -> list[dict[str, Any]]:
    cmd = [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        state,
        "--limit",
        str(PR_FETCH_LIMIT),
        "--json",
        GH_FIELDS,
    ]
    if window:
        key = "merged" if state == "merged" else "closed"
        cmd.extend(
            [
                "--search",
                f"{key}:>={window.since.isoformat()} {key}:<={window.until.isoformat()}",
            ]
        )
    return _run_gh(cmd)


def _repo_parts(repo: str) -> tuple[str, str]:
    owner, name = repo.split("/", 1)
    return owner, name


def _discussion_for_pr(repo: str, number: int) -> dict[str, list[dict[str, Any]]]:
    key = (repo, number)
    if key in _PR_DISCUSSION_CACHE:
        return _PR_DISCUSSION_CACHE[key]
    owner, name = _repo_parts(repo)
    comments = _run_gh(
        [
            "api",
            f"/repos/{owner}/{name}/issues/{number}/comments?per_page=100",
        ]
    )
    reviews = _run_gh(
        [
            "api",
            f"/repos/{owner}/{name}/pulls/{number}/reviews?per_page=100",
        ]
    )
    normalized = {
        "comments": comments if isinstance(comments, list) else [],
        "reviews": reviews if isinstance(reviews, list) else [],
    }
    _PR_DISCUSSION_CACHE[key] = normalized
    return normalized


def _enrich_discussions(repo: str, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    discussions: dict[int, dict[str, list[dict[str, Any]]]] = {}
    with ThreadPoolExecutor(max_workers=DISCUSSION_FETCH_WORKERS) as executor:
        futures = {
            executor.submit(_discussion_for_pr, repo, int(pr["number"])): int(pr["number"])
            for pr in records
        }
        for future in as_completed(futures):
            discussions[futures[future]] = future.result()

    enriched = []
    for pr in records:
        number = int(pr["number"])
        discussion = discussions[number]
        enriched.append(
            {
                **pr,
                "comments": discussion["comments"],
                "reviews": discussion["reviews"],
                "latestReviews": discussion["reviews"],
            }
        )
    return enriched


def _records_for_window(repo: str, window: Window | None) -> list[dict[str, Any]]:
    merged = _query_closed_prs(repo, "merged", window)
    closed = [
        pr
        for pr in _query_closed_prs(repo, "closed", window)
        if not pr.get("mergedAt")
    ]
    records = sorted([*merged, *closed], key=lambda pr: pr.get("closedAt") or pr.get("mergedAt") or "")
    return _enrich_discussions(repo, records)


def _records_for_all_time(repo: str) -> list[dict[str, Any]]:
    return _analysis(_records_for_window(repo, None))


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
    days = args.days or DEFAULT_PRIMARY_DAYS
    today = date.today()
    since = today - timedelta(days=days)
    return Window(f"last {days} days", since, today)


def _friendly_date(value: date, *, include_year: bool = True) -> str:
    text = f"{value:%b} {value.day}"
    if include_year:
        text = f"{text}, {value.year}"
    return text


def _friendly_range(since: date, until: date) -> str:
    if since == until:
        return _friendly_date(since)
    if since.year == until.year and since.month == until.month:
        return f"{since:%b} {since.day}-{until.day}, {until.year}"
    if since.year == until.year:
        return f"{since:%b} {since.day}-{until:%b} {until.day}, {until.year}"
    return f"{_friendly_date(since)}-{_friendly_date(until)}"


def _window_display(window: Window) -> str:
    return f"{window.label} ({_friendly_range(window.since, window.until)})"


def _refreshed_display() -> str:
    now_utc = datetime.now(UTC).replace(microsecond=0)
    now_local = now_utc.astimezone(REPORT_TZ)
    return (
        f"{now_local:%b} {now_local.day}, {now_local.year} "
        f"at {now_local:%-I:%M %p} PT / {now_utc:%b} {now_utc.day}, "
        f"{now_utc.year} at {now_utc:%H:%M} UTC"
    )


def _author(pr: dict[str, Any]) -> str:
    author = pr.get("author") or {}
    return author.get("login") or "unknown"


def _harvest_credit(pr_number: int) -> dict[str, str | int] | None:
    return HARVEST_SOURCE_INDEX.get(pr_number)


def _pr_url(number: int) -> str:
    return f"https://github.com/{DEFAULT_REPO}/pull/{number}"


def _pr_link(number: int) -> str:
    return f"[#{number}]({_pr_url(number)})"


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


def _normalized_words(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _keyword_matches(haystack: str, keyword: str) -> bool:
    normalized_haystack = f" {_normalized_words(haystack)} "
    normalized_keyword = _normalized_words(keyword)
    if not normalized_keyword:
        return False
    return f" {normalized_keyword} " in normalized_haystack


def _vectors(pr: dict[str, Any]) -> list[str]:
    haystack = _haystack(pr)
    vectors = [
        vector
        for vector, keywords in VECTOR_KEYWORDS.items()
        if any(_keyword_matches(haystack, keyword) for keyword in keywords)
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
    if "ria/advisor" in vectors:
        return "RIA and advisor workflows"
    if "portfolio/import" in vectors:
        return "Portfolio import and account linking"
    if "onboarding/profile" in vectors:
        return "Onboarding and profile workflows"
    if "frontend/design" in vectors:
        return "Frontend design system and responsiveness"
    if "backend/api" in vectors:
        return "Backend API and contract surface"
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
    if _harvest_credit(int(pr["number"])) and not pr.get("mergedAt"):
        return "harvested_source"
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
    harvest = _harvest_credit(int(pr["number"]))
    if lifecycle == "harvested_source" and harvest:
        return (
            f"Harvested into #{harvest['landing_pr']}: "
            f"{harvest['accepted_value']}"
        )
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
    if "ria/advisor" in vectors:
        return "Improves RIA, advisor, firm, or verification workflows."
    if "portfolio/import" in vectors:
        return "Improves portfolio import, Plaid, account, or statement flow."
    if "onboarding/profile" in vectors:
        return "Improves onboarding, profile, or first-run user flow."
    if "frontend/design" in vectors:
        return "Improves frontend design-system behavior, responsiveness, or UI clarity."
    if "backend/api" in vectors:
        return "Improves backend API, route, service, or contract behavior."
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
        "harvested_source": 12,
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
    if lifecycle != "harvested_source" and ("duplicate" in haystack or "superseded" in haystack):
        score -= 6
    if "ipl" in haystack or "arena" in haystack:
        score -= 18
    if _author(pr) == "app/dependabot":
        score -= 4
    return score


def _source_product_bonus(pr: dict[str, Any], vectors: list[str], lifecycle: str) -> int:
    title = str(pr.get("title", "")).lower()
    vector_set = set(vectors)
    bonus = 0
    if "one/kai/nav" in vector_set:
        bonus += 8
    if vector_set & {"trust/security", "consent/vault", "pkm/memory"}:
        bonus += 6
    if vector_set & {"ria/advisor", "portfolio/import"}:
        bonus += 5
    if vector_set & {"onboarding/profile", "frontend/design"}:
        bonus += 4
    if "runtime quality" in vector_set:
        bonus += 5 if lifecycle in {"revert_correction", "patched_then_merged"} or "fix" in title or "bug" in title else 3
    if "proof/tests" in vector_set:
        bonus += 3
    if lifecycle in {"closed_duplicate", "closed_drift", "changes_requested", "closed_unmerged"}:
        bonus = round(bonus * 0.65)
    if lifecycle == "harvested_source":
        bonus += 4
    return min(max(bonus, 0), 18)


def _operator_event_is_material(event_type: str) -> bool:
    return event_type in {"maintainer_patch", "maintainer_harvest", "governance_closure"}


def _balanced_operator_credit_by_actor(
    source_score: int,
    operator_events: list[dict[str, Any]],
) -> dict[str, int]:
    raw_by_actor: dict[str, int] = defaultdict(int)
    material_by_actor: dict[str, bool] = defaultdict(bool)
    for event in operator_events:
        if not isinstance(event, dict):
            continue
        actor = str(event.get("actor") or "")
        event_type = str(event.get("type") or "")
        if not actor:
            continue
        factor = BALANCED_OPERATOR_EVENT_FACTORS.get(event_type, 0.10)
        weighted = round(int(event.get("score") or 0) * factor)
        if int(event.get("score") or 0) > 0:
            weighted = max(weighted, 1)
        raw_by_actor[actor] += weighted
        material_by_actor[actor] = material_by_actor[actor] or _operator_event_is_material(event_type)

    balanced: dict[str, int] = {}
    for actor, raw_score in raw_by_actor.items():
        material = material_by_actor[actor]
        event_cap = BALANCED_OPERATOR_CAP_MATERIAL if material else BALANCED_OPERATOR_CAP_ROUTINE
        source_cap_factor = 0.70 if material else 0.35
        source_cap = max(6, round(max(source_score, 4) * source_cap_factor))
        balanced[actor] = min(raw_score, event_cap, source_cap)
    return balanced


def _operator_complexity_bonus(vectors: list[str]) -> int:
    bonus = 0
    if "trust/security" in vectors or "consent/vault" in vectors:
        bonus += 6
    if "pkm/memory" in vectors or "one/kai/nav" in vectors:
        bonus += 4
    if "proof/tests" in vectors or "ops/governance" in vectors:
        bonus += 3
    return min(bonus, 10)


def _review_state(review: dict[str, Any]) -> str:
    return str(review.get("state") or "").upper()


def _operator_events(pr: dict[str, Any], vectors: list[str], lifecycle: str) -> list[dict[str, Any]]:
    maintainers = _maintainer_users()
    complexity_bonus = _operator_complexity_bonus(vectors)
    events: dict[tuple[str, str], dict[str, Any]] = {}

    def add(actor: str, event_type: str, score: int, reason: str) -> None:
        if not actor or actor not in maintainers or actor.startswith("app/"):
            return
        key = (actor, event_type)
        capped_score = max(0, min(score, OPERATOR_EVENT_CAP_PER_PR_ACTOR))
        existing = events.get(key)
        if existing and int(existing["score"]) >= capped_score:
            return
        events[key] = {
            "actor": actor,
            "type": event_type,
            "score": capped_score,
            "reason": reason,
        }

    for comment in pr.get("comments") or []:
        if not isinstance(comment, dict):
            continue
        actor = _comment_author(comment)
        text = _body(comment).lower()
        if not text:
            continue
        if "### maintainer patch" in text or "approved with maintainer patch" in text:
            add(
                actor,
                "maintainer_patch",
                OPERATOR_EVENT_WEIGHTS["maintainer_patch"] + complexity_bonus,
                "Maintainer normalized or patched the PR into a canonical landing path.",
            )
        if "maintainer harvest" in text or ("harvest" in text and "accepted value" in text):
            add(
                actor,
                "maintainer_harvest",
                OPERATOR_EVENT_WEIGHTS["maintainer_harvest"] + complexity_bonus,
                "Maintainer harvested useful contributor value without treating the unsafe head as merge-ready.",
            )
        if lifecycle in {"closed_duplicate", "closed_drift"} and (
            "duplicate" in text or "superseded" in text or "drift" in text or "closed" in text
        ):
            add(
                actor,
                "governance_closure",
                OPERATOR_EVENT_WEIGHTS["governance_closure"] + complexity_bonus,
                "Maintainer resolved duplicate, superseded, or drifted work to keep the product surface coherent.",
            )
        if "changes requested" in text or "## changes requested" in text:
            add(
                actor,
                "changes_requested",
                OPERATOR_EVENT_WEIGHTS["changes_requested"] + complexity_bonus,
                "Maintainer requested bounded correction before merge.",
            )
        elif len(text) > 120:
            add(
                actor,
                "review_comment",
                OPERATOR_EVENT_WEIGHTS["review_comment"] + min(complexity_bonus, 4),
                "Maintainer provided review or triage context on a resolved PR.",
            )

    for review in [*(pr.get("reviews") or []), *(pr.get("latestReviews") or [])]:
        if not isinstance(review, dict):
            continue
        actor = _review_author(review)
        state = _review_state(review)
        text = _body(review).lower()
        if state == "CHANGES_REQUESTED":
            add(
                actor,
                "changes_requested",
                OPERATOR_EVENT_WEIGHTS["changes_requested"] + complexity_bonus,
                "Maintainer used review authority to block unsafe or incomplete work.",
            )
        elif state == "APPROVED":
            add(
                actor,
                "review_comment",
                OPERATOR_EVENT_WEIGHTS["review_comment"] + min(complexity_bonus, 4),
                "Maintainer approved or reviewed a resolved PR.",
            )
        elif state == "COMMENTED" or text:
            add(
                actor,
                "review_comment",
                OPERATOR_EVENT_WEIGHTS["review_comment"] + min(complexity_bonus, 4),
                "Maintainer provided review or triage context on a resolved PR.",
            )
        if "### maintainer patch" in text or "approved with maintainer patch" in text:
            add(
                actor,
                "maintainer_patch",
                OPERATOR_EVENT_WEIGHTS["maintainer_patch"] + complexity_bonus,
                "Maintainer normalized or patched the PR into a canonical landing path.",
            )

    merged_by = _actor_login(pr.get("mergedBy"))
    if pr.get("mergedAt") and merged_by:
        merge_score = OPERATOR_EVENT_WEIGHTS["merge_stewardship"] + min(complexity_bonus, 6)
        if lifecycle == "patched_then_merged":
            merge_score += 6
        add(
            merged_by,
            "merge_stewardship",
            merge_score,
            "Maintainer landed a resolved PR through the repository merge path.",
        )
        if merged_by in maintainers and merged_by in _merge_queue_bypass_users():
            add(
                merged_by,
                "owner_bypass_stewardship",
                OPERATOR_EVENT_WEIGHTS["owner_bypass_stewardship"] + min(complexity_bonus, 4),
                "Owner-bypass maintainer carried queue stewardship for a resolved PR.",
            )

    by_actor: dict[str, int] = defaultdict(int)
    collapsed: list[dict[str, Any]] = []
    for event in sorted(events.values(), key=lambda item: (str(item["actor"]), str(item["type"]))):
        actor = str(event["actor"])
        remaining = OPERATOR_EVENT_CAP_PER_PR_ACTOR - by_actor[actor]
        if remaining <= 0:
            continue
        score = min(int(event["score"]), remaining)
        by_actor[actor] += score
        collapsed.append({**event, "score": score})
    return collapsed


def _analysis(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    analyzed = []
    for pr in records:
        vectors = _vectors(pr)
        lifecycle = _lifecycle(pr)
        harvest = _harvest_credit(int(pr["number"]))
        source_score = _impact_score(pr)
        product_bonus = _source_product_bonus(pr, vectors, lifecycle)
        operator_events = _operator_events(pr, vectors, lifecycle)
        operator_score = sum(int(event["score"]) for event in operator_events)
        balanced_operator_by_actor = _balanced_operator_credit_by_actor(source_score, operator_events)
        balanced_operator_score = sum(balanced_operator_by_actor.values())
        composite_score = source_score + operator_score
        balanced_score = source_score + product_bonus + balanced_operator_score
        analyzed.append(
            {
                "number": int(pr["number"]),
                "title": pr.get("title", ""),
                "author": str(harvest["author"]) if harvest else _author(pr),
                "url": pr.get("url", ""),
                "createdAt": pr.get("createdAt"),
                "mergedAt": pr.get("mergedAt"),
                "closedAt": pr.get("closedAt"),
                "lifecycle": lifecycle,
                "score": balanced_score,
                "source_impact_score": source_score,
                "source_product_bonus": product_bonus,
                "operator_impact_score": operator_score,
                "balanced_operator_impact_score": balanced_operator_score,
                "balanced_operator_impact_by_actor": balanced_operator_by_actor,
                "balanced_impact_score": balanced_score,
                "composite_impact_score": composite_score,
                "operator_events": operator_events,
                "vectors": vectors,
                "cluster": _cluster(pr, vectors),
                "reason": _impact_reason(pr, vectors, lifecycle),
                "additions": int(pr.get("additions") or 0),
                "deletions": int(pr.get("deletions") or 0),
                "changedFiles": int(pr.get("changedFiles") or 0),
                "harvestedInto": int(harvest["landing_pr"]) if harvest else None,
                "harvestAcceptedValue": str(harvest["accepted_value"]) if harvest else "",
                "officialGitHubContributorCredit": bool(pr.get("mergedAt")),
            }
        )
    return analyzed


def _leaderboard(records: list[dict[str, Any]], mode: str = "balanced") -> list[dict[str, Any]]:
    authors: dict[str, dict[str, Any]] = {}

    def row_for(author: str) -> dict[str, Any]:
        return authors.setdefault(
            author,
            {
                "author": author,
                "score": 0,
                "source_score": 0,
                "source_product_bonus": 0,
                "operator_score": 0,
                "balanced_operator_score": 0,
                "resolved": 0,
                "merged": 0,
                "patched": 0,
                "harvested": 0,
                "closed": 0,
                "reverted": 0,
                "operator_events": 0,
                "top": [],
            },
        )

    for item in records:
        source_row = row_for(item["author"])
        source_score = int(item.get("source_impact_score", item.get("score", 0)))
        product_bonus = int(item.get("source_product_bonus", 0))
        source_row["source_score"] += source_score
        source_row["source_product_bonus"] += product_bonus
        source_row["resolved"] += 1
        source_row["merged"] += 1 if item["mergedAt"] else 0
        source_row["patched"] += 1 if item["lifecycle"] == "patched_then_merged" else 0
        source_row["harvested"] += 1 if item["lifecycle"] == "harvested_source" else 0
        source_row["closed"] += 1 if not item["mergedAt"] else 0
        source_row["reverted"] += 1 if item["lifecycle"] in {"revert_correction", "merged_then_reverted"} else 0
        if mode in {"source", "balanced", "composite"}:
            top_score = source_score + product_bonus if mode == "balanced" else source_score
            source_row["top"].append({**item, "score": top_score})

        by_actor: dict[str, int] = defaultdict(int)
        for event in item.get("operator_events") or []:
            if not isinstance(event, dict):
                continue
            actor = str(event.get("actor") or "")
            if not actor:
                continue
            by_actor[actor] += int(event.get("score") or 0)
        balanced_by_actor = {
            str(actor): int(score)
            for actor, score in (item.get("balanced_operator_impact_by_actor") or {}).items()
        }
        for actor, operator_score in by_actor.items():
            operator_row = row_for(actor)
            operator_row["operator_score"] += operator_score
            operator_row["balanced_operator_score"] += balanced_by_actor.get(actor, 0)
            operator_row["operator_events"] += sum(
                1
                for event in item.get("operator_events") or []
                if isinstance(event, dict) and event.get("actor") == actor
            )
            if mode in {"operator", "composite", "balanced"}:
                top_score = balanced_by_actor.get(actor, 0) if mode in {"operator", "balanced"} else operator_score
                operator_row["top"].append({**item, "score": top_score})

    rows = []
    for row in authors.values():
        row["score"] = {
            "source": row["source_score"],
            "operator": row["balanced_operator_score"],
            "composite": row["source_score"] + row["operator_score"],
            "balanced": row["source_score"] + row["source_product_bonus"] + row["balanced_operator_score"],
        }.get(mode, row["source_score"] + row["source_product_bonus"] + row["balanced_operator_score"])
        if mode == "operator" and row["balanced_operator_score"] <= 0:
            continue
        if mode == "source" and row["source_score"] <= 0:
            continue
        if mode == "balanced" and row["score"] <= 0:
            continue
        row["top"] = sorted(row["top"], key=lambda item: item["score"], reverse=True)[:3]
        rows.append(row)
    return sorted(
        rows,
        key=lambda row: (
            row["score"],
            row["operator_score"] if mode == "operator" else row["merged"],
            row["balanced_operator_score"],
            row["source_score"],
            row["resolved"],
        ),
        reverse=True,
    )


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _search_count(repo: str, qualifiers: str) -> int:
    query = f"repo:{repo} type:pr"
    if qualifiers:
        query = f"{query} {qualifiers}"
    encoded = quote(query, safe="")
    value = _run_gh(
        [
            "api",
            "-H",
            "Accept: application/vnd.github+json",
            f"/search/issues?q={encoded}&per_page=1",
            "--jq",
            ".total_count",
        ]
    )
    return int(value)


def _first_pr_summary(repo: str) -> dict[str, Any] | None:
    try:
        rows = _run_gh(
            [
                "pr",
                "list",
                "--repo",
                repo,
                "--state",
                "all",
                "--search",
                "sort:created-asc",
                "--limit",
                "1",
                "--json",
                "number,title,createdAt,url,state",
            ]
        )
    except RuntimeError:
        return None
    return rows[0] if rows else None


def _first_resolved_record(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    dated: list[tuple[datetime, dict[str, Any]]] = []
    for item in records:
        created = _parse_datetime(item.get("createdAt"))
        if created:
            dated.append((created, item))
    if not dated:
        return None
    return min(dated, key=lambda pair: pair[0])[1]


def _all_time_window(records: list[dict[str, Any]]) -> Window:
    first = _first_resolved_record(records)
    created = _parse_datetime(first.get("createdAt") if first else None)
    since = created.date() if created else date.today()
    return Window("all resolved PR history", since, date.today())


def _github_insights(repo: str, overall_records: list[dict[str, Any]]) -> dict[str, Any]:
    total_prs = _search_count(repo, "")
    open_prs = _search_count(repo, "is:open")
    closed_prs = _search_count(repo, "is:closed")
    merged_prs = _search_count(repo, "is:merged")
    first_pr = _first_pr_summary(repo)
    first_resolved = _first_resolved_record(overall_records)
    included = len(overall_records)
    expected_closed_unmerged = max(closed_prs - merged_prs, 0)
    coverage_status = "complete" if included == closed_prs else "needs review"
    return {
        "total_prs": total_prs,
        "open_prs": open_prs,
        "closed_prs": closed_prs,
        "merged_prs": merged_prs,
        "closed_unmerged_prs": expected_closed_unmerged,
        "included_resolved_prs": included,
        "coverage_status": coverage_status,
        "first_pr": first_pr,
        "first_resolved_pr": first_resolved,
        "fetch_limit": PR_FETCH_LIMIT,
    }


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
    titles = " ".join(str(item.get("title", "")).lower() for item in records)
    resolved = len(records)
    merged = sum(1 for item in records if item["mergedAt"])
    resolution_days = [
        value for value in (_resolution_days(item) for item in records) if value is not None
    ]
    corrected = lifecycle_counts["revert_correction"] + lifecycle_counts["merged_then_reverted"]
    governance_interventions = lifecycle_counts["closed_duplicate"] + lifecycle_counts["closed_drift"] + corrected
    operator_events = sum(len(item.get("operator_events") or []) for item in records)
    source_total = sum(int(item.get("source_impact_score", item.get("score", 0))) for item in records)
    operator_total = sum(int(item.get("operator_impact_score", 0)) for item in records)
    product_bonus_total = sum(int(item.get("source_product_bonus", 0)) for item in records)
    balanced_operator_total = sum(int(item.get("balanced_operator_impact_score", 0)) for item in records)
    balanced_total = sum(int(item.get("balanced_impact_score", item.get("score", 0))) for item in records)
    return {
        "impact_score_total": balanced_total,
        "balanced_impact_score_total": balanced_total,
        "composite_impact_score_total": source_total + operator_total,
        "source_impact_score_total": source_total,
        "source_product_bonus_total": product_bonus_total,
        "operator_impact_score_total": operator_total,
        "balanced_operator_impact_score_total": balanced_operator_total,
        "resolved_prs": resolved,
        "merged_prs": merged,
        "merge_rate": _percent(merged, resolved),
        "median_resolution_days": round(_median(resolution_days), 1),
        "contributors_represented": len({item["author"] for item in records}),
        "operators_represented": len(
            {
                event.get("actor")
                for item in records
                for event in item.get("operator_events") or []
                if isinstance(event, dict) and event.get("actor")
            }
        ),
        "operator_events": operator_events,
        "patched_then_merged_prs": lifecycle_counts["patched_then_merged"],
        "harvested_source_prs": lifecycle_counts["harvested_source"],
        "closed_duplicate_or_drift_prs": lifecycle_counts["closed_duplicate"] + lifecycle_counts["closed_drift"],
        "reverted_or_corrected_prs": corrected,
        "governance_intervention_load": _percent(governance_interventions, resolved),
        "trust_security_prs": vectors["trust/security"],
        "consent_vault_prs": vectors["consent/vault"],
        "one_kai_nav_alignment_prs": vectors["one/kai/nav"],
        "ria_advisor_prs": vectors["ria/advisor"],
        "onboarding_profile_prs": vectors["onboarding/profile"],
        "portfolio_import_prs": vectors["portfolio/import"],
        "frontend_design_prs": vectors["frontend/design"],
        "backend_api_prs": vectors["backend/api"],
        "user_value_prs": vectors["user utility"],
        "proof_test_prs": vectors["proof/tests"],
        "high_churn_prs": sum(1 for item in records if item["additions"] + item["deletions"] > 3000),
        "duplicate_avoided_prs": lifecycle_counts["closed_duplicate"],
        "regression_corrections": corrected,
        "product_positioning_prs": vectors["one/kai/nav"],
        "bug_fix_or_regression_prs": sum(
            1
            for item in records
            if item["lifecycle"] in {"revert_correction", "merged_then_reverted"}
            or "fix" in str(item.get("title", "")).lower()
            or "bug" in str(item.get("title", "")).lower()
        ),
        "robustness_reliability_prs": sum(
            1
            for item in records
            if {"runtime quality", "trust/security", "consent/vault", "proof/tests"} & set(item["vectors"])
        ),
        "trust_consent_vault_pkm_security_prs": sum(
            1
            for item in records
            if {"trust/security", "consent/vault", "pkm/memory"} & set(item["vectors"])
        ),
        "maintainer_governance_pr_train_events": operator_events + lifecycle_counts["patched_then_merged"] + governance_interventions,
        "fix_keyword_mentions": titles.count("fix"),
    }


def _cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


def _link(item: dict[str, Any]) -> str:
    return f"[#{item['number']}]({item['url']})"


def _topper_lines(
    records: list[dict[str, Any]],
    window: Window,
    limit: int = 10,
    mode: str = "balanced",
) -> list[str]:
    rows = _leaderboard(records, mode=mode)[:limit]
    if not rows:
        return [f"- Window: {_window_display(window)}", "- No resolved PRs in this window."]
    score_label = {
        "balanced": "Balanced Impact",
        "source": "Source Impact",
        "operator": "Maintainer Support",
        "composite": "Raw Source + Maintainer",
    }.get(mode, "Impact Score")
    lines = [
        f"- Window: {_window_display(window)}",
        "",
        f"| Rank | Contributor | {score_label} | Source | Product Bonus | Maintainer Support | Raw Maintainer | Resolved | Merged | Patched | Harvested | Closed | Corrected | Maintainer Events | Top PRs |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for idx, row in enumerate(rows, start=1):
        lines.append(
            f"| {idx} | `{_cell(row['author'])}` | {row['score']} | {row['source_score']} | {row['source_product_bonus']} | "
            f"{row['balanced_operator_score']} | {row['operator_score']} | {row['resolved']} | "
            f"{row['merged']} | {row['patched']} | {row['harvested']} | {row['closed']} | {row['reverted']} | {row['operator_events']} | "
            f"{', '.join(_link(item) for item in row['top'])} |"
        )
    return lines


def _leaderboard_index(records: list[dict[str, Any]], mode: str = "balanced") -> dict[str, dict[str, Any]]:
    return {row["author"]: row for row in _leaderboard(records, mode=mode)}


def _scoreboard_lines(
    weekly_window: Window,
    weekly_records: list[dict[str, Any]],
    two_week_window: Window,
    two_week_records: list[dict[str, Any]],
    overall_window: Window,
    overall_records: list[dict[str, Any]],
    limit: int = 15,
) -> list[str]:
    weekly = _leaderboard_index(weekly_records, mode="balanced")
    two_week = _leaderboard_index(two_week_records, mode="balanced")
    overall = _leaderboard_index(overall_records, mode="balanced")
    authors = {
        row["author"]
        for rows in (
            _leaderboard(weekly_records, mode="balanced")[:10],
            _leaderboard(two_week_records, mode="balanced")[:10],
            _leaderboard(overall_records, mode="balanced")[:10],
        )
        for row in rows
    }

    def value(source: dict[str, dict[str, Any]], author: str, key: str) -> int:
        return int(source.get(author, {}).get(key, 0))

    ranked = sorted(
        authors,
        key=lambda author: (
            value(two_week, author, "score"),
            value(overall, author, "score"),
            value(weekly, author, "score"),
            value(two_week, author, "merged"),
        ),
        reverse=True,
    )[:limit]

    lines = [
        f"- Weekly: {_window_display(weekly_window)}",
        f"- Two-week: {_window_display(two_week_window)}",
        f"- Overall: {_window_display(overall_window)}",
        "",
        "| Rank | Contributor | Weekly Balanced | Two-Week Balanced | Two-Week Source | Product Bonus | Maintainer Support | Raw Maintainer | Overall Balanced | Two-Week PRs | Two-Week Merged | Two-Week Harvested | Maintainer Events |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for idx, author in enumerate(ranked, start=1):
        lines.append(
            f"| {idx} | `{_cell(author)}` | "
            f"{value(weekly, author, 'score')} | "
            f"{value(two_week, author, 'score')} | "
            f"{value(two_week, author, 'source_score')} | "
            f"{value(two_week, author, 'source_product_bonus')} | "
            f"{value(two_week, author, 'balanced_operator_score')} | "
            f"{value(two_week, author, 'operator_score')} | "
            f"{value(overall, author, 'score')} | "
            f"{value(two_week, author, 'resolved')} | "
            f"{value(two_week, author, 'merged')} | "
            f"{value(two_week, author, 'harvested')} | "
            f"{value(two_week, author, 'operator_events')} |"
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
        key=lambda key: sum(int(item.get("balanced_impact_score", item["score"])) for item in by_cluster[key]),
        reverse=True,
    )
    for cluster in ranked[:limit]:
        items = sorted(
            by_cluster[cluster],
            key=lambda item: int(item.get("balanced_impact_score", item["score"])),
            reverse=True,
        )
        score = sum(int(item.get("balanced_impact_score", item["score"])) for item in items)
        lines.append(
            f"| {_cell(cluster)} | {len(items)} | {score} | "
            f"{', '.join(_link(item) for item in items[:5])} |"
        )
    remaining = ranked[limit:]
    if remaining:
        remaining_prs = sum(len(by_cluster[cluster]) for cluster in remaining)
        remaining_score = sum(
            int(item.get("balanced_impact_score", item["score"])) for cluster in remaining for item in by_cluster[cluster]
        )
        lines.append(f"| Other clusters | {remaining_prs} | {remaining_score} | _Grouped to keep the report compact._ |")
    return lines


def _kpi_lines(kpis: dict[str, Any]) -> list[str]:
    labels = {
        "balanced_impact_score_total": "Balanced Impact total",
        "source_impact_score_total": "Source Impact total",
        "source_product_bonus_total": "Product category bonus total",
        "balanced_operator_impact_score_total": "Maintainer Support total",
        "operator_impact_score_total": "Raw maintainer activity total",
        "composite_impact_score_total": "Raw source + maintainer total",
        "resolved_prs": "Resolved PRs",
        "merged_prs": "Merged PRs",
        "merge_rate": "Merge rate",
        "median_resolution_days": "Median PR resolution time (days)",
        "contributors_represented": "Contributors represented",
        "operators_represented": "Maintainers represented",
        "operator_events": "Maintainer events",
        "patched_then_merged_prs": "Patched-then-merged PRs",
        "harvested_source_prs": "Harvested source PRs",
        "closed_duplicate_or_drift_prs": "Closed duplicate/drift PRs",
        "reverted_or_corrected_prs": "Reverted/corrected PRs",
        "governance_intervention_load": "PRs redirected or corrected",
        "product_positioning_prs": "Product positioning / north-star PRs",
        "bug_fix_or_regression_prs": "Bug-fix / regression PRs",
        "robustness_reliability_prs": "Robustness / reliability PRs",
        "trust_consent_vault_pkm_security_prs": "Trust, consent, vault, PKM, security PRs",
        "maintainer_governance_pr_train_events": "Maintainer support / PR train events",
        "trust_security_prs": "Trust/security PRs",
        "consent_vault_prs": "Consent/vault PRs",
        "one_kai_nav_alignment_prs": "One/Kai/Nav alignment PRs",
        "ria_advisor_prs": "RIA / advisor PRs",
        "onboarding_profile_prs": "Onboarding / profile PRs",
        "portfolio_import_prs": "Portfolio import PRs",
        "frontend_design_prs": "Frontend / design-system PRs",
        "backend_api_prs": "Backend API / contract PRs",
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


def _kpi_comparison_lines(primary_kpis: dict[str, Any], overall_kpis: dict[str, Any]) -> list[str]:
    labels = [
        ("balanced_impact_score_total", "Balanced Impact total"),
        ("source_impact_score_total", "Source Impact total"),
        ("source_product_bonus_total", "Product category bonus total"),
        ("balanced_operator_impact_score_total", "Maintainer Support total"),
        ("operator_impact_score_total", "Raw maintainer activity total"),
        ("composite_impact_score_total", "Raw source + maintainer total"),
        ("resolved_prs", "Resolved PRs"),
        ("merged_prs", "Merged PRs"),
        ("merge_rate", "Merge rate"),
        ("median_resolution_days", "Median PR resolution time"),
        ("contributors_represented", "Contributors represented"),
        ("operators_represented", "Maintainers represented"),
        ("operator_events", "Maintainer events"),
        ("harvested_source_prs", "Harvested source PRs"),
        ("product_positioning_prs", "Product positioning / north-star PRs"),
        ("bug_fix_or_regression_prs", "Bug-fix / regression PRs"),
        ("robustness_reliability_prs", "Robustness / reliability PRs"),
        ("trust_security_prs", "Trust/security PRs"),
        ("consent_vault_prs", "Consent/vault PRs"),
        ("one_kai_nav_alignment_prs", "One/Kai/Nav alignment PRs"),
        ("ria_advisor_prs", "RIA / advisor PRs"),
        ("onboarding_profile_prs", "Onboarding / profile PRs"),
        ("portfolio_import_prs", "Portfolio import PRs"),
        ("frontend_design_prs", "Frontend / design-system PRs"),
        ("backend_api_prs", "Backend API / contract PRs"),
        ("proof_test_prs", "Proof/test PRs"),
        ("duplicate_avoided_prs", "Duplicate avoided PRs"),
        ("regression_corrections", "Regression corrections"),
    ]
    lines = [
        "| KPI | Two-Week Window | All-Time Resolved |",
        "| --- | ---: | ---: |",
    ]
    for key, label in labels:
        lines.append(f"| {_cell(label)} | {primary_kpis.get(key, 0)} | {overall_kpis.get(key, 0)} |")
    return lines


def _bar(value: int, maximum: int, width: int = GRAPH_WIDTH) -> str:
    if maximum <= 0 or value <= 0:
        return ""
    filled = max(1, round((value / maximum) * width))
    return "█" * min(filled, width)


def _impact_area_label(vector: str) -> str:
    return {
        "trust/security": "Trust / security",
        "consent/vault": "Consent / vault",
        "one/kai/nav": "One / Kai / Nav / agents",
        "ria/advisor": "RIA / advisor",
        "onboarding/profile": "Onboarding / profile",
        "portfolio/import": "Portfolio import",
        "pkm/memory": "PKM / memory",
        "frontend/design": "Frontend / design system",
        "backend/api": "Backend API / contracts",
        "user utility": "User value",
        "runtime quality": "Runtime quality",
        "proof/tests": "Proof / tests",
        "ops/governance": "Docs / governance / ops",
        "general": "General",
    }.get(vector, vector)


def _leaderboard_graph_lines(
    records: list[dict[str, Any]],
    title: str,
    limit: int = 10,
    mode: str = "balanced",
) -> list[str]:
    rows = _leaderboard(records, mode=mode)[:limit]
    if not rows:
        return [f"### {title}", "", "- No resolved PRs in this window."]
    maximum = max(int(row["score"]) for row in rows)
    lines = [
        f"### {title}",
        "",
        "| Rank | Contributor | Score | Source | Product Bonus | Maintainer Support | Raw Maintainer | Graph |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for idx, row in enumerate(rows, start=1):
        lines.append(
            f"| {idx} | `{_cell(row['author'])}` | {row['score']} | {row['source_score']} | {row['source_product_bonus']} | "
            f"{row['balanced_operator_score']} | {row['operator_score']} | {_bar(int(row['score']), maximum)} |"
        )
    return lines


def _finished_date(item: dict[str, Any]) -> date | None:
    finished = _parse_datetime(item.get("mergedAt") or item.get("closedAt"))
    return finished.date() if finished else None


def _week_start(value: date) -> date:
    return value - timedelta(days=value.weekday())


def _timeline_graph_lines(records: list[dict[str, Any]], limit: int = 12) -> list[str]:
    by_week: dict[date, list[dict[str, Any]]] = defaultdict(list)
    for item in records:
        finished = _finished_date(item)
        if finished:
            by_week[_week_start(finished)].append(item)
    if not by_week:
        return ["### Weekly Resolved PR Trend", "", "- No resolved PRs available for trend analysis."]

    weeks = sorted(by_week)
    if len(weeks) > limit:
        weeks = weeks[-limit:]
    maximum = max(len(by_week[week]) for week in weeks)
    lines = [
        "### Weekly Resolved PR Trend",
        "",
        "| Week | Resolved | Merged | Balanced Impact | Graph |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    today = date.today()
    for week in weeks:
        items = by_week[week]
        merged = sum(1 for item in items if item.get("mergedAt"))
        score = sum(int(item.get("balanced_impact_score", item["score"])) for item in items)
        lines.append(
            f"| {_friendly_range(week, min(week + timedelta(days=6), today))} | "
            f"{len(items)} | {merged} | {score} | {_bar(len(items), maximum)} |"
        )
    return lines


def _impact_area_mix_lines(
    primary_records: list[dict[str, Any]],
    overall_records: list[dict[str, Any]],
) -> list[str]:
    primary = Counter(vector for item in primary_records for vector in item["vectors"])
    overall = Counter(vector for item in overall_records for vector in item["vectors"])
    vectors = sorted(
        set(primary) | set(overall),
        key=lambda vector: (overall[vector], primary[vector], vector),
        reverse=True,
    )
    if not vectors:
        return ["### Impact Area Mix", "", "- No impact vectors detected."]
    maximum = max(overall[vector] for vector in vectors)
    lines = [
        "### Impact Area Mix",
        "",
        "| Impact Area | Two-Week PRs | All-Time PRs | All-Time Graph |",
        "| --- | ---: | ---: | --- |",
    ]
    for vector in vectors:
        lines.append(
            f"| {_cell(_impact_area_label(vector))} | {primary[vector]} | {overall[vector]} | {_bar(overall[vector], maximum)} |"
        )
    return lines


def _how_accounted_lines() -> list[str]:
    return [
        "- Source Impact credits the PR author or harvested source contributor for the useful idea, code, proof, or product improvement.",
        "- Product category bonus makes strong ideas easier to see when they extend One/Kai/Nav, RIA, onboarding, vault, PKM, portfolio import, runtime quality, or proof surfaces.",
        "- Maintainer Support credits review, patch, harvest, closure, queue, and merge work, but the default leaderboard uses capped weighted support so routine operator volume cannot dominate.",
        "- Balanced Impact is the default ranking: Source Impact + product category bonus + capped Maintainer Support.",
        "- Raw maintainer activity and raw source + maintainer totals remain available for internal diagnosis.",
        "- GitHub Credit is separate and still depends on commit authorship or valid `Co-authored-by` trailers.",
    ]


def _product_breakdown(records: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    rows = {
        "One / Kai / Nav / agents": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "RIA and advisor workflows": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "onboarding and profile": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "portfolio import / Plaid / statements": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "vault / PKM / consent / trust": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "robustness / reliability / bug fixes": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "frontend design system / responsiveness": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "backend API / runtime contracts": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "proof / tests / CI": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "docs / governance / release operations": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
        "maintainer support / PR throughput": {"prs": 0, "balanced": 0, "source": 0, "maintainer": 0},
    }

    def add(name: str, item: dict[str, Any]) -> None:
        rows[name]["prs"] += 1
        rows[name]["balanced"] += int(item.get("balanced_impact_score", item.get("score", 0)))
        rows[name]["source"] += int(item.get("source_impact_score", item.get("score", 0)))
        rows[name]["maintainer"] += int(item.get("balanced_operator_impact_score", 0))

    for item in records:
        vectors = set(item["vectors"])
        title = str(item.get("title", "")).lower()
        item_areas: set[str] = set()

        def add_once(name: str) -> None:
            if name in item_areas:
                return
            item_areas.add(name)
            add(name, item)

        if "one/kai/nav" in vectors:
            add_once("One / Kai / Nav / agents")
        if "ria/advisor" in vectors:
            add_once("RIA and advisor workflows")
        if "onboarding/profile" in vectors:
            add_once("onboarding and profile")
        if "portfolio/import" in vectors:
            add_once("portfolio import / Plaid / statements")
        if vectors & {"trust/security", "consent/vault", "pkm/memory"}:
            add_once("vault / PKM / consent / trust")
        if item["lifecycle"] in {"revert_correction", "merged_then_reverted"} or "fix" in title or "bug" in title:
            add_once("robustness / reliability / bug fixes")
        if vectors & {"runtime quality", "trust/security", "consent/vault", "proof/tests"}:
            add_once("robustness / reliability / bug fixes")
        if "frontend/design" in vectors:
            add_once("frontend design system / responsiveness")
        if "backend/api" in vectors:
            add_once("backend API / runtime contracts")
        if "proof/tests" in vectors:
            add_once("proof / tests / CI")
        if "ops/governance" in vectors:
            add_once("docs / governance / release operations")
        if "ops/governance" in vectors or item.get("operator_events"):
            add_once("maintainer support / PR throughput")
    return rows


def _product_breakdown_lines(
    two_week_records: list[dict[str, Any]],
    overall_records: list[dict[str, Any]],
) -> list[str]:
    two_week = _product_breakdown(two_week_records)
    overall = _product_breakdown(overall_records)
    lines = [
        "| Product Area | Two-Week PRs | Two-Week Balanced | Two-Week Source | Maintainer Support | Overall PRs | Overall Balanced |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for area in two_week:
        lines.append(
            f"| {_cell(area)} | {two_week[area]['prs']} | {two_week[area]['balanced']} | "
            f"{two_week[area]['source']} | {two_week[area]['maintainer']} | "
            f"{overall[area]['prs']} | {overall[area]['balanced']} |"
        )
    return lines


def _lifecycle_mix_lines(records: list[dict[str, Any]]) -> list[str]:
    lifecycle_labels = {
        "merged": "Merged",
        "patched_then_merged": "Patched then merged",
        "harvested_source": "Harvested source",
        "revert_correction": "Revert correction",
        "merged_then_reverted": "Merged then reverted",
        "closed_duplicate": "Closed duplicate",
        "closed_drift": "Closed drift",
        "changes_requested": "Changes requested",
        "closed_unmerged": "Closed without merge",
    }
    counts = Counter(item["lifecycle"] for item in records)
    if not counts:
        return ["### Resolution Mix", "", "- No lifecycle data available."]
    rows = sorted(counts.items(), key=lambda pair: pair[1], reverse=True)
    maximum = max(count for _, count in rows)
    lines = [
        "### Resolution Mix",
        "",
        "| Outcome | PRs | Graph |",
        "| --- | ---: | --- |",
    ]
    for lifecycle, count in rows:
        lines.append(
            f"| {_cell(lifecycle_labels.get(lifecycle, lifecycle))} | {count} | {_bar(count, maximum)} |"
        )
    return lines


def _pr_summary(item: dict[str, Any] | None) -> str:
    if not item:
        return "Unavailable"
    created = _parse_datetime(item.get("createdAt"))
    date_text = _friendly_date(created.date()) if created else "unknown date"
    url = item.get("url")
    number = item.get("number")
    if url and number:
        return f"[#{number}]({url}) on {date_text}"
    if number:
        return f"#{number} on {date_text}"
    return date_text


def _github_audit_lines(insights: dict[str, Any], overall_window: Window) -> list[str]:
    included = int(insights.get("included_resolved_prs", 0))
    closed = int(insights.get("closed_prs", 0))
    merged = int(insights.get("merged_prs", 0))
    status = "Complete against GitHub closed-PR count"
    if closed > insights.get("fetch_limit", PR_FETCH_LIMIT):
        status = "Partial: GitHub result count exceeds current fetch limit"
    elif included != closed:
        status = f"Needs review: included {included} of {closed} closed PRs"
    lines = [
        "| Audit Check | Value |",
        "| --- | ---: |",
        f"| GitHub PRs discovered | {insights.get('total_prs', 0)} |",
        f"| Open PRs not scored yet | {insights.get('open_prs', 0)} |",
        f"| Closed PRs | {closed} |",
        f"| Merged PRs | {merged} |",
        f"| Closed without merge | {insights.get('closed_unmerged_prs', 0)} |",
        f"| Resolved PRs included in all-time score | {included} |",
        f"| All-time window | {_window_display(overall_window)} |",
        f"| First PR GitHub exposes | {_pr_summary(insights.get('first_pr'))} |",
        f"| First resolved PR included | {_pr_summary(insights.get('first_resolved_pr'))} |",
        f"| Coverage status | {_cell(status)} |",
    ]
    return lines


def _most_impactful(records: list[dict[str, Any]], limit: int = 10) -> list[str]:
    lines = []
    for item in sorted(records, key=lambda row: (int(row.get("balanced_impact_score", row["score"])), row["number"]), reverse=True)[:limit]:
        lines.append(
            f"- {_link(item)} by `{item['author']}` - Balanced Impact `{item.get('balanced_impact_score', item['score'])}`: "
            f"{item['reason']}"
        )
    return lines or ["- No resolved PRs in this window."]


def _harvest_attribution_lines(records: list[dict[str, Any]]) -> list[str]:
    harvested = [
        item for item in records if item.get("lifecycle") == "harvested_source"
    ]
    if not harvested:
        return [
            "- No maintainer-harvest source credits detected in this window.",
        ]
    lines = [
        "These are Hussh impact credits for contributor PRs whose useful value was harvested into a maintainer patch. Internal impact credit stays on the source PRs. External GitHub credit requires valid co-author trailers on a real commit.",
        "",
        "For [PR #1013](https://github.com/hushh-labs/hushh-research/pull/1013), the original merge commit was not co-authored. GitHub-visible co-author credit is provided by the transparent co-authored harvest replay follow-up once that commit lands; it does not change #1013's original merge authorship or original additions/deletions.",
        "",
        "| Source PR | Contributor | Landing PR | Accepted Value | Official GitHub Commit Credit |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item in sorted(
        harvested,
        key=lambda row: (int(row.get("harvestedInto") or 0), int(row["number"])),
    ):
        landing = int(item.get("harvestedInto") or 0)
        lines.append(
            f"| {_link(item)} | `{_cell(item['author'])}` | {_pr_link(landing) if landing else 'n/a'} | "
            f"{_cell(item.get('harvestAcceptedValue') or item['reason'])} | "
            "Contributor is co-authored on the harvest replay follow-up once it lands; original landing merge authorship is unchanged. |"
        )
    return lines


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
    overall_window: Window,
    overall_records: list[dict[str, Any]],
    github_insights: dict[str, Any],
) -> str:
    refreshed = _refreshed_display()
    kpis = _kpis(records)
    overall_kpis = _kpis(overall_records)
    lines = [
        "# Contributor Impact Dashboard",
        "",
        "Status: rolling operational record",
        f"Last refreshed: {refreshed}",
        f"Repo: https://github.com/{repo}",
        f"Two-week window: {_window_display(window)}",
        f"Overall window: {_window_display(overall_window)}",
        "",
        "## Index",
        "",
        "- [Executive Summary](#executive-summary)",
        "- [How This Is Counted](#how-this-is-counted)",
        "- [GitHub Coverage Audit](#github-coverage-audit)",
        "- [Harvest Attribution](#harvest-attribution)",
        "- [KPI Board](#kpi-board)",
        "- [Visual Insights](#visual-insights)",
        "- [Weekly And Two-Week Scoreboard](#weekly-and-two-week-scoreboard)",
        "- [Weekly Top 10](#weekly-top-10)",
        "- [Two-Week Top 10](#two-week-top-10)",
        "- [Overall Top 10](#overall-top-10)",
        "- [Most Impactful PRs](#most-impactful-prs)",
        "- [Directional Corrections](#directional-corrections)",
        "- [Product Area Impact](#product-area-impact)",
        "- [Contract Clusters](#contract-clusters)",
        "",
        "## Executive Summary",
        "",
        f"- Resolved PRs in two-week window: `{len(records)}`.",
        f"- Two-week Balanced Impact total: `{kpis['balanced_impact_score_total']}` (`{kpis['source_impact_score_total']}` Source Impact + `{kpis['source_product_bonus_total']}` product category bonus + `{kpis['balanced_operator_impact_score_total']}` Maintainer Support).",
        f"- Raw maintainer activity total: `{kpis['operator_impact_score_total']}`; raw source + maintainer total: `{kpis['composite_impact_score_total']}`.",
        f"- All-time resolved PRs scored: `{overall_kpis['resolved_prs']}` with Balanced Impact `{overall_kpis['balanced_impact_score_total']}`.",
        f"- GitHub currently shows `{github_insights.get('total_prs', 0)}` PRs: `{github_insights.get('open_prs', 0)}` open and `{github_insights.get('closed_prs', 0)}` closed.",
        f"- Merged PRs: `{kpis['merged_prs']}`.",
        f"- Merge rate: `{kpis['merge_rate']}` with median PR resolution time `{kpis['median_resolution_days']}` days.",
        f"- Contributors represented: `{kpis['contributors_represented']}`.",
        f"- Maintainer events represented: `{kpis['operator_events']}` across `{kpis['operators_represented']}` maintainer(s).",
        f"- Harvested source PRs credited internally: `{kpis['harvested_source_prs']}`.",
        f"- Redirected or corrected PRs: `{kpis['governance_intervention_load']}` across duplicate, drift, and revert/correction work.",
        "- KPI model weighs product area, robustness, bug fixing, trust/security, proof, throughput, and Maintainer Support. Raw PR count is never the winner by itself.",
        "- GitHub Credit still follows Git commit authorship and valid `Co-authored-by` trailers; comments and PR references are internal/public acknowledgement only.",
        "",
        "## How This Is Counted",
        "",
        *_how_accounted_lines(),
        "",
        "## GitHub Coverage Audit",
        "",
        *_github_audit_lines(github_insights, overall_window),
        "",
        "## Harvest Attribution",
        "",
        *_harvest_attribution_lines(records),
        "",
        "## KPI Board",
        "",
        *_kpi_lines(kpis),
        "",
        "### Two-Week Vs All-Time",
        "",
        *_kpi_comparison_lines(kpis, overall_kpis),
        "",
        "## Visual Insights",
        "",
        *_leaderboard_graph_lines(records, "Balanced Impact Leaders", mode="balanced"),
        "",
        *_leaderboard_graph_lines(records, "Source Contribution Leaders", mode="source"),
        "",
        *_leaderboard_graph_lines(records, "Maintainer Support Leaders", mode="operator"),
        "",
        *_leaderboard_graph_lines(overall_records, "All-Time Balanced Impact Leaders", mode="balanced"),
        "",
        *_timeline_graph_lines(overall_records),
        "",
        *_impact_area_mix_lines(records, overall_records),
        "",
        *_lifecycle_mix_lines(overall_records),
        "",
        "## Weekly And Two-Week Scoreboard",
        "",
        *_scoreboard_lines(weekly_window, weekly_records, window, records, overall_window, overall_records),
        "",
        "## Weekly Top 10",
        "",
        *_topper_lines(weekly_records, weekly_window, mode="balanced"),
        "",
        "## Two-Week Top 10",
        "",
        *_topper_lines(records, window, mode="balanced"),
        "",
        "## Overall Top 10",
        "",
        *_topper_lines(overall_records, overall_window, mode="balanced"),
        "",
        "## Most Impactful PRs",
        "",
        *_most_impactful(records),
        "",
        "## Directional Corrections",
        "",
        *_corrections(records),
        "",
        "## Product Area Impact",
        "",
        *_product_breakdown_lines(records, overall_records),
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
    overall_window: Window,
    overall_records: list[dict[str, Any]],
    github_insights: dict[str, Any],
) -> dict[str, Any]:
    return {
        "repo": repo,
        "window": {
            "label": window.label,
            "since": window.since.isoformat(),
            "until": window.until.isoformat(),
            "display": _window_display(window),
        },
        "overall_window": {
            "label": overall_window.label,
            "since": overall_window.since.isoformat(),
            "until": overall_window.until.isoformat(),
            "display": _window_display(overall_window),
        },
        "github_insights": github_insights,
        "kpis": _kpis(records),
        "overall_kpis": _kpis(overall_records),
        "harvest_credits": HARVEST_CREDITS,
        "leaderboard": _leaderboard(records, mode="balanced"),
        "balanced_leaderboard": _leaderboard(records, mode="balanced"),
        "composite_leaderboard": _leaderboard(records, mode="composite"),
        "source_leaderboard": _leaderboard(records, mode="source"),
        "operator_leaderboard": _leaderboard(records, mode="operator"),
        "weekly_top_10": {
            "window": {
                "label": weekly_window.label,
                "since": weekly_window.since.isoformat(),
                "until": weekly_window.until.isoformat(),
                "display": _window_display(weekly_window),
            },
            "contributors": _leaderboard(weekly_records, mode="balanced")[:10],
        },
        "weekly_two_week_scoreboard": {
            "weekly_window": _window_display(weekly_window),
            "two_week_window": _window_display(window),
            "overall_window": _window_display(overall_window),
        },
        "two_week_top_10": {
            "window": {
                "label": two_week_window.label,
                "since": two_week_window.since.isoformat(),
                "until": two_week_window.until.isoformat(),
                "display": _window_display(two_week_window),
            },
            "contributors": _leaderboard(two_week_records, mode="balanced")[:10],
        },
        "overall_top_10": {
            "window": {
                "label": overall_window.label,
                "since": overall_window.since.isoformat(),
                "until": overall_window.until.isoformat(),
                "display": _window_display(overall_window),
            },
            "contributors": _leaderboard(overall_records, mode="balanced")[:10],
        },
        "product_area_impact": _product_breakdown(records),
        "product_impact_breakdown": _product_breakdown(records),
        "records": records,
        "overall_records": overall_records,
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
    parser.add_argument("--days", type=int, default=None, help=f"Two-week rolling window in days. Default: {DEFAULT_PRIMARY_DAYS}.")
    parser.add_argument("--month", nargs="?", const="current", help="Use a calendar month window, optionally YYYY-MM.")
    parser.add_argument("--since", help="Explicit two-week/dashboard window start date, YYYY-MM-DD.")
    parser.add_argument("--until", help="Explicit two-week/dashboard window end date, YYYY-MM-DD. Defaults to today when --since is used.")
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
    overall_records = _records_for_all_time(args.repo)
    overall = _all_time_window(overall_records)
    github_insights = _github_insights(args.repo, overall_records)
    cache = _cached_records(args.repo, [primary, weekly, two_week])
    records = cache[(primary.since, primary.until)]
    weekly_records = cache[(weekly.since, weekly.until)]
    two_week_records = cache[(two_week.since, two_week.until)]

    if args.json:
        print(json.dumps(_json_payload(args.repo, primary, records, weekly, weekly_records, two_week, two_week_records, overall, overall_records, github_insights), indent=2))
    else:
        print(_report_text(args.repo, primary, records, weekly, weekly_records, two_week, two_week_records, overall, overall_records, github_insights))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
