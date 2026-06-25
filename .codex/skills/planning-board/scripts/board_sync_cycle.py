#!/usr/bin/env python3
"""Engineering Board Synchronization Cycle (hussh 🤫 One variant).

OWNERSHIP-SAFE board sync for the Hushh Engineering Core board.

Hard guardrails (non-negotiable):
- WRITE operations (status / dates / sprint / labels / hierarchy / close) are
  ONLY ever applied to issues and PRs OWNED BY THE OPERATOR (authored or
  assigned). Items owned by other contributors are NEVER mutated.
- For non-owned drift, the script REPORTS ONLY — it never silently force-closes
  or re-stamps another person's task. Surfacing != mutating.
- The operator identity is configurable (OPERATOR_LOGIN / OPERATOR_HIERARCHY)
  so this stays a thin, upgradeable layer over the generic board_ops.py engine
  that ships in the repo. board_ops.py = core engine (hermes-analog),
  this file = hussh-one operator-scoped overlay.

Run modes:
  (default)      full run, always prints the report
  --watchdog     silent unless real owner-scoped changes happened (cron-friendly)
  --dry-run      compute + report, perform NO writes (safe inspection)
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from collections import Counter

# --- Thin overlay over the repo-resident core engine ------------------------
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
try:
    import board_ops
except ImportError:
    sys.path.append(
        "/Users/kushaltrivedi/Documents/GitHub/hushh-research/.codex/skills/planning-board/scripts"
    )
    import board_ops

# --- Operator identity (configurable; defaults to Kushal) -------------------
OPERATOR_LOGIN = os.environ.get("HUSSH_BOARD_OPERATOR", "kushaltrivedi5")
OPERATOR_HIERARCHY = os.environ.get("HUSSH_BOARD_OPERATOR_HIERARCHY", "Kushal")
LOOKBACK_DAYS = int(os.environ.get("HUSSH_BOARD_LOOKBACK_DAYS", "2")) # Standard lookback of 2 days for fast runs

# --- Change-detection state cache (keeps the watchdog quiet) ----------------
STATE_CACHE_PATH = os.path.expanduser("~/.hermes/scripts/.board_sync_state.json")


def _load_state() -> dict:
    try:
        with open(STATE_CACHE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:  # noqa: BLE001
        return {}


def _save_state(state: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_CACHE_PATH), exist_ok=True)
        with open(STATE_CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    except Exception as exc:  # noqa: BLE001
        print(f"Warning: could not persist state cache: {exc}", file=sys.stderr)


def _gh_json(args: list[str]) -> list[dict]:
    try:
        return board_ops.run_gh_json(args)
    except Exception as exc:  # noqa: BLE001
        print(f"Warning: gh query failed ({' '.join(args[:3])}): {exc}", file=sys.stderr)
        return []


def get_owned_prs(repo: str, days: int) -> list[dict]:
    """PRs the operator authored OR is assigned to, updated recently (open and closed/merged)."""
    since = (dt.datetime.now() - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    seen: dict[int, dict] = {}
    for clause in (f"author:{OPERATOR_LOGIN}", f"assignee:{OPERATOR_LOGIN}"):
        rows = _gh_json([
            "pr", "list", "--repo", repo,
            "--state", "all",
            "--search", f"{clause} updated:>={since}",
            "--limit", "15", # Kept small for fast execution
            "--json",
            "number,title,state,url,assignees,author,labels,createdAt,updatedAt,baseRefName,headRefName,body,isDraft",
        ])
        for r in rows:
            seen[r["number"]] = r
    return list(seen.values())


def get_owned_issues(repo: str, days: int) -> list[dict]:
    """Issues the operator is assigned to, updated recently (open and closed)."""
    since = (dt.datetime.now() - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    return _gh_json([
        "issue", "list", "--repo", repo,
        "--state", "all",
        "--search", f"assignee:{OPERATOR_LOGIN} updated:>={since}",
        "--limit", "15", # Kept small for fast execution
        "--json",
        "number,title,state,url,assignees,labels,createdAt,updatedAt,body",
    ])


def is_owned_by_operator(item: dict) -> bool:
    """True only if the operator authored or is assigned to the item."""
    author = (item.get("author") or {}).get("login")
    if author == OPERATOR_LOGIN:
        return True
    for a in item.get("assignees", []) or []:
        if a.get("login") == OPERATOR_LOGIN:
            return True
    return False


def extract_referenced_issues(text: str) -> list[int]:
    if not text:
        return []
    pattern = r"(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|ref|refs)?\s*#(\d+)"
    return [int(n) for n in re.findall(pattern, text, re.IGNORECASE)]


def initiate_local_plans_if_needed(repo: str, dry_run: bool = False) -> list[dict]:
    """Scans the local git workspace for unpushed commits and untracked files.
    If a new plan (like UCP Ap2 reverse-auction) is detected locally but has no
    issue on GitHub, it automatically creates a real GitHub issue and enqueues it."""
    import subprocess
    local_repo_path = "/Users/kushaltrivedi/Documents/GitHub/hushh-research"
    if not os.path.exists(local_repo_path):
        return []

    # 1. Check for unpushed commits on the active branch
    try:
        proc = subprocess.run(
            ["git", "-C", local_repo_path, "log", "origin/main..HEAD", "--oneline"],
            capture_output=True, text=True, check=True, timeout=10
        )
        lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    except Exception:
        lines = []

    # 2. Check for untracked files
    try:
        proc_status = subprocess.run(
            ["git", "-C", local_repo_path, "status", "--porcelain"],
            capture_output=True, text=True, check=True, timeout=10
        )
        status_lines = [line.strip() for line in proc_status.stdout.splitlines() if line.strip()]
    except Exception:
        status_lines = []

    local_detected_plans = []
    # Process unpushed commits
    for line in lines:
        parts = line.split(" ", 1)
        if len(parts) < 2:
            continue
        sha, msg = parts
        # If the commit message relates to our active local plans (like reverse-auction/ucp/ap2/campaign)
        if any(k in msg.lower() for k in ["ucp", "ap2", "reverse-auction", "consent", "campaign"]):
            local_detected_plans.append({"source": f"local commit {sha}", "title": msg})

    # Process untracked files
    for line in status_lines:
        if line.startswith("?? "):
            filepath = line[3:]
            filename = os.path.basename(filepath)
            if any(k in filename.lower() for k in ["ucp", "ap2", "reverse_auction", "consent", "campaign"]):
                local_detected_plans.append({"source": "untracked file", "title": f"Implement {filename} plan"})

    new_issues = []
    if not local_detected_plans:
        return []

    # For each detected local plan, check if an issue with the same name already exists on the board
    try:
        items = board_ops.normalize_items(board_ops.fetch_project_items())
        existing_titles = {str(it.get("title") or "").lower().strip() for it in items if it.get("title")}
    except Exception:
        existing_titles = set()

    for plan in local_detected_plans:
        title = plan["title"]
        normalized_title = title.lower().strip()
        # Strip conventional commit prefix for matching if present
        match = re.match(r"^(?:feat|fix|docs|chore|refactor|test)(?:\([^)]+\))?:\s*(.+)$", normalized_title)
        clean_normalized_title = match.group(1) if match else normalized_title

        # Check if already initiated on the board
        already_exists = False
        for ext_title in existing_titles:
            if clean_normalized_title in ext_title or ext_title in clean_normalized_title:
                already_exists = True
                break

        if already_exists:
            continue

        # If not on the board, initiate it!
        if dry_run:
            print(f"Dry-run: Would initiate local plan '{title}' (found via {plan['source']}) on the board")
            # Create a mock issue dict so it gets listed in active work under dry-run
            new_issues.append({
                "number": 9999, # Dummy
                "title": f"Local Plan: {title}",
                "state": "OPEN",
                "createdAt": dt.datetime.now().isoformat(),
                "updatedAt": dt.datetime.now().isoformat(),
                "assignees": [{"login": OPERATOR_LOGIN}],
                "labels": [{"name": "learning/research"}, {"name": "enhancement"}],
            })
        else:
            # Create a real GitHub issue!
            try:
                # Add default details in body
                body = f"Automatically initiated by Board Sync watchdog from local work on active branch.\nSource: {plan['source']}\nOriginal title: {title}"
                cmd = [
                    "gh", "issue", "create",
                    "--repo", repo,
                    "--title", title,
                    "--body", body,
                    "--assignee", OPERATOR_LOGIN,
                    "--label", "enhancement"
                ]
                proc_issue = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
                url = proc_issue.stdout.strip()
                new_num = int(url.rstrip("/").split("/")[-1])

                # Fetch fresh issue metadata
                issue_details = board_ops.get_issue_json(repo, new_num)
                new_issues.append(issue_details)
                print(f"Successfully initiated local plan on board: Created Issue #{new_num} - '{title}'")
            except Exception as e:
                print(f"Failed to automatically create issue for local plan '{title}': {e}", file=sys.stderr)

    return new_issues


def sync_board_cycle(dry_run: bool = False) -> tuple[str, bool]:
    repo = board_ops.DEFAULT_REPO
    has_changes = False
    prev_state = _load_state()
    cur_state: dict[str, str] = {}

    def signature(item: dict, kind: str) -> str:
        """Stable signature of an item's tracked attributes."""
        st = item.get("state", "")
        draft = "draft" if item.get("isDraft") else ""
        return f"{kind}:{st}:{draft}"

    def mark_delta(key: str, sig: str) -> bool:
        """Record current signature; return True only if it changed vs cache."""
        cur_state[key] = sig
        return prev_state.get(key) != sig

    out: list[str] = []
    mode = " (DRY-RUN, no writes)" if dry_run else ""
    out.append("# 🤫 hussh 🤫 One — Board Sync Report")
    out.append(f"**Date:** {board_ops.today_iso()} | **Operator:** @{OPERATOR_LOGIN}{mode}\n")
    out.append("> Scope guardrail: only issues/PRs owned by the operator are mutated. "
               "Other contributors' tasks are reported, never modified.\n")

    # Fetch fresh GitHub activity
    prs = get_owned_prs(repo, LOOKBACK_DAYS)
    issues = get_owned_issues(repo, LOOKBACK_DAYS)

    # Auto-detect and initiate local unpushed plans/commits
    try:
        local_issues = initiate_local_plans_if_needed(repo, dry_run)
        issues.extend(local_issues)
    except Exception as exc:
        out.append(f"*(Note: Local plan auto-detector skipped: {exc})*")

    # --- 1. Completion & Delivery: merged/closed owned PRs & closed owned issues
    out.append("## 🏁 Completion & Delivery")
    completed: list[str] = []

    # 1a. Process owned closed/merged PRs and link their referenced issues
    for pr in prs:
        if pr["state"] not in ("MERGED", "CLOSED"):
            continue
        if not is_owned_by_operator(pr):
            continue  # safety: never act on others' PRs

        # Ensure the closed PR itself is on the project board and marked Done
        try:
            # Map start and target dates to real PR creation and merge timelines
            start_date = pr["createdAt"][:10]
            target_date = pr["updatedAt"][:10]
            key = f"pr#{pr['number']}"
            sig = f"{signature(pr, 'pr')}:Done"
            if prev_state.get(key) == sig:
                cur_state[key] = sig
            else:
                if dry_run:
                    completed.append(f"PR #{pr['number']} -> would ensure on board & set **Done** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                else:
                    board_ops.ensure_issue_on_project(repo, pr["number"])
                    board_ops.update_task(
                        repo=repo, issue_number=pr["number"], status="Done",
                        start_date=start_date, target_date=target_date, labels=None,
                        sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                    )
                    completed.append(f"PR #{pr['number']} -> ensured on board & marked **Done** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                cur_state[key] = sig
        except Exception:
            pass

        # Linked issues from PR body or branch name
        refs = set(extract_referenced_issues(pr.get("body", "")))
        refs.update(extract_referenced_issues(pr.get("headRefName", "")))
        for num in refs:
            try:
                details = board_ops.get_issue_json(repo, num)
                # OWNERSHIP CHECK on the linked item itself
                if not is_owned_by_operator(details):
                    out.append(f"- ⏭️ #{num} linked by PR #{pr['number']} but owned by "
                               f"another contributor — left untouched.")
                    continue

                # Determine timeline from actual issue creation and completion
                start_date = details["createdAt"][:10]
                target_date = pr["updatedAt"][:10] # finished when PR was merged/closed
                key = f"issue#{num}"
                sig = f"{signature(details, 'issue')}:Done"
                if prev_state.get(key) == sig:
                    cur_state[key] = sig
                else:
                    if dry_run:
                        completed.append(f"#{num} -> would ensure on board & set **Done** (Start: {start_date}, Target: {target_date})")
                        has_changes = True
                        continue
                    # Ensure it is added to the board (adds if missing)
                    board_ops.ensure_issue_on_project(repo, num)
                    if details["state"] == "OPEN":
                        board_ops.run_gh(["issue", "close", str(num), "--repo", repo])
                    board_ops.update_task(
                        repo=repo, issue_number=num, status="Done",
                        start_date=start_date, target_date=target_date, labels=None,
                        sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                    )
                    completed.append(f"#{num} -> ensured on board & marked **Done** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                    cur_state[key] = sig
            except Exception:  # noqa: BLE001
                pass

    # 1b. Process direct recently closed owned issues
    for issue in issues:
        if issue["state"] != "CLOSED":
            continue
        if not is_owned_by_operator(issue):
            continue
        try:
            num = issue["number"]
            start_date = issue["createdAt"][:10]
            target_date = issue["updatedAt"][:10]
            key = f"issue#{num}"
            sig = f"{signature(issue, 'issue')}:Done"
            if prev_state.get(key) == sig:
                cur_state[key] = sig
            else:
                if dry_run:
                    completed.append(f"#{num} -> would ensure on board & set **Done** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                    continue
                # Ensure it is added to the board (adds if missing)
                board_ops.ensure_issue_on_project(repo, num)
                board_ops.update_task(
                    repo=repo, issue_number=num, status="Done",
                    start_date=start_date, target_date=target_date, labels=None,
                    sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                )
                completed.append(f"#{num} -> ensured on board & marked **Done** (Start: {start_date}, Target: {target_date})")
                has_changes = True
                cur_state[key] = sig
        except Exception:  # noqa: BLE001
            pass

    if completed:
        out.extend(f"- ✓ {c}" for c in completed)
    else:
        out.append("_No owner-scoped completions detected._")

    # --- 2. Active work: open OWNED issues/PRs -> ensure fields configured
    out.append("\n## ⚡ Active Work & Backlog")
    active: list[str] = []
    for issue in issues:
        if issue["number"] == 9999:
            active.append(f"🔧 #9999 *{issue['title']}* -> would set **In progress**")
            has_changes = True
            continue
        if issue["state"] != "OPEN" or not is_owned_by_operator(issue):
            continue
        try:
            status = "In progress"
            item_id = board_ops.get_project_item_id_for_issue(repo, issue["number"])
            if item_id:
                d = board_ops.get_issue_json(repo, issue["number"])
                for pi in d.get("projectItems", []):
                    if pi.get("title") == board_ops.PROJECT_TITLE:
                        cur = (pi.get("status") or {}).get("name")
                        if cur in ("In review", "Backlog"):
                            status = cur

            # Align start and target date to actual creation and standard sprint buffer
            start_date = issue["createdAt"][:10]
            target_date = (dt.date.today() + dt.timedelta(days=1)).isoformat() # Tightly bounded forward target
            key = f"issue#{issue['number']}"
            sig = f"{signature(issue, 'issue')}:{status}"
            if prev_state.get(key) == sig:
                cur_state[key] = sig
            else:
                if dry_run:
                    active.append(f"#{issue['number']} *{issue['title']}* -> would set **{status}** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                    continue
                board_ops.update_task(
                    repo=repo, issue_number=issue["number"], status=status,
                    start_date=start_date, target_date=target_date,
                    labels=[l["name"] for l in issue.get("labels", [])],
                    sync_current_sprint=True, hierarchy=OPERATOR_HIERARCHY,
                )
                cur_state[key] = sig
                active.append(f"🔧 #{issue['number']} *{issue['title']}* -> **{status}**")
                has_changes = True
        except Exception as exc:  # noqa: BLE001
            out.append(f"- ⚠️ Failed to sync issue #{issue['number']}: {exc}")

    for pr in prs:
        if pr["state"] != "OPEN" or not is_owned_by_operator(pr):
            continue
        try:
            status = "In progress" if pr.get("isDraft") else "In review"
            start_date = pr["createdAt"][:10]
            target_date = (dt.date.today() + dt.timedelta(days=1)).isoformat()
            key = f"pr#{pr['number']}"
            sig = f"{signature(pr, 'pr')}:{status}"
            if prev_state.get(key) == sig:
                cur_state[key] = sig
            else:
                if dry_run:
                    active.append(f"PR #{pr['number']} *{pr['title']}* -> would set **{status}** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                    continue
                board_ops.update_task(
                    repo=repo, issue_number=pr["number"], status=status,
                    start_date=start_date, target_date=target_date,
                    labels=[l["name"] for l in pr.get("labels", [])],
                    sync_current_sprint=True, hierarchy=OPERATOR_HIERARCHY,
                )
                cur_state[key] = sig
                active.append(f"🚀 PR #{pr['number']} *{pr['title']}* -> **{status}**")
                has_changes = True
        except Exception:  # noqa: BLE001
            pass

    if active:
        out.extend(f"- {a}" for a in active)
    else:
        out.append("_No new owner-scoped transitions since last run._")

    # --- 3. Hygiene audit: REPORT-ONLY, auto-fix ONLY operator-owned drift
    out.append("\n## 🔍 Board Hygiene & Audit")
    try:
        items = board_ops.normalize_items(board_ops.fetch_project_items())
        issue_items = [i for i in items if i.get("type") == "Issue" and i.get("repo") == repo]
        closed_not_done = [i for i in issue_items
                           if i.get("state") == "CLOSED" and i.get("status") != "Done"]
        open_done = [i for i in issue_items
                     if i.get("state") == "OPEN" and i.get("status") == "Done"]

        if not closed_not_done and not open_done:
            out.append("- ✓ **Audit Clean:** no drift detected.")
        else:
            if closed_not_done:
                out.append("### Closed issues not marked Done:")
                for it in closed_not_done:
                    # Only auto-fix if it's the operator's own item
                    owned = False
                    try:
                        d = board_ops.get_issue_json(repo, it["number"])
                        owned = is_owned_by_operator(d)
                    except Exception:  # noqa: BLE001
                        pass
                    if owned and not dry_run:
                        board_ops.update_task(
                            repo=repo, issue_number=it["number"], status="Done",
                            start_date=None, target_date=None, labels=None,
                            sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                        )
                        has_changes = True
                        out.append(f"  - ✓ #{it['number']} {it['title']} — auto-fixed to **Done** (yours)")
                    elif owned and dry_run:
                        has_changes = True
                        out.append(f"  - #{it['number']} {it['title']} — would auto-fix (yours)")
                    else:
                        out.append(f"  - 👀 #{it['number']} {it['title']} — drift, "
                                   f"NOT yours, reporting only")
            if open_done:
                out.append("### Open issues marked Done (verify):")
                for it in open_done:
                    out.append(f"  - 👀 #{it['number']} {it['title']} — reporting only")
    except Exception as exc:  # noqa: BLE001
        out.append(f"- ❌ Audit failed: {exc}")

    # --- 4. Stats (read-only) --------------------------------------------------
    out.append("\n## 📊 Board Statistics (read-only)")
    try:
        all_items = board_ops.normalize_items(board_ops.fetch_project_items())
        research = [i for i in all_items if i.get("repo") == repo]
        counts = Counter(i.get("status", "No Status") for i in research)
        out.append(f"**Total tasks in {repo}:** {len(research)}")
        for st, c in sorted(counts.items()):
            out.append(f"- **{st}:** {c}")
    except Exception as exc:  # noqa: BLE001
        out.append(f"- Failed to fetch statistics: {exc}")

    # Persist the change-detection cache (skip on dry-run to avoid masking deltas).
    if not dry_run:
        _save_state(cur_state)

    return "\n".join(out), has_changes


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    report, changed = sync_board_cycle(dry_run=dry)
    if "--watchdog" in sys.argv and not changed:
        sys.exit(0)  # silent watchdog: nothing to report
    print(report)
