#!/usr/bin/env python3
"""Backfill + maintain the Sector and Workstream single-select fields on the
Hushh Engineering Core board (project #73).

Org-convention alignment: every well-run hushh-labs board (MuleSoft #80,
Bug Tracker #79) organizes via custom single-select fields (Workstream, Sector,
Owner, ...), NOT native parent/sub-issue nesting (which no org board uses). This
brings #73 in line:

- Sector   = derived from the item's repository (the product line).
- Workstream = derived from the item title via an ordered keyword ruleset
               (specific -> general), defaulting to "Platform".

Both are pure, deterministic, and cross-contributor SAFE: they only ever set
two project fields, never touch issue bodies/status/dates/assignees. Idempotent:
items already correct are skipped.

Usage:
  python3 backfill_taxonomy.py --dry-run
  python3 backfill_taxonomy.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

OWNER = "hushh-labs"
PROJECT_NUMBER = 73

# repo nameWithOwner -> Sector option name
SECTOR_BY_REPO = {
    "hushh-labs/hushh-research": "Hushh Research",
    "hushh-labs/hussh-dev-platform": "Dev Platform",
    "hushh-labs/hussh-matrix-dashboard": "Dev Platform",
    "hushh-labs/hushh_Tech_website": "HushhTech",
    "hushh-labs/hushh-search-console": "HushhTech",
    "hushh-labs/hushh.ai-website": "Hushh AI",
    "hushh-labs/HushhVoice": "HushhVoice",
    "RGlodAkshat/HushhVoice": "HushhVoice",
    "hushh-labs/HusshOne": "Hussh One",
}

# Ordered (specific -> general). First match wins; default "Platform".
WORKSTREAM_RULES = [
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


def run(args: list[str]) -> str:
    p = subprocess.run(["gh", *args], text=True, capture_output=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return p.stdout


def derive_workstream(title: str) -> str:
    for name, pat in WORKSTREAM_RULES:
        if re.search(pat, title or ""):
            return name
    return "Platform"


def derive_sector(repo: str | None) -> str | None:
    return SECTOR_BY_REPO.get(repo or "")


def project_id() -> str:
    return json.loads(run([
        "project", "view", str(PROJECT_NUMBER), "--owner", OWNER, "--format", "json",
    ]))["id"]


def field_catalog() -> dict[str, dict]:
    data = json.loads(run([
        "project", "field-list", str(PROJECT_NUMBER), "--owner", OWNER,
        "--format", "json", "-L", "60",
    ]))
    out = {}
    for f in data["fields"]:
        if f.get("name") in ("Sector", "Workstream"):
            out[f["name"]] = {
                "id": f["id"],
                "options": {o["name"]: o["id"] for o in f.get("options", [])},
            }
    return out


def list_items() -> list[dict]:
    import board_ops
    return board_ops.fetch_items_graphql()


def main() -> int:
    dry = "--dry-run" in sys.argv
    pid = project_id()
    fields = field_catalog()
    if "Sector" not in fields or "Workstream" not in fields:
        print("❌ Sector/Workstream field missing — create them first.", file=sys.stderr)
        return 1
    items = list_items()

    fixed_sec = fixed_ws = skipped = 0
    unmapped_repo: set[str] = set()

    for it in items:
        c = it.get("content") or {}
        repo = (c.get("repository") if isinstance(c.get("repository"), str) else None) or c.get("repository")
        # gh item-list surfaces repository as a string under content.repository
        repo = c.get("repository")
        title = c.get("title") or ""

        # gh surfaces existing custom single-selects lowercased w/o spaces:
        cur_sec = it.get("sector")
        cur_ws = it.get("workstream")

        tgt_sec = derive_sector(repo)
        tgt_ws = derive_workstream(title)

        did = False
        if tgt_sec is None and repo:
            unmapped_repo.add(repo)

        if tgt_sec and tgt_sec in fields["Sector"]["options"] and cur_sec != tgt_sec:
            if not dry:
                run(["project", "item-edit", "--id", it["id"], "--project-id", pid,
                     "--field-id", fields["Sector"]["id"],
                     "--single-select-option-id", fields["Sector"]["options"][tgt_sec]])
            fixed_sec += 1
            did = True

        if tgt_ws in fields["Workstream"]["options"] and cur_ws != tgt_ws:
            if not dry:
                run(["project", "item-edit", "--id", it["id"], "--project-id", pid,
                     "--field-id", fields["Workstream"]["id"],
                     "--single-select-option-id", fields["Workstream"]["options"][tgt_ws]])
            fixed_ws += 1
            did = True

        if not did:
            skipped += 1

    print(f"# Taxonomy backfill ({'DRY-RUN' if dry else 'APPLIED'})")
    print(f"- items scanned: {len(items)}")
    print(f"- Sector {'would set' if dry else 'set'}: {fixed_sec}")
    print(f"- Workstream {'would set' if dry else 'set'}: {fixed_ws}")
    print(f"- already correct (no change): {skipped}")
    if unmapped_repo:
        print(f"- repos with no Sector mapping (reported): {sorted(unmapped_repo)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
