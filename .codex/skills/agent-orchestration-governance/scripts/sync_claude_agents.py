#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh Research

"""Mirror `agents/*.toml` into runnable Claude Code subagents.

The codex agent fleet is the single source of truth for lane definitions:
authority, sandbox posture, the skills each lane routes through, and the
truth-first handoff shape. Those TOML files are advisory text that the Codex
harness reads; Claude Code needs a `.claude/agents/<name>.md` file with
frontmatter before the same lane can actually be delegated to.

Rather than hand-maintaining two fleets that drift apart, this script derives
the Claude side from the Codex side.

    python3 .codex/skills/agent-orchestration-governance/scripts/sync_claude_agents.py --write
    python3 .codex/skills/agent-orchestration-governance/scripts/sync_claude_agents.py --check

`--check` exits non-zero when a mirror is missing, stale, or orphaned, so the
two fleets cannot silently diverge.
"""

from __future__ import annotations

import argparse
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
CODEX_AGENTS = REPO_ROOT / "agents"
CLAUDE_AGENTS = REPO_ROOT / ".claude" / "agents"

GENERATED_MARKER = "<!-- generated from agents/"

# Read-only lanes get inspection and verification tools, never mutation tools.
# Bash is present because the handoff shape requires `validations_run`, which
# means actually executing the skill's Required Checks.
READ_ONLY_TOOLS = "Read, Grep, Glob, Bash, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch"
WRITE_TOOLS = READ_ONLY_TOOLS + ", Edit, Write"

GOVERNOR_AUTHORITY_MARKER = "only you may produce final merge"


def _load(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _authority(manifest: dict) -> str:
    instructions = str(manifest.get("developer_instructions") or "")
    if GOVERNOR_AUTHORITY_MARKER in instructions:
        return "final-authority"
    return "advisory-only"


def _description(manifest: dict) -> str:
    base = str(manifest.get("description") or "").strip().rstrip(".")
    authority = _authority(manifest)
    if authority == "final-authority":
        tail = "Read-only lane that synthesizes child evidence and owns final plan-level recommendations for the delegated workflow"
    else:
        tail = "Read-only lane that returns evidence and never self-authorizes merge, deploy, release, or governance decisions"
    return f"{base}. {tail}."


def render(path: Path) -> str:
    manifest = _load(path)
    name = str(manifest.get("name") or path.stem)
    sandbox = str(manifest.get("sandbox_mode") or "read-only")
    tools = READ_ONLY_TOOLS if sandbox == "read-only" else WRITE_TOOLS
    instructions = str(manifest.get("developer_instructions") or "").strip()
    nicknames = ", ".join(str(n) for n in (manifest.get("nickname_candidates") or []))

    # No `model:` key on purpose. The delegation contract is inheritance-first:
    # a lane runs at the session's model unless there is a documented reason to
    # pin one, and none of the codex definitions state such a reason.
    lines = [
        "---",
        f"name: {name}",
        f"description: {_description(manifest)}",
        f"tools: {tools}",
        "---",
        "",
        f"{GENERATED_MARKER}{path.name} -- edit the TOML, then re-run sync_claude_agents.py --write -->",
        "",
        instructions,
        "",
        "## Operating context in this harness",
        "",
        f"- Mirror of `agents/{path.name}`, which stays the source of truth for this lane.",
        f"- Sandbox posture: `{sandbox}`. Inspect the repo and run verification commands; do not edit tracked",
        "  files. Hand proposed edits back to the parent session as a diff or a precise instruction.",
        "- The skills listed above are codex skills, not Claude skills. Load one with",
        "  `python3 .claude/skills/codex-bridge/scripts/route.py <skill-id>` and follow its Read First and",
        "  Required Checks.",
        "- Fan-out limits come from `.codex/config.toml`: `max_threads = 6`, `max_depth = 1`. You are a leaf",
        "  lane; do not spawn further subagents.",
        "- Your final message is the handoff. It must carry every field named in the truth-first protocol",
        "  above, and it must cite the files or commands that produced each conclusion.",
    ]
    if nicknames:
        lines.append(f"- Nicknames this lane answers to: {nicknames}.")
    return "\n".join(lines) + "\n"


def sync(write: bool) -> int:
    if not CODEX_AGENTS.is_dir():
        print(f"error: {CODEX_AGENTS} does not exist", file=sys.stderr)
        return 1

    sources = sorted(CODEX_AGENTS.glob("*.toml"))
    expected = {p.stem: render(p) for p in sources}
    problems: list[str] = []

    if write:
        CLAUDE_AGENTS.mkdir(parents=True, exist_ok=True)

    for stem, body in expected.items():
        target = CLAUDE_AGENTS / f"{stem}.md"
        current = target.read_text(encoding="utf-8") if target.exists() else None
        if current == body:
            continue
        if write:
            target.write_text(body, encoding="utf-8")
            print(f"{'updated' if current is not None else 'created'} {target.relative_to(REPO_ROOT)}")
        else:
            problems.append(
                f"{target.relative_to(REPO_ROOT)}: "
                + ("missing" if current is None else "out of sync with the codex definition")
            )

    if CLAUDE_AGENTS.is_dir():
        for stray in sorted(CLAUDE_AGENTS.glob("*.md")):
            if stray.stem in expected:
                continue
            problems.append(
                f"{stray.relative_to(REPO_ROOT)}: agent has no authored `agents/{stray.stem}.toml`; "
                "the TOML fleet is the only authored source"
            )

    if problems:
        print(f"Claude agent mirror check failed ({len(problems)} issue(s)):", file=sys.stderr)
        for line in problems:
            print(f"- {line}", file=sys.stderr)
        print("\nRun: python3 .codex/skills/agent-orchestration-governance/scripts/sync_claude_agents.py --write", file=sys.stderr)
        return 1

    print(f"Claude agent mirror in sync: {len(expected)} lane(s) from agents/")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--write", action="store_true", help="Write the mirrored agent files.")
    group.add_argument("--check", action="store_true", help="Fail when the mirror is stale (default).")
    args = parser.parse_args()
    return sync(write=args.write)


if __name__ == "__main__":
    raise SystemExit(main())
