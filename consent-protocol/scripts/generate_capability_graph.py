#!/usr/bin/env python3
"""Build the immutable Agent One CapabilityGraphV1 artifact.

The production command and chat paths read the checked-in artifact only. Source
discovery (including the intentionally non-executable endpoint catalog) happens
here at build time, never while a command is being interpreted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hushh_mcp.services.app_intelligence_runtime import (  # noqa: E402
    CAPABILITY_GRAPH_SCHEMA_VERSION,
    capability_graph_compiler_source_digest,
    capability_graph_evolution_source_digest,
    capability_graph_policy_digest,
    compile_capability_graph_from_sources,
    location_agent_manifest_source_digest,
    location_knowledge_package_source_digest,
    location_onboarding_runtime_source_digest,
    location_workflow_api_contract_source_digest,
    service_knowledge_packages_source_digest,
)

EVOLUTION_CONTRACT_PATH = ROOT / "hushh_mcp" / "agents" / "capability_graph_evolution.v1.json"
WORKFLOW_REVISION_COMPATIBILITY_SCHEMA_VERSION = "one.workflow_revision_compatibility.v1"
CAPABILITY_GRAPH_EVOLUTION_SCHEMA_VERSION = "one.capability_graph_evolution.v1"

OUTPUTS = (
    REPO_ROOT / "contracts" / "kai" / "one-capability-graph.v1.json",
    REPO_ROOT / "hushh-webapp" / "contracts" / "kai" / "one-capability-graph.v1.json",
    ROOT / "contracts" / "kai" / "one-capability-graph.v1.json",
)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _semantic_index(graph: dict[str, Any]) -> dict[str, str]:
    """Hash semantic nodes, excluding generated revision/diff metadata."""
    nodes: dict[str, Any] = {}
    for collection in (
        "actions",
        "workflows",
        "services",
        "screens",
        "entities",
        "render_surfaces",
    ):
        for node in graph.get(collection) or []:
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("capability_id") or node.get("service_id") or "").strip()
            if node_id:
                nodes[f"{collection}:{node_id}"] = node
    # Model-facing service brains are semantic artifacts in their own right.
    # They have no executable authority, so a change is non-breaking here,
    # but excluding them would hide a package wording/policy revision from the
    # generated semantic diff and make review of future model context harder.
    projections = graph.get("model_projections")
    if isinstance(projections, dict):
        for service_id, projection in sorted(projections.items()):
            if isinstance(projection, dict) and str(service_id or "").strip():
                nodes[f"brains:{service_id}"] = projection
    return {
        node_id: hashlib.sha256(
            json.dumps(node, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()
        for node_id, node in sorted(nodes.items())
    }


def _read_previous() -> dict[str, Any] | None:
    """Read the committed predecessor, never an intermediate generated file."""

    relative = OUTPUTS[0].relative_to(REPO_ROOT).as_posix()
    try:
        completed = subprocess.run(  # noqa: S603 - fixed git executable/arguments
            ["git", "show", f"HEAD:{relative}"],  # noqa: S607
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        completed = None
    if completed is not None and completed.returncode == 0:
        try:
            payload = json.loads(completed.stdout)
        except ValueError:
            return None
        return payload if isinstance(payload, dict) else None
    # In an exported source archive there may be no Git object database. Keep
    # `--check` useful there by comparing the checked-in file to itself. In a
    # Git checkout, a missing HEAD path means this is the graph's first release
    # and an untracked intermediate artifact is not a compatibility ancestor.
    if (REPO_ROOT / ".git").exists():
        return None
    try:
        payload = json.loads(OUTPUTS[0].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _workflow_by_id(graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(workflow.get("capability_id") or ""): workflow
        for workflow in graph.get("workflows") or []
        if isinstance(workflow, dict) and str(workflow.get("capability_id") or "")
    }


def _node_version(node: dict[str, Any] | None) -> int:
    if not isinstance(node, dict):
        return 0
    try:
        return max(1, int(node.get("version") or 1))
    except (TypeError, ValueError):
        return 0


def _load_evolution_deprecations() -> tuple[dict[str, Any], ...]:
    """Load exact-revision, fail-closed capability retirement declarations.

    Workflow migrations live with the owning workflow package. A removed node
    cannot carry its own declaration in the new graph, so deprecations use this
    small checked-in ledger and must name the exact predecessor revision and
    version. Broad or stale acknowledgements never suppress the breaking gate.
    """

    try:
        payload = json.loads(EVOLUTION_CONTRACT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError("Capability graph evolution contract is unavailable.") from exc
    if (
        not isinstance(payload, dict)
        or set(payload) != {"schema_version", "deprecations"}
        or payload.get("schema_version") != CAPABILITY_GRAPH_EVOLUTION_SCHEMA_VERSION
        or not isinstance(payload.get("deprecations"), list)
    ):
        raise RuntimeError("Capability graph evolution contract is invalid.")
    declarations: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    required = {
        "schema_version",
        "semantic_id",
        "from_revision",
        "from_version",
        "to_version",
        "active_run_policy",
    }
    for raw in payload["deprecations"]:
        if not isinstance(raw, dict) or set(raw) != required:
            raise RuntimeError("Capability graph deprecation declaration is invalid.")
        semantic_id = str(raw.get("semantic_id") or "").strip()
        from_revision = str(raw.get("from_revision") or "").strip()
        from_version = raw.get("from_version")
        to_version = raw.get("to_version")
        if (
            raw.get("schema_version") != "one.capability_deprecation.v1"
            or not semantic_id.startswith(("actions:", "workflows:"))
            or not from_revision
            or not isinstance(from_version, int)
            or from_version < 1
            or (to_version is not None and (not isinstance(to_version, int) or to_version < 1))
            or raw.get("active_run_policy") != "reject"
            or (semantic_id, from_revision) in seen
        ):
            raise RuntimeError("Capability graph deprecation declaration is invalid.")
        seen.add((semantic_id, from_revision))
        declarations.append(dict(raw))
    return tuple(declarations)


def _semantic_node(graph: dict[str, Any], semantic_id: str) -> dict[str, Any] | None:
    collection, separator, capability_id = semantic_id.partition(":")
    if not separator or collection not in {"actions", "workflows"}:
        return None
    id_field = "capability_id"
    return next(
        (
            node
            for node in graph.get(collection) or []
            if isinstance(node, dict) and str(node.get(id_field) or "") == capability_id
        ),
        None,
    )


def _semantic_change_has_deprecation(
    previous: dict[str, Any],
    graph: dict[str, Any],
    semantic_id: str,
    declarations: tuple[dict[str, Any], ...],
) -> bool:
    old = _semantic_node(previous, semantic_id)
    new = _semantic_node(graph, semantic_id)
    if old is None:
        return False
    old_version = _node_version(old)
    new_version = _node_version(new) if new is not None else None
    previous_revision = str(previous.get("revision") or "").strip()
    if not previous_revision or not old_version:
        return False
    return any(
        declaration.get("semantic_id") == semantic_id
        and declaration.get("from_revision") == previous_revision
        and declaration.get("from_version") == old_version
        and declaration.get("to_version") == new_version
        and declaration.get("active_run_policy") == "reject"
        for declaration in declarations
    )


def _workflow_change_has_migration(
    previous: dict[str, Any],
    graph: dict[str, Any],
    semantic_id: str,
) -> bool:
    workflow_id = semantic_id.removeprefix("workflows:")
    old = _workflow_by_id(previous).get(workflow_id)
    new = _workflow_by_id(graph).get(workflow_id)
    if old is None or new is None:
        return False
    try:
        old_version = int(old.get("version") or 1)
        new_version = int(new.get("version") or 1)
    except (TypeError, ValueError):
        return False
    if new_version <= old_version:
        return False
    plan = new.get("plan") if isinstance(new.get("plan"), dict) else {}
    migrations = plan.get("migrations") if isinstance(plan.get("migrations"), list) else []
    old_step_ids = {
        str(step.get("step_id") or "")
        for step in old.get("steps") or []
        if isinstance(step, dict) and str(step.get("step_id") or "")
    }
    new_step_ids = {
        str(step.get("step_id") or "")
        for step in new.get("steps") or []
        if isinstance(step, dict) and str(step.get("step_id") or "")
    }
    for migration in migrations:
        if (
            not isinstance(migration, dict)
            or migration.get("policy") != "map_known_cursor_fail_closed"
            or migration.get("from_workflow_version") != old_version
            or not isinstance(migration.get("cursor_map"), dict)
            or not migration["cursor_map"]
        ):
            continue
        cursor_map = migration["cursor_map"]
        source_ids = {str(source) for source in cursor_map}
        target_ids = {str(target) for target in cursor_map.values()}
        if old_step_ids and not old_step_ids.issubset(source_ids):
            continue
        if any(target not in new_step_ids and not target.startswith("$") for target in target_ids):
            continue
        return True
    return False


def _semantic_diff(
    previous: dict[str, Any] | None,
    graph: dict[str, Any],
    *,
    deprecations: tuple[dict[str, Any], ...] = (),
) -> dict[str, Any]:
    # A fresh `--check` rebuilds the same graph.  Preserve the recorded diff
    # in that case rather than comparing the graph to itself and producing an
    # artifact that changes on every verification run.
    if (
        isinstance(previous, dict)
        and str(previous.get("revision") or "") == str(graph.get("revision") or "")
        and isinstance(previous.get("semantic_diff"), dict)
    ):
        return dict(previous["semantic_diff"])
    old = _semantic_index(previous or {})
    new = _semantic_index(graph)
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changed = sorted(key for key in set(new) & set(old) if new[key] != old[key])
    # A missing capability or a changed action contract can invalidate a paused
    # run. A versioned workflow change is non-breaking only when the new
    # package explicitly maps the prior cursor version and fails closed for
    # unknown cursors.
    previous_graph = previous or {}
    migrated = sorted(
        item
        for item in changed
        if item.startswith("workflows:")
        and _workflow_change_has_migration(previous_graph, graph, item)
    )
    deprecated = sorted(
        item
        for item in [*removed, *changed]
        if item.startswith(("actions:", "workflows:"))
        and _semantic_change_has_deprecation(
            previous_graph,
            graph,
            item,
            deprecations,
        )
    )
    breaking = sorted(
        item
        for item in [*removed, *changed]
        if item.startswith(("actions:", "workflows:"))
        and item not in migrated
        and item not in deprecated
    )
    return {
        "from_revision": str((previous or {}).get("revision") or "") or None,
        "added": added,
        "removed": removed,
        "changed": changed,
        "migrated": migrated,
        "deprecated": deprecated,
        "breaking": breaking,
    }


def _require_acknowledged_semantic_changes(semantic_diff: dict[str, Any]) -> None:
    breaking = semantic_diff.get("breaking")
    if not isinstance(breaking, list) or not breaking:
        return
    raise RuntimeError(
        "Capability graph has unacknowledged breaking changes: "
        + ", ".join(str(item) for item in breaking)
        + ". Add an applicable workflow migration or exact-revision deprecation."
    )


def _previous_workflow_compatibility(previous: dict[str, Any], workflow_id: str) -> dict[str, Any]:
    compatibility = previous.get("workflow_revision_compatibility")
    if not isinstance(compatibility, dict):
        return {}
    entries = compatibility.get("workflows")
    if not isinstance(entries, list):
        return {}
    return next(
        (
            dict(entry)
            for entry in entries
            if isinstance(entry, dict) and entry.get("workflow_id") == workflow_id
        ),
        {},
    )


def _clean_revisions(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(item).strip() for item in value if str(item).strip()})


def _workflow_revision_compatibility(
    previous: dict[str, Any] | None,
    graph: dict[str, Any],
    semantic_diff: dict[str, Any],
) -> dict[str, Any]:
    current_revision = str(graph.get("revision") or "").strip()
    if not current_revision:
        raise RuntimeError("Capability graph revision is unavailable.")
    if (
        isinstance(previous, dict)
        and previous.get("revision") == current_revision
        and isinstance(previous.get("workflow_revision_compatibility"), dict)
    ):
        return dict(previous["workflow_revision_compatibility"])

    previous_revision = str((previous or {}).get("revision") or "").strip()
    old_workflows = _workflow_by_id(previous or {})
    migrated = set(semantic_diff.get("migrated") or [])
    deprecated = set(semantic_diff.get("deprecated") or [])
    entries: list[dict[str, Any]] = []
    for workflow_id, workflow in sorted(_workflow_by_id(graph).items()):
        semantic_id = f"workflows:{workflow_id}"
        digest = _semantic_index({"workflows": [workflow]}).get(semantic_id, "")
        old = old_workflows.get(workflow_id)
        prior = _previous_workflow_compatibility(previous or {}, workflow_id)
        compatible = _clean_revisions(prior.get("compatible_graph_revisions"))
        migration_required = _clean_revisions(prior.get("migration_required_graph_revisions"))
        rejected = _clean_revisions(prior.get("rejected_graph_revisions"))
        predecessor_revisions = sorted(
            set(compatible + ([previous_revision] if previous_revision else []))
        )
        if old is not None:
            old_digest = _semantic_index({"workflows": [old]}).get(semantic_id, "")
            if semantic_id in migrated:
                migration_required = sorted(set(migration_required + predecessor_revisions))
                compatible = []
            elif semantic_id in deprecated:
                rejected = sorted(set(rejected + predecessor_revisions))
                compatible = []
            elif old_digest == digest:
                compatible = predecessor_revisions
        entries.append(
            {
                "workflow_id": workflow_id,
                "workflow_version": _node_version(workflow),
                "workflow_digest": digest,
                "compatible_graph_revisions": compatible,
                "migration_required_graph_revisions": migration_required,
                "rejected_graph_revisions": rejected,
            }
        )
    return {
        "schema_version": WORKFLOW_REVISION_COMPATIBILITY_SCHEMA_VERSION,
        "current_graph_revision": current_revision,
        "workflows": entries,
    }


def build_payload() -> dict[str, Any]:
    previous = _read_previous()
    deprecations = _load_evolution_deprecations()
    graph = compile_capability_graph_from_sources()
    if graph.get("schema_version") != CAPABILITY_GRAPH_SCHEMA_VERSION:
        raise RuntimeError("capability graph compiler returned an unsupported schema")
    graph = json.loads(json.dumps(graph, sort_keys=True, default=str))
    graph["generator"] = "consent-protocol/scripts/generate_capability_graph.py"
    graph["source_digests"] = {
        "kai_action_gateway": _sha256_file(
            ROOT / "contracts" / "kai" / "kai-action-gateway.vnext.json"
        ),
        "route_orchestration_index": _sha256_file(
            ROOT / "contracts" / "kai" / "one-route-orchestration-index.v1.json"
        ),
        "product_agent_registry": _sha256_file(
            ROOT / "contracts" / "agents" / "product-agent-registry.v2.json"
        ),
        "location_agent_manifest": location_agent_manifest_source_digest(),
        "location_knowledge_package": location_knowledge_package_source_digest(),
        "service_knowledge_packages": service_knowledge_packages_source_digest(),
        "location_onboarding_runtime": location_onboarding_runtime_source_digest(),
        "location_workflow_api_contract": location_workflow_api_contract_source_digest(),
        # The generated sources above describe product inventory. These two
        # fingerprints cover compiler-owned execution/security policy as well:
        # trusted render catalog, hard confirmations, direct binding registry,
        # and the code that turns those sources into a graph.
        "capability_runtime_policy": capability_graph_policy_digest(),
        "capability_runtime_compiler": capability_graph_compiler_source_digest(),
        "capability_graph_evolution": capability_graph_evolution_source_digest(),
    }
    semantic_diff = _semantic_diff(previous, graph, deprecations=deprecations)
    _require_acknowledged_semantic_changes(semantic_diff)
    graph["semantic_diff"] = semantic_diff
    graph["workflow_revision_compatibility"] = _workflow_revision_compatibility(
        previous,
        graph,
        semantic_diff,
    )
    return graph


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check", action="store_true", help="fail when a committed mirror is stale"
    )
    args = parser.parse_args()
    payload = build_payload()
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    stale = []
    for output in OUTPUTS:
        current = output.read_text(encoding="utf-8") if output.exists() else ""
        if current != text:
            stale.append(output)
            if not args.check:
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(text, encoding="utf-8")
    if args.check and stale:
        joined = ", ".join(str(path.relative_to(REPO_ROOT)) for path in stale)
        raise SystemExit(
            f"CapabilityGraphV1 artifacts are stale: {joined}. Run npm run build:voice-gateway."
        )
    print(
        "CapabilityGraphV1 is current "
        f"(revision={payload.get('revision')}, actions={len(payload.get('actions') or [])}, "
        f"workflows={len(payload.get('workflows') or [])})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
