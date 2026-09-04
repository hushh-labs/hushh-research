import json
from types import SimpleNamespace

import pytest

from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.renaissance_service import RenaissanceService
from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError, RIAIAMService
from hushh_mcp.services.ria_verification import (
    NameVerificationResult,
    validate_regulated_runtime_configuration,
)


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


def test_name_first_inputs_allow_missing_manual_regulatory_identity():
    payload = RIAIAMService._prepare_professional_onboarding_inputs(
        display_name="Advisor Alpha",
        requested_capabilities=["advisory"],
        individual_legal_name="",
        individual_crd="",
        advisory_firm_legal_name="",
        advisory_firm_iapd_number="",
        broker_firm_legal_name=None,
        broker_firm_crd=None,
        bio=None,
        strategy=None,
        disclosures_url=None,
        require_regulatory_identity=False,
        require_advisory_firm_identifiers=False,
    )

    assert payload["display_name"] == "Advisor Alpha"
    assert payload["individual_legal_name"] is None
    assert payload["advisory_firm_iapd_number"] is None


def test_ria_verified_status_helper_matches_expected_statuses():
    assert RIAIAMService._is_verified_ria_status("verified") is True
    assert RIAIAMService._is_verified_ria_status("active") is True
    assert RIAIAMService._is_verified_ria_status("bypassed") is False
    assert RIAIAMService._is_verified_ria_status("submitted") is False


def test_regulated_runtime_guard_requires_a_provider_in_production(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.setenv("BROKER_VERIFICATION_BYPASS_ENABLED", "false")

    try:
        validate_regulated_runtime_configuration()
    except RuntimeError as exc:
        assert "advisory verification provider must be configured" in str(exc)
    else:
        raise AssertionError(
            "Expected production runtime guard to require an advisory verification provider"
        )


def test_regulated_runtime_guard_accepts_ria_intelligence_only(monkeypatch):
    # RIA intelligence is the provider actually used today (UAT verifies through
    # it); the guard must accept it without IAPD configured.
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intel.example.com")
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.setenv("RIA_DEV_BYPASS_ENABLED", "false")
    monkeypatch.setenv("BROKER_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.delenv("RIA_DEV_ALLOWLIST", raising=False)

    # Should not raise: a configured advisory provider is present.
    validate_regulated_runtime_configuration()


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


def test_license_verification_payload_maps_to_submit_name_lookup():
    result = RIAIAMService._name_lookup_from_license_verification_payload(
        {
            "verifiedName": "Advisor Alpha",
            "crdNumber": "12345",
            "currentFirm": "Advisor Alpha LLC",
            "status": "ACTIVE",
            "disclosures": {"count": 0},
        },
        license_number="12345",
        submitted_individual_crd="12345",
    )

    assert result is not None
    assert result.status == "verified"
    assert result.matched_name == "Advisor Alpha"
    assert result.crd_number == "12345"
    assert result.current_firm == "Advisor Alpha LLC"
    assert result.provider == "broker_intelligence_license_verification"


def test_license_verification_payload_rejects_crd_mismatch():
    result = RIAIAMService._name_lookup_from_license_verification_payload(
        {
            "verifiedName": "Advisor Alpha",
            "crdNumber": "99999",
            "currentFirm": "Advisor Alpha LLC",
            "status": "ACTIVE",
        },
        license_number="12345",
        submitted_individual_crd="12345",
    )

    assert result is None


@pytest.mark.asyncio
async def test_verify_ria_name_serializes_verified_stage1_lookup(monkeypatch):
    service = RIAIAMService()

    async def _mock_lookup(
        *,
        query: str,
        crd_number: str | None = None,
        use_cache: bool = True,
    ):
        assert query == "Advisor Alpha"
        assert crd_number is None
        assert use_cache is True
        return NameVerificationResult(
            status="verified",
            matched_name="Advisor Alpha",
            crd_number="12345",
            current_firm="Advisor Alpha LLC",
            sec_number="801-12345",
            provider="ria_intelligence_stage1",
        )

    monkeypatch.setattr(service._name_verification_gateway, "verify_name", _mock_lookup)

    result = await service.verify_ria_name("Advisor Alpha")

    assert result["status"] == "verified"
    assert result["matched_name"] == "Advisor Alpha"
    assert result["crd_number"] == "12345"


@pytest.mark.asyncio
async def test_verify_ria_name_serializes_reason_code_for_broad_queries(monkeypatch):
    service = RIAIAMService()

    async def _mock_lookup(
        *,
        query: str,
        crd_number: str | None = None,
        use_cache: bool = True,
    ):
        assert query == "Andrew G"
        assert crd_number is None
        assert use_cache is True
        return NameVerificationResult(
            status="not_verified",
            matched_name=None,
            crd_number=None,
            current_firm=None,
            sec_number=None,
            reason=(
                "The query 'Andrew G' is too broad and lacks a full last name or firm context."
            ),
            reason_code="query_too_broad",
            suggested_names=["Andrew Garrett Kirkland"],
            provider="ria_intelligence_stage1",
        )

    monkeypatch.setattr(service._name_verification_gateway, "verify_name", _mock_lookup)

    result = await service.verify_ria_name("Andrew G")

    assert result["status"] == "not_verified"
    assert result["reason_code"] == "query_too_broad"
    assert result["suggested_names"] == ["Andrew Garrett Kirkland"]


@pytest.mark.asyncio
async def test_submit_ria_onboarding_reverifies_stage1_before_granting_access(monkeypatch):
    service = RIAIAMService()

    class _FakeTransaction:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FakeConn:
        def transaction(self):
            return _FakeTransaction()

        async def fetchrow(self, query: str, *_args):
            if "INSERT INTO ria_profiles" in query:
                return {"id": "ria-profile-1", "user_id": "user-1", "display_name": "Advisor Alpha"}
            if "INSERT INTO ria_firms" in query:
                return {"id": "firm-1"}
            return None

        async def execute(self, *_args, **_kwargs):
            return None

        async def close(self):
            return None

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    async def _fake_vault_user_row(_conn, _user_id):
        return None

    async def _fake_runtime_persona(_conn, _user_id, _persona):
        return None

    async def _fake_verify_name_result(
        query: str,
        *,
        crd_number: str | None = None,
        use_cache: bool = True,
    ):
        assert query == "Advisor Alpha"
        assert crd_number == "12345"
        assert use_cache is False
        return NameVerificationResult(
            status="verified",
            matched_name="Advisor Alpha",
            crd_number="12345",
            current_firm="Advisor Alpha LLC",
            sec_number="801-12345",
            provider="ria_intelligence_stage1",
        )

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _fake_vault_user_row)
    monkeypatch.setattr(service, "_set_runtime_last_persona", _fake_runtime_persona)
    monkeypatch.setattr(service, "_verify_ria_name_result", _fake_verify_name_result)

    result = await service.submit_ria_onboarding(
        "user-1",
        display_name="Advisor Alpha",
        requested_capabilities=["advisory"],
        individual_crd="12345",
        force_live_verification=True,
        strategy="Long-term planning",
    )

    assert result["verification_status"] == "verified"
    assert result["advisory_status"] == "verified"
    assert result["professional_access_granted"] is True
    assert result["individual_crd"] == "12345"


@pytest.mark.asyncio
async def test_submit_ria_onboarding_reuses_recent_license_verification(monkeypatch):
    service = RIAIAMService()

    class _FakeTransaction:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FakeConn:
        def transaction(self):
            return _FakeTransaction()

        async def fetchrow(self, query: str, *_args):
            if "INSERT INTO ria_profiles" in query:
                return {"id": "ria-profile-1", "user_id": "user-1", "display_name": "Advisor Alpha"}
            if "INSERT INTO ria_firms" in query:
                return {"id": "firm-1"}
            return None

        async def execute(self, *_args, **_kwargs):
            return None

        async def close(self):
            return None

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    async def _fake_vault_user_row(_conn, _user_id):
        return None

    async def _fake_runtime_persona(_conn, _user_id, _persona):
        return None

    async def _fake_license_lookup_result(
        *,
        user_id: str,
        license_number: str | None,
        submitted_individual_crd: str | None,
    ):
        assert user_id == "user-1"
        assert license_number == "12345"
        assert submitted_individual_crd == "12345"
        return NameVerificationResult(
            status="verified",
            matched_name="Advisor Alpha",
            crd_number="12345",
            current_firm="Advisor Alpha LLC",
            sec_number=None,
            provider="broker_intelligence_license_verification",
        )

    async def _unexpected_verify_name_result(*_args, **_kwargs):
        raise AssertionError("submit should reuse the recent license verification audit")

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _fake_vault_user_row)
    monkeypatch.setattr(service, "_set_runtime_last_persona", _fake_runtime_persona)
    monkeypatch.setattr(
        service,
        "_lookup_recent_license_verification_result",
        _fake_license_lookup_result,
    )
    monkeypatch.setattr(service, "_verify_ria_name_result", _unexpected_verify_name_result)

    result = await service.submit_ria_onboarding(
        "user-1",
        display_name="Advisor Alpha",
        requested_capabilities=["advisory"],
        individual_crd="12345",
        license_number="12345",
        force_live_verification=False,
        strategy="Long-term planning",
    )

    assert result["verification_status"] == "verified"
    assert result["advisory_status"] == "verified"
    assert result["professional_access_granted"] is True
    assert result["individual_crd"] == "12345"


@pytest.mark.asyncio
async def test_submit_ria_onboarding_rejects_entered_crd_mismatch(monkeypatch):
    service = RIAIAMService()

    async def _fake_verify_name_result(
        query: str,
        *,
        crd_number: str | None = None,
        use_cache: bool = True,
    ):
        assert query == "Advisor Alpha"
        assert crd_number == "12345"
        assert use_cache is False
        return NameVerificationResult(
            status="verified",
            matched_name="Advisor Alpha",
            crd_number="99999",
            current_firm="Advisor Alpha LLC",
            sec_number="801-12345",
            provider="ria_intelligence_stage1",
        )

    class DummyTx:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class DummyConn:
        def transaction(self):
            return DummyTx()

        async def fetchrow(self, _query, *args):
            _ = args
            return {
                "id": "ria-1",
                "user_id": "user-1",
                "display_name": "Advisor Alpha",
                "legal_name": "Advisor Alpha",
                "finra_crd": "12345",
                "sec_iard": "801-12345",
                "verification_status": "submitted",
            }

        async def execute(self, _query, *args):
            _ = args
            return "OK"

        async def close(self):
            return None

    async def _fake_conn():
        return DummyConn()

    async def _fake_schema_ready(_conn):
        return None

    async def _fake_vault_user_row(_conn, _user_id):
        return None

    async def _fake_runtime_persona(_conn, _user_id, _persona):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _fake_vault_user_row)
    monkeypatch.setattr(service, "_set_runtime_last_persona", _fake_runtime_persona)
    monkeypatch.setattr(service, "_verify_ria_name_result", _fake_verify_name_result)

    result = await service.submit_ria_onboarding(
        "user-1",
        display_name="Advisor Alpha",
        requested_capabilities=["advisory"],
        individual_crd="12345",
        force_live_verification=True,
    )

    assert result["verification_status"] == "submitted"
    assert result["advisory_status"] == "submitted"
    assert result["professional_access_granted"] is False
    assert result["individual_crd"] == "12345"


@pytest.mark.asyncio
async def test_submit_ria_onboarding_uses_provider_returned_crd(monkeypatch):
    service = RIAIAMService()

    async def _fake_verify_name_result(
        query: str,
        *,
        crd_number: str | None = None,
        use_cache: bool = True,
    ):
        assert query == "Advisor Alpha"
        assert crd_number is None
        assert use_cache is False
        return NameVerificationResult(
            status="verified",
            matched_name="Advisor Alpha",
            crd_number="99999",
            current_firm="Advisor Alpha LLC",
            sec_number="801-12345",
            provider="ria_intelligence_stage1",
        )

    class DummyTx:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class DummyConn:
        def transaction(self):
            return DummyTx()

        async def fetchrow(self, _query, *args):
            _ = args
            return {
                "id": "ria-1",
                "user_id": "user-1",
                "display_name": "Advisor Alpha",
                "legal_name": "Advisor Alpha",
                "finra_crd": "99999",
                "sec_iard": "801-12345",
                "verification_status": "verified",
            }

        async def execute(self, _query, *args):
            _ = args
            return "OK"

        async def close(self):
            return None

    async def _fake_conn():
        return DummyConn()

    async def _fake_schema_ready(_conn):
        return None

    async def _fake_vault_user_row(_conn, _user_id):
        return None

    async def _fake_runtime_persona(_conn, _user_id, _persona):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _fake_vault_user_row)
    monkeypatch.setattr(service, "_set_runtime_last_persona", _fake_runtime_persona)
    monkeypatch.setattr(service, "_verify_ria_name_result", _fake_verify_name_result)

    result = await service.submit_ria_onboarding(
        "user-1",
        display_name="Advisor Alpha",
        requested_capabilities=["advisory"],
        force_live_verification=True,
    )

    assert result["verification_status"] == "verified"
    assert result["individual_crd"] == "99999"


@pytest.mark.asyncio
async def test_refresh_ria_profile_from_license_updates_official_fields_only(monkeypatch):
    service = RIAIAMService()
    executed: list[tuple[str, tuple]] = []

    class DummyTx:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class DummyConn:
        def transaction(self):
            return DummyTx()

        async def fetchrow(self, query, *args):
            _ = args
            if "FROM ria_profiles" in query:
                return {
                    "id": "ria-1",
                    "user_id": "user-1",
                    "display_name": "User Authored Name",
                    "legal_name": "Old Legal Name",
                    "finra_crd": "11111",
                    "sec_iard": "801-OLD",
                }
            if "INSERT INTO ria_firms" in query:
                return {"id": "firm-1"}
            return None

        async def execute(self, query, *args):
            executed.append((query, args))
            return "OK"

        async def close(self):
            return None

    async def _fake_conn():
        return DummyConn()

    async def _fake_schema_ready(_conn):
        return None

    async def _fake_verify_license(_user_id, **kwargs):
        assert kwargs["license_number"] == "7413463"
        return {
            "status": "found",
            "advisor_name": "Andrew Garrett Kirkland",
            "firm_name": "Financial Advocates Advisory Services",
            "regulator": "SEC",
            "regulator_status": "ACTIVE",
            "certifications": ["SIE", "Series 7TO"],
            "city": "Kennesaw",
            "state": "GA",
            "pin_zip": "30144",
            "full_street_address": "123 Main St",
            "crd_number": "7413463",
            "provider": "ria_intelligence_combined",
        }

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "verify_ria_license", _fake_verify_license)

    result = await service.refresh_ria_profile_from_license(
        "user-1",
        license_number="7413463",
        regulator="SEC",
        force_live_verification=True,
    )

    assert result["updated"] is True
    assert result["profile"]["business_city"] == "Kennesaw"
    assert "services_offered" not in result["applied_fields"]
    update_profile_queries = [query for query, _args in executed if "UPDATE ria_profiles" in query]
    assert update_profile_queries
    profile_update = update_profile_queries[0]
    assert "bio =" not in profile_update
    assert "strategy =" not in profile_update
    assert "services_offered =" not in profile_update
    assert "fee_structure =" not in profile_update
    assert "min_engagement_amount =" not in profile_update


@pytest.mark.asyncio
async def test_refresh_ria_profile_from_license_preserves_profile_on_provider_failure(
    monkeypatch,
):
    service = RIAIAMService()
    executed: list[str] = []

    class DummyTx:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class DummyConn:
        def transaction(self):
            return DummyTx()

        async def fetchrow(self, query, *args):
            _ = args
            if "FROM ria_profiles" in query:
                return {
                    "id": "ria-1",
                    "user_id": "user-1",
                    "display_name": "User Authored Name",
                    "legal_name": "Old Legal Name",
                    "finra_crd": "11111",
                    "sec_iard": "801-OLD",
                }
            return None

        async def execute(self, query, *args):
            _ = args
            executed.append(query)
            return "OK"

        async def close(self):
            return None

    async def _fake_conn():
        return DummyConn()

    async def _fake_schema_ready(_conn):
        return None

    async def _fake_verify_license(_user_id, **_kwargs):
        return {
            "status": "not_found",
            "provider": "ria_intelligence_combined",
        }

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "verify_ria_license", _fake_verify_license)

    result = await service.refresh_ria_profile_from_license(
        "user-1",
        license_number="0000000",
    )

    assert result["updated"] is False
    assert result["applied_fields"] == []
    assert not any("UPDATE ria_profiles" in query for query in executed)


def test_dev_activation_method_removed():
    """activate_ria_dev_onboarding was fully removed — method must not exist."""
    service = RIAIAMService()
    assert not hasattr(service, "activate_ria_dev_onboarding")


def test_renaissance_service_exposes_generic_security_list_descriptors():
    descriptors = RenaissanceService().list_descriptors()
    ids = {descriptor.list_id for descriptor in descriptors}

    assert "renaissance_universe" in ids
    assert "renaissance_avoid" in ids
    assert "renaissance_screening_criteria" in ids


def test_relationship_share_summary_describes_explicit_picks_capability():
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


def test_consent_center_generic_ria_consent_is_not_a_connection_request():
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
                "additional_access_summary": "Scope details are reviewed separately.",
            },
        }
    )

    assert entry["kind"] == "outgoing_request"
    assert not ConsentCenterService._is_connection_entry(entry, actor="ria")
    assert entry["additional_access_summary"] == "Scope details are reviewed separately."


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


def test_consent_center_collapses_visible_entries_by_requester_subject_and_scope():
    entries = [
        {
            "id": "req_latest",
            "request_id": "req_latest",
            "status": "pending",
            "action": "REQUESTED",
            "scope": "attr.shopping.receipts_memory.*",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "counterpart_label": "Google Ads Agent",
            "issued_at": 200,
            "metadata": {"subject_user_id": "user_123"},
        },
        {
            "id": "req_older",
            "request_id": "req_older",
            "status": "expired",
            "action": "TIMEOUT",
            "scope": "attr.shopping.receipts_memory.*",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "counterpart_label": "Google Ads Agent",
            "issued_at": 100,
            "metadata": {"subject_user_id": "user_123"},
        },
    ]

    collapsed = ConsentCenterService._collapse_consent_chains(entries)

    assert len(collapsed) == 1
    assert collapsed[0]["request_id"] == "req_latest"
    assert collapsed[0]["chain_request_count"] == 2
    assert collapsed[0]["chain_request_ids"] == ["req_latest", "req_older"]
    assert collapsed[0]["normalized_scope"] == "attr.shopping.receipts_memory.*"
    assert len(collapsed[0]["consent_chain"]) == 2


def test_consent_center_history_groups_one_identifier_with_scope_trails():
    entries = [
        {
            "id": "evt_latest",
            "request_id": "req_latest",
            "status": "approved",
            "action": "CONSENT_GRANTED",
            "scope": "attr.shopping.receipts_memory.*",
            "scope_description": "Shopping receipts",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "counterpart_label": "Google Ads Agent",
            "issued_at": 300,
            "metadata": {"subject_user_id": "user_123"},
        },
        {
            "id": "evt_scope_2",
            "request_id": "req_scope_2",
            "status": "denied",
            "action": "CONSENT_DENIED",
            "scope": "attr.email.receipts.*",
            "scope_description": "Email receipts",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "counterpart_label": "Google Ads Agent",
            "issued_at": 200,
            "metadata": {"subject_user_id": "user_123"},
        },
        {
            "id": "evt_older",
            "request_id": "req_older",
            "status": "expired",
            "action": "TIMEOUT",
            "scope": "attr.shopping.receipts_memory.*",
            "scope_description": "Shopping receipts",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "counterpart_label": "Google Ads Agent",
            "issued_at": 100,
            "metadata": {"subject_user_id": "user_123"},
        },
    ]

    grouped = ConsentCenterService._group_history_identifier_trails(entries)

    assert len(grouped) == 1
    assert grouped[0]["id"] == "identifier:developer|developer:google_ads|user_123"
    assert grouped[0]["request_id"] == "req_latest"
    assert grouped[0]["trail_count"] == 3
    assert grouped[0]["event_count"] == 3
    assert grouped[0]["consent_trails"][0]["scope"] == "attr.shopping.receipts_memory.*"
    assert grouped[0]["consent_trails"][0]["request_ids"] == ["req_latest"]
    assert [event["request_id"] for event in grouped[0]["consent_chain"]] == [
        "req_latest",
    ]


def test_consent_center_history_keeps_different_subjects_separate():
    entries = [
        {
            "id": "evt_user_1",
            "request_id": "req_user_1",
            "status": "approved",
            "scope": "attr.shopping.receipts_memory.*",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "issued_at": 200,
            "metadata": {"subject_user_id": "user_1"},
        },
        {
            "id": "evt_user_2",
            "request_id": "req_user_2",
            "status": "approved",
            "scope": "attr.shopping.receipts_memory.*",
            "counterpart_type": "developer",
            "counterpart_id": "developer:google_ads",
            "issued_at": 100,
            "metadata": {"subject_user_id": "user_2"},
        },
    ]

    grouped = ConsentCenterService._group_history_identifier_trails(entries)

    assert len(grouped) == 2
    assert {entry["identifier_key"] for entry in grouped} == {
        "developer|developer:google_ads|user_1",
        "developer|developer:google_ads|user_2",
    }


@pytest.mark.asyncio
async def test_consent_center_summary_uses_surface_loaders_without_get_center(monkeypatch):
    # No env var set at all: this is the default now, not an opt-in.
    monkeypatch.delenv("CONSENT_CENTER_SUMMARY_V2_ENABLED", raising=False)
    service = ConsentCenterService()
    contributor_calls = {"location": 0, "marketplace": 0, "connections": 0}

    async def _unexpected_get_center(*_args, **_kwargs):  # noqa: ANN002,ANN003
        raise AssertionError("get_center should not be used for summary counts")

    async def _pending(_user_id: str):
        return [{"id": "pending_1"}, {"id": "pending_2"}]

    async def _active(_user_id: str):
        return [{"id": "active_1"}]

    async def _previous(_user_id: str):
        return [
            {"id": "history_1", "counterpart_id": "developer:one"},
            {"id": "history_2", "counterpart_id": "developer:two"},
            {"id": "history_3", "counterpart_id": "developer:three"},
        ]

    async def _location(_user_id: str):
        contributor_calls["location"] += 1
        return {
            "incoming_requests": [],
            "active_grants": [],
            "history": [],
        }

    async def _marketplace(_user_id: str):
        contributor_calls["marketplace"] += 1
        return {
            "incoming_requests": [],
            "active_grants": [],
            "history": [],
        }

    async def _connections(_user_id: str):
        contributor_calls["connections"] += 1
        return 0

    monkeypatch.setattr(service, "get_center", _unexpected_get_center)
    monkeypatch.setattr(service, "_load_investor_pending_entries", _pending)
    monkeypatch.setattr(service, "_load_investor_active_entries", _active)
    monkeypatch.setattr(service, "_load_investor_previous_entries", _previous)
    monkeypatch.setattr(service, "_location_buckets_async", _location)
    monkeypatch.setattr(service, "_marketplace_buckets_async", _marketplace)
    monkeypatch.setattr(service, "_incoming_connection_request_count", _connections)

    payload = await service.get_center_summary("investor_1", actor="investor")

    assert payload["counts"] == {"pending": 2, "active": 1, "previous": 3}
    assert contributor_calls == {"location": 1, "marketplace": 1, "connections": 1}


@pytest.mark.asyncio
async def test_consent_center_summary_ria_actor_always_uses_legacy_surface_counts(monkeypatch):
    """The single-fetch optimization only covers the investor actor -- the
    branch in `get_center_summary` that calls `_location_buckets_async` /
    `_marketplace_buckets_async` once is `elif normalized_actor == "investor"`,
    so a ria actor keeps the three independent `_get_surface_count` calls
    regardless of the feature flag. Unset here (the default) on purpose: this
    must stay true whether or not V2 is enabled."""
    monkeypatch.delenv("CONSENT_CENTER_SUMMARY_V2_ENABLED", raising=False)
    service = ConsentCenterService()
    calls: list[tuple[str, str, str]] = []

    async def _surface_count(user_id: str, *, actor: str, surface: str, mode: str) -> int:
        calls.append((user_id, actor, surface))
        return {"pending": 3, "active": 2, "previous": 1}[surface]

    monkeypatch.setattr(service, "_get_surface_count", _surface_count)

    payload = await service.get_center_summary("user_1", actor="ria")

    assert payload["counts"] == {"pending": 3, "active": 2, "previous": 1}
    assert calls == [
        ("user_1", "ria", "pending"),
        ("user_1", "ria", "active"),
        ("user_1", "ria", "previous"),
    ]


@pytest.mark.asyncio
async def test_consent_center_summary_explicit_opt_out_uses_legacy_surface_counts(monkeypatch):
    """`CONSENT_CENTER_SUMMARY_V2_ENABLED=false` is the rollback lever for the
    investor actor's single-fetch path -- explicitly disabling it must still
    fall all the way back to the original three-`_get_surface_count`-calls
    behavior."""
    monkeypatch.setenv("CONSENT_CENTER_SUMMARY_V2_ENABLED", "false")
    service = ConsentCenterService()
    calls: list[tuple[str, str, str]] = []

    async def _surface_count(user_id: str, *, actor: str, surface: str, mode: str) -> int:
        calls.append((user_id, actor, surface))
        return {"pending": 3, "active": 2, "previous": 1}[surface]

    async def _unexpected(*_args, **_kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("V2 loaders must not run while explicitly disabled")

    monkeypatch.setattr(service, "_get_surface_count", _surface_count)
    monkeypatch.setattr(service, "_location_buckets_async", _unexpected)
    monkeypatch.setattr(service, "_marketplace_buckets_async", _unexpected)
    monkeypatch.setattr(service, "_incoming_connection_request_count", _unexpected)

    payload = await service.get_center_summary("user_1", actor="investor")

    assert payload["counts"] == {"pending": 3, "active": 2, "previous": 1}
    assert calls == [
        ("user_1", "investor", "pending"),
        ("user_1", "investor", "active"),
        ("user_1", "investor", "previous"),
    ]


@pytest.mark.asyncio
async def test_consent_center_summary_connections_mode_fetches_entries_once(monkeypatch):
    """`mode=connections` has its own v2 branch, reachable by real traffic --
    the Consent Center page's Connections tab passes it through to this exact
    endpoint. It must fetch `_load_connection_entries_for_actor` once and
    derive all three counts from it via `_connection_surface_for_status`,
    the same predicate the legacy per-surface path used, rather than the
    legacy path's three independent fetches."""
    monkeypatch.delenv("CONSENT_CENTER_SUMMARY_V2_ENABLED", raising=False)
    service = ConsentCenterService()
    fetch_calls = 0

    async def _connection_entries(_user_id: str, *, actor: str):
        nonlocal fetch_calls
        fetch_calls += 1
        return [
            {"id": "c1", "status": "pending"},
            {"id": "c2", "status": "pending"},
            {"id": "c3", "status": "accepted"},
            {"id": "c4", "status": "rejected"},
            {"id": "c5", "status": "revoked"},
        ]

    monkeypatch.setattr(service, "_load_connection_entries_for_actor", _connection_entries)

    payload = await service.get_center_summary("user_1", actor="ria", mode="connections")

    assert payload["counts"] == {"pending": 2, "active": 1, "previous": 2}
    assert fetch_calls == 1


@pytest.mark.asyncio
async def test_consent_center_list_investor_pending_avoids_monolithic_center(monkeypatch):
    service = ConsentCenterService()

    async def _unexpected_get_center(*_args, **_kwargs):  # noqa: ANN002,ANN003
        raise AssertionError("get_center should not be used for paged list loading")

    async def _pending(_user_id: str):
        return [
            {
                "id": "req_3",
                "issued_at": 300,
                "counterpart_label": "Later request",
                "status": "pending",
            },
            {
                "id": "req_2",
                "issued_at": 200,
                "counterpart_label": "Kai Access",
                "status": "pending",
            },
            {
                "id": "req_1",
                "issued_at": 100,
                "counterpart_label": "Earlier request",
                "status": "pending",
            },
        ]

    monkeypatch.setattr(service, "get_center", _unexpected_get_center)
    monkeypatch.setattr(service, "_load_investor_pending_entries", _pending)

    payload = await service.list_center(
        "investor_1",
        actor="investor",
        surface="pending",
        query="kai",
        page=1,
        limit=20,
    )

    assert payload["total"] == 1
    assert payload["has_more"] is False
    assert [item["id"] for item in payload["items"]] == ["req_2"]


@pytest.mark.asyncio
async def test_consent_center_list_investor_previous_totals_identifier_rows(monkeypatch):
    service = ConsentCenterService()

    async def _previous(_user_id: str):
        return [
            {
                "id": "evt_latest",
                "request_id": "req_latest",
                "issued_at": 300,
                "status": "approved",
                "scope": "attr.shopping.receipts_memory.*",
                "counterpart_type": "developer",
                "counterpart_id": "developer:google_ads",
                "metadata": {"subject_user_id": "user_123"},
            },
            {
                "id": "evt_other_scope",
                "request_id": "req_other_scope",
                "issued_at": 200,
                "status": "denied",
                "scope": "attr.email.receipts.*",
                "scope_description": "Email receipts",
                "counterpart_type": "developer",
                "counterpart_id": "developer:google_ads",
                "metadata": {"subject_user_id": "user_123"},
            },
            {
                "id": "evt_other_identifier",
                "request_id": "req_other_identifier",
                "issued_at": 100,
                "status": "expired",
                "scope": "attr.shopping.receipts_memory.*",
                "counterpart_type": "developer",
                "counterpart_id": "developer:crm",
                "metadata": {"subject_user_id": "user_123"},
            },
        ]

    monkeypatch.setattr(service, "_load_investor_previous_entries", _previous)

    payload = await service.list_center(
        "investor_1",
        actor="investor",
        surface="previous",
        page=1,
        limit=20,
    )

    assert payload["total"] == 2
    assert payload["items"][0]["identifier_key"] == "developer|developer:google_ads|user_123"
    assert payload["items"][0]["trail_count"] == 2
    assert payload["items"][0]["event_count"] == 2

    filtered_payload = await service.list_center(
        "investor_1",
        actor="investor",
        surface="previous",
        query="Email receipts",
        page=1,
        limit=20,
    )

    assert filtered_payload["total"] == 1
    assert filtered_payload["items"][0]["identifier_key"] == (
        "developer|developer:google_ads|user_123"
    )


@pytest.mark.asyncio
async def test_consent_center_pending_expands_verified_account_identifiers(monkeypatch):
    service = ConsentCenterService()
    captured: dict[str, object] = {}

    async def _identifiers(_user_id: str):
        return [
            "firebase_uid_123",
            "akshat@example.com",
            "jd77v9k4nx@privaterelay.appleid.com",
        ]

    class _FakeConsentDBService:
        async def get_pending_requests(self, user_id: str, *, user_ids=None):
            captured["user_id"] = user_id
            captured["user_ids"] = user_ids
            return [
                {
                    "id": "req_alias",
                    "subjectUserId": "jd77v9k4nx@privaterelay.appleid.com",
                    "developer": "developer:app_demo",
                    "scope": "pkm.read",
                    "scopeDescription": "Read PKM",
                    "requestedAt": 100,
                    "pollTimeoutAt": 200,
                    "metadata": {"developer_app_display_name": "Demo App"},
                }
            ]

    async def _hydrate(entries):
        return entries

    monkeypatch.setattr(service._identity, "list_account_identifiers", _identifiers)
    service._consent_db = _FakeConsentDBService()
    monkeypatch.setattr(service, "_hydrate_entry_identities", _hydrate)

    entries = await service._load_investor_pending_entries("firebase_uid_123")

    assert captured["user_id"] == "firebase_uid_123"
    assert captured["user_ids"] == [
        "firebase_uid_123",
        "akshat@example.com",
        "jd77v9k4nx@privaterelay.appleid.com",
    ]
    assert entries[0]["id"] == "req_alias"


@pytest.mark.asyncio
async def test_consent_center_list_preview_top_caps_page_and_limit(monkeypatch):
    service = ConsentCenterService()

    async def _pending(_user_id: str):
        return [
            {"id": "req_6", "issued_at": 600, "counterpart_label": "Six", "status": "pending"},
            {"id": "req_5", "issued_at": 500, "counterpart_label": "Five", "status": "pending"},
            {"id": "req_4", "issued_at": 400, "counterpart_label": "Four", "status": "pending"},
            {"id": "req_3", "issued_at": 300, "counterpart_label": "Three", "status": "pending"},
            {"id": "req_2", "issued_at": 200, "counterpart_label": "Two", "status": "pending"},
            {"id": "req_1", "issued_at": 100, "counterpart_label": "One", "status": "pending"},
        ]

    monkeypatch.setattr(service, "_load_investor_pending_entries", _pending)

    payload = await service.list_center(
        "investor_1",
        actor="investor",
        surface="pending",
        top=5,
        page=9,
        limit=99,
    )

    assert payload["page"] == 1
    assert payload["limit"] == 5
    assert payload["total"] == 6
    assert payload["has_more"] is True
    assert [item["id"] for item in payload["items"]] == [
        "req_6",
        "req_5",
        "req_4",
        "req_3",
        "req_2",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "surface"),
    [("pending", "pending"), ("accepted", "active"), ("rejected", "previous")],
)
async def test_consent_center_connection_mode_uses_explicit_proposal_status(
    monkeypatch,
    status,
    surface,
):
    service = ConsentCenterService()

    async def _connection_entries(_user_id: str, *, actor: str):
        assert actor == "ria"
        return [
            {
                "id": "connection_1",
                "kind": "connection_request",
                "status": status,
                "relationship_state": status,
                "counterpart_label": "Taylor",
                "counterpart_id": "investor_1",
                "metadata": {
                    "scope_proposals": [
                        {
                            "handle": "opaque_scope_handle",
                            "status": "pending" if status == "pending" else "active",
                        }
                    ]
                },
            }
        ]

    monkeypatch.setattr(service, "_load_connection_entries_for_actor", _connection_entries)

    payload = await service.list_center(
        "ria_user_1",
        actor="ria",
        surface=surface,
        mode="connections",
        query="taylor",
        page=1,
        limit=20,
    )

    assert payload["actor"] == "ria"
    assert payload["surface"] == surface
    assert payload["mode"] == "connections"
    assert payload["total"] == 1
    assert payload["items"][0]["kind"] == "connection_request"
    assert payload["items"][0]["status"] == status


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
                    "artifact_id": "artifact_1",
                    "artifact_updated_at": "2026-04-02T12:34:56Z",
                    "source_data_version": 7,
                    "share_status": "active",
                    "share_granted_at": "2026-03-24T00:00:00Z",
                    "share_metadata": {"share_origin": "connection_scope_proposal"},
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
    assert items[0]["artifact_id"] == "artifact_1"
    assert items[0]["artifact_updated_at"] == "2026-04-02T12:34:56Z"
    assert items[0]["source_data_version"] == 7
    assert items[0]["share_status"] == "active"
    assert items[0]["share_origin"] == "connection_scope_proposal"


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


@pytest.mark.asyncio
async def test_get_pick_rows_for_source_prefers_active_share_artifact(monkeypatch):
    class _FakeConn:
        async def fetchrow(self, query: str, *_args):
            if "relationship_share_grants share" in query and "SELECT 1" in query:
                return {"exists": 1}
            if "JOIN ria_pick_share_artifacts artifact" in query:
                return {
                    "artifact_projection": json.dumps(
                        {
                            "top_picks": [
                                {
                                    "ticker": "AAPL",
                                    "company_name": "Apple Inc.",
                                    "sector": "Technology",
                                    "tier": "CORE",
                                    "tier_rank": 1,
                                    "sort_order": 1,
                                    "conviction_weight": 1.0,
                                    "investment_thesis": "Installed base moat",
                                }
                            ],
                            "avoid_rows": [],
                            "screening_sections": [],
                            "package_note": "Smoke package",
                        }
                    )
                }
            raise AssertionError(f"Unexpected fetchrow query: {query}")

        async def close(self):
            return None

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_build_pick_package_projection", lambda package: package)

    rows = await service.get_pick_rows_for_source("investor_1", "ria:ria_profile_1")

    assert len(rows) == 1
    assert rows[0]["ticker"] == "AAPL"


@pytest.mark.asyncio
async def test_queue_ria_invite_email_delivery_records_queue_and_success_metadata(monkeypatch):
    import hushh_mcp.services.ria_iam_service as ria_module

    service = ria_module.RIAIAMService()
    metadata_updates: list[tuple[str, dict[str, object]]] = []
    captured: dict[str, object] = {}

    class _FakeConfig:
        configured = True
        delivery_mode = "test"
        test_to_email = "qa@example.com"
        from_email = "kai@hushh.ai"
        support_to_email = "support@hushh.ai"
        delegated_user = "support@hushh.ai"

    class _FakeInviteEmailService:
        config = _FakeConfig()

        def _effective_recipient(self, target_email: str) -> str:
            _ = target_email
            return "qa@example.com"

        def send_ria_invite(self, **kwargs):  # noqa: ANN003
            captured["send_kwargs"] = kwargs
            return SimpleNamespace(
                accepted=True,
                message_id="msg_1",
                recipient="qa@example.com",
                intended_recipient=kwargs["target_email"],
                delivery_mode="test",
                from_email="kai@hushh.ai",
            )

    class _FakeQueue:
        async def enqueue(self, **kwargs):  # noqa: ANN003
            captured["enqueue_kwargs"] = kwargs
            return {
                "accepted": True,
                "delivery_status": "queued",
                "job_id": "job_1",
                "kind": kwargs["kind"],
                "queued_at": "2026-04-13T00:00:00Z",
            }

    async def _record_update(self, invite_id: str, metadata_patch: dict[str, object]):
        metadata_updates.append((invite_id, metadata_patch))

    monkeypatch.setattr(
        ria_module, "get_kai_invite_email_service", lambda: _FakeInviteEmailService()
    )
    monkeypatch.setattr(ria_module, "get_email_delivery_queue_service", lambda: _FakeQueue())
    monkeypatch.setattr(
        ria_module.RIAIAMService,
        "_update_ria_invite_email_delivery_metadata",
        _record_update,
    )

    created_item: dict[str, object] = {}
    sample_invite_code = "invite-fixture-1"
    await service._queue_ria_invite_email_delivery(
        invite_id="invite_1",
        invite_token=sample_invite_code,
        invite_path=f"/kai/onboarding?invite={sample_invite_code}",
        target_email="investor@example.com",
        target_display_name="Taylor",
        advisor_name="Advisor Alpha",
        firm_name="Advisor Alpha LLC",
        expires_at="2026-05-01T00:00:00Z",
        reason="Come join Kai",
        created_item=created_item,
    )

    assert created_item["delivery_status"] == "queued"
    assert metadata_updates[0][1]["status"] == "queued"
    assert captured["enqueue_kwargs"]["kind"] == "invite_email"

    send_result = captured["enqueue_kwargs"]["send_callable"]()
    await captured["enqueue_kwargs"]["on_success"](send_result)

    assert created_item["delivery_status"] == "sent"
    assert created_item["delivery_message_id"] == "msg_1"
    assert metadata_updates[-1][1]["status"] == "sent"


def test_next_action_for_relationship_status():
    service = RIAIAMService()
    assert service._next_action_for_relationship_status("approved") == "open_workspace"
    assert service._next_action_for_relationship_status("request_pending") == "await_consent"
    assert service._next_action_for_relationship_status("revoked") == "re_request"
    assert service._next_action_for_relationship_status("expired") == "re_request"
    assert service._next_action_for_relationship_status("blocked") == "resolve_block"
    assert service._next_action_for_relationship_status("unknown") == "request_access"


def test_pick_package_projection_bounds_and_attributes_advisor_thesis(monkeypatch):
    import hushh_mcp.services.ria_iam_service as ria_module

    class _SymbolMaster:
        @staticmethod
        def normalize(value):
            return str(value or "").strip().upper()

        @staticmethod
        def get_ticker_metadata(_ticker):
            return {"title": "NVIDIA Corporation", "sector_primary": "Technology"}

    monkeypatch.setattr(ria_module, "get_symbol_master_service", lambda: _SymbolMaster())
    service = RIAIAMService()
    oversized = "A" * 2100

    package = service._build_pick_package_projection(
        {
            "top_picks": [
                {
                    "ticker": "NVDA",
                    "tier": "ACE",
                    "investment_thesis": oversized,
                    "advisor_thesis": {
                        "text": "forged browser text",
                        "authored_by_user_id": "attacker",
                        "source": "ria_picks_editor",
                        "updated_at": "1999-01-01T00:00:00Z",
                    },
                }
            ],
            "avoid_rows": [],
            "screening_sections": [],
        },
        provider_user_id="ria_user_1",
        updated_at="2026-08-28T00:00:00Z",
    )

    row = package["top_picks"][0]
    assert row["investment_thesis"] == "A" * 2000
    assert row["advisor_thesis"] == {
        "text": "A" * 2000,
        "authored_by_user_id": "ria_user_1",
        "source": "ria_picks_editor",
        "updated_at": "2026-08-28T00:00:00Z",
    }


def test_pick_package_projection_allows_absent_advisor_thesis(monkeypatch):
    import hushh_mcp.services.ria_iam_service as ria_module

    class _SymbolMaster:
        @staticmethod
        def normalize(value):
            return str(value or "").strip().upper()

        @staticmethod
        def get_ticker_metadata(_ticker):
            return {"title": "NVIDIA Corporation", "sector_primary": "Technology"}

    monkeypatch.setattr(ria_module, "get_symbol_master_service", lambda: _SymbolMaster())
    service = RIAIAMService()

    package = service._build_pick_package_projection(
        {
            "top_picks": [
                {
                    "ticker": "NVDA",
                    "tier": "ACE",
                    "investment_thesis": "",
                    "advisor_thesis": {
                        "text": "stale browser value",
                        "authored_by_user_id": "attacker",
                        "source": "ria_picks_editor",
                        "updated_at": "1999-01-01T00:00:00Z",
                    },
                }
            ],
            "avoid_rows": [],
            "screening_sections": [],
        },
        provider_user_id="ria_user_1",
        updated_at="2026-08-28T00:00:00Z",
    )

    row = package["top_picks"][0]
    assert row["investment_thesis"] is None
    assert row["advisor_thesis"] is None


def test_pick_package_projection_does_not_resurrect_removed_advisor_thesis(monkeypatch):
    import hushh_mcp.services.ria_iam_service as ria_module

    class _SymbolMaster:
        @staticmethod
        def normalize(value):
            return str(value or "").strip().upper()

        @staticmethod
        def get_ticker_metadata(_ticker):
            return {"title": "NVIDIA Corporation", "sector_primary": "Technology"}

    monkeypatch.setattr(ria_module, "get_symbol_master_service", lambda: _SymbolMaster())
    service = RIAIAMService()

    package = service._build_pick_package_projection(
        {
            "top_picks": [
                {
                    "ticker": "NVDA",
                    "tier": "ACE",
                    "investment_thesis": "",
                    "advisor_thesis": {
                        "text": "OLD_REMOVED_THESIS_MUST_NOT_SURVIVE",
                        "authored_by_user_id": "ria_user_1",
                        "source": "ria_picks_editor",
                        "updated_at": "2026-08-27T00:00:00Z",
                    },
                }
            ],
            "avoid_rows": [],
            "screening_sections": [],
        },
        provider_user_id="ria_user_1",
        updated_at="2026-08-28T00:00:00Z",
    )

    row = package["top_picks"][0]
    assert row["investment_thesis"] is None
    assert row["advisor_thesis"] is None
    assert "OLD_REMOVED_THESIS_MUST_NOT_SURVIVE" not in json.dumps(package)


def test_pick_package_projection_bounds_oversized_advisor_thesis_at_backend(monkeypatch):
    import hushh_mcp.services.ria_iam_service as ria_module

    class _SymbolMaster:
        @staticmethod
        def normalize(value):
            return str(value or "").strip().upper()

        @staticmethod
        def get_ticker_metadata(_ticker):
            return {"title": "NVIDIA Corporation", "sector_primary": "Technology"}

    monkeypatch.setattr(ria_module, "get_symbol_master_service", lambda: _SymbolMaster())
    service = RIAIAMService()

    for oversized in ("B" * 2001, "C" * 2100):
        package = service._build_pick_package_projection(
            {
                "top_picks": [
                    {
                        "ticker": "NVDA",
                        "tier": "ACE",
                        "investment_thesis": oversized,
                    }
                ],
                "avoid_rows": [],
                "screening_sections": [],
            },
            provider_user_id="ria_user_1",
            updated_at="2026-08-28T00:00:00Z",
        )
        row = package["top_picks"][0]
        assert len(row["investment_thesis"]) == 2000
        assert len(row["advisor_thesis"]["text"]) == 2000


@pytest.mark.asyncio
async def test_resolve_investor_pick_source_denies_connection_only_without_share(monkeypatch):
    class _FakeConn:
        async def fetchrow(self, query: str, *args):
            assert args == ("investor_1", "ria_profile_1", "ria_active_picks_feed_v1")
            assert "rel.status = 'approved'" in query
            assert "share.status = 'active'" in query
            assert "proposal.status = 'active'" in query
            assert "proposal.expires_at > NOW()" in query
            assert "artifact.status = 'active'" in query
            return None

        async def close(self):
            return None

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)

    resolved = await service.resolve_investor_pick_source("investor_1", "ria:ria_profile_1")

    assert resolved is None
    assert "CONNECTION_ONLY_THESIS_MUST_NOT_LEAK" not in json.dumps(resolved)


@pytest.mark.asyncio
async def test_resolve_investor_pick_source_denies_wrong_investor(monkeypatch):
    class _FakeConn:
        async def fetchrow(self, _query: str, *args):
            investor_user_id, ria_profile_id, grant_key = args
            assert ria_profile_id == "ria_profile_1"
            assert grant_key == "ria_active_picks_feed_v1"
            if investor_user_id != "investor_a":
                return None
            return {
                "relationship_id": "rel_a",
                "share_grant_id": "grant_a",
                "connection_scope_proposal_id": "proposal_a",
                "ria_user_id": "ria_user_1",
                "label": "Advisor Alpha",
                "artifact_id": "artifact_a",
                "source_data_version": 7,
                "source_manifest_revision": 3,
                "artifact_updated_at": "2026-08-28T00:00:00Z",
                "artifact_projection": json.dumps(
                    {
                        "top_picks": [
                            {
                                "ticker": "NVDA",
                                "tier": "ACE",
                                "investment_thesis": "AUTHORIZED_ONLY_FOR_INVESTOR_A",
                            }
                        ],
                        "avoid_rows": [],
                        "screening_sections": [],
                    }
                ),
            }

        async def close(self):
            return None

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_build_pick_package_projection", lambda package: package)

    denied = await service.resolve_investor_pick_source("investor_b", "ria:ria_profile_1")
    allowed = await service.resolve_investor_pick_source("investor_a", "ria:ria_profile_1")

    assert denied is None
    assert "AUTHORIZED_ONLY_FOR_INVESTOR_A" not in json.dumps(denied)
    assert allowed is not None
    assert (
        allowed["package"]["top_picks"][0]["investment_thesis"] == "AUTHORIZED_ONLY_FOR_INVESTOR_A"
    )
    assert allowed["snapshot"]["share_grant_id"] == "grant_a"


@pytest.mark.asyncio
async def test_resolve_investor_pick_source_denies_revoked_share_on_new_resolution(monkeypatch):
    class _FakeConn:
        active = True

        async def fetchrow(self, query: str, *_args):
            assert "share.status = 'active'" in query
            if not self.active:
                return None
            return {
                "relationship_id": "rel_1",
                "share_grant_id": "grant_1",
                "connection_scope_proposal_id": "proposal_1",
                "ria_user_id": "ria_user_1",
                "label": "Advisor Alpha",
                "artifact_id": "artifact_1",
                "source_data_version": 7,
                "source_manifest_revision": 3,
                "artifact_updated_at": "2026-08-28T00:00:00Z",
                "artifact_projection": json.dumps(
                    {
                        "top_picks": [
                            {
                                "ticker": "NVDA",
                                "tier": "ACE",
                                "investment_thesis": "REVOKED_THESIS_MUST_DISAPPEAR",
                            }
                        ],
                        "avoid_rows": [],
                        "screening_sections": [],
                    }
                ),
            }

        async def close(self):
            return None

    conn = _FakeConn()
    service = RIAIAMService()

    async def _fake_conn():
        return conn

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_build_pick_package_projection", lambda package: package)

    active = await service.resolve_investor_pick_source("investor_1", "ria:ria_profile_1")
    conn.active = False
    revoked = await service.resolve_investor_pick_source("investor_1", "ria:ria_profile_1")

    assert "REVOKED_THESIS_MUST_DISAPPEAR" in json.dumps(active)
    assert revoked is None
    assert "REVOKED_THESIS_MUST_DISAPPEAR" not in json.dumps(revoked)


@pytest.mark.asyncio
async def test_resolve_investor_pick_source_denies_expired_proposal(monkeypatch):
    class _FakeConn:
        async def fetchrow(self, query: str, *_args):
            assert "proposal.status = 'active'" in query
            assert "proposal.expires_at > NOW()" in query
            return None

        async def close(self):
            return None

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)

    resolved = await service.resolve_investor_pick_source("investor_1", "ria:ria_profile_1")

    assert resolved is None
    assert "EXPIRED_THESIS_MUST_NOT_LEAK" not in json.dumps(resolved)


def test_directory_search_never_emits_pick_thesis_fields(monkeypatch):
    service = ConnectionsService(
        directory_lookup=lambda _user_id: [
            {
                "userId": "ria_user_1",
                "displayName": "Advisor Alpha",
                "photoUrl": None,
                "email": "advisor@example.com",
                "advisor_thesis": "PUBLIC_DIRECTORY_THESIS_MUST_NOT_LEAK",
                "investment_thesis": "PUBLIC_DIRECTORY_THESIS_MUST_NOT_LEAK",
            }
        ],
        directory_visible=lambda _viewer, _candidate: True,
    )
    service._directory_search = None
    monkeypatch.setattr(service, "_execute_many", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(service, "_verified_ria_user_ids", lambda _user_ids: {"ria_user_1"})
    monkeypatch.setattr(
        service, "_public_person_refs", lambda _user_ids: {"ria_user_1": "person_1"}
    )

    payload = service.search_directory("investor_1", audience="advisors")

    assert payload["items"] == [
        {
            "userId": "ria_user_1",
            "publicPersonRef": "person_1",
            "displayName": "Advisor Alpha",
            "photoUrl": None,
            "email": "advisor@example.com",
            "maskedEmail": None,
            "maskedPhone": None,
            "relationship": "none",
            "isRia": True,
        }
    ]
    assert "PUBLIC_DIRECTORY_THESIS_MUST_NOT_LEAK" not in json.dumps(payload)
