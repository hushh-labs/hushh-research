#!/usr/bin/env python3
"""Collect calendar-ready, organization-scoped GitHub report evidence.

Owner: platform. Requires an authenticated ``gh`` CLI session with read access to the
requested organization. The collector records GitHub metadata only and never reads,
stores, or emits credentials.
"""

from __future__ import annotations

import argparse
import calendar
import json
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, time as clock_time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SEARCH_QUERY = """
query($searchTerm: String!, $after: String) {
  search(type: ISSUE, query: $searchTerm, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number url title createdAt mergedAt closedAt state isDraft
        additions deletions changedFiles
        author { login }
        repository { nameWithOwner url isPrivate }
        commits(last: 1) {
          nodes {
            commit {
              oid url committedDate messageHeadline
              statusCheckRollup { state }
            }
          }
        }
      }
      ... on Issue {
        number url title createdAt closedAt state
        author { login }
        repository { nameWithOwner url isPrivate }
      }
    }
  }
}
"""

COMMIT_QUERY = """
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    login name url
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalRepositoriesWithContributedCommits
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner url isPrivate }
        contributions(first: 1) { totalCount }
      }
    }
  }
}
"""

REVIEW_QUERY = """
query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      pullRequestReviewContributions(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          occurredAt
          pullRequestReview {
            state url
            pullRequest {
              number url title state mergedAt
              repository { nameWithOwner url isPrivate }
            }
          }
        }
      }
    }
  }
}
"""


@dataclass(frozen=True)
class Window:
    month: str
    start_date: date
    end_date: date
    timezone_name: str

    @property
    def local_zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_name)

    @property
    def start_local(self) -> datetime:
        return datetime.combine(self.start_date, clock_time.min, tzinfo=self.local_zone)

    @property
    def end_local(self) -> datetime:
        return datetime.combine(self.end_date, clock_time.max, tzinfo=self.local_zone)

    @property
    def from_utc(self) -> str:
        return self.start_local.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    @property
    def to_utc(self) -> str:
        return self.end_local.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    @property
    def search_start_date(self) -> date:
        """Include the local-month boundary even when it crosses a UTC calendar day."""
        return self.start_local.astimezone(timezone.utc).date() - timedelta(days=1)

    @property
    def search_end_date(self) -> date:
        return self.end_local.astimezone(timezone.utc).date() + timedelta(days=1)


def parse_window(value: str, timezone_name: str) -> Window:
    try:
        year, month = (int(part) for part in value.split("-", 1))
        start = date(year, month, 1)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("month must use YYYY-MM") from error
    end = date(year, month, calendar.monthrange(year, month)[1])
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as error:
        raise argparse.ArgumentTypeError(f"timezone must be a valid IANA name, got {timezone_name!r}") from error
    return Window(month=value, start_date=start, end_date=end, timezone_name=timezone_name)


def parse_person(value: str) -> tuple[str, str]:
    display_name, separator, login = value.partition("=")
    if not separator or not display_name.strip() or not login.strip():
        raise argparse.ArgumentTypeError("person must use Display name=github-login")
    return display_name.strip(), login.strip()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True, help="GitHub organization login, for example hushh-labs")
    parser.add_argument("--month", required=True, help="local reporting month in YYYY-MM form")
    parser.add_argument(
        "--timezone",
        required=True,
        help="IANA timezone for report boundaries and calendar labels, for example America/Los_Angeles",
    )
    parser.add_argument(
        "--person",
        action="append",
        required=True,
        type=parse_person,
        metavar="DISPLAY=LOGIN",
        help="repeat once for each attributed contributor",
    )
    parser.add_argument("--output", required=True, type=Path, help="JSON evidence file to create")
    args = parser.parse_args(argv)
    args.month = parse_window(args.month, args.timezone)
    return args


def gh_json(args: list[str]) -> Any:
    for attempt in range(4):
        result = subprocess.run(["gh", *args], text=True, capture_output=True, check=False)
        if result.returncode == 0:
            return json.loads(result.stdout)
        retryable = any(code in result.stderr for code in ("HTTP 429", "HTTP 502", "HTTP 503"))
        if not retryable or attempt == 3:
            raise RuntimeError(result.stderr.strip() or "gh command failed")
        time.sleep(2**attempt)
    raise AssertionError("unreachable")


def gh_pages(endpoint: str) -> list[dict[str, Any]]:
    pages = gh_json(["api", "--paginate", "--slurp", endpoint])
    if not isinstance(pages, list):
        raise RuntimeError(f"unexpected paginated response for {endpoint}")
    return [item for page in pages for item in page]


def graphql(query: str, variables: dict[str, str]) -> dict[str, Any]:
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        args.extend(["-f", f"{key}={value}"])
    payload = gh_json(args)
    if "errors" in payload:
        raise RuntimeError(json.dumps(payload["errors"], indent=2))
    return payload["data"]


def search_all(query_text: str) -> tuple[int, list[dict[str, Any]]]:
    after: str | None = None
    nodes: list[dict[str, Any]] = []
    total: int | None = None
    while True:
        variables = {"searchTerm": query_text}
        if after:
            variables["after"] = after
        search = graphql(SEARCH_QUERY, variables)["search"]
        total = search["issueCount"]
        if total > 1000:
            raise RuntimeError(
                f"GitHub Search has {total} matches for `{query_text}`, above its 1,000-result cap; "
                "split the source query before reporting."
            )
        nodes.extend(search["nodes"])
        page = search["pageInfo"]
        if not page["hasNextPage"]:
            return total, nodes
        after = page["endCursor"]


def reviews_all(login: str, window: Window) -> list[dict[str, Any]]:
    after: str | None = None
    nodes: list[dict[str, Any]] = []
    while True:
        variables = {"login": login, "from": window.from_utc, "to": window.to_utc}
        if after:
            variables["after"] = after
        contribution = graphql(REVIEW_QUERY, variables)["user"]["contributionsCollection"]
        reviews = contribution["pullRequestReviewContributions"]
        nodes.extend(reviews["nodes"])
        page = reviews["pageInfo"]
        if not page["hasNextPage"]:
            return nodes
        after = page["endCursor"]


def belongs_to_org(node: dict[str, Any], organization: str) -> bool:
    repository = node.get("repository") or {}
    return repository.get("nameWithOwner", "").startswith(f"{organization}/")


def date_in_window(value: str | None, window: Window) -> str | None:
    if not value:
        return None
    event_time = datetime.fromisoformat(value.replace("Z", "+00:00"))
    event_date = event_time.astimezone(window.local_zone).date()
    if window.start_date <= event_date <= window.end_date:
        return event_date.isoformat()
    return None


def empty_calendar(window: Window) -> dict[str, dict[str, Any]]:
    dates: dict[str, dict[str, Any]] = {}
    current = window.start_date
    while current <= window.end_date:
        dates[current.isoformat()] = {"prs_opened": 0, "prs_merged": 0, "issues_created": 0, "contributors": {}}
        current = date.fromordinal(current.toordinal() + 1)
    return dates


def add_daily_event(
    calendar_days: dict[str, dict[str, Any]],
    event_date: str | None,
    display_name: str,
    metric: str,
    source: dict[str, Any] | None = None,
) -> None:
    if not event_date:
        return
    day = calendar_days[event_date]
    day[metric] += 1
    contributor = day["contributors"].setdefault(
        display_name, {"prs_opened": 0, "prs_merged": 0, "issues_created": 0, "events": []}
    )
    contributor[metric] += 1
    if source:
        contributor["events"].append(source)


def source_reference(node: dict[str, Any], kind: str, event_at: str) -> dict[str, Any]:
    """Preserve an auditable source link without implying the event date is a work date."""
    source: dict[str, Any] = {
        "kind": kind,
        "number": node["number"],
        "url": node["url"],
        "title": node["title"],
        "event_at": event_at,
    }
    commit = (((node.get("commits") or {}).get("nodes") or [{}])[0].get("commit") or {})
    if commit.get("url"):
        source["head_commit"] = {
            "oid": commit["oid"],
            "short_oid": commit["oid"][:7],
            "url": commit["url"],
            "committed_at": commit.get("committedDate"),
            "message_headline": commit.get("messageHeadline"),
        }
    return source


def by_repository(nodes: list[dict[str, Any]]) -> dict[str, int]:
    return dict(sorted(Counter(node["repository"]["nameWithOwner"] for node in nodes).items()))


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    people = dict(args.person)
    if len(people) != len(args.person) or len(set(people.values())) != len(people):
        raise ValueError("each display name and GitHub login must be unique")

    # Proves the authenticated API lane before a potentially expensive collection.
    gh_json(["api", "user"])
    organization = gh_json(["api", f"orgs/{args.org}"])
    repositories = gh_pages(f"orgs/{args.org}/repos?type=all&per_page=100")
    members = gh_pages(f"orgs/{args.org}/members?per_page=100")
    calendar_days = empty_calendar(args.month)

    result: dict[str, Any] = {
        "schema_version": 3,
        "collector": "skills/pdf-artifact-generation/scripts/collect_github_month.py",
        "audit_window": {
            "month": args.month.month,
            "timezone": args.month.timezone_name,
            "from_local": args.month.start_local.isoformat(),
            "to_local": args.month.end_local.isoformat(),
            "from_utc": args.month.from_utc,
            "to_utc": args.month.to_utc,
        },
        "source_collected_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "organization": {
            "login": organization["login"],
            "url": organization["html_url"],
            "repositories_visible_to_audit": len(repositories),
            "public_repositories_visible": sum(not repository["private"] for repository in repositories),
            "private_repositories_visible": sum(repository["private"] for repository in repositories),
        },
        "identity_mapping": {},
        "people": {},
        "calendar": {"timezone": args.month.timezone_name, "days": calendar_days},
    }

    all_merged: list[dict[str, Any]] = []
    all_opened: list[dict[str, Any]] = []
    all_reviewed: list[dict[str, Any]] = []
    for display_name, login in people.items():
        user = gh_json(["api", f"users/{login}"])
        result["identity_mapping"][display_name] = {
            "login": login,
            "profile_name": user.get("name"),
            "url": user["html_url"],
            "confirmed_org_member": any(member["login"].lower() == login.lower() for member in members),
        }

        commit_data = graphql(
            COMMIT_QUERY, {"login": login, "from": args.month.from_utc, "to": args.month.to_utc}
        )["user"]
        contribution = commit_data["contributionsCollection"]
        commit_repositories = [
            {"repository": item["repository"], "count": item["contributions"]["totalCount"]}
            for item in contribution["commitContributionsByRepository"]
            if item["repository"]["nameWithOwner"].startswith(f"{args.org}/")
        ]

        created_range = f"{args.month.search_start_date.isoformat()}..{args.month.search_end_date.isoformat()}"
        _, opened_source = search_all(f"org:{args.org} author:{login} is:pr created:{created_range}")
        _, merged_source = search_all(f"org:{args.org} author:{login} is:pr merged:{created_range}")
        _, issues_source = search_all(f"org:{args.org} author:{login} is:issue -is:pr created:{created_range}")
        opened = [node for node in opened_source if date_in_window(node["createdAt"], args.month)]
        merged = [node for node in merged_source if date_in_window(node["mergedAt"], args.month)]
        issues = [node for node in issues_source if date_in_window(node["createdAt"], args.month)]
        reviews = [
            node
            for node in reviews_all(login, args.month)
            if belongs_to_org(node["pullRequestReview"]["pullRequest"], args.org)
        ]

        for node in [*opened, *merged, *reviews]:
            node["audit_display_name"] = display_name
        for node in opened:
            add_daily_event(
                calendar_days,
                date_in_window(node["createdAt"], args.month),
                display_name,
                "prs_opened",
                source_reference(node, "pull_request_opened", node["createdAt"]),
            )
        for node in merged:
            add_daily_event(
                calendar_days,
                date_in_window(node["mergedAt"], args.month),
                display_name,
                "prs_merged",
                source_reference(node, "pull_request_merged", node["mergedAt"]),
            )
        for node in issues:
            add_daily_event(
                calendar_days,
                date_in_window(node["createdAt"], args.month),
                display_name,
                "issues_created",
                source_reference(node, "issue_created", node["createdAt"]),
            )
        all_opened.extend(opened)
        all_merged.extend(merged)
        all_reviewed.extend(reviews)

        result["people"][display_name] = {
            "login": login,
            "commits": {
                "github_recognized_default_branch_count": sum(item["count"] for item in commit_repositories),
                "by_repository": commit_repositories,
                "github_all_repositories_count_unscoped": contribution["totalCommitContributions"],
                "github_all_repositories_distinct_count_unscoped": contribution["totalRepositoriesWithContributedCommits"],
            },
            "pull_requests": {
                "opened_in_window_count": len(opened),
                "merged_in_window_count": len(merged),
                "opened_in_window": opened,
                "merged_in_window": merged,
            },
            "reviews": {"github_recorded_count": len(reviews), "events": reviews},
            "issues": {"created_in_window_count": len(issues), "created_in_window": issues},
        }

    result["combined"] = {
        "commits": sum(person["commits"]["github_recognized_default_branch_count"] for person in result["people"].values()),
        "prs_opened": sum(person["pull_requests"]["opened_in_window_count"] for person in result["people"].values()),
        "prs_merged": sum(person["pull_requests"]["merged_in_window_count"] for person in result["people"].values()),
        "review_events": sum(person["reviews"]["github_recorded_count"] for person in result["people"].values()),
        "issues_created": sum(person["issues"]["created_in_window_count"] for person in result["people"].values()),
        "pr_opened_by_repository": by_repository(all_opened),
        "pr_merged_by_repository": by_repository(all_merged),
        "review_by_repository": dict(
            sorted(
                Counter(
                    node["pullRequestReview"]["pullRequest"]["repository"]["nameWithOwner"]
                    for node in all_reviewed
                ).items()
            )
        ),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (RuntimeError, ValueError) as error:
        print(f"GitHub month collection failed: {error}", file=sys.stderr)
        raise SystemExit(1)
