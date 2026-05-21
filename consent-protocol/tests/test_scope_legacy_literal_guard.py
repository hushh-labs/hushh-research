from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCAN_PREFIXES = (
    ".codex/",
    "consent-protocol/api/",
    "consent-protocol/mcp_modules/",
    "docs/",
    "hushh-webapp/",
    "packages/",
)
FORBIDDEN_SCOPE_LITERALS = (
    "world_model" + ".read",
    "world_model" + ".write",
    "vault" + ".read.all",
    "vault" + ".read.",
    "vault" + ".write.",
)
TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}


def _iter_text_files():
    result = subprocess.run(  # noqa: S603 - fixed git command with static arguments.
        ["git", "ls-files", *SCAN_PREFIXES],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    for rel_path in result.stdout.splitlines():
        path = REPO_ROOT / rel_path
        if path.suffix not in TEXT_SUFFIXES:
            continue
        if "/tests/" in rel_path:
            continue
        yield path


def test_active_surfaces_do_not_reintroduce_legacy_scope_literals() -> None:
    findings: list[str] = []

    for path in _iter_text_files():
        text = path.read_text(encoding="utf-8", errors="ignore")
        for literal in FORBIDDEN_SCOPE_LITERALS:
            if literal in text:
                findings.append(f"{path.relative_to(REPO_ROOT)}: {literal}")

    assert not findings, "Legacy scope literals found:\n" + "\n".join(findings)
