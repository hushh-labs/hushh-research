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

    monkeypatch.setattr(service, "_load_ria_active_entries", _ria_active)

    payload = await service.list_center(
        "ria_user_1",
        actor="ria",
        surface="active",
        mode="connections",
        query="taylor",
        page=2,
        limit=20,
    )

    assert payload["actor"] == "ria"
    assert payload["surface"] == "active"
    assert payload["total"] == 21
    assert payload["items"][0]["counterpart_label"] == "Taylor"
    assert payload["items"][0]["status"] == "active"


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
    assert items[0]["upload_id"] == "upload_1"
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
