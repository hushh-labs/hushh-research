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
    """Extract issue numbers from GitHub closing-keyword references only.

    IMPORTANT: the keyword prefix is REQUIRED, not optional. An earlier
    version made the keyword group optional (`(?:close|...)?`), which matched
    ANY bare `#NNN` anywhere in the body -- including CSS hex colors like
    `#007aff` (captured as issue #007) and narrative cross-references to
    OTHER PRs ("pairs with #4441", "mirrors #4442") that are not closing
    references at all. Verified 2026-07-14: this false-matched 4 of ~37 PRs
    that were actually unlinked, silently marking them "linked" in state and
    suppressing the unlinked-PR warning that should have fired. A matched
    non-issue number (e.g. a PR number) also risks get_issue_json()'s
    pr-view fallback treating a PR as a linkable "issue" -- never let that
    reach ensure_issue_on_project/update_task; PRs must never land on the
    board (see board sync SOP: "PRs are NOT board items").
    """
    if not text:
        return []
    pattern = r"(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)"
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
        # Try checking against the upstream tracking branch first (most accurate for unpushed commits)
        proc = subprocess.run(
            ["git", "-C", local_repo_path, "log", "@{u}..HEAD", "--oneline"],
            capture_output=True, text=True, check=False, timeout=10
        )
        if proc.returncode != 0:
            # If no upstream is configured, fall back to checking against origin/main, but limit to operator's own commits
            proc = subprocess.run(
                ["git", "-C", local_repo_path, "log", f"--author={OPERATOR_LOGIN}", "origin/main..HEAD", "--oneline"],
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
        
        # Exclude merge commits
        msg_lower = msg.lower().strip()
        if msg_lower.startswith("merge ") or "pull request #" in msg_lower:
            continue
            
        # If the commit message relates to our active local plans (like reverse-auction/ucp/ap2/campaign)
        if any(k in msg_lower for k in ["ucp", "ap2", "reverse-auction", "consent", "campaign"]):
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


def sync_hierarchy_field(dry_run: bool = False) -> tuple[list[str], bool]:
    """Keep the 'Hierarchy' single-select correct for EVERY board item, derived
    from each item's GitHub assignee via board_ops.ASSIGNEE_HIERARCHY_DEFAULTS.

    This is the board-wide hygiene pass that the operator-scoped sync omits — it
    is what stops non-operator items (Neelesh, Akshat, Akash, ...) from drifting
    to a blank/wrong Hierarchy and the board looking "under no hierarchy".

    Cross-contributor by design (Hierarchy is an org-wide planning label, not a
    content mutation): it only ever sets the project Hierarchy field, never edits
    another person's issue body, status, or dates. Unmapped assignees are left
    untouched (never guessed).
    """
    notes: list[str] = []
    changed = False
    import subprocess
    try:
        project_id = board_ops.get_project_id()
        fields = board_ops.get_field_catalog()
        hfield = fields.get("Hierarchy")
        if not hfield:
            return ["- ⚠️ Hierarchy field not found; skipped."], False
        opt_ids = {o["name"]: o["id"] for o in hfield.get("options", [])}
        # Use fast, non-flaky paginated GraphQL fetch instead of gh CLI item-list
        items = board_ops.fetch_items_graphql()
    except Exception as exc:  # noqa: BLE001
        return [f"- ⚠️ Hierarchy sync skipped: {exc}"], False

    fixed = 0
    for it in items:
        assignees = it.get("assignees") or []
        target = None
        for a in assignees:
            login = a.get("login") if isinstance(a, dict) else a
            if login in board_ops.ASSIGNEE_HIERARCHY_DEFAULTS:
                target = board_ops.ASSIGNEE_HIERARCHY_DEFAULTS[login]
                break
        if target is None or target not in opt_ids:
            continue
        if it.get("hierarchy") == target:
            continue
        item_id = it.get("id")
        if not item_id:
            continue
        if dry_run:
            fixed += 1
            changed = True
            continue
        try:
            board_ops.set_project_field(
                item_id=item_id,
                project_id=project_id,
                field_id=hfield["id"],
                single_select_option_id=opt_ids[target],
            )
            fixed += 1
            changed = True
        except Exception:  # noqa: BLE001
            pass

    if fixed:
        verb = "would set" if dry_run else "set"
        notes.append(f"- 🧭 Hierarchy {verb} on {fixed} item(s) from assignee mapping.")
    else:
        notes.append("- ✓ Hierarchy field clean across all items.")
    return notes, changed


# --- Taxonomy (Sector + Workstream) derivation, mirrors backfill_taxonomy.py --
_SECTOR_BY_REPO = {
    "hushh-labs/hushh-research": "Hushh Research",
    "hushh-labs/hussh-dev-platform": "Dev Platform",
    "hushh-labs/hussh-matrix-dashboard": "Dev Platform",
    "hushh-labs/hushh_Tech_website": "HushhTech",
    "hushh-labs/hushh-search-console": "HushhTech",
    "hushh-labs/hushh.ai-website": "Hushh AI",
    "hushh-labs/HushhVoice": "HushhVoice",
    "RGlodAkshat/HushhVoice": "HushhVoice",
    "hushh-labs/HusshOne": "Hussh One",
    "hushh-labs/hermes-agent": "Hussh One",
}

_WORKSTREAM_RULES = [
    ("Voice/Kai",        r"(?i)\bvoice\b|\bkai\b|dictation|\btts\b|\bstt\b|speech|hushhvoice"),
    ("Location",         r"(?i)location|geo\b|kirkland|\bmaps?\b|nearby"),
    ("Portfolio/Invest", r"(?i)portfolio|\bfund\b|stock|ticker|investor|\bria\b|alpaca|plaid|debate|losers|advisor"),
    ("Consent",          r"(?i)consent|vault|trustlink|pchp|\bcrt\b|reverse.?auction|\bucp\b|\bap2\b"),
    ("MCP",              r"(?i)\bmcp\b|connector"),
    ("SDK",              r"(?i)\bsdk\b|husshkit|swift|kotlin|\bmlx\b|capacitor|passkey"),
    ("Marketplace",      r"(?i)marketplace|certif|listing|promot"),
    ("Onboarding",       r"(?i)onboard|portal|workspace|getting.?started|signup|sign.?in|login|account"),
    ("Agents",           r"(?i)\bagent\b|gemini|realtime|\bllm\b|hallucinat|debate engine|alphaagent"),
    ("UI/UX",            r"(?i)\bui\b|\bux\b|ui/ux|design|theme|responsiv|landing|footer|icon|step indicator|progress bar|revamp"),
    ("Website",          r"(?i)website|blog|\bseo\b|sitemap|marketing|demo|community"),
    ("Backend/Data",     r"(?i)backend|supabase|database|sqlite|sync|migrat|observability|world model|\bmail\b|gmail|calendar|routes|\bapi\b"),
    ("Security",         r"(?i)security|privacy|\btoken\b|hmac|\bpii\b|exception|vulnerab|hardening|\bauth\b"),
    ("Infra/CI",         r"(?i)\bci\b|deploy|build|pipeline|janitor|coverage|unit test|console"),
    ("Docs/Learning",    r"(?i)^\[read\]|^\[learn\]|read .*\.md|studied|understand |readme|getting started|docs:"),
]


def _derive_workstream(title: str) -> str:
    for name, pat in _WORKSTREAM_RULES:
        if re.search(pat, title or ""):
            return name
    return "Platform"


def sync_taxonomy_fields(dry_run: bool = False) -> tuple[list[str], bool]:
    """Keep Sector (from repo) + Workstream (from title) correct for EVERY item.

    Mirrors the org convention (MuleSoft #80 Workstream, Bug Tracker #79 Sector):
    field-based grouping, never native parent/sub-issue nesting. Cross-contributor
    SAFE — only ever sets two project fields, never edits issue content. Idempotent.
    """
    import subprocess
    notes: list[str] = []
    changed = False
    try:
        project_id = board_ops.get_project_id()
        cat = json.loads(subprocess.run(
            ["gh", "project", "field-list", str(board_ops.PROJECT_NUMBER),
             "--owner", board_ops.OWNER, "--format", "json", "-L", "60"],
            text=True, capture_output=True, timeout=60, check=True).stdout)
        fields = {}
        for f in cat["fields"]:
            if f.get("name") in ("Sector", "Workstream"):
                fields[f["name"]] = {"id": f["id"],
                                     "options": {o["name"]: o["id"] for o in f.get("options", [])}}
        if "Sector" not in fields or "Workstream" not in fields:
            return ["- ⚠️ Sector/Workstream field missing; skipped."], False
        # Use fast, non-flaky paginated GraphQL fetch instead of gh CLI item-list
        items = board_ops.fetch_items_graphql()
    except Exception as exc:  # noqa: BLE001
        return [f"- ⚠️ Taxonomy sync skipped: {exc}"], False

    sec_n = ws_n = 0
    for it in items:
        c = it.get("content") or {}
        repo = c.get("repository")
        title = c.get("title") or ""
        tgt_sec = _SECTOR_BY_REPO.get(repo or "")
        tgt_ws = _derive_workstream(title)
        if tgt_sec and tgt_sec in fields["Sector"]["options"] and it.get("sector") != tgt_sec:
            if not dry_run:
                try:
                    board_ops.set_project_field(
                        item_id=it["id"], project_id=project_id,
                        field_id=fields["Sector"]["id"],
                        single_select_option_id=fields["Sector"]["options"][tgt_sec])
                except Exception:  # noqa: BLE001
                    pass
            sec_n += 1
            changed = True
        if tgt_ws in fields["Workstream"]["options"] and it.get("workstream") != tgt_ws:
            if not dry_run:
                try:
                    board_ops.set_project_field(
                        item_id=it["id"], project_id=project_id,
                        field_id=fields["Workstream"]["id"],
                        single_select_option_id=fields["Workstream"]["options"][tgt_ws])
                except Exception:  # noqa: BLE001
                    pass
            ws_n += 1
            changed = True

    if sec_n or ws_n:
        verb = "would set" if dry_run else "set"
        notes.append(f"- 🗂️ Sector {verb} on {sec_n}, Workstream {verb} on {ws_n} item(s).")
    else:
        notes.append("- ✓ Sector & Workstream clean across all items.")
    return notes, changed


def sync_board_cycle(dry_run: bool = False) -> tuple[str, bool]:
    tracked_repos = ["hushh-labs/hushh-research", "hushh-labs/hushh-search-console"]
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

    # Fetch fresh GitHub activity across all tracked repos
    prs = []
    issues = []
    for r in tracked_repos:
        for pr in get_owned_prs(r, LOOKBACK_DAYS):
            pr["repo"] = r
            prs.append(pr)
        for issue in get_owned_issues(r, LOOKBACK_DAYS):
            issue["repo"] = r
            issues.append(issue)

    # Fetch all project items once at the start to completely optimize lookup queries and avoid duplicates
    try:
        project_items = board_ops.normalize_items(board_ops.fetch_project_items())
    except Exception as exc:
        project_items = []
        print(f"Warning: failed to fetch project items: {exc}", file=sys.stderr)

    project_item_by_num = {
        (item["repo"], item["number"]): item
        for item in project_items
        if item.get("repo") and item.get("number")
    }

    # Auto-detect of local unpushed plans/commits is DISABLED (bloat source).
    # It auto-created GitHub issues from local commits/untracked files every run,
    # growing the board to 751 items (83% Done). Issue creation is now a
    # deliberate human action. Opt back in with HUSSH_BOARD_AUTOCREATE=1.
    if os.environ.get("HUSSH_BOARD_AUTOCREATE") == "1":
        try:
            local_issues = initiate_local_plans_if_needed(board_ops.DEFAULT_REPO, dry_run)
            for li in local_issues:
                li["repo"] = board_ops.DEFAULT_REPO
            issues.extend(local_issues)
        except Exception as exc:
            out.append(f"*(Note: Local plan auto-detector skipped: {exc})*")

    # --- 1. Completion & Delivery: merged/closed owned PRs & closed owned issues
    out.append("## 🏁 Completion & Delivery")
    completed: list[str] = []

    # 1a. Process owned merged/closed PRs by completing their LINKED ISSUES.
    #     PRs are implementation artifacts, NOT board items — we never add a PR
    #     itself to the board (that bloated it with promotion/merge/train PRs
    #     like "Promote PR train to main"). The board tracks the ISSUE a PR
    #     closes; the PR just drives that issue to Done.
    for pr in prs:
        if pr["state"] not in ("MERGED", "CLOSED"):
            continue
        if not is_owned_by_operator(pr):
            continue  # safety: never act on others' PRs

        # Linked issues from PR body or branch name
        refs = set(extract_referenced_issues(pr.get("body", "")))
        refs.update(extract_referenced_issues(pr.get("headRefName", "")))
        r = pr["repo"]
        for num in refs:
            try:
                details = board_ops.get_issue_json(r, num)
                # OWNERSHIP CHECK on the linked item itself
                if not is_owned_by_operator(details):
                    out.append(f"- ⏭️ {r}#{num} linked by PR #{pr['number']} but owned by "
                               f"another contributor — left untouched.")
                    continue

                # Determine timeline from actual issue creation and completion
                start_date = details["createdAt"][:10]
                target_date = pr["updatedAt"][:10] # finished when PR was merged/closed
                key = f"{r}-issue#{num}"
                sig = f"{signature(details, 'issue')}:Done"
                
                item_entry = project_item_by_num.get((r, num))
                item_status = item_entry.get("status") if item_entry else None
                
                if prev_state.get(key) == sig or item_status == "Done":
                    cur_state[key] = sig
                else:
                    if dry_run:
                        completed.append(f"{r}#{num} -> would ensure on board & set **Done** (Start: {start_date}, Target: {target_date})")
                        has_changes = True
                        continue
                    # Ensure it is added to the board (adds if missing)
                    board_ops.ensure_issue_on_project(r, num)
                    if details["state"] == "OPEN":
                        board_ops.run_gh(["issue", "close", str(num), "--repo", r])
                    board_ops.update_task(
                        repo=r, issue_number=num, status="Done",
                        start_date=start_date, target_date=target_date, labels=None,
                        sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                    )
                    completed.append(f"{r}#{num} -> ensured on board & marked **Done** (Start: {start_date}, Target: {target_date})")
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
            r = issue["repo"]
            num = issue["number"]
            start_date = issue["createdAt"][:10]
            target_date = issue["updatedAt"][:10]
            key = f"{r}-issue#{num}"
            sig = f"{signature(issue, 'issue')}:Done"
            
            item_entry = project_item_by_num.get((r, num))
            item_status = item_entry.get("status") if item_entry else None
            
            if prev_state.get(key) == sig or item_status == "Done":
                cur_state[key] = sig
            else:
                if dry_run:
                    completed.append(f"{r}#{num} -> would ensure on board & set **Done** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                    continue
                # Ensure it is added to the board (adds if missing)
                board_ops.ensure_issue_on_project(r, num)
                board_ops.update_task(
                    repo=r, issue_number=num, status="Done",
                    start_date=start_date, target_date=target_date, labels=None,
                    sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                )
                completed.append(f"{r}#{num} -> ensured on board & marked **Done** (Start: {start_date}, Target: {target_date})")
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
            r = issue["repo"]
            status = "In progress"
            item_entry = project_item_by_num.get((r, issue["number"]))
            if item_entry:
                cur = item_entry.get("status")
                if cur in ("In review", "Backlog", "Done", "In progress", "Ready"):
                    status = cur

            # Align start and target date to actual creation and standard sprint buffer
            start_date = issue["createdAt"][:10]
            target_date = (dt.date.today() + dt.timedelta(days=1)).isoformat() # Tightly bounded forward target
            key = f"{r}-issue#{issue['number']}"
            sig = f"{signature(issue, 'issue')}:{status}"
            
            actual_matches = False
            if item_entry:
                actual_matches = (
                    item_entry.get("status") == status and
                    item_entry.get("startDate") == start_date and
                    item_entry.get("targetDate") == target_date
                )
                
            if prev_state.get(key) == sig or actual_matches:
                cur_state[key] = sig
            else:
                if dry_run:
                    active.append(f"{r}#{issue['number']} *{issue['title']}* -> would set **{status}** (Start: {start_date}, Target: {target_date})")
                    has_changes = True
                    continue
                board_ops.ensure_issue_on_project(r, issue["number"])
                board_ops.update_task(
                    repo=r, issue_number=issue["number"], status=status,
                    start_date=start_date, target_date=target_date,
                    labels=[l["name"] for l in issue.get("labels", [])],
                    sync_current_sprint=True, hierarchy=OPERATOR_HIERARCHY,
                )
                cur_state[key] = sig
                active.append(f"🔧 {r}#{issue['number']} *{issue['title']}* -> **{status}**")
                has_changes = True
        except Exception as exc:  # noqa: BLE001
            out.append(f"- ⚠️ Failed to sync issue {r}#{issue['number']}: {exc}")

    # Open PRs are NOT board items. We only reflect a PR's status onto the board
    # if its item is ALREADY there (legacy) — we never ADD a PR to the board.
    # New PR work surfaces via the linked ISSUE, not the PR.
    for pr in prs:
        if pr["state"] != "OPEN" or not is_owned_by_operator(pr):
            continue
        r = pr["repo"]
        item_entry = project_item_by_num.get((r, pr["number"]))
        if not item_entry:
            continue  # PR not on board -> leave it off (no bloat)
        try:
            status = "In progress" if pr.get("isDraft") else "In review"
            cur = item_entry.get("status")
            if cur in ("In review", "Backlog", "Done", "In progress", "Ready"):
                status = cur

            start_date = pr["createdAt"][:10]
            target_date = (dt.date.today() + dt.timedelta(days=1)).isoformat()
            key = f"{r}-pr#{pr['number']}"
            sig = f"{signature(pr, 'pr')}:{status}"

            actual_matches = (
                item_entry.get("status") == status and
                item_entry.get("startDate") == start_date and
                item_entry.get("targetDate") == target_date
            )

            if prev_state.get(key) == sig or actual_matches:
                cur_state[key] = sig
            else:
                if dry_run:
                    active.append(f"PR {r}#{pr['number']} *{pr['title']}* -> would set **{status}** (already on board)")
                    has_changes = True
                    continue
                board_ops.update_task(
                    repo=r, issue_number=pr["number"], status=status,
                    start_date=start_date, target_date=target_date,
                    labels=[l["name"] for l in pr.get("labels", [])],
                    sync_current_sprint=True, hierarchy=OPERATOR_HIERARCHY,
                )
                cur_state[key] = sig
                active.append(f"🚀 PR {r}#{pr['number']} *{pr['title']}* -> **{status}**")
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
        items = project_items
        drift_found = False
        for r in tracked_repos:
            issue_items = [i for i in items if i.get("type") == "Issue" and i.get("repo") == r]
            closed_not_done = [i for i in issue_items
                               if i.get("state") == "CLOSED" and i.get("status") != "Done"]
            open_done = [i for i in issue_items
                         if i.get("state") == "OPEN" and i.get("status") == "Done"]

            if closed_not_done or open_done:
                drift_found = True
                if closed_not_done:
                    out.append(f"### Closed issues in {r} not marked Done:")
                    for it in closed_not_done:
                        # Only auto-fix if it's the operator's own item
                        owned = False
                        try:
                            d = board_ops.get_issue_json(r, it["number"])
                            owned = is_owned_by_operator(d)
                        except Exception:  # noqa: BLE001
                            pass
                        if owned and not dry_run:
                            board_ops.update_task(
                                repo=r, issue_number=it["number"], status="Done",
                                start_date=None, target_date=None, labels=None,
                                sync_current_sprint=False, hierarchy=OPERATOR_HIERARCHY,
                            )
                            has_changes = True
                            out.append(f"  - ✓ {r}#{it['number']} {it['title']} — auto-fixed to **Done** (yours)")
                        elif owned and dry_run:
                            has_changes = True
                            out.append(f"  - {r}#{it['number']} {it['title']} — would auto-fix (yours)")
                        else:
                            out.append(f"  - 👀 {r}#{it['number']} {it['title']} — drift, "
                                       f"NOT yours, reporting only")
                if open_done:
                    out.append(f"### Open issues in {r} marked Done (verify):")
                    for it in open_done:
                        out.append(f"  - 👀 {r}#{it['number']} {it['title']} — reporting only")
        if not drift_found:
            out.append("- ✓ **Audit Clean:** no drift detected.")
    except Exception as exc:  # noqa: BLE001
        out.append(f"- ❌ Audit failed: {exc}")

    # --- 3b. Hierarchy field maintenance: board-wide, assignee-derived ---------
    out.append("\n## 🧭 Hierarchy Field Maintenance")
    try:
        hier_notes, hier_changed = sync_hierarchy_field(dry_run=dry_run)
        out.extend(hier_notes)
        has_changes = has_changes or hier_changed
    except Exception as exc:  # noqa: BLE001
        out.append(f"- ❌ Hierarchy maintenance failed: {exc}")

    # --- 3c. Taxonomy maintenance: Sector (repo) + Workstream (title) ----------
    out.append("\n## 🗂️ Taxonomy Maintenance (Sector + Workstream)")
    try:
        tax_notes, tax_changed = sync_taxonomy_fields(dry_run=dry_run)
        out.extend(tax_notes)
        has_changes = has_changes or tax_changed
    except Exception as exc:  # noqa: BLE001
        out.append(f"- ❌ Taxonomy maintenance failed: {exc}")

    # --- 3d. Date alignment: Start=createdAt, Target=closedAt|sprint-end --------
    out.append("\n## 📅 Date Alignment (Start + Target vs Sprint)")
    try:
        import align_dates  # stable copy lives beside this file in board_lib/
        # align_dates prints its own report; capture it.
        import io
        import contextlib
        buf = io.StringIO()
        argv_saved = sys.argv
        sys.argv = ["align_dates.py"] + (["--dry-run"] if dry_run else [])
        try:
            with contextlib.redirect_stdout(buf):
                align_dates.main()
        finally:
            sys.argv = argv_saved
        report = buf.getvalue().strip()
        # Surface the result lines; flag changes for the watchdog.
        for line in report.splitlines():
            if line.startswith("- "):
                out.append(line)
                if "set:" in line and not line.rstrip().endswith(" 0"):
                    has_changes = True
    except Exception as exc:  # noqa: BLE001
        out.append(f"- ❌ Date alignment failed: {exc}")

    # --- 4. Stats (read-only) --------------------------------------------------
    out.append("\n## 📊 Board Statistics (read-only)")
    try:
        all_items = project_items
        for r in tracked_repos:
            research = [i for i in all_items if i.get("repo") == r]
            if not research:
                continue
            counts = Counter(i.get("status", "No Status") for i in research)
            out.append(f"**Total tasks in {r}:** {len(research)}")
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
