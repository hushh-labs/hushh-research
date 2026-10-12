"""Validate the business preview shape; never choose or rewrite agent meaning."""

import json
import re
from copy import deepcopy


def valid_business_source(message: str) -> bool:
    try:
        fields = json.loads(message)
    except (ValueError, TypeError):
        return False
    return (
        len(message) <= 4000
        and isinstance(fields, dict)
        and bool(fields)
        and all(
            key not in {"__proto__", "prototype", "constructor"}
            and isinstance(value, str)
            and bool(value.strip())
            for key, value in fields.items()
        )
    )


def business_merge_schema(base: dict) -> dict:
    schema = deepcopy(base)
    schema["properties"]["proposed_entity_id"] = {
        "type": "STRING",
        "description": "Canonical lowercase underscore business key; reuse the target key for an existing business, choose a new key for creation.",
    }
    schema["required"].append("proposed_entity_id")
    return schema


def business_structure_schema(message: str, base: dict, merge: dict | None = None) -> dict:
    """Constrain representation, not meaning; domain and entity ID stay model-chosen.

    The generic structurer permits summary records. A listing instead has exact
    supplied strings: make that distinction visible to constrained generation,
    while retaining the independent final validator and all authority guards.
    """
    schema = deepcopy(base)
    try:
        fields = json.loads(message)
    except (ValueError, TypeError):
        return schema
    if (
        not isinstance(fields, dict)
        or not fields
        or len(message) > 4000
        or any(
            key in {"__proto__", "prototype", "constructor"}
            or not isinstance(value, str)
            or not value.strip()
            for key, value in fields.items()
        )
    ):
        return schema
    entity = {
        "type": "OBJECT",
        "properties": {key: {"type": "STRING", "enum": [value]} for key, value in fields.items()},
        "required": list(fields),
        "additionalProperties": False,
    }
    entity_id = (merge or {}).get("proposed_entity_id")
    entities = {
        "type": "OBJECT",
        "additionalProperties": entity,
        "minProperties": 1,
        "maxProperties": 1,
    }
    if isinstance(entity_id, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,127}", entity_id):
        # Use the merge agent's semantic choice, not an application-generated ID.
        # Explicit properties work across providers that omit dynamic-map values.
        entities = {
            "type": "OBJECT",
            "properties": {entity_id: entity},
            "required": [entity_id],
            "additionalProperties": False,
        }
    schema["properties"]["candidate_payload"] = {
        "type": "OBJECT",
        "properties": {
            "businesses": {
                "type": "OBJECT",
                "properties": {"entities": entities},
                "required": ["entities"],
                "additionalProperties": False,
            }
        },
        "required": ["businesses"],
        "additionalProperties": False,
    }
    schema["properties"]["write_mode"] = {"type": "STRING", "enum": ["confirm_first"]}
    schema["properties"]["target_entity_scope"] = {"type": "STRING", "enum": ["businesses"]}
    return schema


def valid_business_preview(message: str, preview: dict, merge: dict) -> bool:
    try:
        supplied = json.loads(message)
    except (ValueError, TypeError):
        return False
    if len(message) > 4000 or not isinstance(supplied, dict) or not supplied:
        return False
    if not all(
        isinstance(key, str)
        and isinstance(value, str)
        and value.strip()
        and key not in {"__proto__", "prototype", "constructor"}
        for key, value in supplied.items()
    ):
        return False
    decision = preview.get("structure_decision")
    if not isinstance(decision, dict):
        return False
    domain = decision.get("target_domain")
    if not domain or domain in {"identity", "location", "health", "social", "financial"}:
        return False
    if merge.get("target_domain") and merge["target_domain"] != domain:
        return False
    if (
        preview.get("write_mode") != "confirm_first"
        or preview.get("target_entity_scope") != "businesses"
    ):
        return False
    payload = preview.get("candidate_payload")
    if not isinstance(payload, dict) or set(payload) != {"businesses"}:
        return False
    branch = payload["businesses"]
    if not isinstance(branch, dict) or set(branch) != {"entities"}:
        return False
    entities = branch["entities"]
    if not isinstance(entities, dict) or len(entities) != 1:
        return False
    entity_id, entity = next(iter(entities.items()))
    if (
        not isinstance(entity_id, str)
        or not entity_id
        or "." in entity_id
        or entity_id in {"__proto__", "prototype", "constructor"}
    ):
        return False
    # A strict profile contract: missing, invented or policy fields are a
    # schema failure, not an excuse to silently clip a successful model result.
    if entity != supplied:
        return False
    mode = merge.get("merge_mode")
    if mode not in {"create_entity", "extend_entity", "correct_entity"}:
        return False
    target = merge.get("target_entity_path")
    if target and target != f"businesses.entities.{entity_id}":
        return False
    return True
