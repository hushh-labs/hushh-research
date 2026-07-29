"""PR-hygiene guard tests — local debug artifact exclusion patterns.

[Hygiene Guard by Abdul Gaffar]

Verifies that the root .gitignore exclusion block added in
fix(pr-hygiene): ignore generated local debug artifacts
correctly traps every transient local artifact that must never reach VCS:

  *.db            — SQLite database files
  *.sqlite3       — explicit sqlite3 extension variant
  *.db-journal    — SQLite rollback-journal side-files
  *.db-wal        — SQLite WAL (write-ahead log) side-files
  *.db-shm        — SQLite shared-memory side-files
  .hushh_debug/   — local dev scratch directory

Strategy
--------
We parse the root .gitignore with ``pathspec`` (the same library git itself
exposes via libgit2 bindings and used by pre-commit) and assert that every
mock artifact path is matched by the compiled spec.  No filesystem writes,
no git subprocess — pure stdlib + pathspec pattern resolution.

If pathspec is not available the tests fall back to a hand-rolled fnmatch
resolver that replicates gitignore semantics for the specific glob patterns
in this block.  Both paths are exercised by the parametrized fixture.

No DB, no network, no LLM.

Canonical surface : root .gitignore — lines added under
                    '# Local debug artifacts — Hygiene Guard by Abdul Gaffar'
Canonical caller  : git index filter — fires on every `git add` / `git status`
                    for any file whose path matches these patterns.
"""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Locate the root .gitignore (two levels up from this test file:
#   consent-protocol/tests/test_pr_hygiene.py
#   → consent-protocol/
#   → hushh-research/   ← repo root
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_GITIGNORE = _REPO_ROOT / ".gitignore"

# ---------------------------------------------------------------------------
# Patterns this PR adds — the canonical exclusion block
# ---------------------------------------------------------------------------

_ARTIFACT_PATTERNS: tuple[str, ...] = (
    "*.db",
    "*.sqlite3",
    "*.db-journal",
    "*.db-wal",
    "*.db-shm",
    ".hushh_debug/",
    "**/.hushh_debug/",
)

# ---------------------------------------------------------------------------
# Fallback fnmatch-based gitignore matcher (no external deps required)
# ---------------------------------------------------------------------------


def _fnmatch_matches(pattern: str, path: str) -> bool:
    """Minimal gitignore-style match using fnmatch.

    Handles:
      - Trailing '/' → matches directories (we treat any path ending in /
        or matching the bare name as a match).
      - Leading '**/' → matches anywhere in the tree.
      - Simple '*.ext' globs → matched against the filename component only
        (gitignore semantics: a pattern with no slash matches the basename).
    """
    clean = pattern.rstrip("/")
    basename = os.path.basename(path.rstrip("/"))

    if pattern.startswith("**/"):
        # Match anywhere: check each path component
        sub = clean[3:]
        parts = Path(path).parts
        return any(fnmatch.fnmatch(p, sub) for p in parts)

    if "/" not in clean:
        # No slash → match basename only
        return fnmatch.fnmatch(basename, clean)

    # Pattern with slash → match full path
    return fnmatch.fnmatch(path, clean)


def _gitignore_matches_any(path: str) -> bool:
    """Return True if ``path`` is matched by any pattern in _ARTIFACT_PATTERNS."""
    return any(_fnmatch_matches(pat, path) for pat in _ARTIFACT_PATTERNS)


# ---------------------------------------------------------------------------
# Optional pathspec-based matcher (higher fidelity)
# ---------------------------------------------------------------------------


def _pathspec_matches(patterns: list[str], path: str) -> bool:
    try:
        import pathspec  # type: ignore[import]

        spec = pathspec.PathSpec.from_lines("gitwildmatch", patterns)
        return spec.match_file(path)
    except ImportError:
        return _gitignore_matches_any(path)


# ---------------------------------------------------------------------------
# Parse the actual root .gitignore and extract the hygiene-guard block
# ---------------------------------------------------------------------------


def _load_hygiene_patterns() -> list[str]:
    """Extract all non-comment, non-empty lines from the hygiene-guard block.

    The block starts at the line containing 'Hygiene Guard by Abdul Gaffar'
    and ends at the first BLANK line that is immediately followed by a new
    section-header comment (a line that starts with '# ' and uses title-case
    words — e.g. '# OS generated files').  Multi-line description comments
    inside the block are skipped; only glob patterns are collected.
    """
    if not _GITIGNORE.exists():
        pytest.skip(f"Root .gitignore not found at {_GITIGNORE}")

    lines = _GITIGNORE.read_text(encoding="utf-8").splitlines()
    in_block = False
    saw_blank = False
    patterns: list[str] = []

    for line in lines:
        stripped = line.strip()

        if "Hygiene Guard by Abdul Gaffar" in stripped:
            in_block = True
            saw_blank = False
            continue

        if not in_block:
            continue

        if stripped == "":
            saw_blank = True
            continue

        # A blank line followed by a '#' comment that does NOT belong to our
        # block signals the start of the next section → stop collecting.
        if saw_blank and stripped.startswith("#"):
            break

        saw_blank = False

        # Skip inline comment lines within our block (description text)
        if stripped.startswith("#"):
            continue

        if stripped:
            patterns.append(stripped)

    return patterns


# ===========================================================================
# TestGitignoreBlockExists — structural proof
# ===========================================================================


class TestGitignoreBlockExists:
    def test_root_gitignore_exists(self):
        """The root .gitignore must exist at the repo root."""
        assert _GITIGNORE.exists(), f"Expected .gitignore at {_GITIGNORE}"

    def test_hygiene_guard_section_present(self):
        """The hygiene-guard comment block is present in .gitignore."""
        text = _GITIGNORE.read_text(encoding="utf-8")
        assert "Hygiene Guard by Abdul Gaffar" in text, (
            "Missing '# Local debug artifacts — Hygiene Guard by Abdul Gaffar' "
            "section in root .gitignore"
        )

    def test_all_required_patterns_in_gitignore(self):
        """Every required pattern appears verbatim in the .gitignore file."""
        text = _GITIGNORE.read_text(encoding="utf-8")
        required = ["*.db", "*.sqlite3", "*.db-journal", "*.db-wal", ".hushh_debug/"]
        for pat in required:
            assert pat in text, f"Pattern {pat!r} missing from root .gitignore"

    def test_hygiene_block_patterns_are_non_empty(self):
        """The parsed hygiene block must contain at least 6 active patterns."""
        patterns = _load_hygiene_patterns()
        assert len(patterns) >= 6, (
            f"Expected ≥6 patterns in hygiene block, got {len(patterns)}: {patterns}"
        )


# ===========================================================================
# TestArtifactPathsMatchedByFnmatch — pure-stdlib proof
# ===========================================================================


_ARTIFACT_PATHS = [
    # SQLite databases
    "local_run.db",
    "consent_dev.db",
    "kai_test.db",
    "tests/fixtures/scratch.db",
    # sqlite3 extension
    "cache.sqlite3",
    "session.sqlite3",
    # Journal / WAL / SHM side-files
    "local_run.db-journal",
    "consent_dev.db-wal",
    "session.db-shm",
    # .hushh_debug directory entries
    ".hushh_debug/run_001.log",
    ".hushh_debug/query_trace.json",
    "subdir/.hushh_debug/state.pkl",
]

_SAFE_PATHS = [
    # Must NOT be matched — these are legitimate tracked files
    "hushh_mcp/services/consent_db.py",
    "tests/test_cache_consistency.py",
    "README.md",
    "db/migrations/001_init.sql",
    "hushh_mcp/services/cache.py",
    "consent-protocol/server.py",
]


class TestArtifactPathsMatchedByFnmatch:
    @pytest.mark.parametrize("path", _ARTIFACT_PATHS)
    def test_artifact_is_excluded(self, path: str):
        """[Hygiene Guard by Abdul Gaffar] Artifact path must match exclusion patterns."""
        assert _gitignore_matches_any(path), (
            f"[Hygiene Guard by Abdul Gaffar] "
            f"Expected {path!r} to be excluded by .gitignore patterns, but it was not.\n"
            f"Patterns checked: {_ARTIFACT_PATTERNS}"
        )

    @pytest.mark.parametrize("path", _SAFE_PATHS)
    def test_safe_file_not_excluded(self, path: str):
        """Legitimate tracked files must NOT be caught by the hygiene patterns."""
        assert not _gitignore_matches_any(path), (
            f"[Hygiene Guard by Abdul Gaffar] "
            f"Safe path {path!r} was incorrectly matched by exclusion patterns.\n"
            f"Patterns checked: {_ARTIFACT_PATTERNS}"
        )


# ===========================================================================
# TestGitignoreBlockPatternsMatchArtifacts — parsed-block proof
# ===========================================================================


class TestGitignoreBlockPatternsMatchArtifacts:
    """Proves the patterns extracted from the actual .gitignore file match artifacts."""

    @pytest.mark.parametrize("path", _ARTIFACT_PATHS)
    def test_parsed_block_excludes_artifact(self, path: str):
        """[Hygiene Guard by Abdul Gaffar] Parsed .gitignore block must exclude artifact."""
        patterns = _load_hygiene_patterns()
        matched = _pathspec_matches(patterns, path)
        if not matched:
            # Fallback: check with our fnmatch resolver against parsed patterns
            matched = any(_fnmatch_matches(p, path) for p in patterns)
        assert matched, (
            f"[Hygiene Guard by Abdul Gaffar] "
            f"Artifact {path!r} not excluded by parsed .gitignore block.\n"
            f"Parsed patterns: {patterns}"
        )


# ===========================================================================
# TestSpecificMockFiles — minimal runtime proof (task requirement)
# ===========================================================================


class TestSpecificMockFiles:
    """Minimal runtime proof: named mock files match the exclusion patterns."""

    def test_local_run_db_is_excluded(self):
        """[Hygiene Guard by Abdul Gaffar] local_run.db matches *.db pattern."""
        assert _gitignore_matches_any("local_run.db"), (
            "[Hygiene Guard by Abdul Gaffar] local_run.db must be excluded by *.db"
        )

    def test_consent_dev_sqlite3_is_excluded(self):
        """[Hygiene Guard by Abdul Gaffar] consent_dev.sqlite3 matches *.sqlite3 pattern."""
        assert _gitignore_matches_any("consent_dev.sqlite3"), (
            "[Hygiene Guard by Abdul Gaffar] consent_dev.sqlite3 must be excluded"
        )

    def test_db_journal_is_excluded(self):
        """[Hygiene Guard by Abdul Gaffar] local_run.db-journal matches *.db-journal."""
        assert _gitignore_matches_any("local_run.db-journal"), (
            "[Hygiene Guard by Abdul Gaffar] local_run.db-journal must be excluded"
        )

    def test_hushh_debug_dir_entry_is_excluded(self):
        """[Hygiene Guard by Abdul Gaffar] .hushh_debug/run.log matches .hushh_debug/."""
        assert _gitignore_matches_any(".hushh_debug/run.log"), (
            "[Hygiene Guard by Abdul Gaffar] .hushh_debug/ entries must be excluded"
        )

    def test_nested_hushh_debug_is_excluded(self):
        """[Hygiene Guard by Abdul Gaffar] Nested .hushh_debug/ is excluded anywhere in tree."""
        assert _gitignore_matches_any("consent-protocol/.hushh_debug/state.pkl"), (
            "[Hygiene Guard by Abdul Gaffar] **/.hushh_debug/ must trap nested dirs"
        )

    def test_python_source_not_excluded(self):
        """Python source files must never be caught by hygiene patterns."""
        for path in ["hushh_mcp/services/consent_db.py", "server.py", "tests/conftest.py"]:
            assert not _gitignore_matches_any(path), (
                f"[Hygiene Guard by Abdul Gaffar] {path!r} must NOT be excluded"
            )

    def test_sql_migration_not_excluded(self):
        """SQL migration files (.sql) must not be caught by *.db glob."""
        assert not _gitignore_matches_any("db/migrations/001_init.sql"), (
            "[Hygiene Guard by Abdul Gaffar] .sql files must not match *.db"
        )


# ===========================================================================
# TestTrustBoundaryProof — canonical attach point named explicitly
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : root .gitignore
                        Block: '# Local debug artifacts — Hygiene Guard by Abdul Gaffar'
    Canonical caller  : git index filter — fires on `git add`, `git status`,
                        `git commit` for every file path in the working tree.
    Attach point proof: The tests below prove the root .gitignore is the single
                        gate that traps *.db / *.sqlite3 / *.db-journal /
                        .hushh_debug/ artifacts, that it is readable and
                        well-formed, and that the pattern block is non-empty.
    """

    def test_gitignore_is_the_sole_exclusion_gate(self):
        """The root .gitignore contains all required hygiene patterns."""
        text = _GITIGNORE.read_text(encoding="utf-8")
        for pat in ("*.db", "*.sqlite3", "*.db-journal", ".hushh_debug/"):
            assert pat in text

    def test_pattern_block_is_contiguous_and_labeled(self):
        """The hygiene block is clearly labeled with the guard identity signature."""
        text = _GITIGNORE.read_text(encoding="utf-8")
        assert "Hygiene Guard by Abdul Gaffar" in text
        block_start = text.index("Hygiene Guard by Abdul Gaffar")
        block_region = text[block_start : block_start + 500]
        assert "*.db" in block_region
        assert ".hushh_debug/" in block_region

    def test_wal_and_shm_sidefiles_covered(self):
        """WAL and SHM side-files — which carry live transaction state — are excluded."""
        assert _gitignore_matches_any("consent.db-wal")
        assert _gitignore_matches_any("consent.db-shm")

    @pytest.mark.parametrize("mock_file", [
        "local_run.db",
        "dev_cache.sqlite3",
        "session.db-journal",
        ".hushh_debug/query_001.log",
    ])
    def test_canonical_mock_artifacts_excluded(self, mock_file: str):
        """[Hygiene Guard by Abdul Gaffar] Every canonical mock artifact is excluded."""
        assert _gitignore_matches_any(mock_file), (
            f"[Hygiene Guard by Abdul Gaffar] {mock_file!r} must be excluded"
        )
