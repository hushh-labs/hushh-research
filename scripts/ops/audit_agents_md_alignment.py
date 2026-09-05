#!/usr/bin/env python3
"""Audit the repository against its own operating kernel, `AGENTS.md`.

The full audit is ON-DEMAND ONLY. The portable bridge check is reused by skill lint;
the broader inventory is deliberately NOT wired into the governance gate: it walks
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
import hashlib
import json
import re
import sys
import subprocess
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
    "Project-Wide Runtime Telemetry Default & Chat Session Naming": ("asserted", "No automated enforcement."),
    "Project-Wide Agent Architecture Doctrine": (
        "asserted",
        "Nine principles, none gated. This is the section that drifted from ARCHITECTURE.md "
        "sec 7a for eight days without any check noticing.",
    ),
    "Project-Wide Premise Verification Gate": (
        "partial",
        "truth_first_smoke.py and skill_lint.py check contract markers; marker presence does not prove premise verification occurred.",
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
        "string-checked by truth_first_smoke.py and skill_lint.py; neither proves runtime conduct.",
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


def bridge_findings(root: Path) -> list[str]:
    """Check existing canonical twins on both hosts without authoring another registry."""
    findings = []
    for canonical in sorted((root / "skills").glob("*/SKILL.md")):
        source = canonical.read_text(encoding="utf-8")
        match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", source, re.S)
        if not match:
            findings.append(f"{canonical.relative_to(root)}: missing YAML frontmatter")
            continue
        name = re.search(r"^name:\s*(.+)$", match.group(1), re.M)
        if not name or name.group(1).strip().strip("\"'") != canonical.parent.name:
            findings.append(f"{canonical.relative_to(root)}: canonical name differs from directory")
        for host in (".claude", ".codex"):
            bridge = root / host / "skills" / canonical.parent.name / "SKILL.md"
            if not bridge.is_file():
                continue
            text = bridge.read_text(encoding="utf-8")
            front = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
            if not front or front.group(1) != match.group(1):
                findings.append(f"{bridge.relative_to(root)}: canonical frontmatter differs")
            body = text[front.end():].strip() if front else text
            target = canonical.relative_to(root).as_posix()
            if target not in body:
                findings.append(f"{bridge.relative_to(root)}: missing pointer to {target}")
            if body != f"Read `{target}` and follow it.":
                findings.append(f"{bridge.relative_to(root)}: bridge contains a procedure")
    for host in (".claude", ".codex"):
        for bridge in sorted((root / host / "skills").glob("*/SKILL.md")):
            text = bridge.read_text(encoding="utf-8")
            for target in re.findall(r"Read `(skills/[^`]+/SKILL\.md)` and follow it\.", text):
                if not (root / target).is_file():
                    findings.append(f"{bridge.relative_to(root)}: dangling canonical target {target}")
    return findings


SOURCE_INVENTORY = ".codex/skills/agent-orchestration-governance/references/platform-source-inventory.json"


def classification_findings(root: Path) -> list[str]:
    """Ratchet host-authored behavior without treating legacy imports as approved."""
    manifest = root / SOURCE_INVENTORY
    inventory = json.loads(manifest.read_text()) if manifest.exists() else {}
    sources = inventory.get("sources", {})
    findings = []
    seen = set()
    allowed = {"owner_alias", "host_adapter", "imported_dependency_pending_review",
               "legacy_adapter_pending_migration", "legacy_behavior_pending_review"}
    for host in (".claude", ".codex"):
        for path in sorted((root / host / "skills").glob("*/SKILL.md")):
            if (root / "skills" / path.parent.name / "SKILL.md").is_file():
                continue
            if host == ".codex" and path.with_name("skill.json").is_file():
                continue
            key = path.relative_to(root).as_posix()
            seen.add(key)
            entry = sources.get(key)
            if not entry:
                findings.append(f"{key}: unclassified platform behavior")
            elif entry.get("classification") not in allowed:
                findings.append(f"{key}: invalid platform classification")
            elif entry.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
                findings.append(f"{key}: platform behavior changed; review its classification")
    findings.extend(f"{key}: stale platform classification" for key in sources.keys() - seen)
    expected_agents = inventory.get("imported_agents", {})
    nested = {p.relative_to(root).as_posix(): p for host in (".claude", ".codex")
              for p in (root / host / "skills").glob("**/agents/*.toml")}
    # Canonical portable skills live directly under skills/, unlike host folders.
    nested.update({p.relative_to(root).as_posix(): p for p in (root / "skills").glob("*/agents/*.toml")})
    for key, path in nested.items():
        if expected_agents.get(key) != hashlib.sha256(path.read_bytes()).hexdigest():
            findings.append(f"{key}: unclassified or changed imported agent resource")
    findings.extend(f"{key}: stale imported agent classification" for key in expected_agents.keys() - nested.keys())

    return findings


def c1_bridges_point_at_canonical() -> None:
    offenders = bridge_findings(REPO_ROOT) + classification_findings(REPO_ROOT)
    record("C1 bridge bodies point at canonical", not offenders,
           "; ".join(offenders) if offenders else "Existing canonical twins match on both hosts; absent discovery bridges are not covered.")


def c7_platform_authored_inventory() -> None:
    """Expose ungoverned bodies and nested agent definitions; never call them dead code."""
    candidates = []
    for host in (".claude", ".codex"):
        for skill in sorted((REPO_ROOT / host / "skills").glob("*/SKILL.md")):
            if (skill.parent / "skill.json").is_file():
                continue  # governed owner/spoke behavior intentionally stays in .codex
            if (REPO_ROOT / "skills" / skill.parent.name / "SKILL.md").is_file():
                continue
            text = skill.read_text(encoding="utf-8")
            front = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
            body = text[front.end():].strip() if front else text
            if len(body.splitlines()) > 20:
                candidates.append(str(skill.relative_to(REPO_ROOT)))
    record("C7 platform-authored skill review", not candidates,
           "Review host adapters/imported resources versus portable behavior: " + ", ".join(candidates)
           if candidates else "No substantial ungoverned platform skill bodies found.")
    nested = [str(p.relative_to(REPO_ROOT)) for host in (".claude", ".codex")
              for folder in ("agents", "skills")
              for p in sorted((REPO_ROOT / host / folder).rglob("*.toml"))
              if "agents" in p.relative_to(REPO_ROOT / host).parts]
    record("C8 platform-authored agent review", not nested,
           "Classify imported resources or migrate authored lanes: " + ", ".join(nested)
           if nested else "No platform-local TOML agent definitions found.")


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
            f"Stages without a direct literal workflow invocation: {dead}. Inspect indirect/all-stage callers before declaring a gate disconnected."
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
    governance = REPO_ROOT / "scripts/ci/repo-governance-check.sh"
    cli = REPO_ROOT / "bin/hushh"
    orchestrator = REPO_ROOT / "scripts/ci/orchestrate.sh"
    orchestrator_text = orchestrator.read_text(encoding="utf-8") if orchestrator.is_file() else ""
    callers = [wf.name for wf in wf_dir.glob("*.yml")
               if "repo-governance-check.sh" in wf.read_text(encoding="utf-8")
               or ("orchestrate.sh governance" in wf.read_text(encoding="utf-8")
                   and "scripts/ci/repo-governance-check.sh" in orchestrator_text)]
    indirect = bool(callers and governance.is_file() and cli.is_file()
                    and "./bin/hushh docs verify" in governance.read_text(encoding="utf-8")
                    and "docs-parity-check.sh" in cli.read_text(encoding="utf-8"))
    record(
        "C6 docs-parity-check.sh runs in CI",
        bool(direct) or indirect,
        (
            f"Invoked directly by: {direct}."
            if direct
            else f"Indirect invocation: {callers} -> repo-governance-check.sh -> bin/hushh docs verify -> docs-parity-check.sh."
            if indirect else "No supported invocation chain found; inspect dynamic callers before declaring CI coverage absent."
        ),
        "risk",
    )


def self_test() -> int:
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "skills/example/SKILL.md"
        source.parent.mkdir(parents=True)
        source.write_text("---\nname: example\ndescription: Example\n---\nBehavior.\n")
        bridge = root / ".codex/skills/example/SKILL.md"
        bridge.parent.mkdir(parents=True)
        valid = "---\nname: example\ndescription: Example\n---\nRead `skills/example/SKILL.md` and follow it.\n"
        bridge.write_text(valid)
        assert bridge_findings(root) == []
        bridge.write_text(valid.replace("description: Example", "description: Drift"))
        assert any("frontmatter differs" in item for item in bridge_findings(root))
        bridge.write_text(valid.replace("skills/example/SKILL.md", "missing/SKILL.md"))
        assert any("missing pointer" in item for item in bridge_findings(root))
        bridge.write_text(valid + "\n```sh\necho duplicate procedure\n```\n")
        assert any("procedure" in item for item in bridge_findings(root))
        bridge.write_text(valid)
        claude = root / ".claude/skills/example/SKILL.md"
        claude.parent.mkdir(parents=True)
        claude.write_text(valid)
        assert bridge_findings(root) == []
        bridge.write_text(valid + "Deploy now.\n")
        assert any("procedure" in item for item in bridge_findings(root))
        bridge.write_text(valid)
        source.write_text("---\nname: wrong\ndescription: Example\n---\nBehavior.\n")
        assert any("name differs" in item for item in bridge_findings(root))
        source.unlink()
        assert any("dangling canonical" in item for item in bridge_findings(root))
        source.write_text("No frontmatter\n")
        assert any("missing YAML" in item for item in bridge_findings(root))
        rogue = root / ".claude/skills/rogue/SKILL.md"
        rogue.parent.mkdir(parents=True)
        for body in ("Do this.", "Do this.\n" * 30):
            rogue.write_text(body)
            assert any("rogue" in x and "unclassified" in x for x in classification_findings(root))
        inventory = root / SOURCE_INVENTORY
        inventory.parent.mkdir(parents=True, exist_ok=True)
        inventory.write_text(json.dumps({"sources": {rogue.relative_to(root).as_posix(): {
            "classification": "host_adapter", "sha256": hashlib.sha256(rogue.read_bytes()).hexdigest()
        }}}))
        assert not any("rogue" in x for x in classification_findings(root))
        rogue.write_text("Changed behavior")
        assert any("rogue" in x and "changed" in x for x in classification_findings(root))
        imported = root / ".claude/skills/bundle/agents/unclassified.toml"
        imported.parent.mkdir(parents=True)
        imported.write_text('name = "unexpected"')
        assert any("unclassified.toml" in x for x in classification_findings(root))
    print("Portable bridge regression checks passed (both hosts, metadata, target, procedure, malformed source).")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    ap.add_argument("--strict", action="store_true", help="Exit non-zero when any check fails.")
    ap.add_argument("--self-test", action="store_true", help="Run portable bridge regression fixtures.")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    RESULTS.clear()

    for fn in (
        c1_bridges_point_at_canonical,
        c2_canonical_frontmatter,
        c3_agent_mirrors_have_authored_source,
        c4_commit_attribution_control,
        c5_orchestrate_stages_reachable,
        c6_docs_parity_in_ci,
        c7_platform_authored_inventory,
    ):
        fn()

    rows = c0_enforcement_map()
    counts = {"mechanical": 0, "partial": 0, "asserted": 0, "unknown": 0}
    for _, verdict, _ in rows:
        counts[verdict] = counts.get(verdict, 0) + 1

    if args.json:
        revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT,
                                  capture_output=True, text=True, check=False)
        branch = subprocess.run(["git", "branch", "--show-current"], cwd=REPO_ROOT,
                                capture_output=True, text=True, check=False)
        status = subprocess.run(["git", "status", "--porcelain"], cwd=REPO_ROOT,
                                capture_output=True, text=True, check=False)
        print(json.dumps({"working_tree_dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
                          "revision": revision.stdout.strip() or None,
                          "branch": branch.stdout.strip() or None,
                          "enforcement": [dict(zip(("section", "verdict", "why"), r)) for r in rows],
                          "counts": counts, "checks": RESULTS}, indent=2))
    else:
        print("AGENTS.md alignment audit\n" + "=" * 70)
        print("\n-- Enforcement map --\n")
        for section, verdict, why in rows:
            print(f"[{verdict:>10}] {section}\n             {why}\n")
        total = sum(counts.values())
        print(f"Summary: {counts['mechanical']} mechanical, {counts['partial']} partial, "
              f"{counts['asserted']} asserted-only, of {total} sections.")
        print("The curated enforcement map is review context; live checks below provide structural evidence.\n")
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
