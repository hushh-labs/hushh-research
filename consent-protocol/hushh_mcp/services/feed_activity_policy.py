"""Authored Feed admission and operation identity, shared with the client projection.

This classifies closed event contracts, never user prose or model meaning.
Domain stores continue to authorize actions and determine current state.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

_POLICY_PATH = Path(__file__).resolve().parents[2] / "contracts/feed/activity-policy.v1.json"
POLICY: dict[str, Any] = json.loads(_POLICY_PATH.read_text())
EVENTS: dict[str, dict[str, Any]] = POLICY["events"]
AGENTS: dict[str, str] = POLICY["agents"]
POLICY_REVISION = "minimal-feed-v1-" + hashlib.sha256(_POLICY_PATH.read_bytes()).hexdigest()[:16]


def event_policy(event_type: str) -> dict[str, Any]:
    return EVENTS.get(event_type, {"agent": "agent_one", "kind": "routine", "operation": "source"})


def _literal(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_]+", value):
        raise ValueError("Feed policy identifiers must be authored constants")
    return "'" + value + "'"


def policy_case_sql(field: str, alias: str = "f") -> str:
    if field not in {"agent", "kind"} or not re.fullmatch(r"[a-z]+", alias):
        raise ValueError("Invalid Feed policy projection")
    cases = "\n".join(
        f"WHEN {alias}.event_type = {_literal(event)} THEN {_literal(rule[field])}"
        for event, rule in EVENTS.items()
        if rule["kind"] != "routine"
    )
    default = "agent_one" if field == "agent" else "routine"
    return f"CASE {cases} ELSE '{default}' END"


def browse_admission_sql(alias: str = "f") -> str:
    if not re.fullmatch(r"[a-z]+", alias):
        raise ValueError("Invalid Feed source")
    simple, conditional = [], []
    for event, rule in EVENTS.items():
        if rule["kind"] == "routine":
            continue
        checks = [f"{alias}.event_type={_literal(event)}"]
        for field, values in rule.get("metadata", {}).items():
            checks.append(
                f"{alias}.metadata->>{_literal(field)} IN ({','.join(_literal(value) for value in values)})"
            )
        prefixes = rule.get("operation_prefixes", [])
        if prefixes:
            if not all(re.fullmatch(r"[a-z][a-z-]*:", prefix) for prefix in prefixes):
                raise ValueError("Authored operation prefixes required")
            checks.append(
                "("
                + " OR ".join(
                    f"left({alias}.thread_key,{len(prefix)})='{prefix}'" for prefix in prefixes
                )
                + ")"
            )
        if len(checks) == 1:
            simple.append(_literal(event))
        else:
            conditional.append("(" + " AND ".join(checks) + ")")
    return "(" + " OR ".join([f"{alias}.event_type IN ({','.join(simple)})", *conditional]) + ")"


# Only source-owned IDs form a key. Missing/legacy identities remain separate.
# Never use a name, query text, date bucket, or provider status as identity.
GENERAL_OPERATION_KEY_SQL = """CASE
  WHEN f.source_domain='location' AND f.metadata->>'share_kind'='check_in'
    AND f.event_type IN ('location_share_created','location_share_revoked','location_share_shortened',
      'location_share_duration_changed','location_share_expired','location_access_approved')
    AND NULLIF(f.metadata->>'check_in_operation_id','') IS NOT NULL
    AND f.metadata->>'feed_audience'='owner'
    THEN 'check-in:' || f.user_id || ':' || (f.metadata->>'check_in_operation_id')
  WHEN f.source_domain='location'
    AND f.event_type IN ('circle_member_added','circle_member_left','circle_membership_ended',
      'location_circle_code_joined','location_circle_member_invite_accepted')
    AND NULLIF(f.metadata->>'membership_key','') IS NOT NULL
    THEN 'circle-membership:' || (f.metadata->>'membership_key')
  WHEN f.event_type='followup_reminder' AND NULLIF(f.metadata->>'request_id','') IS NOT NULL
    THEN 'calendar-followup:' || COALESCE(f.metadata->>'account_id','default') || ':' || (f.metadata->>'request_id')
  WHEN f.event_type IN ('connected_systems_failed','connected_systems_mutation_partial')
    AND NULLIF(f.source_row_id,'') IS NOT NULL THEN 'connected-operation:' || f.source_row_id
  WHEN f.event_type IN ('circle_member_invited','circle_member_added','circle_invite_declined','circle_invite_cancelled',
    'location_circle_member_invite_accepted') AND COALESCE(NULLIF(f.metadata->>'invite_id',''),NULLIF(f.source_row_id,'')) IS NOT NULL
    THEN 'circle-invite:' || COALESCE(NULLIF(f.metadata->>'invite_id',''),f.source_row_id)
  WHEN f.event_type IN ('circle_member_left','circle_membership_ended','circle_deleted',
    'location_one_network_joined','location_circle_code_joined','location_public_invite_submitted','location_referral_invite',
    'location_sms_contact_added','location_sms_contact_removed') AND NULLIF(f.source_row_id,'') IS NOT NULL
    THEN 'location-operation:' || f.source_row_id
  WHEN f.event_type IN ('mail_reconnect_required','calendar_reconnect_required','connector_reconnect_required')
    AND NULLIF(f.metadata->>'connector_key','') IS NOT NULL
    THEN 'connector:' || (f.metadata->>'connector_key')
  WHEN f.event_type IN ('drive_bulk_completed','drive_bulk_partial','drive_bulk_failed','drive_bulk_stopped')
    AND NULLIF(f.metadata->>'bulk_share_id','') IS NOT NULL
    THEN 'file-bulk:' || (f.metadata->>'bulk_share_id')
  WHEN f.event_type = 'mail_mailbox_failed' AND NULLIF(f.source_row_id,'') IS NOT NULL
    THEN 'mailbox-operation:' || f.source_row_id
  WHEN f.event_type IN ('answer_request_received','answer_request_payment_ready',
    'answer_request_declined','answer_delivered') AND NULLIF(f.metadata->>'request_id','') IS NOT NULL
    THEN 'answer-request:' || (f.metadata->>'request_id')
  WHEN f.event_type IN ('consent_requested','consent_granted','consent_revoked',
    'consent_denied','consent_cancelled') AND COALESCE(NULLIF(f.metadata->>'bundle_id',''),
    NULLIF(f.metadata->>'request_id','')) IS NOT NULL
    THEN 'consent:' || COALESCE(NULLIF(f.metadata->>'bundle_id',''), f.metadata->>'request_id')
  WHEN f.event_type IN ('location_share_created','location_share_revoked',
    'location_share_shortened','location_share_duration_changed','location_share_expired')
    AND COALESCE(NULLIF(f.metadata->>'grant_id',''),NULLIF(f.metadata->>'recorded_grant_id','')) IS NOT NULL
    THEN CASE WHEN COALESCE(NULLIF(f.metadata->>'request_id',''),NULLIF(f.metadata->>'recorded_request_id','')) IS NOT NULL
      THEN 'location-request:' || COALESCE(NULLIF(f.metadata->>'request_id',''),f.metadata->>'recorded_request_id')
      ELSE 'location-grant:' || COALESCE(NULLIF(f.metadata->>'grant_id',''),f.metadata->>'recorded_grant_id') END
  WHEN f.event_type IN ('location_access_request','location_access_approved',
    'location_access_denied','location_access_request_withdrawn')
    AND COALESCE(NULLIF(f.metadata->>'request_id',''),NULLIF(f.metadata->>'recorded_request_id','')) IS NOT NULL
    THEN 'location-request:' || COALESCE(NULLIF(f.metadata->>'request_id',''),f.metadata->>'recorded_request_id')
  WHEN f.event_type IN ('connection_accepted','connection_rejected','connection_withdrawn')
    AND NULLIF(f.source_row_id,'') IS NOT NULL THEN 'connection-request:' || f.source_row_id
  WHEN f.event_type IN ('document_share_question','document_share_answered',
    'document_share_declined','drive_question_withdrawn','drive_question_retry_required')
    AND NULLIF(f.metadata->>'request_id','') IS NOT NULL
    THEN 'document-question:' || (f.metadata->>'request_id')
  WHEN f.event_type IN ('calendar_event_created','calendar_event_rescheduled','calendar_event_canceled')
    AND NULLIF(f.metadata->>'calendar_event_key','') IS NOT NULL
    THEN 'calendar-event:' || (f.metadata->>'calendar_event_key')
  WHEN f.event_type IN ('calendar_event_created','calendar_event_rescheduled','calendar_event_canceled',
    'calendar_action_failed') AND NULLIF(f.source_row_id,'') IS NOT NULL
    THEN 'calendar-operation:' || f.source_row_id
  WHEN f.event_type IN ('mail_information_request_detected','mail_message_sent',
    'mail_message_failed','mail_delivery_unconfirmed')
    AND NULLIF(f.metadata->>'workflow_id','') IS NOT NULL
    THEN 'kyc-workflow:' || (f.metadata->>'workflow_id')
  WHEN f.event_type = 'mail_information_request_detected' AND NULLIF(f.source_row_id,'') IS NOT NULL
    THEN 'kyc-workflow:' || f.source_row_id
  WHEN f.event_type IN ('mail_message_sent','mail_message_failed','mail_delivery_unconfirmed')
    AND NULLIF(f.source_row_id,'') IS NOT NULL THEN 'mail-send:' || f.source_row_id
  WHEN f.source_domain = 'profile_discovery' AND NULLIF(f.source_row_id,'') IS NOT NULL
    THEN 'profile-discovery:' || f.source_row_id
  WHEN f.event_type = 'pwm_research' AND NULLIF(f.metadata->>'draft_id','') IS NOT NULL
    THEN 'memory-draft:' || (f.metadata->>'draft_id')
  WHEN f.event_type IN ('personal_agent_ready','personal_agent_failed','personal_agent_updated')
    AND NULLIF(f.source_row_id,'') IS NOT NULL THEN 'private-agent:' || f.source_row_id
  WHEN f.event_type IN ('drive_share_succeeded','drive_share_failed','drive_share_unconfirmed',
    'drive_trash_succeeded','drive_trash_failed','drive_trash_unconfirmed','drive_bulk_completed',
    'drive_bulk_partial','drive_bulk_failed','drive_bulk_stopped')
    AND NULLIF(f.source_row_id,'') IS NOT NULL THEN 'file-operation:' || f.source_row_id
END"""
