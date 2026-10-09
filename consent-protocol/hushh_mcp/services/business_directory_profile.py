"""Validate the business preview shape; never choose or rewrite agent meaning."""

import json


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
