#!/usr/bin/env python3
"""Route an intent to a Codex skill, workflow, or agent and compose a briefing
that mirrors `./bin/hushh codex route-task` semantics: workflow -> owner_skill
+ default_spoke -> union(required_reads, required_commands, handoff_chain,
risks). Agents are surfaced as advisory delegation lanes, never as primary
winners over a matching skill or workflow (per the delegation contract).

Modes:
  route.py <id>                Exact skill, workflow, or agent id.
  route.py "<free text>"       Score task_types, descriptions, owned_paths.
  route.py --list              Catalog (owners, spokes, workflows, agents).
  route.py --check             Structural lint of the .codex tree.
  route.py                     Equivalent to --list.

Designed for Claude Code `!` shell injection: stdout is Markdown that Claude
reads at invocation time.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import tomllib
from collections import Counter, OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
STOPWORDS = {
    "a", "an", "the", "i", "we", "you", "to", "from", "of", "for", "on", "in", "at",
    "and", "or", "is", "are", "be", "this", "that", "with", "as", "it", "its", "need",
    "want", "please", "can", "should", "how", "do", "does", "use", "run", "my", "me",
    "when", "what", "why", "would", "could", "about", "have", "has", "had", "not",
    "but", "so", "if", "then", "than", "into", "by", "via", "across", "while",
}

# Kept in sync with .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py.
AGENT_SKILL_BLOCK_HEADER = "Use these repo-local skills when they fit the lane:"
AGENT_PRIORITY_HEADINGS = ("Priorities:", "Focus on:", "Review priorities:", "Investigation priorities:")
GOVERNOR_AUTHORITY_MARKER = "only you may produce final merge"


@dataclass
class Entry:
    kind: str        # "skill" | "workflow" | "agent"
    path: Path
    name: str
    description: str
    manifest: dict   # skill.json, workflow.json, or parsed agent TOML


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


def _parse_agent_toml(path: Path) -> dict:
    """Parse an agent TOML manifest. Returns `_error` envelope on failure."""
    try:
        return tomllib.loads(path.read_text())
    except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as exc:
        return {"_error": f"invalid agent TOML: {exc}"}


def discover(repo_root: Path) -> tuple[list[Entry], list[Entry], list[Entry]]:
    skills: list[Entry] = []
    workflows: list[Entry] = []
    agents: list[Entry] = []
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
    agents_dir = repo_root / ".codex" / "agents"
    if agents_dir.is_dir():
        for p in sorted(agents_dir.glob("*.toml")):
            manifest = _parse_agent_toml(p)
            agents.append(
                Entry(
                    kind="agent",
                    path=p,
                    name=str(manifest.get("name") or p.stem),
                    description=str(manifest.get("description") or ""),
                    manifest=manifest,
                )
            )
    return skills, workflows, agents


def _tokens(text: str) -> set[str]:
    """Tokenize, emitting both the whole hyphenated term and its parts.

    Skill and workflow ids are kebab-case (`ci-watch-and-heal`), so matching on
    the joined form alone means a prompt saying "CI" can never reach the CI
    workflow by name. Emitting both forms lets the exact id keep its weight
    while the parts still participate.
    """
    out: set[str] = set()
    for raw in re.findall(r"[a-z0-9][a-z0-9\-_]*", text.lower()):
        for part in {raw, *re.split(r"[-_]+", raw)}:
            if len(part) > 1 and part not in STOPWORDS:
                out.add(part)
    return out


def _path_segments(paths: Iterable[Any]) -> set[str]:
    """Split repo paths into whole segments so `app` cannot match `hushh-webapp`."""
    out: set[str] = set()
    for p in paths:
        for seg in re.split(r"[/\-_.]+", str(p).lower()):
            if len(seg) > 1 and seg not in STOPWORDS:
                out.add(seg)
    return out


class Rarity:
    """Per-corpus token rarity, so generic words stop deciding the route.

    `audit`, `review`, `check` and `contract` appear in most manifests; a token
    that shows up almost everywhere carries almost no routing signal, while a
    token unique to one entry carries all of it. Weighting the match by rarity
    (plain IDF, normalized to the corpus size) is what keeps "audit the
    documentation structure" off `security-*` and on `docs-sync`.
    """

    FLOOR = 0.12

    def __init__(self, entries: list[Entry], token_fn: Callable[[Entry], set[str]]) -> None:
        self.size = max(1, len(entries))
        df: Counter[str] = Counter()
        for entry in entries:
            df.update(token_fn(entry))
        self._df = df
        self._scale = math.log(self.size) if self.size > 1 else 1.0

    def weight(self, token: str) -> float:
        seen = self._df.get(token, 0)
        if seen <= 0:
            return 1.0
        return max(self.FLOOR, min(1.0, math.log(self.size / seen) / self._scale))

    def mass(self, tokens: set[str]) -> float:
        return sum(self.weight(t) for t in tokens)


def _skill_corpus_tokens(entry: Entry) -> set[str]:
    m = entry.manifest
    return (
        _tokens(entry.name)
        | _tokens(entry.description)
        | _tokens(" ".join(str(x) for x in (m.get("task_types") or [])))
        | _tokens(str(m.get("primary_scope") or ""))
        | _tokens(str(m.get("owner_family") or ""))
        | _path_segments(m.get("owned_paths") or [])
    )


def _workflow_corpus_tokens(entry: Entry) -> set[str]:
    m = entry.manifest
    return (
        _tokens(entry.name)
        | _tokens(entry.description)
        | _tokens(str(m.get("task_type") or ""))
        | _tokens(str(m.get("goal") or ""))
        | _tokens(str(m.get("title") or ""))
        | _tokens(" ".join(str(x) for x in (m.get("deliverables") or [])))
        | _path_segments(m.get("affected_surfaces") or [])
    )


def _agent_corpus_tokens(entry: Entry) -> set[str]:
    return (
        _tokens(entry.name)
        | _agent_nickname_tokens(entry)
        | _tokens(entry.description)
        | _tokens(" ".join(_agent_skill_refs(entry)))
        | _agent_priority_tokens(entry)
    )


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


def _path_ownership_score(declared: Iterable[Any], mentioned: Iterable[str]) -> float:
    """How specifically a declared surface covers a path the user actually typed.

    Matching is one-directional on purpose. An earlier version also matched when
    the declared surface sat *below* the typed path, which meant typing a parent
    directory handed the full bonus to every entry underneath it and
    manufactured ties instead of breaking them.

    The score scales with how deep the owning surface is, so
    `hushh-webapp/lib/cache` outranks a bare `hushh-webapp` for the same path.
    """
    owned = [str(d).strip("/") for d in declared if str(d).strip()]
    best = 0.0
    for path in mentioned:
        p = path.strip("/")
        for d in owned:
            if p == d:
                best = max(best, 1.0)
            elif p.startswith(d + "/"):
                depth = d.count("/") + 1
                best = max(best, min(0.9, 0.4 + 0.2 * depth))
    return best


# A path the user actually typed is the strongest routing evidence available:
# it beats any amount of prose overlap, so it is scored as a decisive bonus.
PATH_OWNERSHIP_BONUS = 12
# "run the security consent audit" covers every word of `security-consent-audit`.
# Without this, a verbose manifest that repeats one shared word across goal,
# title and deliverables outscores the entry the user actually described.
NAME_COVERAGE_BONUS = 8


def _covers_name(entry: Entry, query_tokens: set[str]) -> bool:
    parts = {p for p in re.split(r"[-_]+", entry.name.lower()) if len(p) > 1 and p not in STOPWORDS}
    return len(parts) >= 2 and parts <= query_tokens


def score_skill(
    entry: Entry,
    query_tokens: set[str],
    rarity: Rarity,
    mentioned_paths: Iterable[str] = (),
) -> int:
    if not query_tokens:
        return 0
    s = 0.0
    m = entry.manifest
    owned = m.get("owned_paths") or []
    adjacent = [str(x) for x in (m.get("adjacent_skills") or [])]

    s += 6 * rarity.mass(query_tokens & _tokens(entry.name))
    s += 4 * rarity.mass(query_tokens & _tokens(entry.description))
    s += 5 * rarity.mass(query_tokens & _tokens(" ".join(str(x) for x in (m.get("task_types") or []))))
    s += 4 * rarity.mass(query_tokens & _tokens(str(m.get("primary_scope") or "")))
    s += 2 * rarity.mass(query_tokens & _tokens(str(m.get("owner_family") or "")))
    s += 1 * rarity.mass(query_tokens & _tokens(" ".join(adjacent)))
    s += 3 * rarity.mass(query_tokens & _path_segments(owned))
    s += PATH_OWNERSHIP_BONUS * _path_ownership_score(owned, mentioned_paths)
    if _covers_name(entry, query_tokens):
        s += NAME_COVERAGE_BONUS
    return round(s)


def score_workflow(
    entry: Entry,
    query_tokens: set[str],
    rarity: Rarity,
    mentioned_paths: Iterable[str] = (),
) -> int:
    if not query_tokens:
        return 0
    s = 0.0
    m = entry.manifest
    surfaces = m.get("affected_surfaces") or []

    s += 6 * rarity.mass(query_tokens & _tokens(entry.name))
    s += 4 * rarity.mass(query_tokens & _tokens(entry.description))
    s += 5 * rarity.mass(query_tokens & _tokens(str(m.get("task_type") or "")))
    s += 3 * rarity.mass(query_tokens & _tokens(str(m.get("goal") or "")))
    s += 3 * rarity.mass(query_tokens & _tokens(str(m.get("title") or "")))
    s += 2 * rarity.mass(query_tokens & _tokens(" ".join(str(x) for x in (m.get("deliverables") or []))))
    s += 3 * rarity.mass(query_tokens & _path_segments(surfaces))
    s += PATH_OWNERSHIP_BONUS * _path_ownership_score(surfaces, mentioned_paths)
    if _covers_name(entry, query_tokens):
        s += NAME_COVERAGE_BONUS
    return round(s)


_AGENT_SKILL_BLOCK_RE = re.compile(
    re.escape(AGENT_SKILL_BLOCK_HEADER) + r"\s*\n((?:\s*-\s+.+\n?)+)",
    re.IGNORECASE,
)


def _agent_skill_refs(entry: Entry) -> list[str]:
    """Extract the skill-id bullets listed under the standardized skill block."""
    instructions = str(entry.manifest.get("developer_instructions") or "")
    m = _AGENT_SKILL_BLOCK_RE.search(instructions)
    if not m:
        return []
    out: list[str] = []
    for line in m.group(1).splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        sid = stripped.lstrip("-").strip()
        if sid:
            out.append(sid)
    return out


def _agent_priority_tokens(entry: Entry) -> set[str]:
    """Tokens pulled only from bullets under Priorities/Focus-on/etc. headings."""
    instructions = str(entry.manifest.get("developer_instructions") or "")
    collected: list[str] = []
    lines = instructions.splitlines()
    capturing = False
    for line in lines:
        stripped = line.strip()
        if any(stripped.startswith(h) for h in AGENT_PRIORITY_HEADINGS):
            capturing = True
            continue
        if capturing:
            if stripped.startswith("-"):
                collected.append(stripped.lstrip("-").strip())
            elif stripped == "":
                continue
            else:
                capturing = False
    return _tokens(" ".join(collected))


def _agent_nickname_tokens(entry: Entry) -> set[str]:
    nicks = entry.manifest.get("nickname_candidates") or []
    if not isinstance(nicks, (list, tuple)):
        return set()
    return _tokens(" ".join(str(n) for n in nicks))


def _agent_authority_kind(entry: Entry) -> str:
    if entry.name == "governor":
        return "final-authority"
    instructions = str(entry.manifest.get("developer_instructions") or "").lower()
    if GOVERNOR_AUTHORITY_MARKER in instructions:
        return "final-authority"
    return "advisory-only"


def score_agent(entry: Entry, query_tokens: set[str], rarity: Rarity) -> int:
    if not query_tokens:
        return 0
    s = 0.0
    s += 6 * rarity.mass(query_tokens & _tokens(entry.name))
    s += 4 * rarity.mass(query_tokens & _agent_nickname_tokens(entry))
    s += 4 * rarity.mass(query_tokens & _tokens(entry.description))
    s += 2 * rarity.mass(query_tokens & _tokens(" ".join(_agent_skill_refs(entry))))
    s += 1 * rarity.mass(query_tokens & _agent_priority_tokens(entry))
    return round(s)


@dataclass
class Ranker:
    """Bundles the three corpora so every call site scores identically."""

    skills: list[Entry]
    workflows: list[Entry]
    agents: list[Entry]

    def __post_init__(self) -> None:
        self._skill_rarity = Rarity(self.skills, _skill_corpus_tokens)
        self._workflow_rarity = Rarity(self.workflows, _workflow_corpus_tokens)
        self._agent_rarity = Rarity(self.agents, _agent_corpus_tokens)

    def rank(self, query: str, repo_root: Path) -> tuple[
        list[tuple[int, Entry]], list[tuple[int, Entry]], list[tuple[int, Entry]]
    ]:
        tokens = _tokens(query)
        paths = _mentioned_paths(query, repo_root)
        ranked_skills = sorted(
            ((score_skill(e, tokens, self._skill_rarity, paths), e) for e in self.skills),
            key=lambda x: -x[0],
        )
        ranked_workflows = sorted(
            ((score_workflow(e, tokens, self._workflow_rarity, paths), e) for e in self.workflows),
            key=lambda x: -x[0],
        )
        ranked_agents = sorted(
            ((score_agent(e, tokens, self._agent_rarity), e) for e in self.agents),
            key=lambda x: -x[0],
        )
        return ranked_skills, ranked_workflows, ranked_agents


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


def named_match(query: str, ordered_kinds: list[tuple[list[Entry], str]]) -> tuple[Entry, str] | None:
    """Resolve a typed name across kinds, exact before prefix.

    Kind order breaks ties (workflow is the actionable unit), but an *exact*
    name in a later kind must still beat a *prefix* hit in an earlier one:
    typing `reviewer` means the reviewer agent, not `reviewer-app-rehearsal`.
    """
    q = query.strip().lower()
    if not q:
        return None
    for entries, kind in ordered_kinds:
        for e in entries:
            if e.name.lower() == q:
                return e, kind
    for entries, kind in ordered_kinds:
        prefixes = [e for e in entries if e.name.lower().startswith(q)]
        if len(prefixes) == 1:
            return prefixes[0], kind
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


def _short_paths(paths: Iterable[Any], limit: int = 6) -> str:
    items = [f"`{p}`" for p in list(paths)[:limit]]
    extra = max(0, len(list(paths)) - limit)
    return ", ".join(items) + (f" (+{extra} more)" if extra else "")


def compose_compact_briefing(
    entry: Entry,
    kind: str,
    skills_by_id: dict[str, Entry],
    rivals: list[Entry] | None = None,
) -> str:
    """Pointer-sized briefing for a plausible-but-not-certain match.

    The full briefing inlines an entire PLAYBOOK or SKILL.md body, which is the
    right trade only when the route is confident. At medium confidence the
    useful payload is just: which lane, what to read, what to run, and how to
    load the rest. That is roughly a tenth of the tokens.
    """
    m = entry.manifest
    out: list[str] = [f"**Routed lane (compact):** {kind} `{entry.name}`"]

    if kind == "workflow":
        owner_id = m.get("owner_skill")
        spoke_id = m.get("default_spoke")
        owner = skills_by_id.get(owner_id) if owner_id else None
        spoke = skills_by_id.get(spoke_id) if spoke_id else None
        if m.get("goal"):
            out.append(f"**Goal:** {m['goal']}")
        out.append(
            f"**Owner skill:** `{owner_id or 'unspecified'}`"
            + (f" | **Default spoke:** `{spoke_id}`" if spoke_id else "")
        )
        reads = _uniq(
            (m.get("required_reads") or [])
            + ((owner.manifest.get("required_reads") if owner else []) or [])
            + ((spoke.manifest.get("required_reads") if spoke else []) or [])
        )
        commands = _uniq(
            (m.get("required_commands") or [])
            + ((m.get("verification_bundle") or {}).get("commands") or [])
        )
    elif kind == "skill":
        out.append(f"**Role:** {m.get('role') or 'unspecified'} | **Owner family:** `{m.get('owner_family') or 'n/a'}`")
        if entry.description:
            out.append(f"**Scope:** {entry.description}")
        if m.get("owned_paths"):
            out.append(f"**Owns:** {_short_paths(m['owned_paths'])}")
        reads = _uniq(m.get("required_reads") or [])
        commands = _uniq(m.get("required_commands") or [])
    else:
        out.append(f"**Authority:** {_agent_authority_kind(entry)} | **Sandbox:** {m.get('sandbox_mode') or 'unspecified'}")
        if entry.description:
            out.append(f"**Lane:** {entry.description}")
        refs = _agent_skill_refs(entry)
        if refs:
            out.append(f"**Routes through:** {', '.join(f'`{r}`' for r in refs)}")
        reads, commands = [], []

    if reads:
        out.append(f"**Read first:** {_short_paths(reads)}")
    if commands:
        out.append("**Required checks:**")
        out.append("```bash")
        out.extend(commands[:5])
        out.append("```")
    if rivals:
        out.append(f"**Other candidates:** {', '.join(f'`{r.name}`' for r in rivals[:3])}")
    out.append(f"\n_Load the full briefing with `/codex-bridge {entry.name}` if this is the right lane._")
    return "\n".join(out) + "\n"


# `## Read First` and `## Required Checks` are recomposed (and linkified) below
# the body, so leaving them in the inlined body prints each one twice.
_SKILL_BODY_DROP_SECTIONS = ("Read First", "Required Checks")


def _strip_skill_sections(body: str, headings: Iterable[str]) -> str:
    out = body
    for heading in headings:
        pattern = re.compile(
            rf"^##\s+{re.escape(heading)}\s*\n.*?(?=^##\s|\Z)",
            re.DOTALL | re.MULTILINE | re.IGNORECASE,
        )
        out = pattern.sub("", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


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
    out.append(_strip_skill_sections(body, _SKILL_BODY_DROP_SECTIONS))

    if m.get("required_reads"):
        # Every entry must survive, not just the linkifiable ones: the body's own
        # Read First section was stripped above, so anything dropped here is
        # dropped from the briefing entirely. Markdown becomes a link; source
        # files and config stay as plain paths.
        out.append("\n## Read First\n")
        out.extend(
            f"- [{r}]({r})" if _doc_like(r) else f"- `{r}`"
            for r in m["required_reads"]
        )

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


_AGENT_HANDOFF_SHAPE = [
    "scope covered",
    "files or surfaces inspected",
    "findings or conclusion",
    "assumptions",
    "validations run",
    "unresolved risks",
]


def compose_agent_briefing(agent: Entry, skills_by_id: dict[str, Entry]) -> str:
    """Compose a briefing for a repo-scoped custom agent under .codex/agents/."""
    m = agent.manifest
    authority = _agent_authority_kind(agent)
    authority_line = (
        "Final merge/deploy/plan recommendations within the delegated workflow."
        if authority == "final-authority"
        else "Advisory-only. Does not self-authorize merge, deploy, release, or governance decisions."
    )
    nicks = m.get("nickname_candidates") or []
    skill_refs = _agent_skill_refs(agent)

    out: list[str] = []
    out.append(f"# Routed agent: `{agent.name}`  _(sandbox: {m.get('sandbox_mode') or 'unspecified'})_")
    out.append(f"_Source: {agent.path.relative_to(agent.path.parents[2])}_\n")
    if agent.description:
        out.append(f"**Description:** {agent.description}\n")
    out.append(f"**Authority:** {authority_line}")
    if nicks:
        out.append(f"\n**Nicknames:** {', '.join(str(n) for n in nicks)}")

    instructions = str(m.get("developer_instructions") or "").strip()
    if instructions:
        out.append("\n## Developer instructions\n")
        out.append("```")
        out.append(instructions)
        out.append("```")

    if skill_refs:
        out.append("\n## Skills this agent routes through\n")
        for sid in skill_refs:
            skill = skills_by_id.get(sid)
            if skill and skill.description:
                out.append(f"- `{sid}` - {skill.description[:120]}")
            elif skill:
                out.append(f"- `{sid}`")
            else:
                out.append(f"- `{sid}` *(unresolved)*")

    out.append("\n## Required handoff shape\n")
    out.append("Every delegated child result must include:")
    for i, item in enumerate(_AGENT_HANDOFF_SHAPE, start=1):
        out.append(f"{i}. {item}")

    out.append("\n## Delegation constraints\n")
    out.append("- `agents.max_threads = 6`, `agents.max_depth = 1` (see `.codex/config.toml`)")
    out.append("- sandbox is read-only; edits stay with the parent session or the built-in worker")
    out.append("- not a second skill system; route domain behavior back to the listed skills")

    out.append(
        "\n_This is a delegation lane, not a workflow. Subagent invocation is explicit only: "
        "the parent session or the user decides whether to delegate._"
    )
    return "\n".join(out) + "\n"


def _compose_agent_lanes_footer(
    ranked_agents: list[tuple[int, Entry]],
    *,
    limit: int = 3,
    min_score: int = 4,
) -> str:
    """Compact `## Suggested delegation lanes` section appended to skill/workflow briefings.

    Returns empty string when:
      - no agent clears `min_score`
      - a pack of `limit`+ agents sits within a factor of two of the top score
        (ambiguous delegation: several lanes are genuinely in contention)
    """
    qualified = [(s, e) for s, e in ranked_agents if s >= min_score]
    if not qualified:
        return ""
    # Ambiguity is closeness to the top, not the raw count of qualifiers. A
    # count rule (`len(qualified) >= limit`) used to live here and silenced
    # clear-cut routes: growing the fleet to 13 agents put a third qualifier at
    # score 4 under a leader at 11, and the footer vanished from a briefing
    # whose delegation was not ambiguous at all. The factor-of-two window keeps
    # suppressing the real packs (12/8/8) while letting a clear leader through
    # (11/4/4), and unlike an absolute window it scales with the score range.
    top_score = qualified[0][0]
    close = [e for s, e in qualified if s * 2 >= top_score]
    if len(close) >= limit:
        return ""
    out: list[str] = ["\n## Suggested delegation lanes\n"]
    for _s, e in qualified[:limit]:
        desc = (e.description or "").strip()[:100]
        out.append(f"- `{e.name}` - {desc}")
    return "\n".join(out) + "\n"


def render_catalog(skills: list[Entry], workflows: list[Entry], agents: list[Entry], note: str | None = None) -> str:
    out: list[str] = []
    if note:
        out.append(f"_{note}_\n")
    out.append("# Codex catalog")
    out.append(f"_{len(skills)} skills, {len(workflows)} workflows, {len(agents)} agents._\n")

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
    if agents:
        out.append("\n## Agents (delegation lanes)\n")
        for a in agents:
            authority = _agent_authority_kind(a)
            tag = "final-authority" if authority == "final-authority" else "advisory-only"
            out.append(f"- `{a.name}` *[{tag}]* - {a.description[:140]}")

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


_AGENT_REQUIRED_KEYS = {"name", "description", "developer_instructions", "sandbox_mode"}


def _is_external_read(read: Any) -> bool:
    """A `required_read` that is a URL is an external reference, not a repo path."""
    return str(read).startswith(("http://", "https://"))


def render_check(
    repo_root: Path,
    skills: list[Entry],
    workflows: list[Entry],
    agents: list[Entry],
) -> tuple[str, int]:
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
            if _is_external_read(rp):
                continue
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
            if _is_external_read(rp):
                continue
            if not (repo_root / str(rp)).exists():
                issues.append(f"workflow `{wf.name}`: required_read not found: {rp}")
    owner_ids = {s.name for s in skills if s.manifest.get("role") == "owner"}
    for fam, members in families.items():
        if fam not in ids and fam not in owner_ids:
            issues.append(f"owner_family `{fam}` referenced by {len(members)} skill(s) but has no matching owner skill")

    # Agents: structural-routing lint only. Governance validation lives in
    # .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py.
    for a in agents:
        if "_error" in a.manifest:
            issues.append(f"agent `{a.name}`: {a.manifest['_error']}")
            continue
        missing = _AGENT_REQUIRED_KEYS - set(a.manifest.keys())
        if missing:
            issues.append(f"agent `{a.name}`: missing required field(s): {sorted(missing)}")
        sandbox = a.manifest.get("sandbox_mode")
        if sandbox is not None and sandbox != "read-only":
            issues.append(f"agent `{a.name}`: sandbox_mode is `{sandbox}`, bridge routing assumes read-only")
        if a.path.stem != str(a.manifest.get("name") or ""):
            issues.append(f"agent `{a.name}`: filename stem `{a.path.stem}` does not match `name`")
        if str(a.manifest.get("developer_instructions") or ""):
            if not _AGENT_SKILL_BLOCK_RE.search(str(a.manifest["developer_instructions"])):
                issues.append(f"agent `{a.name}`: developer_instructions missing standardized skill block header")
            for sid in _agent_skill_refs(a):
                if sid not in ids:
                    issues.append(f"agent `{a.name}`: referenced skill `{sid}` does not resolve")

    out = [
        "# Codex tree check\n",
        f"_Scanned {len(skills)} skills + {len(workflows)} workflows + {len(agents)} agents under `{repo_root}/.codex`._\n",
    ]
    if not issues:
        out.append("**Clean.** No structural issues detected.")
        return "\n".join(out) + "\n", 0
    out.append(f"**{len(issues)} issue(s):**\n")
    out.extend(f"- {line}" for line in issues)
    return "\n".join(out) + "\n", 1


def render_coverage(skills: list[Entry], workflows: list[Entry], agents: list[Entry]) -> tuple[str, int]:
    """Report how routable each entry is. Scaling aid for large codex trees."""
    out: list[str] = ["# Codex routing coverage\n"]
    out.append(f"_{len(skills)} skills, {len(workflows)} workflows, {len(agents)} agents._\n")
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

    out.append("\n## Agents\n")
    out.append("| name | authority | desc_tok | skill_refs | nickname_count |")
    out.append("|---|---|---|---|---|")
    for a in agents:
        desc_tok = len(_tokens(a.description))
        skill_refs = len(_agent_skill_refs(a))
        nick_count = len(a.manifest.get("nickname_candidates") or [])
        authority = _agent_authority_kind(a)
        out.append(
            f"| `{a.name}` | {authority} | {desc_tok} | {skill_refs} | {nick_count} |"
        )
        if desc_tok == 0 and skill_refs == 0 and nick_count == 0:
            unroutable.append(f"agent `{a.name}`")

    total = len(skills) + len(workflows) + len(agents)
    out.append("\n## Summary\n")
    out.append(f"- Reachable: {total - len(unroutable)} / {total}")
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

# `reply-rules.md` is a 180-line Discord tone contract. It used to be prepended
# whenever the prompt contained a question mark, which meant most engineering
# questions paid ~3.3k tokens for community-reply style guidance they never
# used. It now loads only for the lane that owns it, or when the prompt names
# the channel outright.
RESPONSE_RULES_ROUTES = {"comms-community", "community-response"}
# Deliberately narrow. An earlier version matched bare `community` and
# `respond to`, which fired on "should I respond to this review comment on the
# PR?" and "why is the community edition build failing?" -- both engineering
# turns paying 3.3k tokens for Discord tone rules. Only an explicit channel word
# counts as intent; everything else must come from the routed lane.
COMMUNITY_INTENT = re.compile(
    r"\bdiscord\b|\bcontributors?\s+question\b|\bdraft\s+(?:a\s+)?(?:reply|response)\b",
    re.IGNORECASE,
)


def _reply_rules(repo_root: Path) -> str | None:
    path = repo_root / ".codex" / "skills" / "comms-community" / "references" / "reply-rules.md"
    if not path.exists():
        return None
    return path.read_text().strip()


def _wants_reply_rules(query: str, route_id: str | None) -> bool:
    """The routed lane decides; naming the channel is the only escape hatch.

    A question mark is neither necessary nor sufficient: "draft the discord
    announcement" needs the rules and has none, while a PR question has one and
    does not.
    """
    if route_id in RESPONSE_RULES_ROUTES:
        return True
    return bool(COMMUNITY_INTENT.search(query))


def _prepend_response_rules(
    briefing: str,
    repo_root: Path,
    query: str,
    route_id: str | None = None,
) -> str:
    """Prepend codex's Discord reply rules, but only for community-reply work."""
    if not _wants_reply_rules(query, route_id):
        return briefing
    rules = _reply_rules(repo_root)
    if not rules:
        return briefing
    header = [
        "# Response format (codex Q&A rules)\n",
        "_Detected a community-reply task. The routed briefing follows; respond using the rules below, not in a long expository form._\n",
        rules,
        "\n---\n",
    ]
    return "\n".join(header) + briefing


HOOK_MIN_PROMPT_LEN = 12
# Two gates per kind: the lower one is "say something", the upper one is "this
# is confident enough to be worth the full playbook". Between them the hook
# emits the compact pointer instead of nothing (useful) or everything (costly).
HOOK_WORKFLOW_SCORE = 8
HOOK_WORKFLOW_FULL = 20
HOOK_SKILL_SCORE = 10
HOOK_SKILL_FULL = 22
HOOK_AGENT_SCORE = 14  # Strict: agents are execution layer, not a second skill system.
HOOK_AGENT_FULL = 22
# Two entries within this many points of each other is a coin flip, not a match.
HOOK_AMBIGUITY_MARGIN = 2


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


def _hook_wrap_compact(briefing: str, match_id: str, kind: str) -> str:
    return (
        f"_codex-bridge: possible match for **{kind} `{match_id}`**. "
        "Use it if it fits; ignore it if it does not._\n\n"
    ) + briefing


def _hook_wrap(briefing: str, match_id: str, kind: str) -> str:
    if kind == "agent":
        second_sentence = (
            "Treat the briefing below as a suggested delegation lane, not a "
            "workflow to execute. Subagent invocation is explicit only: the "
            "parent session or the user decides whether to delegate. If the "
            "match looks wrong, ignore this block and proceed with the user's "
            "request as stated."
        )
    else:
        second_sentence = (
            "Treat the briefing below as authoritative for this turn: follow "
            "its Read-First list, workflow steps, and required checks, and "
            "hand off if the task leaves scope. If the match looks wrong, "
            "ignore this block and proceed with the user's request as stated."
        )
    header = (
        "# Auto-routed by codex-bridge\n\n"
        f"_Your prompt matched **{kind} `{match_id}`** in the codex tree. "
        f"{second_sentence}_\n\n---\n\n"
    )
    return header + briefing


def _rivals_within(ranked: list[tuple[int, Entry]], winner: Entry, margin: int) -> list[Entry]:
    if not ranked:
        return []
    top = ranked[0][0]
    return [e for s, e in ranked if e is not winner and s >= top - margin]


def _emit(
    entry: Entry,
    kind: str,
    *,
    score: int,
    full_gate: int,
    rivals: list[Entry],
    repo_root: Path,
    query: str,
    skills_by_id: dict[str, Entry],
    workflows: list[Entry],
    footer: str,
) -> tuple[str, int]:
    """Full briefing on a confident, unambiguous match; compact pointer otherwise."""
    if score >= full_gate and not rivals:
        if kind == "workflow":
            briefing = compose_workflow_briefing(entry, skills_by_id) + footer
        elif kind == "skill":
            briefing = compose_skill_briefing(entry, workflows, skills_by_id) + footer
        else:
            briefing = compose_agent_briefing(entry, skills_by_id)
        wrapped = _hook_wrap(briefing, entry.name, kind)
    else:
        wrapped = _hook_wrap_compact(
            compose_compact_briefing(entry, kind, skills_by_id, rivals), entry.name, kind
        )
    return _prepend_response_rules(wrapped, repo_root, query, entry.name), 0


def _route_hook(
    repo_root: Path,
    skills: list[Entry],
    workflows: list[Entry],
    agents: list[Entry],
    query: str,
) -> tuple[str, int]:
    """Silent-fallback mode for the UserPromptSubmit hook.

    Three outcomes, by confidence: silent below the lower gate, a compact
    pointer between the gates (or whenever a rival is within the ambiguity
    margin), and the full composed briefing only when the match is both strong
    and unambiguous. Agents never outrank a matching skill or workflow; they
    surface either on exact-name match, as a suggested delegation lanes footer
    (non-Q&A only), or as a strict agent-primary fallback when no skill or
    workflow clears its gate.
    """
    if os.environ.get("CODEX_BRIDGE_DISABLE") == "1":
        return ("", 0)
    if not query:
        return ("", 0)

    skills_by_id = {s.name: s for s in skills}
    is_qa = bool(QA_MARKERS.search(query))

    # Named matches bypass the length floor and the confidence tiers: the user
    # deliberately typed the name, so "governor" should route in full.
    named = named_match(query, [(workflows, "workflow"), (skills, "skill"), (agents, "agent")])
    if named:
        direct, kind = named
        if kind == "workflow":
            briefing = compose_workflow_briefing(direct, skills_by_id)
        elif kind == "skill":
            briefing = compose_skill_briefing(direct, workflows, skills_by_id)
        else:
            briefing = compose_agent_briefing(direct, skills_by_id)
        return _prepend_response_rules(
            _hook_wrap(briefing, direct.name, kind), repo_root, query, direct.name
        ), 0

    # Length floor only applies to the free-text scoring path so conversational
    # prompts and single-word chitchat stay silent.
    if len(query) < HOOK_MIN_PROMPT_LEN:
        return ("", 0)
    if not _tokens(query):
        return ("", 0)

    ranked_skills, ranked_workflows, ranked_agents = Ranker(skills, workflows, agents).rank(
        query, repo_root
    )
    best_skill_score, best_skill = (ranked_skills[0] if ranked_skills else (0, None))
    best_wf_score, best_wf = (ranked_workflows[0] if ranked_workflows else (0, None))
    best_agent_score, best_agent = (ranked_agents[0] if ranked_agents else (0, None))

    agent_footer = "" if is_qa else _compose_agent_lanes_footer(ranked_agents)
    emit = lambda entry, kind, score, gate, ranked: _emit(  # noqa: E731
        entry,
        kind,
        score=score,
        full_gate=gate,
        rivals=_rivals_within(ranked, entry, HOOK_AMBIGUITY_MARGIN),
        repo_root=repo_root,
        query=query,
        skills_by_id=skills_by_id,
        workflows=workflows,
        footer=agent_footer,
    )

    # A workflow and a skill can share an id (`pr-governance-review`). The
    # workflow is the actionable unit — it composes owner + spoke — so it wins
    # the tie even when the skill's prose scores a little higher.
    same_lane = best_wf is not None and best_skill is not None and best_wf.name == best_skill.name
    if best_wf is not None and best_wf_score >= HOOK_WORKFLOW_SCORE and (
        best_wf_score >= best_skill_score or same_lane
    ):
        # Score the workflow on its own corpus. Skill and workflow scores come
        # from different field weights and a different IDF denominator, so
        # substituting one for the other would not be a comparison.
        return emit(best_wf, "workflow", best_wf_score, HOOK_WORKFLOW_FULL, ranked_workflows)

    if best_skill is not None and best_skill_score >= HOOK_SKILL_SCORE:
        return emit(best_skill, "skill", best_skill_score, HOOK_SKILL_FULL, ranked_skills)

    if best_agent is not None and best_agent_score >= HOOK_AGENT_SCORE:
        return emit(best_agent, "agent", best_agent_score, HOOK_AGENT_FULL, ranked_agents)

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
    skills, workflows, agents = discover(repo_root)
    if not skills and not workflows and not agents:
        if args.hook:
            return ("", 0)
        return (f"_No `.codex/skills/`, `.codex/workflows/`, or `.codex/agents/` entries under {repo_root}._\n", 1)

    if args.hook:
        query = _read_hook_stdin()
        return _route_hook(repo_root, skills, workflows, agents, query)

    if args.check:
        return render_check(repo_root, skills, workflows, agents)
    if args.coverage:
        return render_coverage(skills, workflows, agents)

    query = " ".join(args.query).strip()
    if args.list or not query:
        return render_catalog(skills, workflows, agents), 0

    skills_by_id = {s.name: s for s in skills}

    # Same resolution as the hook. The compact briefing's footer tells the user
    # to run `/codex-bridge <name>`, so a name must not land on a different lane
    # depending on which entry point resolved it.
    named = named_match(query, [(workflows, "workflow"), (skills, "skill"), (agents, "agent")])
    if named:
        direct, kind = named
        if kind == "workflow":
            briefing = compose_workflow_briefing(direct, skills_by_id)
        elif kind == "skill":
            briefing = compose_skill_briefing(direct, workflows, skills_by_id)
        else:
            briefing = compose_agent_briefing(direct, skills_by_id)
        return _prepend_response_rules(briefing, repo_root, query, direct.name), 0

    ranked_skills, ranked_workflows, ranked_agents = Ranker(skills, workflows, agents).rank(
        query, repo_root
    )
    top_s = [(s, e) for s, e in ranked_skills if s > 0]
    top_w = [(s, e) for s, e in ranked_workflows if s > 0]
    top_a = [(s, e) for s, e in ranked_agents if s > 0]

    if not top_s and not top_w and not top_a:
        return render_catalog(skills, workflows, agents, note=f"No token match for '{query}'. Pick one manually."), 0

    best_skill = top_s[0] if top_s else (0, None)
    best_workflow = top_w[0] if top_w else (0, None)
    best_agent = top_a[0] if top_a else (0, None)

    # Explicit invocation always gets the agent footer (the user opted in).
    agent_footer = _compose_agent_lanes_footer(ranked_agents)

    if best_workflow[0] >= best_skill[0] and best_workflow[1] is not None and best_workflow[0] >= 5:
        briefing = compose_workflow_briefing(best_workflow[1], skills_by_id) + agent_footer
        return _prepend_response_rules(briefing, repo_root, query, best_workflow[1].name), 0
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
            briefing = "\n".join(header) + compose_skill_briefing(best_skill[1], workflows, skills_by_id) + agent_footer
            return _prepend_response_rules(briefing, repo_root, query, best_skill[1].name), 0
        briefing = compose_skill_briefing(best_skill[1], workflows, skills_by_id) + agent_footer
        return _prepend_response_rules(briefing, repo_root, query, best_skill[1].name), 0

    # Agent-primary fallback: only reached if no skill or workflow scored.
    if best_agent[1] is not None and best_agent[0] >= HOOK_AGENT_SCORE:
        close = [e for s_, e in top_a if s_ >= best_agent[0] - 2 and e is not best_agent[1]]
        if not close:
            briefing = compose_agent_briefing(best_agent[1], skills_by_id)
            return _prepend_response_rules(briefing, repo_root, query, best_agent[1].name), 0

    return render_catalog(skills, workflows, agents, note=f"Weak match for '{query}'. Pick manually."), 0


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    text, code = route(argv)
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
