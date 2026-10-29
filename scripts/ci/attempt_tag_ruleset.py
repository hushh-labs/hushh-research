#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Reconcile the server-side immutability policy for deployment receipts."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

REPO = "hushh-labs/hushh-research"
LIST_ENDPOINT = f"repos/{REPO}/rulesets?per_page=100"


class RulesetError(RuntimeError):
    """The live GitHub ruleset state cannot safely be reconciled."""


def desired_payload(policy: dict[str, Any]) -> dict[str, Any]:
    config = policy.get("attempt_receipt_tag_ruleset") or {}
    name = str(config.get("name") or "").strip()
    patterns = config.get("patterns")
    expected = [
        "refs/tags/deployed/dev-attempt/*",
        "refs/tags/deployed/uat-attempt/*",
    ]
    if not name or not isinstance(patterns, list) or patterns != expected:
        raise RulesetError("attempt receipt tag policy must name the exact Dev and UAT tag patterns")
    return {
        "name": name,
        "target": "tag",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {
            "ref_name": {"include": expected, "exclude": []},
        },
        # Creation remains unrestricted so the successful release workflows can
        # publish one receipt per run attempt. Update and deletion are blocked.
        "rules": [{"type": "deletion"}, {"type": "update"}],
    }


def _rule_types(rules: Any) -> list[str]:
    if not isinstance(rules, list):
        raise RulesetError("live attempt receipt ruleset has no valid rule list")
    types: list[str] = []
    for rule in rules:
        if not isinstance(rule, dict) or not isinstance(rule.get("type"), str):
            raise RulesetError("live attempt receipt ruleset contains a malformed rule")
        params = rule.get("parameters")
        if params not in (None, {}):
            raise RulesetError("live attempt receipt ruleset contains an unexpected parameterized rule")
        types.append(rule["type"])
    return sorted(types)


def validation_errors(live: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    """Return every acceptance gap in an API ruleset response."""
    errors: list[str] = []
    if live.get("target") != "tag":
        errors.append("ruleset target is not tag")
    if live.get("enforcement") != "active":
        errors.append("ruleset enforcement is not active")
    if live.get("conditions") != expected["conditions"]:
        errors.append("ruleset does not target the exact Dev and UAT attempt tags")
    if live.get("bypass_actors") != []:
        errors.append("ruleset has one or more bypass actors")
    try:
        types = _rule_types(live.get("rules"))
    except RulesetError as exc:
        errors.append(str(exc))
    else:
        if types != ["deletion", "update"]:
            errors.append(
                "ruleset must restrict updates and deletions while leaving tag creation unrestricted"
            )
    return errors


def _summaries(value: Any) -> list[dict[str, Any]]:
    # gh api can return a direct JSON array; keep a nested-page shape accepted
    # for callers that use --paginate --slurp.
    if isinstance(value, list) and all(isinstance(row, dict) for row in value):
        return value
    if isinstance(value, list) and all(isinstance(page, list) for page in value):
        return [row for page in value for row in page if isinstance(row, dict)]
    raise RulesetError("GitHub returned a malformed repository ruleset inventory")


def reconcile(
    policy: dict[str, Any],
    *,
    read: Callable[[str], Any],
    write: Callable[[str, str, dict[str, Any]], Any],
    apply: bool,
    output: Callable[[str], None] = print,
) -> bool:
    """Dry-run or reconcile the exact named tag ruleset; never retarget it."""
    expected = desired_payload(policy)
    matches = [item for item in _summaries(read(LIST_ENDPOINT)) if item.get("name") == expected["name"]]
    if len(matches) > 1:
        raise RulesetError(f"multiple rulesets are named {expected['name']!r}")

    endpoint = f"repos/{REPO}/rulesets"
    method = "POST"
    current: dict[str, Any] | None = None
    if matches:
        ruleset_id = matches[0].get("id")
        if not ruleset_id:
            raise RulesetError("named attempt receipt ruleset has no ID")
        endpoint = f"{endpoint}/{ruleset_id}"
        method = "PUT"
        current = read(endpoint)
        if current.get("id") != ruleset_id or current.get("name") != expected["name"]:
            raise RulesetError("named ruleset identity changed during reconciliation")
        if current.get("target") != "tag" or current.get("conditions") != expected["conditions"]:
            raise RulesetError("refusing to retarget an existing named ruleset")
        # The name is an ownership marker. Refuse to replace rules of another
        # kind; otherwise an unrelated protection could be silently removed.
        current_types = _rule_types(current.get("rules"))
        if any(rule_type not in {"creation", "deletion", "update"} for rule_type in current_types):
            raise RulesetError("refusing to replace unrelated rules on the named ruleset")

    if current and not validation_errors(current, expected):
        output("✓ deployment attempt tag ruleset already matches the active receipt policy")
        return False

    output(
        f"Δ deployment attempt tag ruleset: {method} {endpoint}; target exact Dev/UAT receipt refs; "
        "leave creation open; restrict update/deletion; bypass actors=[]"
    )
    if apply:
        write(method, endpoint, expected)
        output("✅ deployment attempt tag ruleset reconciled")
    return True
