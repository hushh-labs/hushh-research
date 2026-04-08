#!/usr/bin/env python3
"""Helper for Hushh Engineering Core GitHub board operations."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from collections import Counter
from typing import Any

OWNER = "hushh-labs"
PROJECT_NUMBER = 73
PROJECT_TITLE = "Hushh Engineering Core"
DEFAULT_REPO = "hushh-labs/hushh-research"
DEFAULT_STATUS = "In progress"


class BoardOpsError(RuntimeError):
    pass


def run_gh(args: list[str], *, input_text: str | None = None) -> str:
    proc = subprocess.run(
        ["gh", *args],
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise BoardOpsError(proc.stderr.strip() or proc.stdout.strip() or "gh command failed")
    return proc.stdout


def run_gh_json(args: list[str], *, input_text: str | None = None) -> Any:
    output = run_gh(args, input_text=input_text)
    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        raise BoardOpsError(f"invalid JSON from gh: {exc}") from exc


def graphql(query: str) -> Any:
    return run_gh_json(["api", "graphql", "-f", f"query={query}"])


def today_iso() -> str:
    return dt.date.today().isoformat()


def next_day_iso() -> str:
    return (dt.date.today() + dt.timedelta(days=1)).isoformat()


def get_project_id() -> str:
    data = graphql(
        f'query {{ organization(login:"{OWNER}") {{ projectV2(number:{PROJECT_NUMBER}) {{ id title }} }} }}'
    )
    project = data["data"]["organization"]["projectV2"]
    if not project or project["title"] != PROJECT_TITLE:
        raise BoardOpsError("failed to resolve Engineering Core project")
    return project["id"]


def get_field_catalog() -> dict[str, Any]:
    data = run_gh_json(
        ["project", "field-list", str(PROJECT_NUMBER), "--owner", OWNER, "--format", "json"]
    )
    return {field["name"]: field for field in data["fields"]}


def get_current_sprint_iteration_id() -> tuple[str, str]:
    data = graphql(
        f'''
        query {{
          organization(login:"{OWNER}") {{
            projectV2(number:{PROJECT_NUMBER}) {{
              fields(first:30) {{
                nodes {{
                  ... on ProjectV2IterationField {{
                    name
                    configuration {{
                      iterations {{ id title startDate duration }}
                    }}
                  }}
                }}
              }}
            }}
          }}
        }}
        '''
    )
    nodes = data["data"]["organization"]["projectV2"]["fields"]["nodes"]
    for node in nodes:
        if node.get("name") == "Sprint":
            iterations = node["configuration"]["iterations"]
            if not iterations:
                raise BoardOpsError("no open sprint iteration found")
            current = iterations[0]
            return current["id"], current["title"]
    raise BoardOpsError("Sprint field not found")


def get_issue_node_id(repo: str, issue_number: int) -> str:
    owner, name = repo.split("/", 1)
    data = graphql(
        f'''
        query {{
          repository(owner:"{owner}", name:"{name}") {{
            issue(number:{issue_number}) {{ id }}
          }}
        }}
        '''
    )
    node_id = data["data"]["repository"]["issue"]
    if not node_id:
        raise BoardOpsError(f"issue #{issue_number} not found in {repo}")
    return node_id["id"]


def get_issue_json(repo: str, issue_number: int) -> Any:
    return run_gh_json(
        [
            "issue",
            "view",
            str(issue_number),
            "--repo",
            repo,
            "--json",
            "number,title,url,assignees,projectItems,createdAt",
        ]
    )


def get_project_item_id_for_issue(repo: str, issue_number: int) -> str | None:
    owner, name = repo.split("/", 1)
    data = graphql(
        f'''
        query {{
          repository(owner:"{owner}", name:"{name}") {{
            issue(number:{issue_number}) {{
              projectItems(first:20) {{
                nodes {{
                  id
                  project {{ title }}
                }}
              }}
            }}
          }}
        }}
        '''
    )
    issue = data["data"]["repository"]["issue"]
    if not issue:
        raise BoardOpsError(f"issue #{issue_number} not found in {repo}")
    for item in issue["projectItems"]["nodes"]:
        if item["project"]["title"] == PROJECT_TITLE:
            return item["id"]
    return None


def ensure_issue_on_project(repo: str, issue_number: int) -> str:
    item_id = get_project_item_id_for_issue(repo, issue_number)
    if item_id:
        return item_id

    issue = get_issue_json(repo, issue_number)
    run_gh(
        [
            "project",
            "item-add",
            str(PROJECT_NUMBER),
            "--owner",
            OWNER,
            "--url",
            issue["url"],
        ]
    )
    item_id = get_project_item_id_for_issue(repo, issue_number)
    if item_id:
        return item_id
    raise BoardOpsError("issue added to project but project item could not be resolved")


def set_project_field(
    *,
    item_id: str,
    project_id: str,
    field_id: str,
    single_select_option_id: str | None = None,
    date: str | None = None,
    iteration_id: str | None = None,
) -> None:
    cmd = ["project", "item-edit", "--id", item_id, "--project-id", project_id, "--field-id", field_id]
    if single_select_option_id:
        cmd += ["--single-select-option-id", single_select_option_id]
    elif date:
        cmd += ["--date", date]
    elif iteration_id:
        cmd += ["--iteration-id", iteration_id]
    else:
        raise BoardOpsError("field edit requires a value")
    run_gh(cmd)


def issue_create(args: argparse.Namespace) -> None:
    cmd = [
        "issue",
        "create",
        "--repo",
        args.repo,
        "--title",
        args.title,
        "--body",
        args.body,
        "--project",
        PROJECT_TITLE,
    ]
    if args.assignee:
        cmd += ["--assignee", args.assignee]
    url = run_gh(cmd).strip()
    issue_number = int(url.rstrip("/").split("/")[-1])
    update_task(
        repo=args.repo,
        issue_number=issue_number,
        status=args.status,
        start_date=args.start_date,
        target_date=args.target_date,
    )
    print(json.dumps(get_issue_json(args.repo, issue_number), indent=2))


def update_task(
    *,
    repo: str,
    issue_number: int,
    status: str | None,
    start_date: str | None,
    target_date: str | None,
) -> None:
    project_id = get_project_id()
    fields = get_field_catalog()
    sprint_id, _sprint_title = get_current_sprint_iteration_id()
    item_id = ensure_issue_on_project(repo, issue_number)

    if status:
        status_field = fields["Status"]
        options = {opt["name"]: opt["id"] for opt in status_field["options"]}
        if status not in options:
            raise BoardOpsError(f"unknown status: {status}")
        set_project_field(
            item_id=item_id,
            project_id=project_id,
            field_id=status_field["id"],
            single_select_option_id=options[status],
        )

    set_project_field(
        item_id=item_id,
        project_id=project_id,
        field_id=fields["Start date"]["id"],
        date=start_date or today_iso(),
    )
    set_project_field(
        item_id=item_id,
        project_id=project_id,
        field_id=fields["Target date"]["id"],
        date=target_date or next_day_iso(),
    )
    set_project_field(
        item_id=item_id,
        project_id=project_id,
        field_id=fields["Sprint"]["id"],
        iteration_id=sprint_id,
    )


def cmd_update_task(args: argparse.Namespace) -> None:
    update_task(
        repo=args.repo,
        issue_number=args.issue,
        status=args.status,
        start_date=args.start_date,
        target_date=args.target_date,
    )
    print(json.dumps(get_issue_json(args.repo, args.issue), indent=2))


def fetch_project_items() -> list[dict[str, Any]]:
    page_size = 100
    cursor = None
    all_nodes: list[dict[str, Any]] = []
    while True:
        after = f', after:"{cursor}"' if cursor else ""
        query = f'''
        query {{
          organization(login:"{OWNER}") {{
            projectV2(number:{PROJECT_NUMBER}) {{
              items(first:{page_size}{after}) {{
                pageInfo {{ hasNextPage endCursor }}
                nodes {{
                  id
                  createdAt
                  content {{
                    __typename
                    ... on Issue {{
                      number
                      title
                      url
                      createdAt
                      updatedAt
                      repository {{ nameWithOwner }}
                      state
                    }}
                    ... on PullRequest {{
                      number
                      title
                      url
                      createdAt
                      updatedAt
                      repository {{ nameWithOwner }}
                      state
                    }}
                  }}
                  fieldValues(first:20) {{
                    nodes {{
                      ... on ProjectV2ItemFieldSingleSelectValue {{
                        name
                        field {{ ... on ProjectV2FieldCommon {{ name }} }}
                      }}
                      ... on ProjectV2ItemFieldDateValue {{
                        date
                        field {{ ... on ProjectV2FieldCommon {{ name }} }}
                      }}
                      ... on ProjectV2ItemFieldIterationValue {{
                        title
                        startDate
                        field {{ ... on ProjectV2FieldCommon {{ name }} }}
                      }}
                    }}
                  }}
                }}
              }}
            }}
          }}
        }}
        '''
        data = graphql(query)
        items = data["data"]["organization"]["projectV2"]["items"]
        all_nodes.extend(items["nodes"])
        if not items["pageInfo"]["hasNextPage"]:
            break
        cursor = items["pageInfo"]["endCursor"]
    return all_nodes


def normalize_items(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for node in nodes:
        content = node.get("content") or {}
        if not content:
            continue
        entry: dict[str, Any] = {
            "number": content.get("number"),
            "title": content.get("title"),
            "url": content.get("url"),
            "repo": content.get("repository", {}).get("nameWithOwner"),
            "contentCreatedAt": content.get("createdAt"),
            "contentUpdatedAt": content.get("updatedAt"),
            "itemCreatedAt": node.get("createdAt"),
            "state": content.get("state"),
            "type": content.get("__typename"),
        }
        for value in node.get("fieldValues", {}).get("nodes", []):
            field_name = value.get("field", {}).get("name")
            if field_name == "Status":
                entry["status"] = value.get("name")
            elif field_name == "Sprint":
                entry["sprint"] = {"title": value.get("title"), "startDate": value.get("startDate")}
            elif field_name == "Start date":
                entry["startDate"] = value.get("date")
            elif field_name == "Target date":
                entry["targetDate"] = value.get("date")
        normalized.append(entry)
    return normalized


def date_in_range(value: str | None, start: str, end: str) -> bool:
    if not value:
        return False
    iso = value[:10]
    return start <= iso <= end


def cmd_summary(args: argparse.Namespace) -> None:
    items = normalize_items(fetch_project_items())
    filtered = [
        item
        for item in items
        if date_in_range(item.get("contentCreatedAt") or item.get("itemCreatedAt"), args.date_from, args.date_to)
    ]
    status_counts = Counter(item.get("status", "No status") for item in filtered)
    repo_counts = Counter(item.get("repo", "unknown") for item in filtered)
    research = [item for item in filtered if item.get("repo") == args.repo]
    research_status = Counter(item.get("status", "No status") for item in research)
    payload = {
        "total": len(filtered),
        "status_counts": dict(sorted(status_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "repo_counts": dict(sorted(repo_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "repo_focus": args.repo,
        "repo_focus_status_counts": dict(sorted(research_status.items(), key=lambda kv: (-kv[1], kv[0]))),
        "repo_focus_items": sorted(
            research,
            key=lambda item: item.get("contentCreatedAt") or item.get("itemCreatedAt") or "",
        ),
    }
    print(json.dumps(payload, indent=2))


def cmd_show_open_work(args: argparse.Namespace) -> None:
    issue_args = [
        "issue",
        "list",
        "--repo",
        args.repo,
        "--state",
        "open",
        "--limit",
        str(args.limit),
        "--json",
        "number,title,createdAt,assignees,projectItems,url",
    ]
    if args.assignee:
        query = f"assignee:{args.assignee}"
        issue_args = [
            "issue",
            "list",
            "--repo",
            args.repo,
            "--search",
            query,
            "--state",
            "open",
            "--limit",
            str(args.limit),
            "--json",
            "number,title,createdAt,assignees,projectItems,url",
        ]
    issues = run_gh_json(issue_args)
    filtered = []
    for issue in issues:
        if any(item.get("title") == PROJECT_TITLE for item in issue.get("projectItems", [])):
            filtered.append(issue)
    print(json.dumps(filtered, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hushh Engineering Core GitHub board helper")
    sub = parser.add_subparsers(dest="command", required=True)

    summary = sub.add_parser("summary")
    summary.add_argument("--from", dest="date_from", required=True)
    summary.add_argument("--to", dest="date_to", required=True)
    summary.add_argument("--repo", default=DEFAULT_REPO)
    summary.set_defaults(func=cmd_summary)

    create = sub.add_parser("create-task")
    create.add_argument("--repo", default=DEFAULT_REPO)
    create.add_argument("--title", required=True)
    create.add_argument("--body", required=True)
    create.add_argument("--assignee")
    create.add_argument("--status", default=DEFAULT_STATUS)
    create.add_argument("--start-date", default=today_iso())
    create.add_argument("--target-date", default=next_day_iso())
    create.set_defaults(func=issue_create)

    update = sub.add_parser("update-task")
    update.add_argument("--repo", default=DEFAULT_REPO)
    update.add_argument("--issue", type=int, required=True)
    update.add_argument("--status", default=DEFAULT_STATUS)
    update.add_argument("--start-date")
    update.add_argument("--target-date")
    update.set_defaults(func=cmd_update_task)

    open_work = sub.add_parser("show-open-work")
    open_work.add_argument("--repo", default=DEFAULT_REPO)
    open_work.add_argument("--assignee")
    open_work.add_argument("--limit", type=int, default=100)
    open_work.set_defaults(func=cmd_show_open_work)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except BoardOpsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
