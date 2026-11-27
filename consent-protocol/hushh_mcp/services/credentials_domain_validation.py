"""Credentials' plaintext sidecar contains only a closed bookkeeping schema."""

import re
from typing import Any

from hushh_mcp.services.secrets_domain_validation import validate_secrets_summary_envelope

_FIELDS = frozenset(
    {
        "domain_intent",
        "manifest_version",
        "domain_contract_version",
        "readable_summary_version",
        "pkm_contract_version",
        "readable_projection_version",
        "consumer_visible",
        "internal_only",
        "storage_mode",
        "item_count",
        "schema_version",
    }
)
_BRANCHES = ("summary", "secrets")
_LABELS = {"summary": "Website login summary", "secrets": "Website login secrets"}


def _fixed_fields(container: dict, fields: dict[str, tuple]) -> None:
    for field, allowed in fields.items():
        if field in container and container[field] not in allowed:
            raise ValueError("credentials_metadata_invalid")


def _branch_lists(container: dict, fields: tuple[str, ...]) -> None:
    for field in fields:
        if field in container and (
            not isinstance(container[field], list)
            or any(branch not in _BRANCHES for branch in container[field])
        ):
            raise ValueError("credentials_metadata_invalid")
    if "externalizable_paths" in container and container["externalizable_paths"] != []:
        raise ValueError("credentials_metadata_invalid")


def _scope_handle(container: dict) -> None:
    value = container.get("scope_handle")
    if value is not None and (
        not isinstance(value, str) or not re.fullmatch(r"s_[a-f0-9]{12}", value)
    ):
        raise ValueError("credentials_metadata_invalid")


def _decision_metadata(decision: dict) -> None:
    _branch_lists(decision, ("json_paths", "top_level_scope_paths"))
    _fixed_fields(
        decision,
        {
            "action": ("create_domain", "extend_domain", "match_existing_domain"),
            "target_domain": (None, "credentials"),
            "source_agent": ("credentials_vault", "pkm_structure_agent"),
            "writer_id": (
                None,
                "credentials_vault",
                "credentials_vault_remove",
                "credentials_vault_rotate",
            ),
            "structure_agent_id": (None, "credentials_vault", "pkm_structure_agent"),
            "contract_version": (1,),
        },
    )
    labels = decision.get("sensitivity_labels", {})
    if not isinstance(labels, dict) or any(
        branch not in _BRANCHES or label != "restricted" for branch, label in labels.items()
    ):
        raise ValueError("credentials_metadata_invalid")


def _manifest_metadata(manifest: dict) -> None:
    _branch_lists(manifest, ("top_level_scope_paths", "segment_ids"))
    _fixed_fields(
        manifest, {"domain": ("credentials",), "source_agent": (None, "credentials_vault")}
    )
    paths = manifest.get("paths", [])
    if not isinstance(paths, list):
        raise ValueError("credentials_metadata_invalid")
    for path in paths:
        if (
            not isinstance(path, dict)
            or path.get("json_path") not in _BRANCHES
            or path.get("path_type") != "object"
            or path.get("exposure_eligibility") is not False
        ):
            raise ValueError("credentials_metadata_invalid")
        branch = path["json_path"]
        _fixed_fields(
            path,
            {
                "parent_path": (None,),
                "display_segment": (None, branch),
                "consent_label": (None, _LABELS[branch]),
                "sensitivity_label": (None, "restricted"),
                "segment_id": (None, branch),
                "source_agent": (None, "credentials_vault"),
                "projection_state": (None,),
                "projection_receipt_id": (None,),
            },
        )
        _scope_handle(path)


def _validate_bookkeeping_projection(summary: Any) -> None:
    if not isinstance(summary, dict) or set(summary) - _FIELDS:
        raise ValueError("credentials_summary_invalid")
    validate_secrets_summary_envelope(summary)
    for field in ("manifest_version", "domain_contract_version", "readable_summary_version"):
        if field in summary and (type(summary[field]) is not int or summary[field] < 0):
            raise ValueError("credentials_summary_version_invalid")
    for field in ("pkm_contract_version", "readable_projection_version"):
        if field in summary:
            value = summary[field]
            if (
                not isinstance(value, str)
                or len(value.split(".")) != 3
                or not all(part.isascii() and part.isdigit() for part in value.split("."))
            ):
                raise ValueError("credentials_summary_version_invalid")
    if "internal_only" in summary and type(summary["internal_only"]) is not bool:
        raise ValueError("credentials_summary_visibility_invalid")
    if "domain_intent" in summary and summary["domain_intent"] != "credentials":
        raise ValueError("credentials_summary_version_invalid")
    if "schema_version" in summary and (
        type(summary["schema_version"]) is not int or summary["schema_version"] != 1
    ):
        raise ValueError("credentials_summary_version_invalid")
    if ("consumer_visible" in summary and summary["consumer_visible"] is not False) or (
        "storage_mode" in summary and summary["storage_mode"] != "encrypted_domain"
    ):
        raise ValueError("credentials_summary_visibility_invalid")


def validate_credentials_summary_envelope(summary: Any) -> None:
    _validate_bookkeeping_projection(summary)
    if (
        summary.get("domain_intent") != "credentials"
        or type(summary.get("schema_version")) is not int
        or summary.get("schema_version") != 1
    ):
        raise ValueError("credentials_summary_version_invalid")
    if (
        summary.get("consumer_visible") is not False
        or summary.get("storage_mode") != "encrypted_domain"
    ):
        raise ValueError("credentials_summary_visibility_invalid")


def validate_credentials_write_sidecars(
    summary: Any, *, manifest: dict | None = None, structure_decision: dict | None = None
) -> None:
    """Refuse private values in every plaintext projection beside the ciphertext.

    Manifest and decision projections may be absent. When supplied, they use the
    same closed bookkeeping fields as the required root summary. Scope projections
    additionally identify only the fixed summary/secrets branch.
    """
    validate_credentials_summary_envelope(summary)
    for container in (manifest, structure_decision):
        if container is None:
            continue
        if not isinstance(container, dict):
            raise ValueError("credentials_summary_invalid")
        _validate_bookkeeping_projection(container.get("summary_projection", {}))
    if structure_decision is not None:
        _decision_metadata(structure_decision)
    if manifest is None:
        return
    _manifest_metadata(manifest)
    nested_decision = manifest.get("structure_decision")
    if nested_decision is not None:
        if not isinstance(nested_decision, dict):
            raise ValueError("credentials_summary_invalid")
        _validate_bookkeeping_projection(nested_decision.get("summary_projection", {}))
        _decision_metadata(nested_decision)
    registry = manifest.get("scope_registry", [])
    if not isinstance(registry, list):
        raise ValueError("credentials_summary_invalid")
    for entry in registry:
        if not isinstance(entry, dict):
            raise ValueError("credentials_summary_invalid")
        _branch_lists(entry, ("segment_ids",))
        _scope_handle(entry)
        _fixed_fields(
            entry,
            {
                "scope_label": tuple(_LABELS.values()),
                "sensitivity_tier": ("restricted",),
                "scope_kind": ("reserved_domain_branch",),
                "exposure_enabled": (False,),
                "visibility_posture": ("consent_required",),
                "default_projection_ready": (False,),
                "default_projection_updated_at": (None,),
            },
        )
        projection = entry.get("summary_projection", {})
        if not isinstance(projection, dict):
            raise ValueError("credentials_summary_invalid")
        fields = dict(projection)
        if "top_level_scope_path" in fields and fields.pop("top_level_scope_path") not in {
            "summary",
            "secrets",
        }:
            raise ValueError("credentials_summary_invalid")
        _validate_bookkeeping_projection(fields)
