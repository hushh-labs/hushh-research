"""Confinement boundary shared by canonical framework and skill audits."""

import json
from pathlib import Path, PurePosixPath
import subprocess


def validate_source_confinement(root: Path, errors: list[str]) -> None:
    """A canonical source must stay inside the one repository development tree."""
    source_root = root.resolve() / ".agents"
    if source_root.is_symlink():
        errors.append(".agents: canonical root must not be a symlink")
        return
    for name in ("instructions.md", "README.md", "config.toml", "skills", "subagents",
                 "workflows", "routing", "evals", "imports"):
        source = source_root / name
        paths = [source]
        if source.is_dir() and not source.is_symlink():
            paths.extend(source.rglob("*"))
        for path in paths:
            if not path.exists() and not path.is_symlink():
                continue  # Required-source checks report absence separately.
            try:
                path.resolve(strict=True).relative_to(source_root)
            except (ValueError, OSError, RuntimeError):
                errors.append(f"{path.relative_to(root.resolve())}: canonical source escapes .agents or is missing")


FORBIDDEN_DEVELOPMENT_ROOTS = (".claude", ".codex", ".qwen", ".gemini", ".cursor", ".windsurf")
FORBIDDEN_ENTRYPOINTS = ("CLAUDE.md", "CODEX.md", "QWEN.md", "GEMINI.md")


def nested_vendor_sources(paths: list[str]) -> list[str]:
    """Find tracked vendor instructions without traversing worktrees or dependencies."""
    return sorted(
        path for path in paths
        if len(PurePosixPath(path).parts) > 1
        and (PurePosixPath(path).name in FORBIDDEN_ENTRYPOINTS
             or any(part in FORBIDDEN_DEVELOPMENT_ROOTS for part in PurePosixPath(path).parts))
    )


def validate_platform_agent_sources(root: Path, errors: list[str]) -> None:
    for name in FORBIDDEN_DEVELOPMENT_ROOTS:
        path = root / name
        if path.exists() or path.is_symlink():
            errors.append(f"{name}: vendor discovery is retired; read AGENTS.md and .agents directly")
    for name in FORBIDDEN_ENTRYPOINTS:
        if (root / name).exists() or (root / name).is_symlink():
            errors.append(f"{name}: duplicate operating entrypoint; use root AGENTS.md")
    if not (root / ".git").exists():
        return
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"], check=True,
            capture_output=True, timeout=30,
        )
        paths = [path.decode("utf-8") for path in result.stdout.split(b"\0") if path]
    except (OSError, subprocess.SubprocessError, UnicodeError):
        errors.append("Cannot verify tracked development instruction sources")
        return
    for path in nested_vendor_sources(paths):
        errors.append(f"{path}: vendor instruction source; use AGENTS.md and .agents")


def validate_canonical_framework(root: Path, errors: list[str]) -> None:
    validate_source_confinement(root, errors)
    if errors:
        return
    for name in ("AGENTS.md", ".agents/instructions.md", ".agents/README.md", ".agents/config.toml"):
        if not (root / name).is_file():
            errors.append(f"{name}: canonical framework source is missing")
    for name in (".agents/generated/subagents", ".agents/startup.json", ".agents/scripts/startup.py",
                 ".agents/routing/SKILL.md",
                 ".agents/skills/agent-orchestration-governance/scripts/sync_claude_agents.py",
                 ".agents/skills/agent-orchestration-governance/scripts/sync_host_adapters.py"):
        if (root / name).exists() or (root / name).is_symlink():
            errors.append(f"{name}: retired host projection or startup adapter")
    inventory_path = root / ".agents/skills/agent-orchestration-governance/references/platform-source-inventory.json"
    if inventory_path.is_file():
        inventory = json.loads(inventory_path.read_text())
        if inventory.get("host_adapters") or inventory.get("compatibility_commands"):
            errors.append("Per-host adapters are retired; use the canonical routing CLI")
