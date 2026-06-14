"""
Comprehensive CWE-400 (Resource Exhaustion) test suite for PKM routes.

Tests all request/response models in api/routes/pkm_routes_shared.py to ensure
unbounded string and list fields are properly constrained with max_length,
preventing resource exhaustion attacks on input/output fields.
"""

import pytest
from pydantic import ValidationError

from api.routes.pkm_routes_shared import (
    DecisionRecord,
    DefaultAvailableProjectionRequest,
    DefaultAvailableProjectionResponse,
    DeleteDomainResponse,
    DomainDataResponse,
    DomainManifestPayload,
    DomainManifestResponse,
    DomainMetadata,
    DomainRegistryEntryResponse,
    DomainRegistryResponse,
    EncryptedBlob,
    PathDescriptorPayload,
    PersonalKnowledgeModelMetadataResponse,
    ReconcilePkmResponse,
    ScopeExposureChangePayload,
    ScopeExposureRequest,
    ScopeExposureResponse,
    StockContextRequest,
    StockContextResponse,
    StoreDomainRequest,
    StoreDomainResponse,
    StructureDecisionPayload,
    UpgradeContextPayload,
    UserScopesResponse,
    WriteProjectionPayload,
)


class TestStockContextRequest:
    """Stock context request bounds (CWE-400)."""

    def test_valid_ticker(self):
        """Valid ticker within bounds."""
        req = StockContextRequest(ticker="AAPL")
        assert req.ticker == "AAPL"

    def test_ticker_empty_rejected(self):
        """Empty ticker rejected."""
        with pytest.raises(ValidationError) as exc:
            StockContextRequest(ticker="")
        assert "at least 1 character" in str(exc.value).lower()

    def test_ticker_max_length_accepted(self):
        """Ticker at max length (10 chars) accepted."""
        req = StockContextRequest(ticker="A" * 10)
        assert len(req.ticker) == 10

    def test_ticker_exceeds_max_length_rejected(self):
        """Ticker exceeding max length (11 chars) rejected."""
        with pytest.raises(ValidationError) as exc:
            StockContextRequest(ticker="A" * 11)
        assert "at most 10 character" in str(exc.value).lower()


class TestDecisionRecord:
    """Decision record bounds (CWE-400)."""

    def test_valid_decision_record(self):
        """Valid decision record within all bounds."""
        record = DecisionRecord(
            id=1,
            ticker="AAPL",
            decision_type="BUY",
            confidence=0.95,
            created_at="2024-01-01T00:00:00Z",
            metadata=None,
        )
        assert record.id == 1
        assert record.confidence == 0.95

    def test_ticker_bounds(self):
        """Ticker bounded to max 10 chars."""
        with pytest.raises(ValidationError):
            DecisionRecord(
                id=1,
                ticker="A" * 11,
                decision_type="BUY",
                confidence=0.5,
                created_at="2024-01-01T00:00:00Z",
            )

    def test_decision_type_max_length(self):
        """Decision type bounded to max 32 chars."""
        with pytest.raises(ValidationError):
            DecisionRecord(
                id=1,
                ticker="AAPL",
                decision_type="A" * 33,
                confidence=0.5,
                created_at="2024-01-01T00:00:00Z",
            )

    def test_confidence_bounds(self):
        """Confidence must be 0.0-1.0."""
        with pytest.raises(ValidationError):
            DecisionRecord(
                id=1,
                ticker="AAPL",
                decision_type="BUY",
                confidence=1.5,
                created_at="2024-01-01T00:00:00Z",
            )

    def test_created_at_max_length(self):
        """Created at bounded to max 64 chars."""
        with pytest.raises(ValidationError):
            DecisionRecord(
                id=1,
                ticker="AAPL",
                decision_type="BUY",
                confidence=0.5,
                created_at="A" * 65,
            )


class TestStockContextResponse:
    """Stock context response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within all bounds."""
        resp = StockContextResponse(
            ticker="AAPL",
            user_risk_profile="balanced",
            holdings=[],
            recent_decisions=[],
            portfolio_allocation={"equities": 70},
        )
        assert resp.ticker == "AAPL"

    def test_ticker_exceeds_max(self):
        """Ticker exceeding max length rejected."""
        with pytest.raises(ValidationError):
            StockContextResponse(
                ticker="A" * 11,
                user_risk_profile="balanced",
                holdings=[],
                recent_decisions=[],
                portfolio_allocation={},
            )

    def test_user_risk_profile_max_length(self):
        """User risk profile bounded to 50 chars."""
        with pytest.raises(ValidationError):
            StockContextResponse(
                ticker="AAPL",
                user_risk_profile="A" * 51,
                holdings=[],
                recent_decisions=[],
                portfolio_allocation={},
            )

    def test_holdings_list_max_length(self):
        """Holdings list bounded to 100 items."""
        with pytest.raises(ValidationError):
            StockContextResponse(
                ticker="AAPL",
                user_risk_profile="balanced",
                holdings=[{} for _ in range(101)],
                recent_decisions=[],
                portfolio_allocation={},
            )

    def test_recent_decisions_list_max_length(self):
        """Recent decisions list bounded to 50 items."""
        with pytest.raises(ValidationError):
            StockContextResponse(
                ticker="AAPL",
                user_risk_profile="balanced",
                holdings=[],
                recent_decisions=[{} for _ in range(51)],
                portfolio_allocation={},
            )


class TestPathDescriptorPayload:
    """Path descriptor payload bounds (CWE-400)."""

    def test_valid_path_descriptor(self):
        """Valid path descriptor within all bounds."""
        pd = PathDescriptorPayload(json_path="$.field.subfield")
        assert pd.json_path == "$.field.subfield"

    def test_json_path_max_length(self):
        """JSON path bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            PathDescriptorPayload(json_path="A" * 1025)

    def test_parent_path_max_length(self):
        """Parent path bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            PathDescriptorPayload(
                json_path="$.field",
                parent_path="A" * 1025,
            )

    def test_consent_label_max_length(self):
        """Consent label bounded to 256 chars."""
        with pytest.raises(ValidationError):
            PathDescriptorPayload(
                json_path="$.field",
                consent_label="A" * 257,
            )

    def test_sensitivity_label_max_length(self):
        """Sensitivity label bounded to 256 chars."""
        with pytest.raises(ValidationError):
            PathDescriptorPayload(
                json_path="$.field",
                sensitivity_label="A" * 257,
            )

    def test_source_agent_max_length(self):
        """Source agent bounded to 256 chars."""
        with pytest.raises(ValidationError):
            PathDescriptorPayload(
                json_path="$.field",
                source_agent="A" * 257,
            )


class TestStructureDecisionPayload:
    """Structure decision payload bounds (CWE-400)."""

    def test_valid_structure_decision(self):
        """Valid structure decision within bounds."""
        sd = StructureDecisionPayload()
        assert sd.action == "match_existing_domain"

    def test_target_domain_max_length(self):
        """Target domain bounded to 256 chars."""
        with pytest.raises(ValidationError):
            StructureDecisionPayload(target_domain="A" * 257)

    def test_json_paths_list_max_length(self):
        """JSON paths list bounded to 1000 items."""
        with pytest.raises(ValidationError):
            StructureDecisionPayload(
                json_paths=["$.path" for _ in range(1001)]
            )

    def test_top_level_scope_paths_max_length(self):
        """Top level scope paths list bounded to 1000 items."""
        with pytest.raises(ValidationError):
            StructureDecisionPayload(
                top_level_scope_paths=["scope" for _ in range(1001)]
            )

    def test_externalizable_paths_max_length(self):
        """Externalizable paths list bounded to 1000 items."""
        with pytest.raises(ValidationError):
            StructureDecisionPayload(
                externalizable_paths=["path" for _ in range(1001)]
            )

    def test_confidence_bounds(self):
        """Confidence must be 0.0-1.0."""
        with pytest.raises(ValidationError):
            StructureDecisionPayload(confidence=1.5)

    def test_contract_version_bounds(self):
        """Contract version bounded 1-1000."""
        with pytest.raises(ValidationError):
            StructureDecisionPayload(contract_version=1001)


class TestDomainManifestPayload:
    """Domain manifest payload bounds (CWE-400)."""

    def test_valid_manifest(self):
        """Valid manifest within bounds."""
        dm = DomainManifestPayload()
        assert dm.manifest_version == 1

    def test_manifest_version_bounds(self):
        """Manifest version bounded 1-1000."""
        with pytest.raises(ValidationError):
            DomainManifestPayload(manifest_version=1001)

    def test_paths_list_max_length(self):
        """Paths list bounded to 10000 items."""
        with pytest.raises(ValidationError):
            DomainManifestPayload(
                paths=[PathDescriptorPayload(json_path="$.path") for _ in range(10001)]
            )

    def test_upgraded_at_max_length(self):
        """Upgraded at bounded to 64 chars."""
        with pytest.raises(ValidationError):
            DomainManifestPayload(upgraded_at="A" * 65)


class TestUpgradeContextPayload:
    """Upgrade context payload bounds (CWE-400)."""

    def test_valid_upgrade_context(self):
        """Valid upgrade context within bounds."""
        uc = UpgradeContextPayload(run_id="run-123")
        assert uc.run_id == "run-123"

    def test_run_id_max_length(self):
        """Run ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            UpgradeContextPayload(run_id="A" * 257)

    def test_version_bounds(self):
        """Version fields bounded 0-1000."""
        with pytest.raises(ValidationError):
            UpgradeContextPayload(
                run_id="run-1",
                prior_domain_contract_version=1001,
            )

    def test_retry_count_bounds(self):
        """Retry count bounded 0-1000."""
        with pytest.raises(ValidationError):
            UpgradeContextPayload(
                run_id="run-1",
                retry_count=1001,
            )


class TestWriteProjectionPayload:
    """Write projection payload bounds (CWE-400)."""

    def test_valid_projection(self):
        """Valid projection within bounds."""
        wp = WriteProjectionPayload(projection_type="summary")
        assert wp.projection_type == "summary"

    def test_projection_type_max_length(self):
        """Projection type bounded to 256 chars."""
        with pytest.raises(ValidationError):
            WriteProjectionPayload(projection_type="A" * 257)

    def test_projection_version_bounds(self):
        """Projection version bounded 1-1000."""
        with pytest.raises(ValidationError):
            WriteProjectionPayload(
                projection_type="summary",
                projection_version=1001,
            )


class TestStoreDomainRequest:
    """Store domain request bounds (CWE-400)."""

    @staticmethod
    def _valid_blob():
        """Helper to create valid encrypted blob."""
        return EncryptedBlob(
            ciphertext="valid" * 1000,
            iv="iv" * 100,
            tag="tag" * 100,
        )

    def test_valid_store_domain_request(self):
        """Valid store domain request within bounds."""
        req = StoreDomainRequest(
            user_id="user-123",
            domain="financial",
            encrypted_blob=self._valid_blob(),
            summary={},
        )
        assert req.user_id == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            StoreDomainRequest(
                user_id="A" * 257,
                domain="financial",
                encrypted_blob=self._valid_blob(),
                summary={},
            )

    def test_domain_max_length(self):
        """Domain bounded to 128 chars."""
        with pytest.raises(ValidationError):
            StoreDomainRequest(
                user_id="user-123",
                domain="A" * 129,
                encrypted_blob=self._valid_blob(),
                summary={},
            )

    def test_source_agent_max_length(self):
        """Source agent bounded to 256 chars."""
        with pytest.raises(ValidationError):
            StoreDomainRequest(
                user_id="user-123",
                domain="financial",
                encrypted_blob=self._valid_blob(),
                summary={},
                source_agent="A" * 257,
            )

    def test_write_projections_list_max_length(self):
        """Write projections list bounded to 100 items."""
        with pytest.raises(ValidationError):
            StoreDomainRequest(
                user_id="user-123",
                domain="financial",
                encrypted_blob=self._valid_blob(),
                summary={},
                write_projections=[
                    WriteProjectionPayload(projection_type="proj")
                    for _ in range(101)
                ],
            )


class TestStoreDomainResponse:
    """Store domain response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = StoreDomainResponse(success=True)
        assert resp.success is True

    def test_message_max_length(self):
        """Message bounded to 512 chars."""
        with pytest.raises(ValidationError):
            StoreDomainResponse(
                success=True,
                message="A" * 513,
            )

    def test_data_version_bounds(self):
        """Data version bounded 0-1000000."""
        with pytest.raises(ValidationError):
            StoreDomainResponse(
                success=True,
                data_version=1000001,
            )

    def test_updated_at_max_length(self):
        """Updated at bounded to 64 chars."""
        with pytest.raises(ValidationError):
            StoreDomainResponse(
                success=True,
                updated_at="A" * 65,
            )


class TestDomainDataResponse:
    """Domain data response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        blob = EncryptedBlob(
            ciphertext="valid" * 1000,
            iv="iv" * 100,
            tag="tag" * 100,
        )
        resp = DomainDataResponse(encrypted_blob=blob)
        assert resp.storage_mode == "domain"

    def test_storage_mode_max_length(self):
        """Storage mode bounded to 64 chars."""
        with pytest.raises(ValidationError):
            DomainDataResponse(
                encrypted_blob=EncryptedBlob(
                    ciphertext="valid" * 1000,
                    iv="iv" * 100,
                    tag="tag" * 100,
                ),
                storage_mode="A" * 65,
            )

    def test_segment_ids_list_max_length(self):
        """Segment IDs list bounded to 50 items."""
        with pytest.raises(ValidationError):
            DomainDataResponse(
                encrypted_blob=EncryptedBlob(
                    ciphertext="valid" * 1000,
                    iv="iv" * 100,
                    tag="tag" * 100,
                ),
                segment_ids=["seg" + str(i) for i in range(51)],
            )


class TestDomainManifestResponse:
    """Domain manifest response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = DomainManifestResponse(
            user_id="user-123",
            domain="financial",
        )
        assert resp.user_id == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            DomainManifestResponse(
                user_id="A" * 257,
                domain="financial",
            )

    def test_domain_max_length(self):
        """Domain bounded to 128 chars."""
        with pytest.raises(ValidationError):
            DomainManifestResponse(
                user_id="user-123",
                domain="A" * 129,
            )

    def test_path_count_bounds(self):
        """Path count bounded 0-1000000."""
        with pytest.raises(ValidationError):
            DomainManifestResponse(
                user_id="user-123",
                domain="financial",
                path_count=1000001,
            )

    def test_top_level_scope_paths_max_length(self):
        """Top level scope paths bounded to 1000 items."""
        with pytest.raises(ValidationError):
            DomainManifestResponse(
                user_id="user-123",
                domain="financial",
                top_level_scope_paths=["scope" for _ in range(1001)],
            )

    def test_paths_list_max_length(self):
        """Paths list bounded to 10000 items."""
        with pytest.raises(ValidationError):
            DomainManifestResponse(
                user_id="user-123",
                domain="financial",
                paths=[{} for _ in range(10001)],
            )


class TestScopeExposureChangePayload:
    """Scope exposure change payload bounds (CWE-400)."""

    def test_valid_change(self):
        """Valid change payload within bounds."""
        change = ScopeExposureChangePayload()
        assert change.exposure_enabled is None

    def test_scope_handle_max_length(self):
        """Scope handle bounded to 256 chars."""
        with pytest.raises(ValidationError):
            ScopeExposureChangePayload(scope_handle="A" * 257)

    def test_top_level_scope_path_max_length(self):
        """Top level scope path bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            ScopeExposureChangePayload(top_level_scope_path="A" * 1025)

    def test_visibility_posture_max_length(self):
        """Visibility posture bounded to 128 chars."""
        with pytest.raises(ValidationError):
            ScopeExposureChangePayload(visibility_posture="A" * 129)


class TestScopeExposureRequest:
    """Scope exposure request bounds (CWE-400)."""

    def test_valid_request(self):
        """Valid request within bounds."""
        req = ScopeExposureRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            ScopeExposureRequest(user_id="A" * 257)

    def test_changes_list_max_length(self):
        """Changes list bounded to 200 items."""
        with pytest.raises(ValidationError):
            ScopeExposureRequest(
                user_id="user-123",
                changes=[ScopeExposureChangePayload() for _ in range(201)],
            )


class TestScopeExposureResponse:
    """Scope exposure response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = ScopeExposureResponse(success=True)
        assert resp.success is True

    def test_message_max_length(self):
        """Message bounded to 512 chars."""
        with pytest.raises(ValidationError):
            ScopeExposureResponse(
                success=True,
                message="A" * 513,
            )

    def test_revoked_grant_ids_list_max_length(self):
        """Revoked grant IDs list bounded to 10000 items."""
        with pytest.raises(ValidationError):
            ScopeExposureResponse(
                success=True,
                revoked_grant_ids=["grant" + str(i) for i in range(10001)],
            )


class TestDefaultAvailableProjectionRequest:
    """Default available projection request bounds (CWE-400)."""

    def test_valid_request(self):
        """Valid request within bounds."""
        req = DefaultAvailableProjectionRequest(
            user_id="user-123",
            scope="read",
            top_level_scope_path="$.financial",
        )
        assert req.user_id == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            DefaultAvailableProjectionRequest(
                user_id="A" * 257,
                scope="read",
                top_level_scope_path="$.financial",
            )

    def test_scope_max_length(self):
        """Scope bounded to 256 chars."""
        with pytest.raises(ValidationError):
            DefaultAvailableProjectionRequest(
                user_id="user-123",
                scope="A" * 257,
                top_level_scope_path="$.financial",
            )

    def test_top_level_scope_path_max_length(self):
        """Top level scope path bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            DefaultAvailableProjectionRequest(
                user_id="user-123",
                scope="read",
                top_level_scope_path="A" * 1025,
            )


class TestDefaultAvailableProjectionResponse:
    """Default available projection response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = DefaultAvailableProjectionResponse(success=True)
        assert resp.success is True

    def test_message_max_length(self):
        """Message bounded to 512 chars."""
        with pytest.raises(ValidationError):
            DefaultAvailableProjectionResponse(
                success=True,
                message="A" * 513,
            )

    def test_projection_hash_max_length(self):
        """Projection hash bounded to 256 chars."""
        with pytest.raises(ValidationError):
            DefaultAvailableProjectionResponse(
                success=True,
                projection_hash="A" * 257,
            )

    def test_projection_updated_at_max_length(self):
        """Projection updated at bounded to 64 chars."""
        with pytest.raises(ValidationError):
            DefaultAvailableProjectionResponse(
                success=True,
                projection_updated_at="A" * 65,
            )


class TestDeleteDomainResponse:
    """Delete domain response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = DeleteDomainResponse(success=True)
        assert resp.success is True

    def test_message_max_length(self):
        """Message bounded to 512 chars."""
        with pytest.raises(ValidationError):
            DeleteDomainResponse(
                success=True,
                message="A" * 513,
            )


class TestReconcilePkmResponse:
    """Reconcile PKM response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = ReconcilePkmResponse(success=True)
        assert resp.success is True

    def test_message_max_length(self):
        """Message bounded to 512 chars."""
        with pytest.raises(ValidationError):
            ReconcilePkmResponse(
                success=True,
                message="A" * 513,
            )


class TestDomainMetadata:
    """Domain metadata bounds (CWE-400)."""

    def test_valid_metadata(self):
        """Valid metadata within bounds."""
        meta = DomainMetadata(
            key="financial",
            display_name="Financial",
        )
        assert meta.key == "financial"

    def test_key_max_length(self):
        """Key bounded to 128 chars."""
        with pytest.raises(ValidationError):
            DomainMetadata(
                key="A" * 129,
                display_name="Financial",
            )

    def test_display_name_max_length(self):
        """Display name bounded to 256 chars."""
        with pytest.raises(ValidationError):
            DomainMetadata(
                key="financial",
                display_name="A" * 257,
            )

    def test_icon_max_length(self):
        """Icon bounded to 64 chars."""
        with pytest.raises(ValidationError):
            DomainMetadata(
                key="financial",
                display_name="Financial",
                icon="A" * 65,
            )

    def test_readable_summary_max_length(self):
        """Readable summary bounded to 8192 chars."""
        with pytest.raises(ValidationError):
            DomainMetadata(
                key="financial",
                display_name="Financial",
                readable_summary="A" * 8193,
            )

    def test_readable_highlights_list_max_length(self):
        """Readable highlights list bounded to 1000 items."""
        with pytest.raises(ValidationError):
            DomainMetadata(
                key="financial",
                display_name="Financial",
                readable_highlights=["highlight" for _ in range(1001)],
            )


class TestPersonalKnowledgeModelMetadataResponse:
    """Personal knowledge model metadata response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = PersonalKnowledgeModelMetadataResponse(
            user_id="user-123",
            domains=[],
            total_attributes=0,
            model_completeness=50,
        )
        assert resp.user_id == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            PersonalKnowledgeModelMetadataResponse(
                user_id="A" * 257,
                domains=[],
                total_attributes=0,
                model_completeness=50,
            )

    def test_total_attributes_bounds(self):
        """Total attributes bounded 0-1000000."""
        with pytest.raises(ValidationError):
            PersonalKnowledgeModelMetadataResponse(
                user_id="user-123",
                domains=[],
                total_attributes=1000001,
                model_completeness=50,
            )

    def test_model_completeness_bounds(self):
        """Model completeness bounded 0-100."""
        with pytest.raises(ValidationError):
            PersonalKnowledgeModelMetadataResponse(
                user_id="user-123",
                domains=[],
                total_attributes=0,
                model_completeness=101,
            )

    def test_suggested_domains_list_max_length(self):
        """Suggested domains list bounded to 1000 items."""
        with pytest.raises(ValidationError):
            PersonalKnowledgeModelMetadataResponse(
                user_id="user-123",
                domains=[],
                total_attributes=0,
                model_completeness=50,
                suggested_domains=["domain" + str(i) for i in range(1001)],
            )


class TestUserScopesResponse:
    """User scopes response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = UserScopesResponse(user_id="user-123")
        assert resp.user_id == "user-123"

    def test_user_id_max_length(self):
        """User ID bounded to 256 chars."""
        with pytest.raises(ValidationError):
            UserScopesResponse(user_id="A" * 257)

    def test_scopes_list_max_length(self):
        """Scopes list bounded to 10000 items."""
        with pytest.raises(ValidationError):
            UserScopesResponse(
                user_id="user-123",
                scopes=["scope" + str(i) for i in range(10001)],
            )

    def test_scope_entries_list_max_length(self):
        """Scope entries list bounded to 10000 items."""
        with pytest.raises(ValidationError):
            UserScopesResponse(
                user_id="user-123",
                scope_entries=[{} for _ in range(10001)],
            )


class TestDomainRegistryEntryResponse:
    """Domain registry entry response bounds (CWE-400)."""

    def test_valid_entry(self):
        """Valid entry within bounds."""
        entry = DomainRegistryEntryResponse(
            domain_key="financial",
            display_name="Financial",
            icon_name="wallet",
            color_hex="#FF0000",
            description="User financial data",
            status="active",
        )
        assert entry.domain_key == "financial"

    def test_domain_key_max_length(self):
        """Domain key bounded to 128 chars."""
        with pytest.raises(ValidationError):
            DomainRegistryEntryResponse(
                domain_key="A" * 129,
                display_name="Financial",
                icon_name="wallet",
                color_hex="#FF0000",
                description="desc",
                status="active",
            )

    def test_description_max_length(self):
        """Description bounded to 1024 chars."""
        with pytest.raises(ValidationError):
            DomainRegistryEntryResponse(
                domain_key="financial",
                display_name="Financial",
                icon_name="wallet",
                color_hex="#FF0000",
                description="A" * 1025,
                status="active",
            )


class TestDomainRegistryResponse:
    """Domain registry response bounds (CWE-400)."""

    def test_valid_response(self):
        """Valid response within bounds."""
        resp = DomainRegistryResponse(
            domains=[],
            canonical_domain_count=0,
        )
        assert resp.canonical_domain_count == 0

    def test_domains_list_max_length(self):
        """Domains list bounded to 1000 items."""
        with pytest.raises(ValidationError):
            DomainRegistryResponse(
                domains=[
                    DomainRegistryEntryResponse(
                        domain_key="financial",
                        display_name="Financial",
                        icon_name="wallet",
                        color_hex="#FF0000",
                        description="desc",
                        status="active",
                    )
                    for _ in range(1001)
                ],
                canonical_domain_count=1001,
            )

    def test_canonical_domain_count_bounds(self):
        """Canonical domain count bounded 0-10000."""
        with pytest.raises(ValidationError):
            DomainRegistryResponse(
                domains=[],
                canonical_domain_count=10001,
            )
