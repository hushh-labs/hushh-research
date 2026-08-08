"""get_ria_onboarding_status must surface the latest ria_identity_claim event.

The claim snapshot (firm_record / advisor_record) is persisted in
ria_verification_events with provider 'ria_identity_claim'. Later
refresh-license or onboarding events shadow it in the unfiltered
latest_verification_event fetch, so the status payload carries a dedicated
latest_claim_event resolved with a provider filter.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest

from hushh_mcp.services.ria_iam_service import RIAIAMService

_NOW = datetime(2026, 8, 8, 12, 0, 0, tzinfo=UTC)

_CLAIM_METADATA = {
    "provider": "ria_identity_claim",
    "claim_type": "individual",
    "firm_record": {"firm_crd": "801-12345", "website": "https://advisoralpha.com"},
    "advisor_record": {"individual_crd": "12345", "name": "Advisor Alpha"},
    "verification_level": "provisional",
}

_REFRESH_METADATA = {
    "provider": "profile_refresh",
    "matched_name": "Advisor Alpha",
}


def _claim_event_row() -> dict:
    return {
        "provider": "ria_identity_claim",
        "outcome": "provisional",
        "checked_at": _NOW - timedelta(hours=2),
        "expires_at": None,
        "reference_metadata": json.dumps(_CLAIM_METADATA),
    }


def _refresh_event_row() -> dict:
    return {
        "provider": "profile_refresh",
        "outcome": "verified",
        "checked_at": _NOW - timedelta(minutes=5),
        "expires_at": None,
        "reference_metadata": json.dumps(_REFRESH_METADATA),
    }


class _FakeConn:
    def __init__(self, events: list[dict]):
        self._events = events

    def _latest(self, events: list[dict]) -> dict | None:
        if not events:
            return None
        row = max(events, key=lambda item: item["checked_at"])
        return {
            "outcome": row["outcome"],
            "checked_at": row["checked_at"],
            "expires_at": row["expires_at"],
            "reference_metadata": row["reference_metadata"],
        }

    async def fetchrow(self, query: str, *_args):
        if "FROM ria_verification_events" in query:
            if "ria_identity_claim" in query:
                return self._latest(
                    [row for row in self._events if row["provider"] == "ria_identity_claim"]
                )
            return self._latest(self._events)
        if "FROM ria_profiles" in query and "requested_capabilities" in query:
            return {
                "id": "ria-profile-1",
                "user_id": "user-1",
                "display_name": "Advisor Alpha",
                "requested_capabilities": ["advisory"],
                "individual_legal_name": "Advisor Alpha",
                "individual_crd": "12345",
                "advisory_firm_legal_name": "Advisor Alpha LLC",
                "advisory_firm_iapd_number": "801-12345",
                "broker_firm_legal_name": None,
                "broker_firm_crd": None,
                "advisory_status": "verified",
                "brokerage_status": None,
                "advisory_provider": "ria_identity_claim",
                "brokerage_provider": None,
                "advisory_verification_expires_at": None,
                "brokerage_verification_expires_at": None,
                "legal_name": "Advisor Alpha",
                "finra_crd": "12345",
                "sec_iard": None,
                "verification_status": "provisional",
                "verification_provider": "ria_identity_claim",
                "verification_expires_at": None,
                "created_at": _NOW - timedelta(days=1),
                "updated_at": _NOW,
            }
        return None

    async def close(self):
        return None


def _service_with_events(monkeypatch, events: list[dict]) -> RIAIAMService:
    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn(events)

    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _noop)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _noop)
    monkeypatch.setattr(service, "_ensure_actor_profile_row", _noop)
    return service


@pytest.mark.asyncio
async def test_status_returns_latest_claim_event_when_claim_exists(monkeypatch):
    service = _service_with_events(monkeypatch, [_claim_event_row()])

    result = await service.get_ria_onboarding_status("user-1")

    claim_event = result["latest_claim_event"]
    assert claim_event is not None
    assert claim_event["outcome"] == "provisional"
    assert claim_event["reference_metadata"]["provider"] == "ria_identity_claim"
    assert claim_event["reference_metadata"]["firm_record"]["firm_crd"] == "801-12345"
    assert claim_event["reference_metadata"]["advisor_record"]["individual_crd"] == "12345"


@pytest.mark.asyncio
async def test_claim_event_survives_newer_profile_refresh_event(monkeypatch):
    service = _service_with_events(monkeypatch, [_claim_event_row(), _refresh_event_row()])

    result = await service.get_ria_onboarding_status("user-1")

    # The unfiltered latest event is the newer refresh event...
    latest = result["latest_verification_event"]
    assert latest is not None
    assert latest["reference_metadata"]["provider"] == "profile_refresh"

    # ...but the claim snapshot is still reachable, not shadowed.
    claim_event = result["latest_claim_event"]
    assert claim_event is not None
    assert claim_event["reference_metadata"]["provider"] == "ria_identity_claim"
    assert claim_event["reference_metadata"]["firm_record"]["firm_crd"] == "801-12345"


@pytest.mark.asyncio
async def test_latest_claim_event_is_null_without_claim_event(monkeypatch):
    service = _service_with_events(monkeypatch, [_refresh_event_row()])

    result = await service.get_ria_onboarding_status("user-1")

    assert result["latest_claim_event"] is None
    assert result["latest_verification_event"] is not None


@pytest.mark.asyncio
async def test_latest_claim_event_is_null_with_no_events_at_all(monkeypatch):
    service = _service_with_events(monkeypatch, [])

    result = await service.get_ria_onboarding_status("user-1")

    assert result["latest_claim_event"] is None
    assert result["latest_verification_event"] is None
