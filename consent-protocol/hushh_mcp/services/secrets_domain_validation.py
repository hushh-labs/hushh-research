"""The plaintext envelope of a ``secrets`` domain write.

The Secrets area holds API keys, passwords, tokens and card and government id
numbers. The encrypted blob is ciphertext the server cannot read (BYOK), so the
plaintext ``summary`` beside it is the one place a faulty client could leak a
secret, or even its label, onto the server. This refuses that outright, the
same posture as ``validate_wallet_card_envelope``.

Allowed: bookkeeping scalars only (versions, timestamps, flags, ``item_count``).
Refused: any item, label or value key at any depth; any nested object or list;
any string carrying whitespace (human text such as a label) or a secret span.
"""

from __future__ import annotations

import re
from typing import Any

from hushh_mcp.consent.secret_patterns import find_secret_spans

_FORBIDDEN_KEYS = frozenset(
    {"items", "item", "label", "labels", "value", "values", "secret", "secrets", "kind"}
)
_MACHINE_TEXT = re.compile(r"^[A-Za-z0-9_.:+-]{0,64}$")
MAX_SECRETS_PER_OWNER = 5000


def validate_secrets_summary_envelope(summary: Any) -> None:
    """Raise ``ValueError`` unless ``summary`` is a bookkeeping-only envelope."""
    if not isinstance(summary, dict):
        raise ValueError("secrets_summary_must_be_object")
    for key, value in summary.items():
        normalized = str(key).strip().lower()
        if normalized in _FORBIDDEN_KEYS:
            raise ValueError(f"secrets_summary_forbidden_key:{normalized}")
        if isinstance(value, dict | list | tuple):
            raise ValueError(f"secrets_summary_nested_value:{normalized}")
        if isinstance(value, str) and (
            not _MACHINE_TEXT.fullmatch(value) or find_secret_spans(value)
        ):
            raise ValueError(f"secrets_summary_text_value:{normalized}")
    item_count = summary.get("item_count")
    if item_count is not None and (
        isinstance(item_count, bool)
        or not isinstance(item_count, int)
        or not 0 <= item_count <= MAX_SECRETS_PER_OWNER
    ):
        raise ValueError("secrets_summary_item_count_invalid")


__all__ = ["MAX_SECRETS_PER_OWNER", "validate_secrets_summary_envelope"]


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
_BRANCHES = ("items",)
_LABELS = {"items": "Secrets"}


def _fixed_fields(container: dict, fields: dict[str, tuple]) -> None:
    for field, allowed in fields.items():
        if field in container and container[field] not in allowed:
            raise ValueError("secrets_metadata_invalid")


def _branch_lists(container: dict, fields: tuple[str, ...]) -> None:
    for field in fields:
        if field in container and (
            not isinstance(container[field], list)
            or any(branch not in _BRANCHES for branch in container[field])
        ):
            raise ValueError("secrets_metadata_invalid")
    if "externalizable_paths" in container and container["externalizable_paths"] != []:
        raise ValueError("secrets_metadata_invalid")


def _scope_handle(container: dict) -> None:
    value = container.get("scope_handle")
    if value is not None and (
        not isinstance(value, str)
        or not re.fullmatch(r"(?:s|scope|pending)_[A-Za-z0-9_-]{6,128}", value)
    ):
        raise ValueError("secrets_metadata_invalid")


def _decision_metadata(decision: dict) -> None:
    _branch_lists(decision, ("json_paths", "top_level_scope_paths"))
    _fixed_fields(
        decision,
        {
            "action": ("create_domain", "extend_domain", "match_existing_domain"),
            "target_domain": (None, "secrets"),
            "source_agent": ("secrets_vault", "pkm_structure_agent"),
            "writer_id": (
                None,
                "secrets_vault",
                "secrets_vault_remove",
                "secrets_vault_rotate",
            ),
            "structure_agent_id": (None, "secrets_vault", "pkm_structure_agent"),
            "contract_version": (1,),
        },
    )
    labels = decision.get("sensitivity_labels", {})
    if not isinstance(labels, dict) or any(
        branch not in _BRANCHES or label != "restricted" for branch, label in labels.items()
    ):
        raise ValueError("secrets_metadata_invalid")


def _manifest_metadata(manifest: dict) -> None:
    _branch_lists(manifest, ("top_level_scope_paths", "segment_ids"))
    _fixed_fields(manifest, {"domain": ("secrets",), "source_agent": (None, "secrets_vault")})
    paths = manifest.get("paths", [])
    if not isinstance(paths, list):
        raise ValueError("secrets_metadata_invalid")
    for path in paths:
        if (
            not isinstance(path, dict)
            or path.get("json_path") not in _BRANCHES
            or path.get("path_type") != "object"
            or path.get("exposure_eligibility") is not False
        ):
            raise ValueError("secrets_metadata_invalid")
        branch = path["json_path"]
        _fixed_fields(
            path,
            {
                "parent_path": (None,),
                "display_segment": (None, branch),
                "consent_label": (None, _LABELS[branch]),
                "sensitivity_label": (None, "restricted"),
                "segment_id": (None, branch),
                "source_agent": (None, "secrets_vault"),
                "projection_state": (None,),
                "projection_receipt_id": (None,),
            },
        )
        _scope_handle(path)


def _validate_bookkeeping_projection(summary: Any) -> None:
    if not isinstance(summary, dict) or set(summary) - _FIELDS:
        raise ValueError("secrets_summary_invalid")
    validate_secrets_summary_envelope(summary)
    for field in ("manifest_version", "domain_contract_version", "readable_summary_version"):
        if field in summary and (type(summary[field]) is not int or summary[field] < 0):
            raise ValueError("secrets_summary_version_invalid")
    for field in ("pkm_contract_version", "readable_projection_version"):
        if field in summary:
            value = summary[field]
            if (
                not isinstance(value, str)
                or len(value.split(".")) != 3
                or not all(part.isascii() and part.isdigit() for part in value.split("."))
            ):
                raise ValueError("secrets_summary_version_invalid")
    if "internal_only" in summary and type(summary["internal_only"]) is not bool:
        raise ValueError("secrets_summary_visibility_invalid")
    if "domain_intent" in summary and summary["domain_intent"] != "secrets":
        raise ValueError("secrets_summary_version_invalid")
    if "schema_version" in summary and (
        type(summary["schema_version"]) is not int or summary["schema_version"] != 1
    ):
        raise ValueError("secrets_summary_version_invalid")
    if ("consumer_visible" in summary and summary["consumer_visible"] is not False) or (
        "storage_mode" in summary and summary["storage_mode"] != "encrypted_domain"
    ):
        raise ValueError("secrets_summary_visibility_invalid")


def validate_secrets_write_sidecars(
    summary: Any, *, manifest: dict | None = None, structure_decision: dict | None = None
) -> None:
    """Refuse private values in every plaintext projection beside the ciphertext.

    Manifest and decision projections may be absent. When supplied, they use the
    same closed bookkeeping fields as the required root summary. Scope projections
    additionally identify only the fixed items branch.
    """
    _validate_bookkeeping_projection(summary)
    for container in (manifest, structure_decision):
        if container is None:
            continue
        if not isinstance(container, dict):
            raise ValueError("secrets_summary_invalid")
        _validate_bookkeeping_projection(container.get("summary_projection", {}))
    if structure_decision is not None:
        _decision_metadata(structure_decision)
    if manifest is None:
        return
    _manifest_metadata(manifest)
    nested_decision = manifest.get("structure_decision")
    if nested_decision is not None:
        if not isinstance(nested_decision, dict):
            raise ValueError("secrets_summary_invalid")
        _validate_bookkeeping_projection(nested_decision.get("summary_projection", {}))
        _decision_metadata(nested_decision)
    registry = manifest.get("scope_registry", [])
    if not isinstance(registry, list):
        raise ValueError("secrets_summary_invalid")
    for entry in registry:
        if not isinstance(entry, dict):
            raise ValueError("secrets_summary_invalid")
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
            raise ValueError("secrets_summary_invalid")
        fields = dict(projection)
        reason = fields.pop("visibility_reason", None)
        if reason not in (
            None,
            "A secret leaves the vault only through a per-item grant the owner starts.",
        ):
            raise ValueError("secrets_metadata_invalid")
        if "top_level_scope_path" in fields and fields.pop("top_level_scope_path") not in {
            "items",
        }:
            raise ValueError("secrets_summary_invalid")
        _validate_bookkeeping_projection(fields)
