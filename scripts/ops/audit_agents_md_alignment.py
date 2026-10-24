#!/usr/bin/env python3
"""Audit the repository against its own operating kernel, `AGENTS.md`.

The full audit is ON-DEMAND ONLY. The portable framework check is reused by skill lint;
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
        "architecture_fitness.py reports measured debt; governance supplies the reviewed "
        "post-pilot --baseline and rejects new or worsened findings. Existing debt remains advisory.",
    ),
    "Project-Wide Runtime Telemetry Default & Chat Session Naming": ("asserted", "No automated enforcement."),
    "Project-Wide Agent Architecture Doctrine": (
        "partial",
        "Generated contracts and runtime tests enforce individual boundaries; no single "
        "gate proves the entire doctrine or its deployment-specific implementation.",
    ),
    "Project-Wide Premise Verification Gate": (
        "partial",
        "truth_first_smoke.py and skill_lint.py check contract markers; marker presence does not prove premise verification occurred.",
    ),
    "Canonical skill center": (
        "mechanical",
        "Canonical source checks reject vendor roots and duplicate fleet projections; "
        "skill_lint.py validates skill.json, required SKILL.md sections, canonical sources and "
        "pinned import classifications. Pending import review remains separate debt.",
    ),
    "Project-Wide Routing Gate": (
        "partial",
        "agent_router_smoke.py and .agents/routing/scripts/route.py --check prove the router resolves; "
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
        "partial",
        "reviewer-app-testing-check.sh is required by reviewer-app-rehearsal; "
        "a routed check is not universal CI or proof of each browser session's conduct.",
    ),
    "Project-Wide Branch Discipline Gate (HARD RULE)": (
        "asserted",
        "Self-declared 'enforced by judgment, not just docs'.",
    ),
    "Project-Wide Commit Attribution Gate (HARD RULE)": (
        "partial",
        "check-dco-signoff.sh verifies commit signoffs in CI and the local release gate. "
        "AI co-author prohibition is an asserted cross-host policy; DCO verifies signoff only -- see C4.",
    ),
}

RESULTS: list[dict] = []


def record(check: str, ok: bool, detail: str, severity: str = "finding") -> None:
    RESULTS.append({"check": check, "ok": ok, "detail": detail, "severity": severity})


def load_operating_contract(root: Path) -> str:
    """Load the one binding contract, refusing a missing or bypassed root pointer."""
    entry = root / "AGENTS.md"
    source = root / ".agents/instructions.md"
    if not entry.is_file() or ".agents/instructions.md" not in entry.read_text(encoding="utf-8"):
        raise ValueError("Root AGENTS.md must explicitly load .agents/instructions.md")
    if not source.is_file():
        raise ValueError("Canonical development operating contract is missing")
    return source.read_text(encoding="utf-8")


def agents_md_sections() -> list[str]:
    return re.findall(r"^## (.+)$", load_operating_contract(REPO_ROOT), flags=re.MULTILINE)


def c0_enforcement_map() -> list[tuple[str, str, str]]:
    rows = []
    for section in agents_md_sections():
        verdict, why = ENFORCEMENT.get(section, ("unknown", "Not yet classified — add to ENFORCEMENT."))
        rows.append((section, verdict, why))
    return rows


SOURCE_INVENTORY = ".agents/skills/agent-orchestration-governance/references/platform-source-inventory.json"


def bridge_findings(root: Path) -> list[str]:
    """Verify canonical skills and refusal of duplicate host discovery."""
    findings = []
    import runpy
    checks = runpy.run_path(str(REPO_ROOT / ".agents/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py"))
    checks["validate_platform_agent_sources"](root, findings)
    checks["validate_canonical_framework"](root, findings)
    if findings:
        return findings
    for canonical in sorted((root / ".agents/skills").glob("*/SKILL.md")):
        source = canonical.read_text(encoding="utf-8")
        match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", source, re.S)
        if not match:
            findings.append(f"{canonical.relative_to(root)}: missing YAML frontmatter")
            continue
        name = re.search(r"^name:\s*(.+)$", match.group(1), re.M)
        if not name or name.group(1).strip().strip("\"'") != canonical.parent.name:
            findings.append(f"{canonical.relative_to(root)}: canonical name differs from directory")
    return findings


def classification_findings(root: Path) -> list[str]:
    """Explicit classifications prevent missing manifests or imports from becoming trusted skills."""
    import runpy
    findings = []
    checks = runpy.run_path(str(REPO_ROOT / ".agents/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py"))
    checks["validate_source_confinement"](root, findings)
    if findings:
        return findings
    manifest = root / SOURCE_INVENTORY
    if not manifest.is_file():
        return ["Platform source inventory is missing"]
    inventory = json.loads(manifest.read_text())
    sources = inventory.get("sources", {})
    practices = inventory.get("practice_sources", {})
    for section in ("sources", "practice_sources", "imported_agents"):
        for key in inventory.get(section, {}):
            path = Path(key)
            if path.is_absolute() or ".." in path.parts or not key.startswith(".agents/"):
                findings.append(f"{key}: inventory source must be relative and inside .agents")
    if findings:
        return findings
    allowed = {"imported_dependency_pending_review", "legacy_behavior_pending_review"}
    for key, entry in sources.items():
        path = root / key
        if not path.is_file():
            findings.append(f"{key}: stale platform classification")
        elif entry.get("classification") not in allowed:
            findings.append(f"{key}: invalid platform classification")
        elif entry.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
            findings.append(f"{key}: platform behavior changed; review its classification")
    for key, entry in practices.items():
        path = root / key
        if not path.is_file() or path.with_name("skill.json").exists() or entry.get("classification") != "portable_practice":
            findings.append(f"{key}: invalid portable-practice classification")
    canonical = {p.relative_to(root).as_posix(): p for p in (root / ".agents/skills").glob("*/SKILL.md")}
    for key, path in canonical.items():
        if not path.with_name("skill.json").is_file() and key not in practices:
            findings.append(f"{key}: missing governed manifest or explicit practice classification")
    if inventory.get("host_adapters") or inventory.get("compatibility_commands"):
        findings.append("Per-host adapters are retired")
    expected_agents = inventory.get("imported_agents", {})
    nested = {}
    nested.update({p.relative_to(root).as_posix(): p for p in (root / ".agents/skills").glob("*/agents/*.toml")})
    nested.update({p.relative_to(root).as_posix(): p for p in (root / ".agents/routing").glob("**/agents/*.toml")})
    nested.update({p.relative_to(root).as_posix(): p for p in (root / ".agents/imports").glob("**/agents/*.toml")})
    canonical_nested = {}
    for path in nested.values():
        try:
            canonical_nested[path.resolve(strict=True).relative_to(root.resolve()).as_posix()] = path
        except (ValueError, OSError):
            findings.append(f"{path.relative_to(root)}: imported agent target is outside the repository or missing")
    nested = canonical_nested
    for key, path in nested.items():
        if expected_agents.get(key) != hashlib.sha256(path.read_bytes()).hexdigest():
            findings.append(f"{key}: unclassified or changed imported agent resource")
    findings.extend(f"{key}: stale imported agent classification" for key in expected_agents.keys() - nested.keys())
    return findings


def c1_bridges_point_at_canonical() -> None:
    offenders = bridge_findings(REPO_ROOT) + classification_findings(REPO_ROOT)
    record("C1 portable framework has one canonical source", not offenders,
           "; ".join(offenders) if offenders else "Root AGENTS.md points at canonical .agents sources; vendor discovery is refused.")


def c7_platform_authored_inventory(root: Path | None = None) -> None:
    """Separate classified resources and pending review from structural drift."""
    root = root or REPO_ROOT
    path = root / SOURCE_INVENTORY
    inventory = json.loads(path.read_text()) if path.exists() else {}
    sources = inventory.get("sources", {})
    findings = classification_findings(root)
    agents = [item for item in findings if item.split(": ", 1)[0].endswith(".toml")]
    skills = [item for item in findings if item not in agents]
    record("C7 platform-authored skill review", not skills,
           "; ".join(skills) if skills else
           f"{len(sources)} pinned platform sources match their classifications; this does not approve imported execution.")
    record("C8 platform-authored agent review", not agents,
           "; ".join(agents) if agents else
           f"{len(inventory.get('imported_agents', {}))} pinned imported agent resources retained outside the authored fleet.")
    pending = [f"{key}: {entry['classification']}" for key, entry in sorted(sources.items())
               if "_pending_" in entry.get("classification", "")]
    if pending:
        record("C7 classified platform review debt", False,
               "; ".join(pending) + f". Retain the recorded disposition in {SOURCE_INVENTORY}; classification is not completion.",
               "review_debt")


def c2_canonical_frontmatter() -> None:
    """Canonical skill frontmatter `name` must equal its directory name."""
    root = REPO_ROOT / ".agents/skills"
    if not root.is_dir():
        record("C2 canonical frontmatter matches dir", False, "Missing canonical .agents/skills directory.")
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
    """One authored fleet; no host-specific copies or projections."""
    authored = list((REPO_ROOT / ".agents/subagents").glob("*.toml"))
    duplicate = REPO_ROOT / ".agents/generated/subagents"
    record("C3 one authored development fleet", bool(authored) and not duplicate.exists(),
           f"{len(authored)} authored lanes; no generated host fleet.")


def c4_commit_attribution_control() -> None:
    """Do not confuse a human signoff with automatic AI co-author prevention."""
    instructions = load_operating_contract(REPO_ROOT)
    present = "AI tool is NEVER a contributor" in instructions
    record("C4 AI attribution policy present", present,
           "Cross-host prohibition is stated in the canonical contract. It is an author/reviewer obligation; DCO alone checks signoff, not co-author identity.", "risk")


def c5_orchestrate_stages_reachable() -> None:
    """Find direct CI stage calls; absent literals require indirect-caller review."""
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
        for name, text in {"AGENTS.md": "Read .agents/instructions.md", ".agents/instructions.md": "fixture", ".agents/README.md": "fixture", ".agents/config.toml": ""}.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        source = root / ".agents/skills/example/SKILL.md"
        source.parent.mkdir(parents=True)
        source.write_text("---\nname: example\ndescription: Example\n---\nBehavior.\n")
        inventory = root / SOURCE_INVENTORY
        inventory.parent.mkdir(parents=True, exist_ok=True)
        inventory.write_text(json.dumps({"practice_sources": {source.relative_to(root).as_posix(): {"classification": "portable_practice"}}}))
        assert not bridge_findings(root)
        assert not classification_findings(root)
        for name in (".claude", ".codex", ".qwen"):
            forbidden = root / name
            forbidden.symlink_to("missing-target")
            assert any(name in error for error in bridge_findings(root))
            forbidden.unlink()
        external = root / "external-skill.md"
        external.write_text(source.read_text())
        source.unlink()
        source.symlink_to(external)
        assert any("escapes .agents" in error for error in bridge_findings(root))
        assert any("escapes .agents" in error for error in classification_findings(root))
        source.unlink()
        source.write_text(external.read_text())
        outside = root / ".agents/skills/outside"
        outside.symlink_to(root, target_is_directory=True)
        assert any("escapes .agents" in error for error in bridge_findings(root))
        outside.unlink()
        payload = json.loads(inventory.read_text())
        payload["sources"] = {"../external-skill.md": {"classification": "imported_dependency_pending_review"}}
        inventory.write_text(json.dumps(payload))
        assert any("inside .agents" in error for error in classification_findings(root))
        payload.pop("sources")
        inventory.write_text(json.dumps(payload))
        unclassified = source.parent.parent / "unclassified/SKILL.md"
        unclassified.parent.mkdir()
        unclassified.write_text("---\nname: unclassified\ndescription: Example\n---\nBehavior.\n")
        assert any("missing governed manifest" in error for error in classification_findings(root))
        unclassified.unlink()
        unclassified.parent.rmdir()
        source.write_text("---\nname: wrong\ndescription: Example\n---\nBehavior.\n")
        assert any("name differs" in error for error in bridge_findings(root))
        source.write_text("No frontmatter\n")
        assert any("missing YAML" in error for error in bridge_findings(root))
        imported = root / ".agents/imports/bundle/agents/worker.toml"
        imported.parent.mkdir(parents=True)
        imported.write_text('name = "imported-resource"')
        payload = json.loads(inventory.read_text())
        payload['imported_agents'] = {imported.relative_to(root).as_posix(): hashlib.sha256(imported.read_bytes()).hexdigest()}
        inventory.write_text(json.dumps(payload))
        assert not classification_findings(root)
        imported.write_text('name = "changed-resource"')
        assert any("worker.toml" in error and "changed" in error for error in classification_findings(root))
    print("Portable framework checks passed: canonical source, forbidden roots, malformed skills and imported authority.")
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
            mark = "PASS" if r["ok"] else {"risk": "RISK", "review_debt": "REVIEW"}.get(r["severity"], "FAIL")
            print(f"[{mark}] {r['check']}\n       {r['detail']}\n")

    failed = [r for r in RESULTS if not r["ok"]]
    if args.strict and failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
