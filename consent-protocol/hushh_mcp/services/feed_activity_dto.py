"""Bounded activity identity and attention fields; metadata is sanitized by Feed."""

from typing import Any

from hushh_mcp.services.feed_activity_policy import POLICY, event_policy
from hushh_mcp.services.feed_location_search import location_search_fields
from hushh_mcp.services.feed_search_contract import SCOPES


def activity_fields(row: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    activity: dict[str, str] = {}
    thread_key = str(row.get("thread_key") or "")
    if thread_key and row.get("thread_revision") is not None:
        activity = {
            "activity_group_id": thread_key,
            "activity_revision": str(row["thread_revision"]),
        }
    scope = row.get("scope_id") or (
        POLICY["classified_scopes"].get(row.get("subagent_id"))
        or (
            POLICY["connector_scopes"].get(metadata.get("connector_key"))
            if row.get("event_type") == "connector_reconnect_required"
            else None
        )
        or event_policy(str(row.get("event_type") or "")).get("scope", "one")
    )
    return {
        "scope_id": scope,
        "agent_label": SCOPES.get(scope, SCOPES["one"])["label"],
        "id": str(row.get("id")),
        **activity,
        "source_domain": row.get("source_domain"),
        "subagent_id": row.get("subagent_id")
        or (
            "agent_wallet"
            if metadata.get("wallet_card_request_id") or metadata.get("wallet_card_grant_id")
            else "agent_kyc"
            if metadata.get("workflow_id")
            and row.get("event_type") in {"mail_message_sent", "mail_information_request_detected"}
            else event_policy(str(row.get("event_type") or ""))["agent"]
        ),
        "activity_kind": event_policy(str(row.get("event_type") or ""))["kind"],
        "event_type": row.get("event_type"),
        **location_search_fields(row),
        **(
            {"search_events": row["search_events"]}
            if isinstance(row.get("search_events"), list)
            else {}
        ),
        "read": (int(row["displayed_unread_count"] or 0) == 0)
        if "displayed_unread_count" in row
        else row.get("read_at") is not None,
        "created_at": row.get("created_at"),
    }


def snapshot_fields(rows: list[dict[str, Any]]) -> dict[str, Any]:
    receipt = rows[0] if rows else None
    return {
        "history_revision": receipt["history_revision"] if receipt else None,
        "clear_version": receipt.get("clear_version") if receipt else None,
        "read_snapshot": {
            "up_to_id": str(receipt["snapshot_id"]) if receipt.get("snapshot_id") else None,
            "through_time": receipt.get("snapshot_time"),
            "fingerprint": receipt.get("snapshot_fingerprint"),
        }
        if receipt
        else None,
    }


def chat_activity_fields(row: dict[str, Any]) -> dict[str, Any]:
    if not str(row.get("thread_key", "")).startswith(("circle:", "direct:")):
        return {}
    unread = (
        "thread_message_count"
        if row.get("event_type") == "location_circle_message"
        else "thread_unread_count"
    )
    return {
        "chat_thread_key": str(row["thread_key"]),
        "chat_message_count": min(9999, int(row.get("thread_message_count") or 0)),
        "chat_unread_count": min(9999, int(row.get(unread) or 0)),
    }
