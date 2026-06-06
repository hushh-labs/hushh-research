# tests/test_ria_onboarding_bounds_cwe400.py
"""
Comprehensive bounds validation tests for RIA onboarding models (CWE-400).

Tests validate that all string and numeric fields in RIA request/response models
enforce max_length constraints, preventing resource exhaustion attacks through
unbounded input fields or LLM output manipulation.
"""

import pytest
from pydantic import ValidationError

from api.routes.ria import (
    RIAConsentBundleCreate,
    RIAConsentRequestCreate,
    RIAInviteCreateRequest,
    RIAInviteTarget,
    RIAMarketplaceDiscoverabilityRequest,
    RIAOnboardingSubmitRequest,
    RIAOnboardingVerifyLicenseRequest,
    RIAOnboardingVerifyNameRequest,
    RIAPicksParseRequest,
    RIAPicksSyncRequest,
    RIAProfileRefreshLicenseRequest,
)


class TestRIAOnboardingSubmitRequestBounds:
    """Tests for RIAOnboardingSubmitRequest field bounds (CWE-400)."""

    def test_display_name_max_length_256(self):
        """Test that display_name enforces max_length=256."""
        with pytest.raises(ValidationError) as exc_info:
            RIAOnboardingSubmitRequest(display_name="a" * 257)
        assert "at most 256 characters" in str(exc_info.value)

    def test_individual_crd_max_length_50(self):
        """Test that individual_crd enforces max_length=50."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test", individual_crd="a" * 51
            )

    def test_bio_max_length_5000(self):
        """Test that bio enforces max_length=5000."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Test", bio="a" * 5001)

    def test_strategy_max_length_5000(self):
        """Test that strategy enforces max_length=5000."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test", strategy="a" * 5001
            )

    def test_disclosures_url_max_length_2048(self):
        """Test that disclosures_url enforces max_length=2048."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test", disclosures_url="https://" + "a" * 2048
            )

    def test_disclosures_url_scheme_validation(self):
        """Test that disclosures_url must use http or https."""
        with pytest.raises(ValidationError) as exc_info:
            RIAOnboardingSubmitRequest(
                display_name="Test", disclosures_url="ftp://example.com"
            )
        assert "http or https scheme" in str(exc_info.value)

    def test_contact_email_max_length_320(self):
        """Test that contact_email enforces max_length=320."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test", contact_email="a" * 313 + "@example.com"
            )

    def test_contact_phone_max_length_30(self):
        """Test that contact_phone enforces max_length=30."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test", contact_phone="1" * 31
            )

    def test_business_address_max_length_512(self):
        """Test that business_address enforces max_length=512."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test", business_address="a" * 513
            )

    def test_requested_capabilities_list_bounded(self):
        """Test that requested_capabilities list enforces max_length=20."""
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Test",
                requested_capabilities=["cap" + str(i) for i in range(21)],
            )

    def test_valid_onboarding_submit_request(self):
        """Test that valid request passes validation."""
        req = RIAOnboardingSubmitRequest(
            display_name="John Doe",
            bio="A qualified investor",
            contact_email="john@example.com",
        )
        assert req.display_name == "John Doe"


class TestRIAOnboardingVerifyNameRequestBounds:
    """Tests for RIAOnboardingVerifyNameRequest field bounds."""

    def test_query_max_length_256(self):
        """Test that query enforces max_length=256."""
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="a" * 257)

    def test_crd_number_max_length_50(self):
        """Test that crd_number enforces max_length=50."""
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="valid", crd_number="a" * 51)

    def test_valid_name_verification_request(self):
        """Test that valid query passes."""
        req = RIAOnboardingVerifyNameRequest(query="John Doe")
        assert req.query == "John Doe"


class TestRIAOnboardingVerifyLicenseRequestBounds:
    """Tests for RIAOnboardingVerifyLicenseRequest field bounds."""

    def test_license_number_max_length_128(self):
        """Test that license_number enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyLicenseRequest(license_number="a" * 129)

    def test_regulator_max_length_128(self):
        """Test that regulator enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyLicenseRequest(
                license_number="123456", regulator="a" * 129
            )

    def test_valid_license_verification(self):
        """Test that valid license verification passes."""
        req = RIAOnboardingVerifyLicenseRequest(license_number="123456")
        assert req.license_number == "123456"


class TestRIAProfileRefreshLicenseRequestBounds:
    """Tests for RIAProfileRefreshLicenseRequest field bounds."""

    def test_license_number_max_length_128(self):
        """Test that license_number enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAProfileRefreshLicenseRequest(license_number="a" * 129)

    def test_regulator_max_length_128(self):
        """Test that regulator enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAProfileRefreshLicenseRequest(
                license_number="123456", regulator="a" * 129
            )


class TestRIAConsentRequestCreateBounds:
    """Tests for RIAConsentRequestCreate field bounds."""

    def test_subject_user_id_max_length_128(self):
        """Test that subject_user_id enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(
                subject_user_id="a" * 129, scope_template_id="valid"
            )

    def test_scope_template_id_max_length_128(self):
        """Test that scope_template_id enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(
                subject_user_id="user", scope_template_id="a" * 129
            )

    def test_selected_scope_max_length_128(self):
        """Test that selected_scope enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(
                subject_user_id="user",
                scope_template_id="valid",
                selected_scope="a" * 129,
            )

    def test_reason_max_length_1000(self):
        """Test that reason enforces max_length=1000."""
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(
                subject_user_id="user",
                scope_template_id="valid",
                reason="a" * 1001,
            )

    def test_duration_mode_max_length_50(self):
        """Test that duration_mode enforces max_length=50."""
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(
                subject_user_id="user",
                scope_template_id="valid",
                duration_mode="a" * 51,
            )


class TestRIAConsentBundleCreateBounds:
    """Tests for RIAConsentBundleCreate field bounds."""

    def test_subject_user_id_max_length_128(self):
        """Test that subject_user_id enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(
                subject_user_id="a" * 129, scope_template_id="valid"
            )

    def test_selected_scopes_list_bounded_50(self):
        """Test that selected_scopes list enforces max_length=50."""
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(
                subject_user_id="user",
                scope_template_id="valid",
                selected_scopes=["scope" + str(i) for i in range(51)],
            )

    def test_selected_account_ids_list_bounded_100(self):
        """Test that selected_account_ids list enforces max_length=100."""
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(
                subject_user_id="user",
                scope_template_id="valid",
                selected_account_ids=["account" + str(i) for i in range(101)],
            )

    def test_reason_max_length_1000(self):
        """Test that reason enforces max_length=1000."""
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(
                subject_user_id="user",
                scope_template_id="valid",
                reason="a" * 1001,
            )


class TestRIAPicksParseRequestBounds:
    """Tests for RIAPicksParseRequest field bounds."""

    def test_csv_content_max_length_5mb(self):
        """Test that csv_content enforces max_length=5_242_880 (5 MiB)."""
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a" * 5_242_881)

    def test_source_filename_max_length_256(self):
        """Test that source_filename enforces max_length=256."""
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(
                csv_content="valid", source_filename="a" * 257
            )

    def test_package_note_max_length_1000(self):
        """Test that package_note enforces max_length=1000."""
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(
                csv_content="valid", package_note="a" * 1001
            )

    def test_avoid_rows_list_bounded_5000(self):
        """Test that avoid_rows list enforces max_length=5000."""
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(
                csv_content="valid",
                avoid_rows=[{"row": i} for i in range(5001)],
            )

    def test_screening_sections_list_bounded_100(self):
        """Test that screening_sections list enforces max_length=100."""
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(
                csv_content="valid",
                screening_sections=[{"section": i} for i in range(101)],
            )


class TestRIAPicksSyncRequestBounds:
    """Tests for RIAPicksSyncRequest field bounds."""

    def test_label_max_length_256(self):
        """Test that label enforces max_length=256."""
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(label="a" * 257)

    def test_package_note_max_length_1000(self):
        """Test that package_note enforces max_length=1000."""
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(package_note="a" * 1001)

    def test_top_picks_list_bounded_5000(self):
        """Test that top_picks list enforces max_length=5000."""
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(
                top_picks=[{"pick": i} for i in range(5001)],
            )

    def test_avoid_rows_list_bounded_5000(self):
        """Test that avoid_rows list enforces max_length=5000."""
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(
                avoid_rows=[{"row": i} for i in range(5001)],
            )

    def test_screening_sections_list_bounded_100(self):
        """Test that screening_sections list enforces max_length=100."""
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(
                screening_sections=[{"section": i} for i in range(101)],
            )


class TestRIAInviteTargetBounds:
    """Tests for RIAInviteTarget field bounds."""

    def test_email_max_length_320(self):
        """Test that email enforces max_length=320."""
        with pytest.raises(ValidationError):
            RIAInviteTarget(email="a" * 313 + "@example.com")

    def test_phone_max_length_20(self):
        """Test that phone enforces max_length=20."""
        with pytest.raises(ValidationError):
            RIAInviteTarget(phone="1" * 21)

    def test_display_name_max_length_256(self):
        """Test that display_name enforces max_length=256."""
        with pytest.raises(ValidationError):
            RIAInviteTarget(display_name="a" * 257)

    def test_investor_user_id_max_length_128(self):
        """Test that investor_user_id enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAInviteTarget(investor_user_id="a" * 129)

    def test_source_max_length_100(self):
        """Test that source enforces max_length=100."""
        with pytest.raises(ValidationError):
            RIAInviteTarget(source="a" * 101)

    def test_delivery_channel_max_length_50(self):
        """Test that delivery_channel enforces max_length=50."""
        with pytest.raises(ValidationError):
            RIAInviteTarget(delivery_channel="a" * 51)


class TestRIAInviteCreateRequestBounds:
    """Tests for RIAInviteCreateRequest field bounds."""

    def test_scope_template_id_max_length_128(self):
        """Test that scope_template_id enforces max_length=128."""
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(scope_template_id="a" * 129)

    def test_duration_mode_max_length_50(self):
        """Test that duration_mode enforces max_length=50."""
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(
                scope_template_id="valid", duration_mode="a" * 51
            )

    def test_reason_max_length_1000(self):
        """Test that reason enforces max_length=1000."""
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(
                scope_template_id="valid", reason="a" * 1001
            )

    def test_targets_list_bounded_500(self):
        """Test that targets list enforces max_length=500."""
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(
                scope_template_id="valid",
                targets=[RIAInviteTarget() for _ in range(501)],
            )


class TestRIAMarketplaceDiscoverabilityRequestBounds:
    """Tests for RIAMarketplaceDiscoverabilityRequest field bounds."""

    def test_headline_max_length_512(self):
        """Test that headline enforces max_length=512."""
        with pytest.raises(ValidationError):
            RIAMarketplaceDiscoverabilityRequest(
                enabled=True, headline="a" * 513
            )

    def test_strategy_summary_max_length_5000(self):
        """Test that strategy_summary enforces max_length=5000."""
        with pytest.raises(ValidationError):
            RIAMarketplaceDiscoverabilityRequest(
                enabled=True, strategy_summary="a" * 5001
            )

    def test_valid_marketplace_request(self):
        """Test that valid marketplace request passes."""
        req = RIAMarketplaceDiscoverabilityRequest(
            enabled=True,
            headline="My Strategy",
            strategy_summary="Long term growth focused",
        )
        assert req.enabled is True




if __name__ == "__main__":
    pytest.main([__file__, "-v"])
