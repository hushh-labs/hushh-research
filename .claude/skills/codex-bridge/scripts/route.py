#!/usr/bin/env python3
"""Route an intent to a Codex skill or workflow and compose a briefing that
mirrors `./bin/hushh codex route-task` semantics: workflow -> owner_skill +
default_spoke -> union(required_reads, required_commands, handoff_chain, risks).

Modes:
  route.py <id>                Exact skill or workflow id.
  route.py "<free text>"       Score task_types, descriptions, owned_paths.
  route.py --list              Catalog (owners, spokes, workflows).
  route.py --check             Structural lint of the .codex tree.
  route.py                     Equivalent to --list.

Designed for Claude Code `!` shell injection: stdout is Markdown that Claude
reads at invocation time.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
STOPWORDS = {
    "a", "an", "the", "i", "we", "you", "to", "from", "of", "for", "on", "in", "at",
    "and", "or", "is", "are", "be", "this", "that", "with", "as", "it", "its", "need",
    "want", "please", "can", "should", "how", "do", "does", "use", "run", "my", "me",
    "when", "what", "why", "would", "could", "about", "have", "has", "had", "not",
    "but", "so", "if", "then", "than", "into", "by", "via", "across", "while",
}


@dataclass
class Entry:
    kind: str        # "skill" | "workflow"
    path: Path
    name: str
    description: str
    manifest: dict   # skill.json or workflow.json


def find_repo_root(start: Path) -> Path:
    for candidate in [start.resolve(), *start.resolve().parents]:
        if (candidate / ".codex").is_dir():
            return candidate
    return start.resolve()


def parse_frontmatter(text: str) -> tuple[dict, str]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw, body = m.group(1), m.group(2)
    fm: dict[str, object] = {}
    nested: str | None = None
    for line in raw.splitlines():
        if not line.strip():
            continue
        if line.startswith("  ") and nested:
            k, _, v = line.strip().partition(":")
            sub = fm.setdefault(nested, {})
            if isinstance(sub, dict):
                sub[k.strip()] = v.strip()
            continue
        nested = None
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if not value:
            nested = key
            fm[key] = {}
        else:
            fm[key] = value
    return fm, body


def discover(repo_root: Path) -> tuple[list[Entry], list[Entry]]:
    skills: list[Entry] = []
    workflows: list[Entry] = []
    skills_dir = repo_root / ".codex" / "skills"
    if skills_dir.is_dir():
        for p in sorted(skills_dir.iterdir()):
            if not p.is_dir():
                continue
            skill_md = p / "SKILL.md"
            if not skill_md.exists():
                continue
            fm, _body = parse_frontmatter(skill_md.read_text())
            manifest: dict = {}
            mp = p / "skill.json"
            if mp.exists():
                try:
                    manifest = json.loads(mp.read_text())
                except json.JSONDecodeError:
                    manifest = {"_error": "invalid skill.json"}
            skills.append(
                Entry(
                    kind="skill",
                    path=p,
                    name=str(fm.get("name") or manifest.get("id") or p.name),
                    description=str(fm.get("description") or manifest.get("description") or ""),
                    manifest=manifest,
                )
            )
    wf_dir = repo_root / ".codex" / "workflows"
    if wf_dir.is_dir():
        for p in sorted(wf_dir.iterdir()):
            if not p.is_dir():
                continue
            wf_json = p / "workflow.json"
            if not wf_json.exists():
                continue
            try:
                manifest = json.loads(wf_json.read_text())
            except json.JSONDecodeError:
                manifest = {"_error": "invalid workflow.json"}
            workflows.append(
                Entry(
                    kind="workflow",
                    path=p,
                    name=str(manifest.get("id") or p.name),
                    description=f"{manifest.get('title') or ''}. {manifest.get('goal') or ''}".strip(),
                    manifest=manifest,
                )
            )
    return skills, workflows


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9][a-z0-9\-_]*", text.lower()) if t and t not in STOPWORDS and len(t) > 1}


def _skill_body_section(path: Path, heading: str) -> str | None:
    """Pull one `## Heading` section out of a skill's SKILL.md body."""
    skill_md = path / "SKILL.md"
    if not skill_md.exists():
        return None
    _fm, body = parse_frontmatter(skill_md.read_text())
    # Match "## <heading>" (case-insensitive), capture until next "## " or EOF.
    pattern = re.compile(rf"^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s|\Z)", re.DOTALL | re.MULTILINE | re.IGNORECASE)
    m = pattern.search(body)
    return m.group(1).strip() if m else None


def _mentioned_paths(query: str, repo_root: Path) -> list[str]:
    """Extract any tokens from the query that look like repo paths and exist."""
    out: list[str] = []
    for tok in re.findall(r"[\w./\-]+", query):
        if "/" not in tok and "." not in tok:
            continue
        if (repo_root / tok).exists():
            out.append(tok)
    return out


def score_skill(entry: Entry, query_tokens: set[str]) -> int:
    if not query_tokens:
        return 0
    s = 0
    m = entry.manifest
    name_tokens = _tokens(entry.name)
    desc_tokens = _tokens(entry.description)
    task_types = m.get("task_types") or []
    scope = str(m.get("primary_scope") or "")
    owner_family = str(m.get("owner_family") or "")
    owned = [str(x) for x in (m.get("owned_paths") or [])]
    adjacent = [str(x) for x in (m.get("adjacent_skills") or [])]

    s += 6 * len(query_tokens & name_tokens)
    s += 4 * len(query_tokens & desc_tokens)
    s += 5 * len(query_tokens & _tokens(" ".join(task_types)))
    s += 4 * len(query_tokens & _tokens(scope))
    s += 2 * len(query_tokens & _tokens(owner_family))
    s += 1 * len(query_tokens & _tokens(" ".join(adjacent)))
    for op in owned:
        if any(tok in op.lower() for tok in query_tokens):
            s += 2
    return s


def score_workflow(entry: Entry, query_tokens: set[str]) -> int:
    if not query_tokens:
        return 0
    s = 0
    m = entry.manifest
    name_tokens = _tokens(entry.name)
    desc_tokens = _tokens(entry.description)
    task_type = str(m.get("task_type") or "")
    goal = str(m.get("goal") or "")
    title = str(m.get("title") or "")
    surfaces = [str(x) for x in (m.get("affected_surfaces") or [])]
    deliverables = [str(x) for x in (m.get("deliverables") or [])]

    s += 6 * len(query_tokens & name_tokens)
    s += 4 * len(query_tokens & desc_tokens)
    s += 5 * len(query_tokens & _tokens(task_type))
    s += 3 * len(query_tokens & _tokens(goal))
    s += 3 * len(query_tokens & _tokens(title))
    s += 2 * len(query_tokens & _tokens(" ".join(deliverables)))
    for sf in surfaces:
        if any(tok in sf.lower() for tok in query_tokens):
            s += 1
    return s


def exact_match(query: str, entries: list[Entry]) -> Entry | None:
    q = query.strip().lower()
    if not q:
        return None
    for e in entries:
        if e.name.lower() == q:
            return e
    prefixes = [e for e in entries if e.name.lower().startswith(q)]
    if len(prefixes) == 1:
        return prefixes[0]
    return None


def _uniq(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def _doc_like(p: str) -> bool:
    n = p.rstrip("/")
    return n.endswith(".md") or n == "README.md"


def compose_workflow_briefing(
    wf: Entry,
    skills_by_id: dict[str, Entry],
) -> str:
    """Mirror build_route_task in repo_scan.py: union owner + spoke fields."""
    m = wf.manifest
    owner_id = m.get("owner_skill")
    default_spoke_id = m.get("default_spoke")
    owner = skills_by_id.get(owner_id) if owner_id else None
    spoke = skills_by_id.get(default_spoke_id) if default_spoke_id else None

    reads = _uniq(
        (m.get("required_reads") or [])
        + ((owner.manifest.get("required_reads") if owner else []) or [])
        + ((spoke.manifest.get("required_reads") if spoke else []) or [])
    )
    commands = _uniq(
        (m.get("required_commands") or [])
        + ((owner.manifest.get("required_commands") if owner else []) or [])
        + ((spoke.manifest.get("required_commands") if spoke else []) or [])
        + ((m.get("verification_bundle") or {}).get("commands") or [])
    )
    tests = _uniq(((m.get("verification_bundle") or {}).get("tests") or []))
    adjacent = _uniq(
        ((owner.manifest.get("adjacent_skills") if owner else []) or [])
        + ((spoke.manifest.get("adjacent_skills") if spoke else []) or [])
    )
    risks = _uniq(
        (m.get("common_failures") or [])
        + ((owner.manifest.get("risk_tags") if owner else []) or [])
        + ((spoke.manifest.get("risk_tags") if spoke else []) or [])
    )
    docs = [r for r in reads if _doc_like(r)]

    out: list[str] = []
    out.append(f"# Routed workflow: `{wf.name}`")
    out.append(f"_Source: {wf.path.relative_to(wf.path.parents[2])}/_\n")
    if m.get("title"):
        out.append(f"**Title:** {m['title']}")
    if m.get("goal"):
        out.append(f"**Goal:** {m['goal']}\n")
    out.append(f"**Owner skill:** `{owner_id or 'unspecified'}`" + (f" | **Default spoke:** `{default_spoke_id}`" if default_spoke_id else ""))
    if m.get("affected_surfaces"):
        out.append("\n**Affected surfaces:**")
        out.extend(f"- `{s}`" for s in m["affected_surfaces"])
    if docs:
        out.append("\n## Read First (composed)\n")
        out.extend(f"- [{d}]({d})" for d in docs)
    other_reads = [r for r in reads if not _doc_like(r)]
    if other_reads:
        out.append("\n**Reference surfaces:**")
        out.extend(f"- `{r}`" for r in other_reads)

    playbook = wf.path / "PLAYBOOK.md"
    if playbook.exists():
        out.append("\n## Playbook\n")
        out.append(playbook.read_text().strip())
    elif owner:
        workflow_section = _skill_body_section(owner.path, "Workflow")
        if workflow_section:
            out.append(f"\n## Workflow (from owner `{owner_id}`)\n")
            out.append(workflow_section)

    if commands:
        out.append("\n## Required Checks (composed)\n")
        out.append("```bash")
        out.extend(commands)
        out.append("```")
    if tests and tests != commands:
        out.append("\n**Verification tests:**")
        out.append("```bash")
        out.extend(tests)
        out.append("```")

    if m.get("deliverables"):
        out.append("\n## Deliverables\n")
        out.extend(f"- {d}" for d in m["deliverables"])
    if m.get("handoff_chain"):
        out.append("\n## Handoff Chain\n")
        out.extend(f"{i+1}. `{s}`" for i, s in enumerate(m["handoff_chain"]))
    if adjacent:
        out.append("\n## Adjacent Skills\n")
        out.extend(f"- `{s}`" for s in adjacent)
    if risks:
        out.append("\n## Risks to Watch\n")
        out.extend(f"- {r}" for r in risks)
    if m.get("scheduled_safe"):
        cadence = m.get("maintenance_cadence") or "unspecified"
        out.append(f"\n_Scheduled-safe. Suggested cadence: **{cadence}**._")
    return "\n".join(out) + "\n"


def compose_skill_briefing(
    skill: Entry,
    workflows: list[Entry],
    skills_by_id: dict[str, Entry],
) -> str:
    """Compose a skill-centric briefing, pulling in related workflows."""
    m = skill.manifest
    owner_family = m.get("owner_family")
    related_workflows = [wf for wf in workflows if wf.manifest.get("owner_skill") == skill.name
                         or wf.manifest.get("default_spoke") == skill.name]
    sibling_spokes = [s for s in skills_by_id.values()
                      if s.manifest.get("owner_family") == owner_family
                      and s.manifest.get("role") == "spoke"
                      and s.name != skill.name]

    out: list[str] = []
    role = m.get("role") or "unspecified"
    out.append(f"# Routed skill: `{skill.name}` _(role: {role})_")
    out.append(f"_Source: {skill.path.relative_to(skill.path.parents[2])}/_\n")
    if skill.description:
        out.append(f"**Description:** {skill.description}\n")
    if m.get("primary_scope"):
        out.append(f"**Primary scope:** `{m['primary_scope']}` | **Owner family:** `{owner_family or 'n/a'}`")
    if m.get("owned_paths"):
        out.append("\n**Owned paths:**")
        out.extend(f"- `{p}`" for p in m["owned_paths"])
    if m.get("non_owned_paths"):
        out.append("\n**Non-owned (hand off if in scope):**")
        out.extend(f"- `{p}`" for p in m["non_owned_paths"])

    skill_md = skill.path / "SKILL.md"
    _fm, body = parse_frontmatter(skill_md.read_text())
    out.append("\n## SKILL.md (body)\n")
    out.append(body.strip())

    if m.get("required_reads"):
        docs = [r for r in m["required_reads"] if _doc_like(r)]
        if docs:
            out.append("\n## Read First\n")
            out.extend(f"- [{d}]({d})" for d in docs)

    if related_workflows:
        out.append("\n## Workflows that reach this skill\n")
        for wf in related_workflows:
            role_here = "owner" if wf.manifest.get("owner_skill") == skill.name else "default spoke"
            out.append(f"- `{wf.name}` (as {role_here}) — {wf.manifest.get('title') or ''}")

    if m.get("handoff_targets"):
        out.append("\n## Handoff Targets\n")
        out.extend(f"- `{s}`" for s in m["handoff_targets"])

    if sibling_spokes and role == "spoke":
        out.append("\n## Sibling spokes (same owner family)\n")
        out.extend(f"- `{s.name}` — {s.description[:120]}" for s in sibling_spokes)

    cmds = m.get("required_commands") or []
    if cmds:
        out.append("\n## Required Checks\n")
        out.append("```bash")
        out.extend(cmds)
        out.append("```")
    return "\n".join(out) + "\n"


def render_catalog(skills: list[Entry], workflows: list[Entry], note: str | None = None) -> str:
    out: list[str] = []
    if note:
        out.append(f"_{note}_\n")
    out.append("# Codex catalog")
    out.append(f"_{len(skills)} skills, {len(workflows)} workflows._\n")

    owners = [s for s in skills if s.manifest.get("role") == "owner"]
    spokes = [s for s in skills if s.manifest.get("role") == "spoke"]

    if owners:
        out.append("## Owner skills (broad intake)\n")
        for s in owners:
            out.append(f"- `{s.name}` — {s.description[:140]}")
    if spokes:
        out.append("\n## Spoke skills (specialists)\n")
        by_family: dict[str, list[Entry]] = {}
        for s in spokes:
            by_family.setdefault(s.manifest.get("owner_family") or "other", []).append(s)
        for family in sorted(by_family):
            out.append(f"**{family}**")
            for s in by_family[family]:
                out.append(f"- `{s.name}` — {s.description[:140]}")
            out.append("")
    if workflows:
        out.append("## Workflows\n")
        for wf in workflows:
            out.append(f"- `{wf.name}` — {wf.description[:140]}")

    out.append("\n_To load a briefing: `/codex-bridge <name>` or `/codex-bridge <free-text>`._")
    return "\n".join(out) + "\n"


def _routing_signals(entry: Entry) -> dict[str, int]:
    """Count the signals route.py uses to score a free-text match against this entry."""
    m = entry.manifest
    return {
        "name_tokens": len(_tokens(entry.name)),
        "desc_tokens": len(_tokens(entry.description)),
        "task_types": len(m.get("task_types") or []),
        "scope_tokens": len(_tokens(str(m.get("primary_scope") or m.get("task_type") or ""))),
        "owned_paths": len(m.get("owned_paths") or []),
    }


def _is_unroutable(entry: Entry) -> bool:
    """Entry exists but has no routable signal beyond its name."""
    sig = _routing_signals(entry)
    return sig["desc_tokens"] == 0 and sig["task_types"] == 0 and sig["scope_tokens"] == 0 and sig["owned_paths"] == 0


def render_check(repo_root: Path, skills: list[Entry], workflows: list[Entry]) -> tuple[str, int]:
    issues: list[str] = []
    ids = {s.name for s in skills}
    families: dict[str, list[str]] = {}
    for s in skills:
        fam = str(s.manifest.get("owner_family") or "")
        if fam:
            families.setdefault(fam, []).append(s.name)
        if "_error" in s.manifest:
            issues.append(f"skill `{s.name}`: {s.manifest['_error']}")
            continue
        if not s.description:
            issues.append(f"skill `{s.name}`: missing description")
        if _is_unroutable(s):
            issues.append(f"skill `{s.name}`: unroutable (no description tokens, task_types, scope, or owned_paths)")
        for ht in s.manifest.get("handoff_targets") or []:
            if ht not in ids:
                issues.append(f"skill `{s.name}`: handoff_target `{ht}` is not a known skill")
        for rp in s.manifest.get("required_reads") or []:
            if not (repo_root / str(rp)).exists():
                issues.append(f"skill `{s.name}`: required_read not found: {rp}")
    for wf in workflows:
        if "_error" in wf.manifest:
            issues.append(f"workflow `{wf.name}`: {wf.manifest['_error']}")
            continue
        if wf.manifest.get("owner_skill") and wf.manifest["owner_skill"] not in ids:
            issues.append(f"workflow `{wf.name}`: owner_skill `{wf.manifest['owner_skill']}` is not a known skill")
        if wf.manifest.get("default_spoke") and wf.manifest["default_spoke"] not in ids:
            issues.append(f"workflow `{wf.name}`: default_spoke `{wf.manifest['default_spoke']}` is not a known skill")
        if wf.manifest.get("scheduled_safe") and not wf.manifest.get("maintenance_cadence"):
            issues.append(f"workflow `{wf.name}`: scheduled_safe without maintenance_cadence")
        if _is_unroutable(wf):
            issues.append(f"workflow `{wf.name}`: unroutable (no description tokens or affected_surfaces)")
        for rp in wf.manifest.get("required_reads") or []:
            if not (repo_root / str(rp)).exists():
                issues.append(f"workflow `{wf.name}`: required_read not found: {rp}")
    owner_ids = {s.name for s in skills if s.manifest.get("role") == "owner"}
    for fam, members in families.items():
        if fam not in ids and fam not in owner_ids:
            issues.append(f"owner_family `{fam}` referenced by {len(members)} skill(s) but has no matching owner skill")

    out = ["# Codex tree check\n", f"_Scanned {len(skills)} skills + {len(workflows)} workflows under `{repo_root}/.codex`._\n"]
    if not issues:
        out.append("**Clean.** No structural issues detected.")
        return "\n".join(out) + "\n", 0
    out.append(f"**{len(issues)} issue(s):**\n")
    out.extend(f"- {line}" for line in issues)
    return "\n".join(out) + "\n", 1


def render_coverage(skills: list[Entry], workflows: list[Entry]) -> tuple[str, int]:
    """Report how routable each entry is. Scaling aid for large codex trees."""
    out: list[str] = ["# Codex routing coverage\n"]
    out.append(f"_{len(skills)} skills, {len(workflows)} workflows._\n")
    unroutable: list[str] = []
    thin: list[str] = []

    out.append("## Skills\n")
    out.append("| name | role | owner_family | desc_tok | task_types | scope_tok | owned_paths |")
    out.append("|---|---|---|---|---|---|---|")
    for s in skills:
        sig = _routing_signals(s)
        role = s.manifest.get("role") or "?"
        fam = s.manifest.get("owner_family") or ""
        out.append(
            f"| `{s.name}` | {role} | {fam} | {sig['desc_tokens']} | "
            f"{sig['task_types']} | {sig['scope_tokens']} | {sig['owned_paths']} |"
        )
        if _is_unroutable(s):
            unroutable.append(f"skill `{s.name}`")
        elif sig["desc_tokens"] < 4 and sig["task_types"] == 0:
            thin.append(f"skill `{s.name}` (desc_tokens={sig['desc_tokens']}, task_types=0)")

    out.append("\n## Workflows\n")
    out.append("| name | owner_skill | default_spoke | desc_tok | task_type_tok | surfaces |")
    out.append("|---|---|---|---|---|---|")
    for wf in workflows:
        m = wf.manifest
        sig = _routing_signals(wf)
        out.append(
            f"| `{wf.name}` | {m.get('owner_skill') or ''} | {m.get('default_spoke') or ''} | "
            f"{sig['desc_tokens']} | {sig['scope_tokens']} | {sig['owned_paths']} |"
        )
        if _is_unroutable(wf):
            unroutable.append(f"workflow `{wf.name}`")

    out.append("\n## Summary\n")
    out.append(f"- Reachable: {len(skills) + len(workflows) - len(unroutable)} / {len(skills) + len(workflows)}")
    if unroutable:
        out.append(f"- **Unroutable ({len(unroutable)}):** needs description, task_types, or owned_paths to be pickable by free-text")
        out.extend(f"  - {u}" for u in unroutable)
    if thin:
        out.append(f"- **Thin signal ({len(thin)}):** works today but risky as the corpus grows")
        out.extend(f"  - {t}" for t in thin)
    if not unroutable and not thin:
        out.append("- All entries have healthy routing signals.")

    code = 1 if unroutable else 0
    return "\n".join(out) + "\n", code


QA_MARKERS = re.compile(r"\?|@\w|\bhow\s+(?:does|do|is|are|can)\b|\bis\s+there\b|\bwould\s+(?:it|we)\b|\bwhy\s+", re.IGNORECASE)


def _reply_rules(repo_root: Path) -> str | None:
    path = repo_root / ".codex" / "skills" / "comms-community" / "references" / "reply-rules.md"
    if not path.exists():
        return None
    return path.read_text().strip()


def _prepend_response_rules(briefing: str, repo_root: Path, query: str) -> str:
    """When the query reads like Q&A, prepend codex's reply rules so Claude uses them."""
    if not QA_MARKERS.search(query):
        return briefing
    rules = _reply_rules(repo_root)
    if not rules:
        return briefing
    header = [
        "# Response format (codex Q&A rules)\n",
        "_Detected Q&A intent. The routed briefing follows; respond using the rules below, not in a long expository form._\n",
        rules,
        "\n---\n",
    ]
    return "\n".join(header) + briefing


HOOK_MIN_PROMPT_LEN = 12
HOOK_WORKFLOW_SCORE = 8
HOOK_SKILL_SCORE = 10


def _read_hook_stdin() -> str:
    """Read UserPromptSubmit hook JSON from stdin and return the prompt field.

    Claude Code feeds hooks a JSON payload containing at least `prompt`,
    `session_id`, `cwd`, and `hook_event_name`. We only need `prompt`.
    Returns "" on any parse failure so the hook stays silent.
    """
    try:
        raw = sys.stdin.read()
    except Exception:
        return ""
    if not raw.strip():
        return ""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    return str(data.get("prompt") or "").strip()


def _hook_wrap(briefing: str, match_id: str, kind: str) -> str:
    header = (
        "# Auto-routed by codex-bridge\n\n"
        f"_Your prompt matched **{kind} `{match_id}`** in the codex tree. "
        "Treat the briefing below as authoritative for this turn: follow its "
        "Read-First list, workflow steps, and required checks, and hand off "
        "if the task leaves scope. If the match looks wrong, ignore this "
        "block and proceed with the user's request as stated._\n\n---\n\n"
    )
    return header + briefing


def _route_hook(
    repo_root: Path,
    skills: list[Entry],
    workflows: list[Entry],
    query: str,
) -> tuple[str, int]:
    """Silent-fallback mode for the UserPromptSubmit hook.

    Emits a wrapped briefing only on a confident match. Conversational or
    off-topic prompts produce empty stdout so the hook does not bury the
    turn in catalog dumps.
    """
    if os.environ.get("CODEX_BRIDGE_DISABLE") == "1":
        return ("", 0)
    if not query or len(query) < HOOK_MIN_PROMPT_LEN:
        return ("", 0)

    skills_by_id = {s.name: s for s in skills}

    direct_workflow = exact_match(query, workflows)
    if direct_workflow:
        briefing = compose_workflow_briefing(direct_workflow, skills_by_id)
        return _prepend_response_rules(
            _hook_wrap(briefing, direct_workflow.name, "workflow"), repo_root, query
        ), 0

    direct_skill = exact_match(query, skills)
    if direct_skill:
        briefing = compose_skill_briefing(direct_skill, workflows, skills_by_id)
        return _prepend_response_rules(
            _hook_wrap(briefing, direct_skill.name, "skill"), repo_root, query
        ), 0

    tokens = _tokens(query)
    if not tokens:
        return ("", 0)

    ranked_skills = sorted(((score_skill(e, tokens), e) for e in skills), key=lambda x: -x[0])
    ranked_workflows = sorted(((score_workflow(e, tokens), e) for e in workflows), key=lambda x: -x[0])

    best_skill_score, best_skill = (ranked_skills[0] if ranked_skills else (0, None))
    best_wf_score, best_wf = (ranked_workflows[0] if ranked_workflows else (0, None))

    if best_wf is not None and best_wf_score >= HOOK_WORKFLOW_SCORE and best_wf_score >= best_skill_score:
        briefing = compose_workflow_briefing(best_wf, skills_by_id)
        return _prepend_response_rules(
            _hook_wrap(briefing, best_wf.name, "workflow"), repo_root, query
        ), 0

    if best_skill is not None and best_skill_score >= HOOK_SKILL_SCORE:
        close = [e for s, e in ranked_skills if s >= best_skill_score - 2 and e is not best_skill]
        if close:
            return ("", 0)
        briefing = compose_skill_briefing(best_skill, workflows, skills_by_id)
        return _prepend_response_rules(
            _hook_wrap(briefing, best_skill.name, "skill"), repo_root, query
        ), 0

    return ("", 0)


def route(argv: list[str]) -> tuple[str, int]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--coverage", action="store_true")
    parser.add_argument(
        "--hook",
        action="store_true",
        help="UserPromptSubmit hook mode: read prompt JSON from stdin and emit a briefing only on a confident match.",
    )
    parser.add_argument("--repo", default=None)
    parser.add_argument("query", nargs="*")
    args = parser.parse_args(argv)

    repo_root = Path(args.repo).resolve() if args.repo else find_repo_root(Path.cwd())
    skills, workflows = discover(repo_root)
    if not skills and not workflows:
        if args.hook:
            return ("", 0)
        return (f"_No `.codex/skills/` or `.codex/workflows/` entries under {repo_root}._\n", 1)

    if args.hook:
        query = _read_hook_stdin()
        return _route_hook(repo_root, skills, workflows, query)

    if args.check:
        return render_check(repo_root, skills, workflows)
    if args.coverage:
        return render_coverage(skills, workflows)

    query = " ".join(args.query).strip()
    if args.list or not query:
        return render_catalog(skills, workflows), 0

    skills_by_id = {s.name: s for s in skills}
    all_entries = skills + workflows

    direct_workflow = exact_match(query, workflows)
    if direct_workflow:
        return _prepend_response_rules(compose_workflow_briefing(direct_workflow, skills_by_id), repo_root, query), 0
    direct_skill = exact_match(query, skills)
    if direct_skill:
        return _prepend_response_rules(compose_skill_briefing(direct_skill, workflows, skills_by_id), repo_root, query), 0

    tokens = _tokens(query)
    ranked_skills = sorted(((score_skill(e, tokens), e) for e in skills), key=lambda x: -x[0])
    ranked_workflows = sorted(((score_workflow(e, tokens), e) for e in workflows), key=lambda x: -x[0])
    top_s = [(s, e) for s, e in ranked_skills if s > 0]
    top_w = [(s, e) for s, e in ranked_workflows if s > 0]

    if not top_s and not top_w:
        return render_catalog(skills, workflows, note=f"No token match for '{query}'. Pick one manually."), 0

    best_skill = top_s[0] if top_s else (0, None)
    best_workflow = top_w[0] if top_w else (0, None)

    if best_workflow[0] >= best_skill[0] and best_workflow[1] is not None and best_workflow[0] >= 5:
        briefing = compose_workflow_briefing(best_workflow[1], skills_by_id)
        return _prepend_response_rules(briefing, repo_root, query), 0
    if best_skill[1] is not None:
        close = [e for s, e in top_s if s >= best_skill[0] - 2]
        if len(close) > 1:
            header = [f"# Multiple skills matched '{query}'\n",
                      "Re-invoke with a specific name, or pick the most specialized (spoke) one:\n",
                      "| Score | Name | Role | Description |", "|---|---|---|---|"]
            for s_, e in top_s[:5]:
                desc = (e.description or "").replace("|", "\\|")[:110]
                header.append(f"| {s_} | `{e.name}` | {e.manifest.get('role') or '?'} | {desc} |")
            if top_w:
                header.append("\n**Related workflows:**")
                for s_, e in top_w[:3]:
                    header.append(f"- `{e.name}` (score {s_}) — {e.description[:120]}")
            header.append("\n**Default:** showing briefing for the top skill below.\n---\n")
            briefing = "\n".join(header) + compose_skill_briefing(best_skill[1], workflows, skills_by_id)
            return _prepend_response_rules(briefing, repo_root, query), 0
        briefing = compose_skill_briefing(best_skill[1], workflows, skills_by_id)
        return _prepend_response_rules(briefing, repo_root, query), 0

    return render_catalog(skills, workflows, note=f"Weak match for '{query}'. Pick manually."), 0


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    text, code = route(argv)
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
