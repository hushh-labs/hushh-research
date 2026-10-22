"""Qualify only the recorded owner-specific OAuth-project topic for cleanup.

These readbacks do not invent a Pub/Sub incarnation or conditional DELETE token.
The existing owner lifecycle fence, created-resource receipt and dependency
receipts remain mandatory. Unknown, adopted or shared topics stay unresolved.
"""

from __future__ import annotations

import os
import re
from typing import Any

from hushh_mcp.services.byoc_substrate import _binding_observation
from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError


def bound_operator_topic(
    *, hushh_id: str | None, topic: str, owner_project: str, bootstrap: str
) -> str:
    from hushh_mcp.services.user_gcp_backend import _slug

    project = (os.getenv("GOOGLE_CONNECTOR_OAUTH_PROJECT") or "").strip()
    if (
        not hushh_id
        or re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project) is None
        or topic != f"projects/{project}/topics/one-mail-{_slug(hushh_id)}"
        or not bootstrap.endswith(f"@{owner_project}.iam.gserviceaccount.com")
    ):
        raise SubstrateDeleteError("operator topic owner/project authority unavailable")
    return topic


def verify_exclusive_topic(
    *,
    session: Any,
    headers: dict[str, str],
    topic: str,
    bootstrap: str,
    observations: list[dict] | None,
) -> None:
    """No mutation. Refuse unrelated/conditional grants or live subscriptions.

    Deleting the qualified exclusive topic removes only grants proven added by
    its original setup. A topic with other grants is retained, never replaced
    with a reduced IAM policy or deleted as though it belonged exclusively to us.
    """
    base = "https://pubsub.googleapis.com/v1/" + topic
    allowed = {
        ("roles/pubsub.publisher", "serviceAccount:gmail-api-push@system.gserviceaccount.com"),
        ("roles/pubsub.subscriber", "serviceAccount:" + bootstrap),
    }
    if not isinstance(observations, list) or not 1 <= len(observations) <= 128:
        raise SubstrateDeleteError("operator topic grant provenance unavailable")
    added = set()
    for raw in observations:
        value = _binding_observation(raw)
        if (
            value is None
            or value["policyResource"] != base + ":getIamPolicy"
            or value["step"] != "iam_gmail_publisher_on_topic"
            or (value["role"], value["member"]) not in allowed
        ):
            raise SubstrateDeleteError("operator topic grant provenance unverified")
        if value["disposition"] == "added":
            added.add((value["role"], value["member"]))
    if added != allowed:
        raise SubstrateDeleteError("operator topic grants were adopted or are unqualified")
    response = session.get(
        base + ":getIamPolicy",
        headers=headers,
        params={"options.requestedPolicyVersion": 3},
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise SubstrateDeleteError("operator topic policy unavailable")
    policy = response.json()
    if (
        not isinstance(policy, dict)
        or policy.get("error") is not None
        or not isinstance(policy.get("etag"), str)
        or not policy["etag"]
    ):
        raise SubstrateDeleteError("operator topic policy unverified")
    _verify_policy_bindings(policy, added)
    response = session.get(
        base + "/subscriptions",
        headers=headers,
        params={"pageSize": 1},
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise SubstrateDeleteError("operator topic subscription inventory unavailable")
    body = response.json()
    if (
        not isinstance(body, dict)
        or body.get("error") is not None
        or body.get("subscriptions", []) != []
        or body.get("nextPageToken")
    ):
        raise SubstrateDeleteError("operator topic still has subscriptions or incomplete inventory")


def _verify_policy_bindings(policy: dict, added: set[tuple[str, str]]) -> None:
    bindings = policy.get("bindings", [])
    if not isinstance(bindings, list) or any(
        not isinstance(binding, dict)
        or "condition" in binding
        or not isinstance(binding.get("role"), str)
        or not binding["role"]
        or not isinstance(binding.get("members"), list)
        or not binding["members"]
        or any(
            not isinstance(member, str) or (binding["role"], member) not in added
            for member in binding["members"]
        )
        for binding in bindings
    ):
        raise SubstrateDeleteError("operator topic has unrelated or conditional grants")
