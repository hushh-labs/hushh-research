"""Bounded repair planning for historical PKM manifest path corruption.

Older writers could turn the collection marker ``_entities`` into the ordinary
segment ``entities``.  This module deliberately does not normalize paths.  It
only plans the one lossless repair that can be proven from the stored rows:
the second member of an adjacent ``entities.entities`` pair becomes
``_entities`` when it is followed by a child segment.

The planner is pure and does not read decrypted PKM values.  A caller must
still commit its returned metadata through the owner-scoped, revision-checked
database contract.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


class ManifestRepairError(ValueError):
    """The supplied snapshot cannot be repaired without guessing."""


_PATH_FIELDS = frozenset(
    {
        "id",
        "user_id",
        "domain",
        "json_path",
        "parent_path",
        "path_type",
        "segment_id",
        "scope_handle",
        "exposure_eligibility",
        "display_segment",
        "consent_label",
        "sensitivity_label",
        "source_agent",
        "created_at",
        "updated_at",
    }
)
_SCOPE_FIELDS = frozenset(
    {
        "id",
        "user_id",
        "domain",
        "scope_handle",
        "scope_label",
        "segment_ids",
        "sensitivity_tier",
        "scope_kind",
        "exposure_enabled",
        "manifest_version",
        "summary_projection",
        "visibility_posture",
        "default_projection_ready",
        "default_projection_updated_at",
        "owner_consent_override",
        "scope_origin",
        "scope_origin_code",
        "source_kind",
        "created_at",
        "updated_at",
    }
)
_MANIFEST_FIELDS = frozenset(
    {
        "user_id",
        "domain",
        "manifest_version",
        "structure_decision",
        "summary_projection",
        "top_level_scope_paths",
        "externalizable_paths",
        "segment_ids",
        "path_count",
        "externalizable_path_count",
        "domain_contract_version",
        "readable_summary_version",
        "pkm_contract_version",
        "readable_projection_version",
        "latest_upgrade_commit_id",
        "upgraded_at",
        "last_structured_at",
        "last_content_at",
        "created_at",
        "updated_at",
    }
)
_MANIFEST_PATH_LIST_FIELDS = ("top_level_scope_paths", "externalizable_paths")


@dataclass(frozen=True)
class ManifestRepairPlan:
    """A metadata-only repair plan tied to one owner/domain revision."""

    user_id: str
    domain: str
    expected_content_revision: int
    expected_manifest_revision: int
    next_manifest_revision: int
    manifest_row: dict[str, Any]
    path_rows: tuple[dict[str, Any], ...]
    scope_rows: tuple[dict[str, Any], ...]
    changed_paths: tuple[str, ...]

    @property
    def requires_commit(self) -> bool:
        return self.next_manifest_revision != self.expected_manifest_revision


def build_entity_path_repair_plan(
    *,
    user_id: str,
    domain: str,
    expected_content_revision: int,
    expected_manifest_revision: int,
    manifest: Mapping[str, Any],
    path_rows: Sequence[Mapping[str, Any]],
    scope_rows: Sequence[Mapping[str, Any]],
) -> ManifestRepairPlan:
    """Validate a snapshot and plan the only supported historical repair.

    The returned rows retain all permitted storage metadata.  Only exact path
    fields, manifest revisions, and the explicitly path-bearing projection
    fields are changed.  No case folding, trimming, separator rewriting,
    substring matching, or path invention is performed.
    """

    _require_non_empty_text(user_id, "user_id")
    _require_non_empty_text(domain, "domain")
    _require_revision(expected_content_revision, "expected_content_revision")
    _require_revision(expected_manifest_revision, "expected_manifest_revision")
    if not isinstance(manifest, Mapping):
        raise ManifestRepairError("manifest must be an object")

    expected_manifest_version = _require_revision_value(
        manifest.get("manifest_version"), "manifest.manifest_version"
    )
    if expected_manifest_version != expected_manifest_revision:
        raise ManifestRepairError("manifest revision does not match the snapshot revision")

    manifest_copy = deepcopy(dict(manifest))
    _validate_known_fields(manifest_copy, _MANIFEST_FIELDS, "manifest")
    _validate_owner_domain(manifest_copy, user_id, domain, "manifest")

    current_paths = [deepcopy(dict(row)) for row in path_rows]
    current_scopes = [deepcopy(dict(row)) for row in scope_rows]
    _validate_path_rows(current_paths, user_id=user_id, domain=domain)
    _validate_scope_rows(
        current_scopes,
        user_id=user_id,
        domain=domain,
        expected_manifest_revision=expected_manifest_revision,
    )

    declared_path_count = manifest_copy.get("path_count")
    if declared_path_count is not None:
        if _require_revision_value(declared_path_count, "manifest.path_count") != len(
            current_paths
        ):
            raise ManifestRepairError("manifest path_count does not match path rows")
    declared_externalizable_count = manifest_copy.get("externalizable_path_count")
    if declared_externalizable_count is not None:
        expected_externalizable_count = sum(
            1 for row in current_paths if row.get("exposure_eligibility") is True
        )
        if (
            _require_revision_value(
                declared_externalizable_count,
                "manifest.externalizable_path_count",
            )
            != expected_externalizable_count
        ):
            raise ManifestRepairError("manifest externalizable_path_count does not match path rows")

    current_paths_by_name = {row["json_path"]: row for row in current_paths}
    repaired_paths: list[dict[str, Any]] = []
    repaired_paths_by_name: dict[str, dict[str, Any]] = {}
    changed_paths: list[str] = []
    for row in current_paths:
        current_path = row["json_path"]
        repaired_path = _repair_path(current_path)
        repaired_parent = _repair_parent(row.get("parent_path"), current_path)
        repaired = deepcopy(row)
        repaired["json_path"] = repaired_path
        repaired["parent_path"] = repaired_parent
        if repaired_path != current_path or repaired_parent != row.get("parent_path"):
            changed_paths.append(current_path)
        if repaired_path in repaired_paths_by_name:
            raise ManifestRepairError("repair would create duplicate or colliding paths")
        repaired_paths_by_name[repaired_path] = repaired
        repaired_paths.append(repaired)

    _validate_parent_graph(current_paths_by_name, label="stored")
    _validate_parent_graph(repaired_paths_by_name, label="repaired")
    _validate_entity_collection_parents(current_paths_by_name, label="stored")
    _validate_entity_collection_parents(repaired_paths_by_name, label="repaired")
    _validate_row_identity(current_paths, repaired_paths)

    repaired_manifest_base = _repair_manifest_projection(manifest_copy, repaired_paths_by_name)
    repaired_scopes_base = _repair_scope_rows(
        current_scopes,
        next_manifest_revision=expected_manifest_revision,
        expected_content_revision=expected_content_revision,
        allowed_paths=set(repaired_paths_by_name),
    )
    scope_paths_changed = any(
        before.get("summary_projection", {}).get("top_level_scope_path")
        != after.get("summary_projection", {}).get("top_level_scope_path")
        for before, after in zip(current_scopes, repaired_scopes_base, strict=True)
        if isinstance(before.get("summary_projection"), Mapping)
        and isinstance(after.get("summary_projection"), Mapping)
    )
    requires_commit = bool(
        changed_paths or scope_paths_changed or repaired_manifest_base != manifest_copy
    )
    next_revision = (
        expected_manifest_revision + 1 if requires_commit else expected_manifest_revision
    )
    if requires_commit:
        repaired_manifest = repaired_manifest_base
        repaired_manifest["manifest_version"] = next_revision
        _set_projection_revisions(
            repaired_manifest,
            next_manifest_revision=next_revision,
            content_revision=expected_content_revision,
        )
        repaired_scopes = _repair_scope_rows(
            current_scopes,
            next_manifest_revision=next_revision,
            expected_content_revision=expected_content_revision,
            allowed_paths=set(repaired_paths_by_name),
        )
    else:
        repaired_manifest = manifest_copy
        repaired_scopes = current_scopes

    return ManifestRepairPlan(
        user_id=user_id,
        domain=domain,
        expected_content_revision=expected_content_revision,
        expected_manifest_revision=expected_manifest_revision,
        next_manifest_revision=next_revision,
        manifest_row=repaired_manifest,
        path_rows=tuple(repaired_paths),
        scope_rows=tuple(repaired_scopes),
        changed_paths=tuple(sorted(set(changed_paths))),
    )


def _require_non_empty_text(value: object, field: str) -> None:
    if not isinstance(value, str) or not value:
        raise ManifestRepairError(f"{field} must be a non-empty string")


def _require_revision(value: object, field: str) -> None:
    _require_revision_value(value, field)


def _require_revision_value(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ManifestRepairError(f"{field} must be a non-negative integer")
    return value


def _validate_owner_domain(row: Mapping[str, Any], user_id: str, domain: str, label: str) -> None:
    if "user_id" in row and row["user_id"] != user_id:
        raise ManifestRepairError(f"{label} belongs to a different owner")
    if "domain" in row and row["domain"] != domain:
        raise ManifestRepairError(f"{label} belongs to a different domain")


def _validate_path_rows(rows: Sequence[Mapping[str, Any]], *, user_id: str, domain: str) -> None:
    seen: set[str] = set()
    seen_ids: set[int] = set()
    present_ids = [row.get("id") for row in rows if row.get("id") is not None]
    if present_ids and len(present_ids) != len(rows):
        raise ManifestRepairError("path rows must either all have storage IDs or none")
    for index, row in enumerate(rows):
        _validate_known_fields(row, _PATH_FIELDS, f"path row {index}")
        _validate_owner_domain(row, user_id, domain, f"path row {index}")
        if row.get("id") is not None:
            row_id = _require_revision_value(row["id"], f"path row {index}.id")
            if row_id in seen_ids:
                raise ManifestRepairError("path rows must have unique storage IDs")
            seen_ids.add(row_id)
        path = row.get("json_path")
        if not isinstance(path, str) or path in seen:
            raise ManifestRepairError("path rows must have unique exact json_path values")
        seen.add(path)
        _validate_path_syntax(path, f"path row {index}.json_path")
        parent = row.get("parent_path")
        if parent is not None and not isinstance(parent, str):
            raise ManifestRepairError(f"path row {index}.parent_path must be a string or null")
        path_type = row.get("path_type", "leaf")
        if path_type not in {"object", "array", "leaf"}:
            raise ManifestRepairError(f"path row {index}.path_type is invalid")
        if path.endswith(".entities.entities") and path_type == "leaf":
            raise ManifestRepairError("terminal entities marker must remain a container")
        if "exposure_eligibility" in row and not isinstance(row["exposure_eligibility"], bool):
            raise ManifestRepairError(f"path row {index}.exposure_eligibility must be boolean")


def _validate_scope_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    user_id: str,
    domain: str,
    expected_manifest_revision: int,
) -> None:
    seen: set[str] = set()
    seen_ids: set[int] = set()
    present_ids = [row.get("id") for row in rows if row.get("id") is not None]
    if present_ids and len(present_ids) != len(rows):
        raise ManifestRepairError("scope rows must either all have storage IDs or none")
    for index, row in enumerate(rows):
        _validate_known_fields(row, _SCOPE_FIELDS, f"scope row {index}")
        _validate_owner_domain(row, user_id, domain, f"scope row {index}")
        if row.get("id") is not None:
            row_id = _require_revision_value(row["id"], f"scope row {index}.id")
            if row_id in seen_ids:
                raise ManifestRepairError("scope rows must have unique storage IDs")
            seen_ids.add(row_id)
        handle = row.get("scope_handle")
        if not isinstance(handle, str) or not handle or handle in seen:
            raise ManifestRepairError("scope rows must have unique exact scope handles")
        seen.add(handle)
        if "manifest_version" in row:
            version = _require_revision_value(
                row["manifest_version"], f"scope row {index}.manifest_version"
            )
            if version != expected_manifest_revision:
                raise ManifestRepairError("scope row revision does not match snapshot revision")
        projection = row.get("summary_projection")
        if projection is not None and not isinstance(projection, Mapping):
            raise ManifestRepairError(f"scope row {index}.summary_projection must be an object")


def _validate_known_fields(row: Mapping[str, Any], allowed: frozenset[str], label: str) -> None:
    unknown = set(row) - allowed
    if unknown:
        raise ManifestRepairError(f"{label} contains unknown fields: {sorted(unknown)}")


def _validate_path_syntax(path: str, field: str) -> None:
    parts = path.split(".")
    if not path or any(not part or part != part.strip() for part in parts):
        raise ManifestRepairError(f"{field} contains an invalid path segment")
    if any(part == "_items" and index == len(parts) - 1 for index, part in enumerate(parts)):
        # A collection marker is valid as a node; the check is intentionally
        # structural rather than a normalizer.  Terminal _items is retained.
        return


def _repair_path(path: str) -> str:
    parts = path.split(".")
    for index, part in enumerate(parts):
        if part == "entities" and index > 0 and parts[index - 1] == "entities":
            parts[index] = "_entities"
    return ".".join(parts)


def _repair_parent(parent: object, child_path: str) -> str | None:
    expected_parent = ".".join(child_path.split(".")[:-1]) or None
    if parent is not None and not isinstance(parent, str):
        raise ManifestRepairError("parent path must be a string or null")
    if parent not in {expected_parent, "" if expected_parent is None else expected_parent}:
        raise ManifestRepairError("path parent does not match its stored path")
    if expected_parent is None:
        return parent
    return _repair_path(parent)


def _validate_parent_graph(rows: Mapping[str, Mapping[str, Any]], *, label: str) -> None:
    for path, _row in rows.items():
        parts = path.split(".")
        for index in range(1, len(parts)):
            parent = ".".join(parts[:index])
            parent_row = rows.get(parent)
            if parent_row is None:
                raise ManifestRepairError(f"{label} path graph omits ancestor {parent}")
            if parent_row.get("path_type") not in {"object", "array"}:
                raise ManifestRepairError(f"{label} path graph has a non-container ancestor")


def _validate_entity_collection_parents(
    rows: Mapping[str, Mapping[str, Any]], *, label: str
) -> None:
    """Require `_entities` to be nested below an `entities` object."""
    for path in rows:
        parts = path.split(".")
        for index, part in enumerate(parts):
            if index == 0 or part not in {"entities", "_entities"}:
                continue
            if parts[index - 1] != "entities":
                continue
            parent = ".".join(parts[:index])
            if rows[parent].get("path_type") != "object":
                raise ManifestRepairError(
                    f"{label} entities collection is not below an object parent"
                )


def _validate_row_identity(
    current: Sequence[Mapping[str, Any]], repaired: Sequence[Mapping[str, Any]]
) -> None:
    if len(current) != len(repaired):
        raise ManifestRepairError("repair cannot add or omit path rows")
    ignored = {"json_path", "parent_path"}
    for before, after in zip(current, repaired, strict=True):
        if {key: value for key, value in before.items() if key not in ignored} != {
            key: value for key, value in after.items() if key not in ignored
        }:
            raise ManifestRepairError("repair changed path metadata beyond exact path fields")


def _repair_manifest_projection(
    manifest: dict[str, Any], repaired_paths: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    repaired = deepcopy(manifest)
    repaired_paths_set = set(repaired_paths)
    root_paths = {path.split(".")[0] for path in repaired_paths_set}
    for field in _MANIFEST_PATH_LIST_FIELDS:
        values = repaired.get(field)
        if values is None:
            continue
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise ManifestRepairError(f"manifest.{field} must be a list of strings")
        transformed = [_repair_path(value) for value in values]
        if len(set(transformed)) != len(transformed):
            raise ManifestRepairError(f"manifest.{field} would contain duplicate paths")
        allowed = root_paths if field == "top_level_scope_paths" else repaired_paths_set
        if any(value not in allowed for value in transformed):
            raise ManifestRepairError(f"manifest.{field} references an unknown path")
        repaired[field] = transformed

    decision = repaired.get("structure_decision")
    if isinstance(decision, Mapping):
        decision_copy = deepcopy(dict(decision))
        for field, allowed in (
            ("json_paths", repaired_paths_set),
            ("top_level_scope_paths", root_paths),
            ("externalizable_paths", repaired_paths_set),
        ):
            if field not in decision_copy:
                continue
            values = decision_copy[field]
            if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                raise ManifestRepairError(f"manifest.structure_decision.{field} is invalid")
            transformed = [_repair_path(value) for value in values]
            if len(set(transformed)) != len(transformed):
                raise ManifestRepairError(
                    f"structure decision {field} would contain duplicate paths"
                )
            if any(value not in allowed for value in transformed):
                raise ManifestRepairError(f"structure decision {field} references an unknown path")
            decision_copy[field] = transformed
        labels = decision_copy.get("sensitivity_labels")
        if labels is not None:
            if not isinstance(labels, Mapping):
                raise ManifestRepairError(
                    "manifest.structure_decision.sensitivity_labels is invalid"
                )
            repaired_labels: dict[str, Any] = {}
            for raw_path, label in labels.items():
                if not isinstance(raw_path, str):
                    raise ManifestRepairError(
                        "manifest.structure_decision.sensitivity_labels has an invalid path"
                    )
                repaired_path = _repair_path(raw_path)
                if repaired_path not in repaired_paths_set:
                    raise ManifestRepairError(
                        "manifest.structure_decision.sensitivity_labels references an unknown path"
                    )
                if repaired_path in repaired_labels:
                    raise ManifestRepairError("structure decision sensitivity labels would collide")
                repaired_labels[repaired_path] = label
            decision_copy["sensitivity_labels"] = repaired_labels
        repaired["structure_decision"] = decision_copy
    return repaired


def _repair_scope_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    next_manifest_revision: int,
    expected_content_revision: int,
    allowed_paths: set[str],
) -> list[dict[str, Any]]:
    repaired_rows: list[dict[str, Any]] = []
    for row in rows:
        output = deepcopy(dict(row))
        output["manifest_version"] = next_manifest_revision
        projection = output.get("summary_projection")
        if isinstance(projection, Mapping):
            projection_copy = deepcopy(dict(projection))
            top_level = projection_copy.get("top_level_scope_path")
            if top_level is not None:
                if not isinstance(top_level, str):
                    raise ManifestRepairError("scope top_level_scope_path must be a string")
                repaired_top_level = _repair_path(top_level)
                if repaired_top_level not in allowed_paths and repaired_top_level not in {
                    path.split(".")[0] for path in allowed_paths
                }:
                    raise ManifestRepairError("scope projection references an unknown path")
                projection_copy["top_level_scope_path"] = repaired_top_level
            projection_copy.update(
                {
                    "manifest_version": next_manifest_revision,
                    "content_revision": expected_content_revision,
                    "data_version": expected_content_revision,
                }
            )
            output["summary_projection"] = projection_copy
        repaired_rows.append(output)
    return repaired_rows


def _set_projection_revisions(
    manifest: dict[str, Any], *, next_manifest_revision: int, content_revision: int
) -> None:
    projection = manifest.get("summary_projection")
    if isinstance(projection, Mapping):
        projection_copy = deepcopy(dict(projection))
        projection_copy.update(
            {
                "manifest_version": next_manifest_revision,
                "content_revision": content_revision,
                "data_version": content_revision,
            }
        )
        manifest["summary_projection"] = projection_copy
