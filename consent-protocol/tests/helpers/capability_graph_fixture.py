# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Hermetic Git and graph fixtures for capability-history regression tests."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from scripts import generate_capability_graph as generator

GRAPH_RELATIVE = Path("contracts") / "kai" / "one-capability-graph.v1.json"
MIRRORS = (
    GRAPH_RELATIVE,
    Path("hushh-webapp") / GRAPH_RELATIVE,
    Path("consent-protocol") / GRAPH_RELATIVE,
)
LEDGER_RELATIVE = (
    Path("consent-protocol") / "hushh_mcp" / "agents" / "capability_graph_evolution.v1.json"
)
V1_REVISION = "rev-v1-0000000"
V2_REVISION = "rev-v2-0000000"


def _empty_diff(from_revision: str | None) -> dict[str, Any]:
    return {
        "from_revision": from_revision,
        "added": [],
        "removed": [],
        "changed": [],
        "migrated": [],
        "compatible": [],
        "deprecated": [],
        "breaking": [],
    }


def _graph(revision: str, binding_ref: str, semantic_diff: dict[str, Any]) -> dict[str, Any]:
    """A minimal graph shaped the way ``_semantic_index`` and ``_semantic_node`` read it."""

    return {
        "schema_version": "one.capability_graph.v1",
        "revision": revision,
        "actions": [
            {
                "capability_id": "X",
                "version": 1,
                "execution": {"binding_ref": binding_ref},
            }
        ],
        "workflows": [],
        "semantic_diff": semantic_diff,
    }


def _aliased(
    revision: str,
    aliases: list[str],
    *,
    version: int = 1,
    binding_ref: str = "binding-a",
) -> dict[str, Any]:
    """Graph v1's action plus a spoken-alias list, for the additive rule."""

    graph = _graph(revision, binding_ref, _empty_diff(None))
    graph["actions"][0]["aliases"] = aliases
    graph["actions"][0]["version"] = version
    return graph


V1 = _graph(V1_REVISION, "binding-a", {**_empty_diff(None), "added": ["actions:X"]})
# The author changed X's contract at the same version and recorded no breaking
# change. This is the exact shape of the historical bypass.
V2 = _graph(
    V2_REVISION,
    "binding-b",
    {**_empty_diff(V1_REVISION), "changed": ["actions:X"], "breaking": []},
)


@dataclass(frozen=True)
class Repo:
    root: Path

    def git(self, *args: str) -> str:
        completed = subprocess.run(  # noqa: S603 - fixed git executable, test-owned arguments
            ["git", *args],  # noqa: S607
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    def write_graph(self, graph: dict[str, Any]) -> None:
        text = json.dumps(graph, indent=2, sort_keys=True) + "\n"
        for mirror in MIRRORS:
            path = self.root / mirror
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def write_ledger(self, deprecations: list[dict[str, Any]]) -> None:
        path = self.root / LEDGER_RELATIVE
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": generator.CAPABILITY_GRAPH_EVOLUTION_SCHEMA_VERSION,
            "deprecations": deprecations,
        }
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Repo:
    """A temp repo: main carries graph v1, feature carries the v2 bypass."""

    for name in (
        "CI",
        "GITHUB_ACTIONS",
        "GITHUB_BASE_REF",
        "WEB_TARGETED_BASE_REF",
        generator.CAPABILITY_GRAPH_BASE_REF_ENV,
        "GIT_DIR",
        "GIT_WORK_TREE",
    ):
        monkeypatch.delenv(name, raising=False)
    # Keep the developer's global git config (hooks path, signing) out of the
    # temp repository so the test is hermetic.
    global_config = tmp_path / "gitconfig"
    global_config.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")

    root = tmp_path / "repo"
    root.mkdir()
    repo = Repo(root)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "user.name", "Capability Graph Test")
    repo.git("config", "user.email", "capability-graph-test@example.invalid")
    repo.git("config", "commit.gpgsign", "false")

    repo.write_ledger([])
    repo.commit("chore: ledger without a graph")
    repo.write_graph(V1)
    repo.commit("feat: capability graph v1")
    repo.git("checkout", "-q", "-b", "feature")
    repo.write_graph(V2)
    repo.commit("feat: repurpose X and record breaking: []")

    monkeypatch.setattr(generator, "REPO_ROOT", root)
    monkeypatch.setattr(generator, "OUTPUTS", tuple(root / mirror for mirror in MIRRORS))
    monkeypatch.setattr(generator, "EVOLUTION_CONTRACT_PATH", root / LEDGER_RELATIVE)
    return repo
