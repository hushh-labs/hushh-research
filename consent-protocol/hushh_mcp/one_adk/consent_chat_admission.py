"""Consent continuation and history checks composed with each runtime's read authority."""

from __future__ import annotations

from typing import Any

from hushh_mcp.one_adk.consent_continuation import admit_consent_continuation
from hushh_mcp.one_adk.consent_redaction import access_ended_outcome, redaction_for_history


async def admit_session_continuation(
    forwarded: dict,
    *,
    input_data: Any,
    owner_id: str,
    sessions: Any,
    app_name: str,
    get_bundle: Any,
    person_name: Any,
    finance_lookup: Any = None,
) -> dict:
    if forwarded.get("financeShare") is not None:
        from hushh_mcp.one_adk.finance_share_context import admit_finance_share

        if finance_lookup is None:
            raise PermissionError("finance_authority_unavailable")
        return await admit_finance_share(
            forwarded, owner_id=owner_id, messages=input_data.messages, lookup=finance_lookup
        )
    if forwarded.get("consentContinuation") is None:
        return {}
    session = await sessions.get_session(
        app_name=app_name, user_id=owner_id, session_id=input_data.thread_id
    )

    def asked_here(bundle_id: str) -> bool:
        for event in session.events if session is not None else []:
            metadata = event.custom_metadata
            if not isinstance(metadata, dict):
                metadata = {}
            card = metadata.get("card")
            if not isinstance(card, dict):
                card = {}
            if (
                metadata.get("kind") == "information_request_submission_v1"
                and str(card.get("bundleId") or "").lower() == bundle_id
            ):
                return True
        return False

    return await admit_consent_continuation(
        forwarded,
        owner_id=owner_id,
        messages=input_data.messages,
        session_state=dict(session.state) if session is not None else None,
        asked_here=asked_here,
        get_bundle=get_bundle,
        person_name=person_name,
    )


async def consent_history_access(owner: str, state: Any, *, lookup: Any) -> tuple[dict, dict]:
    by_invocation, ended = redaction_for_history(state)
    pending = [bundle for bundle in dict.fromkeys(by_invocation.values()) if bundle not in ended]
    for bundle_id in pending[:10]:
        try:
            bundle = await lookup(owner, bundle_id)
            if not isinstance(bundle, dict):
                raise ValueError("consent_authority_unavailable")
            if any(
                item.get("status") == "granted" and item.get("accessReady") is False
                for item in bundle.get("items") or []
            ):
                raise ValueError("consent_access_not_ready")
            outcome = access_ended_outcome(bundle)
        except Exception:
            outcome = "revoked"  # unknown authority redacts this response only
        if outcome:
            ended[bundle_id] = outcome
    for bundle_id in pending[10:]:
        ended[bundle_id] = "revoked"
    return by_invocation, ended
