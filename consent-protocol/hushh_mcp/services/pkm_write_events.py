"""Assemble domain audit events from already-validated commit inputs."""

from typing import Any


def build_domain_write_events(
    *,
    normalized_manifest: Any,
    normalized_segments: dict[str, Any],
    operation_type: str,
    path_set: list[str],
    structure_agent_id: str,
    writer_id: str,
    confidence: Any,
    prior_manifest_version: Any,
    next_version: int,
    mutation_metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    return [
        {
            "operation_type": operation_type,
            "segment_ids": sorted(normalized_segments),
            "path_set": path_set,
            "source_agent": structure_agent_id,
            "confidence": confidence,
            "prior_manifest_version": prior_manifest_version,
            "new_manifest_version": normalized_manifest.manifest_version,
            "metadata": {
                "structure_decision": {
                    "action": normalized_manifest.structure_decision.get("action"),
                    "target_domain": normalized_manifest.structure_decision.get("target_domain"),
                    "contract_version": normalized_manifest.structure_decision.get(
                        "contract_version"
                    ),
                    "writer_id": writer_id,
                    "structure_agent_id": structure_agent_id,
                },
                "top_level_scope_paths": normalized_manifest.top_level_scope_paths,
                "externalizable_paths": normalized_manifest.externalizable_paths,
                "provenance": mutation_metadata,
            },
        },
        {
            "operation_type": "content_write",
            "segment_ids": sorted(normalized_segments),
            "path_set": path_set,
            "source_agent": writer_id,
            "confidence": confidence,
            "prior_manifest_version": prior_manifest_version,
            "new_manifest_version": normalized_manifest.manifest_version,
            "metadata": {
                "storage_mode": "per_domain_blob",
                "data_version": next_version,
                "provenance": mutation_metadata,
            },
        },
    ]
