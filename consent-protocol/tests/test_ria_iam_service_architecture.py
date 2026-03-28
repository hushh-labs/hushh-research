import pytest

from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.renaissance_service import RenaissanceService
from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError, RIAIAMService
from hushh_mcp.services.ria_verification import validate_regulated_runtime_configuration


def test_runtime_persona_only_overrides_for_setup_mode():
    assert (
        RIAIAMService._resolve_full_mode_last_persona(
            personas=["investor"],
            actor_last_persona="investor",
            runtime_last_persona="ria",
        )
        == "ria"
    )


def test_runtime_persona_does_not_override_real_dual_persona_account():
    assert (
        RIAIAMService._resolve_full_mode_last_persona(
            personas=["investor", "ria"],
            actor_last_persona="investor",
            runtime_last_persona="ria",
        )
        == "investor"
    )


def test_professional_inputs_require_individual_name_for_regulatory_verification():
    try:
        RIAIAMService._prepare_professional_onboarding_inputs(
            display_name="Advisor Alpha",
            requested_capabilities=["advisory"],
            individual_legal_name="",
            individual_crd="12345",
            advisory_firm_legal_name="Advisor Alpha LLC",
            advisory_firm_iapd_number="801-12345",
            broker_firm_legal_name=None,
            broker_firm_crd=None,
            bio=None,
            strategy=None,
            disclosures_url=None,
            require_regulatory_identity=True,
        )
    except RIAIAMPolicyError as exc:
        assert "individual_legal_name" in str(exc)
    else:
        raise AssertionError("Expected individual_legal_name to be required")


def test_professional_inputs_require_individual_crd_for_regulatory_verification():
    try:
        RIAIAMService._prepare_professional_onboarding_inputs(
            display_name="Advisor Alpha",
            requested_capabilities=["advisory"],
            individual_legal_name="Advisor Alpha LLC",
            individual_crd="",
            advisory_firm_legal_name="Advisor Alpha LLC",
            advisory_firm_iapd_number="801-12345",
            broker_firm_legal_name=None,
            broker_firm_crd=None,
            bio=None,
            strategy=None,
            disclosures_url=None,
            require_regulatory_identity=True,
        )
    except RIAIAMPolicyError as exc:
        assert "individual_crd" in str(exc)
    else:
        raise AssertionError("Expected individual_crd to be required")


def test_professional_inputs_require_advisory_firm_identifiers_for_advisory():
    try:
        RIAIAMService._prepare_professional_onboarding_inputs(
            display_name="Advisor Alpha",
            requested_capabilities=["advisory"],
            individual_legal_name="Advisor Alpha LLC",
            individual_crd="12345",
            advisory_firm_legal_name="",
            advisory_firm_iapd_number="",
            broker_firm_legal_name=None,
            broker_firm_crd=None,
            bio=None,
            strategy=None,
            disclosures_url="https://example.com/disclosures",
            require_regulatory_identity=True,
        )
    except RIAIAMPolicyError as exc:
        assert "advisory_firm_legal_name" in str(exc) or "advisory_firm_iapd_number" in str(exc)
    else:
        raise AssertionError("Expected advisory firm identifiers to be required")


def test_professional_inputs_accept_dual_capability_payload():
    payload = RIAIAMService._prepare_professional_onboarding_inputs(
        display_name="Advisor Alpha",
        requested_capabilities=["advisory", "brokerage"],
        individual_legal_name="Advisor Alpha LLC",
        individual_crd="12345",
        advisory_firm_legal_name="Advisor Alpha LLC",
        advisory_firm_iapd_number="801-12345",
        broker_firm_legal_name="Broker Alpha LLC",
        broker_firm_crd="56789",
        bio="Tax-aware planning",
        strategy=None,
        disclosures_url="https://example.com/disclosures",
        require_regulatory_identity=True,
    )

    assert payload["display_name"] == "Advisor Alpha"
    assert payload["individual_legal_name"] == "Advisor Alpha LLC"
    assert payload["individual_crd"] == "12345"
    assert payload["requested_capabilities"] == ["advisory", "brokerage"]
    assert payload["disclosures_url"] == "https://example.com/disclosures"


def test_ria_verified_status_helper_matches_expected_statuses():
    assert RIAIAMService._is_verified_ria_status("verified") is True
    assert RIAIAMService._is_verified_ria_status("active") is True
    assert RIAIAMService._is_verified_ria_status("bypassed") is True
    assert RIAIAMService._is_verified_ria_status("submitted") is False


def test_regulated_runtime_guard_requires_iapd_in_production(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.setenv("BROKER_VERIFICATION_BYPASS_ENABLED", "false")

    try:
        validate_regulated_runtime_configuration()
    except RuntimeError as exc:
        assert "IAPD_VERIFY_BASE_URL" in str(exc)
    else:
        raise AssertionError("Expected production runtime guard to require IAPD config")


def test_regulated_runtime_guard_rejects_prod_bypass(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("IAPD_VERIFY_BASE_URL", "https://iapd.example.com")
    monkeypatch.setenv("IAPD_VERIFY_API_KEY", "secret")
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "true")
    monkeypatch.setenv("BROKER_VERIFICATION_BYPASS_ENABLED", "false")

    try:
        validate_regulated_runtime_configuration()
    except RuntimeError as exc:
        assert "BYPASS" in str(exc)
    else:
        raise AssertionError("Expected production runtime guard to reject bypass flags")


def test_renaissance_service_exposes_generic_security_list_descriptors():
    descriptors = RenaissanceService().list_descriptors()
    ids = {descriptor.list_id for descriptor in descriptors}

    assert "renaissance_universe" in ids
    assert "renaissance_avoid" in ids
    assert "renaissance_screening_criteria" in ids


def test_relationship_share_summary_describes_implicit_picks_benefit():
    summary = RIAIAMService._relationship_share_summary("ria_active_picks_feed_v1")

    assert "advisor's active picks list" in summary.lower()


def test_picks_feed_status_reflects_relationship_and_upload_state():
    assert (
        RIAIAMService._picks_feed_status(
            relationship_status="approved",
            share_status="active",
            has_active_pick_upload=True,
        )
        == "ready"
    )
    assert (
        RIAIAMService._picks_feed_status(
            relationship_status="approved",
            share_status="active",
            has_active_pick_upload=False,
        )
        == "pending"
    )
    assert (
        RIAIAMService._picks_feed_status(
            relationship_status="request_pending",
            share_status="active",
            has_active_pick_upload=True,
        )
        == "included_on_approval"
    )
    assert (
        RIAIAMService._picks_feed_status(
            relationship_status="approved",
            share_status="revoked",
            has_active_pick_upload=True,
        )
        == "unavailable"
    )


def test_consent_center_outgoing_request_preserves_additional_access_summary():
    entry = ConsentCenterService()._normalize_outgoing(
        {
            "request_id": "req_1",
            "user_id": "investor_1",
            "scope": "attr.financial.*",
            "action": "REQUESTED",
            "issued_at": 1,
            "expires_at": 2,
            "subject_display_name": "Taylor",
            "metadata": {
                "reason": "Need advisory context",
                "additional_access_summary": "Approving this relationship also unlocks the advisor picks feed.",
            },
        }
    )

    assert (
        entry["additional_access_summary"]
        == "Approving this relationship also unlocks the advisor picks feed."
    )


def test_consent_center_pending_surface_excludes_duplicate_developer_entries():
    center = {
        "incoming_requests": [{"id": "req_1", "status": "pending", "kind": "incoming_request"}],
        "developer_requests": [{"id": "req_1", "status": "pending", "kind": "incoming_request"}],
    }

    items = ConsentCenterService()._entries_for_surface(
        center,
        actor="investor",
        surface="pending",
    )

    assert [item["id"] for item in items] == ["req_1"]


def test_consent_center_pending_surface_only_returns_actionable_ria_rows():
    center = {
        "outgoing_requests": [
            {"id": "req_pending", "status": "request_pending", "kind": "outgoing_request"},
            {"id": "req_denied", "status": "denied", "kind": "outgoing_request"},
            {"id": "req_expired", "status": "expired", "kind": "outgoing_request"},
        ],
        "invites": [
            {"id": "invite_sent", "status": "sent", "kind": "invite"},
            {"id": "invite_accepted", "status": "accepted", "kind": "invite"},
        ],
        "history": [
            {"id": "history_requested", "status": "request_pending", "kind": "history"},
            {"id": "history_denied", "status": "denied", "kind": "history"},
        ],
    }

    service = ConsentCenterService()

    pending = service._entries_for_surface(center, actor="ria", surface="pending")
    previous = service._entries_for_surface(center, actor="ria", surface="previous")

    assert [item["id"] for item in pending] == ["req_pending", "invite_sent"]
    assert {item["id"] for item in previous} == {
        "history_denied",
        "req_denied",
        "req_expired",
        "invite_accepted",
    }


@pytest.mark.asyncio
async def test_list_investor_pick_sources_requires_active_relationship_share(monkeypatch):
    class _FakeConn:
        async def fetch(self, query: str, *_args):
            assert "relationship_share_grants picks_share" in query
            return [
                {
                    "ria_profile_id": "ria_profile_1",
                    "ria_user_id": "ria_user_1",
                    "label": "Advisor Alpha",
                    "upload_id": "upload_1",
                    "share_status": "active",
                    "share_granted_at": "2026-03-24T00:00:00Z",
                    "share_metadata": {"share_origin": "relationship_implicit"},
                }
            ]

        async def close(self):
            return None

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)

    items = await service.list_investor_pick_sources("investor_1")

    assert len(items) == 1
    assert items[0]["id"] == "ria:ria_profile_1"
    assert items[0]["state"] == "ready"
    assert items[0]["share_status"] == "active"
    assert items[0]["share_origin"] == "relationship_implicit"


@pytest.mark.asyncio
async def test_get_pick_rows_for_source_returns_empty_without_active_relationship_share(
    monkeypatch,
):
    class _FakeConn:
        async def fetchrow(self, query: str, *_args):
            assert "relationship_share_grants share" in query
            return None

        async def fetch(self, _query: str, *_args):
            raise AssertionError("Pick rows should not be fetched without an active share grant")

        async def close(self):
            return None

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)

    rows = await service.get_pick_rows_for_source("investor_1", "ria:ria_profile_1")

    assert rows == []
