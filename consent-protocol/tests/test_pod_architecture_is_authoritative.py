"""DEV carries the future architecture. A merge must never silently undo that.

This branch is deliberately AHEAD of `main`: it holds the modular per-person pod
deployment, and `main` still holds the older shape. That makes ordinary branch-freshness
synchronisation dangerous in a way git cannot see. Git resolves text; it has no opinion
about which side is the architecture. Resolve a conflict by recency -- or let a
"take theirs" reflex win one file -- and modular pod deployment is gone, with a clean
merge commit and a green diff to show for it.

The concrete case, measured 2026-08-12 against `origin/main`:

    token                     branch   main
    _BUILD_POD_IMAGE               5      0
    Dockerfile.pod                 3      0
    consent-protocol-pod           4      0

`main` does not build the per-user pod image AT ALL. Taking its side of
`deploy/backend.cloudbuild.yaml` deletes the pod image build, and every later stage --
provisioning, the relay, the turn -- is then addressing an image nobody publishes. No
test in the tree would have noticed, because every one of them tests a component and the
thing that broke is the wiring between them.

So this file asserts the ARCHITECTURAL DIRECTION, not any single behaviour. Each marker
below is load-bearing for the pod architecture and absent (or contradicted) in the older
`main` shape. If a merge, rebase, revert or cherry-pick removes one, this goes red and
names what was lost -- which is the only moment the loss is cheap to undo.

It is deliberately a set of coarse presence checks rather than fine behavioural ones.
Finer tests exist elsewhere and are the right place for semantics. What has no other home
is the question "is this still the pod architecture at all", and that question is worth
answering in one file that a merge conflict cannot quietly delete half of.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent


def _read(rel: str, *, from_repo_root: bool = False) -> str:
    root = _REPO if from_repo_root else _BACKEND
    path = root / rel
    assert path.is_file(), (
        f"{rel} is missing entirely. If a merge deleted it, the pod architecture went "
        "with it -- restore from this branch's side rather than resolving forward."
    )
    return path.read_text(encoding="utf-8")


# Each entry: (human name, file, required substring, why it is load-bearing).
_MARKERS: list[tuple[str, str, str, bool]] = [
    (
        "the per-user pod image is built",
        "deploy/backend.cloudbuild.yaml",
        "_BUILD_POD_IMAGE",
        True,
    ),
    (
        "the pod image has a Dockerfile to build from",
        "deploy/backend.cloudbuild.yaml",
        "Dockerfile.pod",
        True,
    ),
    (
        "the hub mounts the pod relay",
        "consent-protocol/api/routes/one/__init__.py",
        "pod_relay",
        True,
    ),
    (
        "a pod mounts its turn route",
        "consent-protocol/pod_server.py",
        "pod_turn_router",
        True,
    ),
    (
        # Strengthened 2026-08-20: the guard used to pin the FLAG check
        # (`pod_mode() and pod_agent_memory_enabled()`), which a BYOC pod with a
        # broken key resolution passed while shipping a recall tool that always
        # errored. The marker is now the resolved-service check, which embeds the
        # flags and adds "the memory actually built".
        "pod agent memory stays pod-conditional",
        "consent-protocol/hushh_mcp/one_adk/agent_tree.py",
        "resolve_pod_memory_service() is not None",
        True,
    ),
    (
        "specialist admission still consults the authority gate",
        "consent-protocol/hushh_mcp/one_adk/agent_tree.py",
        "resolve_specialist_availability",
        True,
    ),
    (
        "the pod turn accepts carried grounding",
        "consent-protocol/api/routes/one/pod_turn.py",
        "pkm_context",
        True,
    ),
]


@pytest.mark.parametrize(
    ("name", "rel", "needle", "from_root"),
    _MARKERS,
    ids=[m[0].replace(" ", "_") for m in _MARKERS],
)
def test_pod_architecture_marker_survives(
    name: str, rel: str, needle: str, from_root: bool
) -> None:
    """One marker per case, so a failure names exactly what a merge removed."""
    body = _read(rel, from_repo_root=from_root)
    assert needle in body, (
        f"ARCHITECTURAL REGRESSION -- {name}.\n"
        f"  {rel} no longer contains {needle!r}.\n\n"
        "This branch is intentionally ahead of `main`: it carries the modular per-person "
        "pod deployment and `main` carries the older shape. A merge that resolved this "
        "file toward `main` has undone the architecture, not synchronised it.\n\n"
        "Resolve by architectural intent, not by branch recency: keep THIS branch's side "
        "for pod-deployment surfaces, and port any genuinely new `main` content on top."
    )


def test_the_crm_zk_constraint_is_dropped_exactly_once() -> None:
    """Both sides fixed this independently, so a union merge yields a duplicate.

    Migration 141 must be re-runnable -- the release guard replays the set on every
    deploy, and a bare ADD CONSTRAINT succeeds once then raises DuplicateObjectError
    forever. Both `main` and this branch added the same `DROP CONSTRAINT IF EXISTS`
    guard separately, which makes this the one conflict where taking BOTH sides is
    wrong: the statement would appear twice.
    """
    sql = _read("db/migrations/141_crm_zk_v1.sql")
    guard = "DROP CONSTRAINT IF EXISTS connected_system_intents_crm_zk_shape"
    count = sql.count(guard)

    assert count != 0, (
        "migration 141 lost its idempotency guard. The release guard replays this set "
        "on every deploy, so without it the second deploy fails on a constraint the "
        "first one created -- which already blocked a dev deploy once."
    )
    assert count == 1, (
        f"migration 141 contains {count} copies of the DROP guard. Both `main` and this "
        "branch added it independently, so a union merge duplicates it. Take one side "
        "whole rather than merging the hunks."
    )


def test_generated_contracts_are_not_hand_merged() -> None:
    """Generated artifacts must be REGENERATED after a merge, never hand-resolved.

    A hand-picked hash makes the artifact lie about the thing it digests, and the
    `--check` mode of its own generator is what catches it. This test does not run the
    generators -- it asserts they still exist to be run, because the merge procedure
    depends on them and a merge that removed one would strand the artifacts.
    """
    generators = [
        ("scripts/ops/generate_runtime_topology_index.py", True),
        ("scripts/generate_product_agent_registry.py", False),
    ]
    for rel, from_root in generators:
        root = _REPO if from_root else _BACKEND
        assert (root / rel).is_file(), (
            f"{rel} is missing. The merge procedure regenerates the contract artifacts "
            "rather than hand-resolving them; without its generator, "
            "contracts/architecture/runtime-topology-index.v1.json and "
            "contracts/agents/product-agent-registry.v2.json cannot be reconciled at all."
        )
