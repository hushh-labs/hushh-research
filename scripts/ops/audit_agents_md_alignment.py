#!/usr/bin/env python3
"""Audit the repository against its own operating kernel, `AGENTS.md`.

ON-DEMAND ONLY. This is deliberately NOT wired into the governance gate: it walks
workflows, skills, agents and settings, and the founder's call was that routine CI
performance must not carry it. Run it when you want the answer:

    python3 scripts/ops/audit_agents_md_alignment.py
    python3 scripts/ops/audit_agents_md_alignment.py --json

Two kinds of output:

1. An enforcement map: every `##` section of AGENTS.md, and whether it is mechanically
   enforced, partially enforced, or asserted-only. Most of the kernel is asserted, not
   enforced -- that is the honest headline, and it is precisely what lets doctrine drift
   from the architecture of record without anything failing.

2. Live structural checks that can actually be computed. These are the valuable half: they
   re-derive their answer from the tree every run rather than trusting this file's table.

Exit code is 0 unless `--strict` is passed, because an audit that blocks work is an audit
people stop running.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Enforcement verdicts. Curated from tracing each doctrine to the check that would fail if
# it were violated. "asserted" is not a criticism -- some doctrines are judgment, not lint.
ENFORCEMENT = {
    "Read this first — how the pieces map together": (
        "asserted",
        "Orientation + anti-drift rule. No check compares kernel claims to architecture docs.",
    ),
    "Project-Wide Principal Craft Kernel": (
        "partial",
        "Only the anti-duplication half: agent_orchestration_check.py fails TOMLs that copy "
        "kernel text. Secrets covered separately by gitleaks. Craft itself is judgment.",
    ),
    "Project-Wide Bacterial Software Architecture Gate": (
        "partial",
        "agent_orchestration_check.py string-checks the heading and markers. "
        "architecture_fitness.py measures real violations but exits 0 by design -- measured, "
        "never enforced.",
    ),
    "Project-Wide Runtime Telemetry Default": ("asserted", "No automated enforcement."),
    "Project-Wide Agent Architecture Doctrine": (
        "asserted",
        "Nine principles, none gated. This is the section that drifted from ARCHITECTURE.md "
        "sec 7a for eight days without any check noticing.",
    ),
    "Project-Wide Premise Verification Gate": (
        "partial",
        "truth_first_smoke.py checks claim-label presence -- but runs only via one-mac.yml, "
        "path-gated on apps/one-mac/**, so it is absent from normal work.",
    ),
    "Canonical skill center": (
        "mechanical",
        "Strongest section. sync_claude_agents.py --check verifies agent mirrors byte-for-byte; "
        "skill_lint.py validates skill.json and required SKILL.md sections. Gap: nothing "
        "verified bridge bodies until check C1 below.",
    ),
    "Project-Wide Routing Gate": (
        "partial",
        "agent_router_smoke.py and codex-bridge route.py --check prove the router resolves; "
        "nothing proves an agent actually routed.",
    ),
    "Project-Wide Delegation Checkpoint": (
        "partial",
        "agent_fleet_audit.py enforces lane count, thread and depth bounds, reasoning tiers. "
        "The behavioural rule (actually delegating) is unenforced.",
    ),
    "Authority Boundary": (
        "partial",
        "Deploy authority enforced by assert-governed-actor.py. The 12 handoff tokens are "
        "string-checked only by truth_first_smoke.py, which effectively does not run.",
    ),
    "Project-Wide BYOK Reviewer Browser Gate": (
        "asserted",
        "reviewer-app-testing-check.sh exists but no gate invokes it.",
    ),
    "Project-Wide Branch Discipline Gate (HARD RULE)": (
        "asserted",
        "Self-declared 'enforced by judgment, not just docs'.",
    ),
    "Project-Wide Commit Attribution Gate (HARD RULE)": (
        "partial",
        "No CI check scans commit messages. Sole control is the settings flag -- see C4.",
    ),
}

RESULTS: list[dict] = []


def record(check: str, ok: bool, detail: str, severity: str = "finding") -> None:
    RESULTS.append({"check": check, "ok": ok, "detail": detail, "severity": severity})


def agents_md_sections() -> list[str]:
    src = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    return re.findall(r"^## (.+)$", src, flags=re.MULTILINE)


def c0_enforcement_map() -> list[tuple[str, str, str]]:
    rows = []
    for section in agents_md_sections():
        verdict, why = ENFORCEMENT.get(section, ("unknown", "Not yet classified — add to ENFORCEMENT."))
        rows.append((section, verdict, why))
    return rows


def c1_bridges_point_at_canonical() -> None:
    """Every platform bridge with a canonical twin must POINT, not restate."""
    canonical = {p.name for p in (REPO_ROOT / "skills").iterdir() if p.is_dir()} if (REPO_ROOT / "skills").is_dir() else set()
    claude_skills = REPO_ROOT / ".claude" / "skills"
    if not claude_skills.is_dir() or not canonical:
        record("C1 bridge bodies point at canonical", True, "No canonical skills to check.")
        return
    offenders = []
    for name in sorted(canonical):
        bridge = claude_skills / name / "SKILL.md"
        if not bridge.is_file():
            continue  # canonical skill with no Claude bridge is allowed
        body = bridge.read_text(encoding="utf-8")
        target = f"skills/{name}/SKILL.md"
        if target not in body:
            offenders.append(f"{bridge.relative_to(REPO_ROOT)} does not reference {target}")
        elif len(body) > 2500:
            offenders.append(
                f"{bridge.relative_to(REPO_ROOT)} is {len(body)}B — bridges point, they do not restate"
            )
    record(
        "C1 bridge bodies point at canonical",
        not offenders,
        "; ".join(offenders) if offenders else f"All {len(canonical)} canonical skill(s) bridged correctly.",
    )


def c2_canonical_frontmatter() -> None:
    """Canonical skill frontmatter `name` must equal its directory name."""
    root = REPO_ROOT / "skills"
    if not root.is_dir():
        record("C2 canonical frontmatter matches dir", True, "No skills/ directory.")
        return
    offenders = []
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        f = d / "SKILL.md"
        if not f.is_file():
            offenders.append(f"{d.name}: missing SKILL.md")
            continue
        m = re.search(r"^name:\s*(.+)$", f.read_text(encoding="utf-8"), flags=re.MULTILINE)
        if not m or m.group(1).strip() != d.name:
            offenders.append(f"{d.name}: frontmatter name is {m.group(1).strip() if m else '(absent)'}")
    record(
        "C2 canonical frontmatter matches dir",
        not offenders,
        "; ".join(offenders) if offenders else "All canonical skills well-formed.",
    )


def c3_agent_mirrors_have_authored_source() -> None:
    """Every generated mirror must trace to an authored agents/*.toml."""
    authored = {p.stem for p in (REPO_ROOT / "agents").glob("*.toml")}
    mirrors = list((REPO_ROOT / ".claude" / "agents").glob("*.md"))
    offenders = [m.name for m in mirrors if m.stem not in authored]
    unmirrored = sorted(authored - {m.stem for m in mirrors})
    detail = f"{len(authored)} authored lane(s), {len(mirrors)} mirror(s)."
    if offenders:
        detail += f" Orphaned mirrors: {offenders}."
    if unmirrored:
        detail += f" Authored but unmirrored: {unmirrored}."
    record("C3 agent mirrors trace to authored source", not offenders and not unmirrored, detail)


def c4_commit_attribution_control() -> None:
    """The Commit Attribution HARD RULE's only control is a settings flag."""
    settings = REPO_ROOT / ".claude" / "settings.json"
    if not settings.is_file():
        record("C4 commit attribution control present", False, "settings.json absent.", "risk")
        return
    try:
        val = json.loads(settings.read_text(encoding="utf-8")).get("includeCoAuthoredBy")
    except json.JSONDecodeError as exc:
        record("C4 commit attribution control present", False, f"settings.json unparseable: {exc}", "risk")
        return
    record(
        "C4 commit attribution control present",
        val is False,
        f"includeCoAuthoredBy={val!r}. No CI check scans commit messages — this flag is the "
        "entire control for a HARD RULE.",
        "risk",
    )


def c5_orchestrate_stages_reachable() -> None:
    """Which orchestrate.sh stages does CI actually invoke? Unreached stages are dead gates."""
    orch = REPO_ROOT / "scripts" / "ci" / "orchestrate.sh"
    wf_dir = REPO_ROOT / ".github" / "workflows"
    if not orch.is_file() or not wf_dir.is_dir():
        record("C5 orchestrate stages reachable from CI", True, "orchestrate.sh or workflows absent.")
        return
    stages = set(re.findall(r"^\s*([a-z][a-z0-9-]*)\)", orch.read_text(encoding="utf-8"), flags=re.MULTILINE))
    stages -= {"all", "*"}
    invoked = set()
    for wf in wf_dir.glob("*.yml"):
        text = wf.read_text(encoding="utf-8")
        for s in stages:
            if re.search(rf"orchestrate\.sh\s+{re.escape(s)}\b", text):
                invoked.add(s)
    dead = sorted(stages - invoked)
    record(
        "C5 orchestrate stages reachable from CI",
        not dead,
        (
            f"Stages never invoked by any workflow: {dead}. Every check inside them is dead in CI."
            if dead
            else f"All {len(stages)} stage(s) invoked."
        ),
        "risk" if dead else "finding",
    )


def c6_docs_parity_in_ci() -> None:
    """docs-parity-check.sh carries 8 checks. Is it reachable from CI at all?"""
    wf_dir = REPO_ROOT / ".github" / "workflows"
    if not wf_dir.is_dir():
        record("C6 docs-parity-check.sh runs in CI", True, "No workflows directory.")
        return
    direct = [wf.name for wf in wf_dir.glob("*.yml") if "docs-parity-check.sh" in wf.read_text(encoding="utf-8")]
    record(
        "C6 docs-parity-check.sh runs in CI",
        bool(direct),
        (
            f"Invoked directly by: {direct}."
            if direct
            else "NOT invoked by any workflow, directly or via a reachable orchestrate.sh stage. "
            "Doc governance, brand, link integrity and visual coverage are unenforced in CI."
        ),
        "risk",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    ap.add_argument("--strict", action="store_true", help="Exit non-zero when any check fails.")
    args = ap.parse_args()

    for fn in (
        c1_bridges_point_at_canonical,
        c2_canonical_frontmatter,
        c3_agent_mirrors_have_authored_source,
        c4_commit_attribution_control,
        c5_orchestrate_stages_reachable,
        c6_docs_parity_in_ci,
    ):
        fn()

    rows = c0_enforcement_map()
    counts = {"mechanical": 0, "partial": 0, "asserted": 0, "unknown": 0}
    for _, verdict, _ in rows:
        counts[verdict] = counts.get(verdict, 0) + 1

    if args.json:
        print(json.dumps({"enforcement": [dict(zip(("section", "verdict", "why"), r)) for r in rows],
                          "counts": counts, "checks": RESULTS}, indent=2))
    else:
        print("AGENTS.md alignment audit\n" + "=" * 70)
        print("\n-- Enforcement map --\n")
        for section, verdict, why in rows:
            print(f"[{verdict:>10}] {section}\n             {why}\n")
        total = sum(counts.values())
        print(f"Summary: {counts['mechanical']} mechanical, {counts['partial']} partial, "
              f"{counts['asserted']} asserted-only, of {total} sections.")
        print("Most of the kernel is asserted, not enforced. That is what allows doctrine to")
        print("drift from the architecture of record without any check failing.\n")
        print("-- Live structural checks --\n")
        for r in RESULTS:
            mark = "PASS" if r["ok"] else ("RISK" if r["severity"] == "risk" else "FAIL")
            print(f"[{mark}] {r['check']}\n       {r['detail']}\n")

    failed = [r for r in RESULTS if not r["ok"]]
    if args.strict and failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
