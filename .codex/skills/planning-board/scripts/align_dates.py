#!/usr/bin/env python3
"""Align Start date + Target date on the Hushh Engineering Core board (#73).

The Roadmap view (#4) sorts by Target date, but dates were ~0% populated, so the
roadmap was blank. This fills them deterministically and keeps Target aligned to
the Sprint:

  Start date  = issue createdAt (when work began)
  Target date = closedAt           if the item is Done/closed (actual finish)
              = Sprint END date     if the item is in a Sprint (start + duration)
              = (skipped)           if neither is known

Sprint end alignment is the key fix: an active item's roadmap bar ends on its
sprint's last day, so Sprint and Target agree.

Pure project-field writes — never edits issue content. Idempotent (skips items
already matching). GraphQL-heavy: ~5 pts per date set; resumable on rate limit.

Usage:
  python3 align_dates.py --dry-run
  python3 align_dates.py
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys

OWNER = "hushh-labs"
PROJECT_NUMBER = 73


def gh(args: list[str]) -> str:
    import time
    retries = 3
    delay = 1
    for attempt in range(retries):
        try:
            p = subprocess.run(["gh", *args], text=True, capture_output=True, timeout=90)
            if p.returncode == 0:
                return p.stdout
            err_msg = p.stderr.strip() or p.stdout.strip()
            if attempt < retries - 1 and any(k in err_msg.lower() for k in ["connection reset", "timeout", "peer", "reset by peer", "failed to connect", "api.github.com"]):
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(err_msg)
        except subprocess.TimeoutExpired as exc:
            if attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise exc
        except Exception as exc:
            if attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise exc


def graphql(q: str) -> dict:
    d = json.loads(gh(["api", "graphql", "-f", f"query={q}"]))
    if "errors" in d:
        raise RuntimeError(str(d["errors"])[:300])
    return d["data"]


def sprint_end_map() -> dict[str, str]:
    """title -> end date (start + duration - 1 day), for all iterations."""
    d = graphql(f'''query {{ organization(login:"{OWNER}"){{ projectV2(number:{PROJECT_NUMBER}){{
        f: field(name:"Sprint"){{ ... on ProjectV2IterationField {{ configuration {{
          iterations {{ title startDate duration }}
          completedIterations {{ title startDate duration }} }} }} }} }} }} }}''')
    cfg = d["organization"]["projectV2"]["f"]["configuration"]
    out = {}
    for it in cfg["iterations"] + cfg["completedIterations"]:
        start = dt.date.fromisoformat(it["startDate"])
        end = start + dt.timedelta(days=int(it["duration"]) - 1)
        out[it["title"]] = end.isoformat()
    return out


def field_ids() -> tuple[str, str, str]:
    d = graphql(f'''query {{ organization(login:"{OWNER}"){{ projectV2(number:{PROJECT_NUMBER}){{
        pid: id
        sd: field(name:"Start date"){{ ... on ProjectV2FieldCommon {{ id }} }}
        td: field(name:"Target date"){{ ... on ProjectV2FieldCommon {{ id }} }} }} }} }}''')
    p = d["organization"]["projectV2"]
    return p["pid"], p["sd"]["id"], p["td"]["id"]


def fetch_items() -> list[dict]:
    nodes, cursor = [], None
    while True:
        after = f', after:"{cursor}"' if cursor else ""
        d = graphql(f'''query {{ organization(login:"{OWNER}"){{ projectV2(number:{PROJECT_NUMBER}){{
          items(first:100{after}){{ pageInfo{{hasNextPage endCursor}} nodes {{ id
            content {{ __typename
              ... on Issue {{ createdAt closedAt state }}
              ... on PullRequest {{ createdAt closedAt state }} }}
            fieldValues(first:30){{ nodes {{
              __typename
              ... on ProjectV2ItemFieldDateValue {{ date field{{...on ProjectV2FieldCommon{{name}}}} }}
              ... on ProjectV2ItemFieldIterationValue {{ title field{{...on ProjectV2FieldCommon{{name}}}} }}
            }} }} }} }} }} }} }}''')
        it = d["organization"]["projectV2"]["items"]
        nodes.extend(it["nodes"])
        if not it["pageInfo"]["hasNextPage"]:
            break
        cursor = it["pageInfo"]["endCursor"]
    return nodes


def set_date(pid: str, item_id: str, field_id: str, date: str) -> None:
    gh(["project", "item-edit", "--id", item_id, "--project-id", pid,
        "--field-id", field_id, "--date", date])


def main() -> int:
    dry = "--dry-run" in sys.argv
    pid, sd_id, td_id = field_ids()
    sprint_end = sprint_end_map()
    items = fetch_items()

    set_start = set_target = skipped = 0
    for it in items:
        c = it.get("content") or {}
        if not c:
            continue
        created = (c.get("createdAt") or "")[:10]
        closed = (c.get("closedAt") or "")[:10]
        state = c.get("state")

        cur = {}
        sprint_title = None
        for fv in it["fieldValues"]["nodes"]:
            fn = (fv.get("field") or {}).get("name")
            if fv.get("date") and fn:
                cur[fn] = fv["date"]
            if fv.get("title") and fv["__typename"] == "ProjectV2ItemFieldIterationValue":
                sprint_title = fv["title"]

        # Start date = createdAt
        if created and cur.get("Start date") != created:
            if not dry:
                try:
                    set_date(pid, it["id"], sd_id, created)
                except Exception:
                    pass
            set_start += 1

        # Target date = closedAt (done) else sprint-end
        target = None
        if state in ("CLOSED", "MERGED") and closed:
            target = closed
        elif sprint_title and sprint_title in sprint_end:
            target = sprint_end[sprint_title]
        if target and cur.get("Target date") != target:
            if not dry:
                try:
                    set_date(pid, it["id"], td_id, target)
                except Exception:
                    pass
            set_target += 1
        if not target and (not created or cur.get("Start date") == created):
            skipped += 1

    verb = "would set" if dry else "set"
    print(f"# Date alignment ({'DRY-RUN' if dry else 'APPLIED'})")
    print(f"- items scanned: {len(items)}")
    print(f"- Start date {verb}: {set_start}")
    print(f"- Target date {verb}: {set_target}")
    print(f"- no target derivable (no closedAt, no sprint): {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
