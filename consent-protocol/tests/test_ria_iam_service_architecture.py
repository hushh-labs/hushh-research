import json
from types import SimpleNamespace

import pytest

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


@pytest.mark.asyncio
async def test_verify_ria_name_serializes_verified_stage1_lookup(monkeypatch):
    service = RIAIAMService()

    async def _mock_lookup(*, query: str, use_cache: bool = True):
        assert query == "Advisor Alpha"
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

    async def _mock_lookup(*, query: str, use_cache: bool = True):
        assert query == "Andrew G"
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

    async def _fake_verify_name_result(query: str, *, use_cache: bool = True):
        assert query == "Advisor Alpha"
        assert use_cache is True
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
        strategy="Long-term planning",
    )

    assert result["verification_status"] == "verified"
    assert result["advisory_status"] == "verified"
    assert result["professional_access_granted"] is True
    assert result["individual_crd"] == "12345"


@pytest.mark.asyncio
async def test_dev_activation_records_allowed_bypass_event(monkeypatch):
    service = RIAIAMService()
    executed: list[tuple[str, tuple[object, ...]]] = []

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
            return None

        async def execute(self, query: str, *args):
            executed.append((query, args))
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

    monkeypatch.setenv("RIA_DEV_BYPASS_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("RIA_DEV_ALLOWLIST", raising=False)
    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _fake_vault_user_row)
    monkeypatch.setattr(service, "_set_runtime_last_persona", _fake_runtime_persona)

    result = await service.activate_ria_dev_onboarding(
        "user-1",
        display_name="Advisor Alpha",
        requested_capabilities=["advisory"],
    )

    assert result["verification_status"] == "active"
    assert result["verification_outcome"] == "dev_allowlist"
    event_queries = [
        query for query, _args in executed if "INSERT INTO ria_verification_events" in query
    ]
    assert event_queries
    assert "'bypassed'" in event_queries[0]
    assert "'dev_allowlist', 'dev_allowlist'" not in event_queries[0]


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
async def test_consent_center_summary_uses_surface_loaders_without_get_center(monkeypatch):
    service = ConsentCenterService()

    async def _unexpected_get_center(*_args, **_kwargs):  # noqa: ANN002,ANN003
        raise AssertionError("get_center should not be used for summary counts")

    async def _pending(_user_id: str):
        return [{"id": "pending_1"}, {"id": "pending_2"}]

    async def _active(_user_id: str):
        return [{"id": "active_1"}]

    async def _previous(_user_id: str):
        return [{"id": "history_1"}, {"id": "history_2"}, {"id": "history_3"}]

    monkeypatch.setattr(service, "get_center", _unexpected_get_center)
    monkeypatch.setattr(service, "_load_investor_pending_entries", _pending)
    monkeypatch.setattr(service, "_load_investor_active_entries", _active)
    monkeypatch.setattr(service, "_load_investor_previous_entries", _previous)

    payload = await service.get_center_summary("investor_1", actor="investor")

    assert payload["counts"] == {"pending": 2, "active": 1, "previous": 3}


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
async def test_consent_center_list_ria_active_uses_relationship_roster(monkeypatch):
    service = ConsentCenterService()

    async def _ria_active(
        _user_id: str, *, query: str | None = None, page: int = 1, limit: int = 20
    ):
        assert query == "taylor"
        assert page == 2
        assert limit == 20
        return {
            "page": page,
            "limit": limit,
            "total": 21,
            "has_more": False,
            "items": [
                {
                    "id": "relationship_1",
                    "kind": "active_grant",
                    "status": "active",
                    "counterpart_label": "Taylor",
                    "scope": "attr.financial.*",
                }
            ],
        }

    async def _connection_entries(_user_id: str, *, actor: str):
        return [
            {
                "id": f"rel_{i}",
                "kind": "active_grant",
                "status": "active",
                "relationship_state": "approved",
                "counterpart_label": "Taylor" if i == 0 else f"Client {i}",
                "counterpart_id": f"investor_{i}",
                "scope": "attr.financial.*",
            }
            for i in range(21)
        ]

    monkeypatch.setattr(service, "_load_connection_entries_for_actor", _connection_entries)

    payload = await service.list_center(
        "ria_user_1",
        actor="ria",
        surface="active",
        mode="connections",
        query="taylor",
        page=1,
        limit=20,
    )

    assert payload["actor"] == "ria"
    assert payload["surface"] == "active"
    assert payload["mode"] == "connections"
    assert payload["total"] >= 1
    assert any(item.get("counterpart_label") == "Taylor" for item in payload["items"])


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
    assert items[0]["artifact_id"] == "artifact_1"
    assert items[0]["artifact_updated_at"] == "2026-04-02T12:34:56Z"
    assert items[0]["source_data_version"] == 7
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
async def test_sync_relationship_from_consent_action_uses_active_tokens_over_latest_requested_row(
    monkeypatch,
):
    updates: list[tuple[str, str]] = []
    materialized: list[dict] = []

    class _FakeTransaction:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FakeConn:
        def transaction(self):
            return _FakeTransaction()

        async def fetchrow(self, query: str, *args):
            if "FROM consent_audit" in query and "action = 'REQUESTED'" in query:
                return {
                    "request_id": "req_1",
                    "user_id": "investor_1",
                    "agent_id": "ria:profile_1",
                    "scope": "attr.financial.*",
                    "metadata": {
                        "requester_actor_type": "ria",
                        "requester_entity_id": "11111111-1111-1111-1111-111111111111",
                    },
                }
            if "FROM advisor_investor_relationships rel" in query:
                return {
                    "id": "relationship_1",
                    "ria_user_id": "ria_user_1",
                }
            raise AssertionError(f"Unexpected fetchrow query: {query}")

        async def fetch(self, query: str, *args):
            if "FROM consent_audit" in query:
                return [
                    {
                        "scope": "attr.financial.*",
                        "action": "REQUESTED",
                        "expires_at": 9999999999999,
                        "issued_at": 200,
                    },
                    {
                        "scope": "attr.financial.*",
                        "action": "CONSENT_GRANTED",
                        "expires_at": 9999999999999,
                        "issued_at": 100,
                    },
                ]
            raise AssertionError(f"Unexpected fetch query: {query}")

        async def execute(self, query: str, *args):
            if "UPDATE advisor_investor_relationships" in query:
                updates.append((args[0], args[1]))
                return None
            raise AssertionError(f"Unexpected execute query: {query}")

        async def close(self):
            return None

    class _FakeConsentDBService:
        async def get_active_tokens(self, user_id: str, agent_id: str | None = None, scope=None):
            assert user_id == "investor_1"
            assert agent_id == "ria:profile_1"
            assert scope is None
            return [
                {
                    "scope": "attr.financial.*",
                    "token_id": "existing_token",
                    "expires_at": 9999999999999,
                }
            ]

    service = RIAIAMService()

    async def _fake_conn():
        return _FakeConn()

    async def _fake_schema_ready(_conn):
        return True

    async def _fake_materialize(self, conn, **kwargs):  # noqa: ANN001
        _ = conn
        materialized.append(kwargs)

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_is_iam_schema_ready", _fake_schema_ready)
    monkeypatch.setattr(
        "hushh_mcp.services.ria_iam_service.ConsentDBService",
        _FakeConsentDBService,
    )
    monkeypatch.setattr(
        RIAIAMService,
        "_materialize_relationship_share_grant",
        _fake_materialize,
    )

    await service.sync_relationship_from_consent_action(
        user_id="investor_1",
        request_id="req_1",
        action="CONSENT_GRANTED",
    )

    assert updates == [("relationship_1", "approved")]
    assert materialized and materialized[0]["relationship_id"] == "relationship_1"


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
