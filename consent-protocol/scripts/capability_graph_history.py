# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Read committed capability history without inventing unpublished revisions."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def read_workflow_predecessor(
    repo_root: Path, outputs: tuple[Path, ...], ref: str, *, allow_unpublished: bool = False
) -> dict[str, Any] | None:
    """Import only a committed ancestor, never an arbitrary compatibility claim."""

    resolved = subprocess.run(  # noqa: S603 - fixed git executable/arguments
        ["git", "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"],  # noqa: S607
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    subprocess.run(  # noqa: S603 - fixed git executable/arguments
        ["git", "merge-base", "--is-ancestor", resolved, "HEAD"],  # noqa: S607
        cwd=repo_root,
        check=True,
        capture_output=True,
    )
    relative = outputs[0].relative_to(repo_root).as_posix()
    try:
        completed = subprocess.run(  # noqa: S603 - fixed git executable/arguments
            ["git", "show", f"{resolved}:{relative}"],  # noqa: S607
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError:
        if not allow_unpublished:
            raise
        paths = [output.relative_to(repo_root).as_posix() for output in outputs]

        def query(*arguments: str) -> str:
            return subprocess.run(  # noqa: S603 - fixed git verbs and committed paths
                ["git", *arguments],  # noqa: S607
                cwd=repo_root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

        # An inferred parent may predate graph publication. Partial mirrors,
        # deleted published history, shallow ancestry and failed reads are not
        # evidence of that state. Explicit ledger/CLI refs never take this path.
        if (
            query("rev-parse", "--is-shallow-repository") != "false"
            or query("ls-tree", "--name-only", resolved, "--", *paths)
            or query("log", "-1", "--format=%H", resolved, "--", *paths)
        ):
            raise
        print("capability graph history: inferred_unpublished_predecessor=1", file=sys.stderr)
        return None
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict) or not payload.get("revision"):
        raise RuntimeError("Workflow predecessor has no generated graph revision.")
    return payload


def merged_workflow_predecessor_refs(repo_root: Path, base_commit: str | None) -> tuple[str, ...]:
    """Keep merged histories from the base integration and later branch merges.

    The base graph supplies one workflow history. A merged feature parent may
    carry another compatible history, including through a second parent. It must
    survive default CI without a one-off flag. Only committed ancestors are returned;
    ``read_workflow_predecessor`` still validates their graph and semantics.
    """

    if not (repo_root / ".git").exists():
        return ()
    if not base_commit:
        return ()
    history = subprocess.run(  # noqa: S603 - fixed git executable/arguments
        ["git", "rev-list", "--ancestry-path", "--parents", f"{base_commit}..HEAD"],  # noqa: S607
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    # Every listed commit descends from the base. Include ordinary commits so
    # first-parent membership proves ancestry without a subprocess per merge.
    lineages = [line.split() for line in history]
    descendants = {base_commit, *(lineage[0] for lineage in lineages)}
    predecessors: list[str] = []
    integrated_base = False
    for lineage in lineages:
        if len(lineage) < 3:
            continue
        if base_commit in lineage[1:]:
            integrated_base = True
            predecessors.extend(parent for parent in lineage[1:] if parent != base_commit)
            continue
        if lineage[1] in descendants:
            predecessors.extend(lineage[2:])
        elif any(parent in descendants for parent in lineage[2:]):
            # Isolated verification may receive the base via a second parent.
            # Its pre-base first parent still owns a separately shipped history.
            predecessors.extend(parent for parent in lineage[1:] if parent not in descendants)
    return tuple(dict.fromkeys(predecessors)) if integrated_base else ()
