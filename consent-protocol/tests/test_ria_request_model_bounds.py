"""
Tests for RIA request model input bounds.

Covers:
- RIAOnboardingSubmitRequest: display_name, bio, strategy, URL fields
- RIAOnboardingVerifyNameRequest: query, crd_number
- RIAConsentRequestCreate: Literal actor types, userId, reason
- RIAConsentBundleCreate: list length limits
- RIAPicksParseRequest: csv_content max size, list bounds
- RIAPicksSyncRequest: list bounds
- RIAInviteTarget: email, phone, user_id
- RIAInviteCreateRequest: targets list max_length
- RIAMarketplaceDiscoverabilityRequest: headline, strategy_summary
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
    RIAOnboardingVerifyNameRequest,
    RIAPicksParseRequest,
    RIAPicksSyncRequest,
)

# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest
# ---------------------------------------------------------------------------


class TestRIAOnboardingSubmitRequest:
    def test_valid_minimal_passes(self):
        r = RIAOnboardingSubmitRequest(display_name="Alice")
        assert r.display_name == "Alice"

    def test_display_name_empty_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="")

    def test_display_name_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="x" * 257)

    def test_bio_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", bio="b" * 5001)

    def test_bio_at_max_passes(self):
        r = RIAOnboardingSubmitRequest(display_name="Alice", bio="b" * 5000)
        assert len(r.bio) == 5000

    def test_strategy_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", strategy="s" * 5001)

    def test_disclosures_url_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", disclosures_url="h" * 2049)

    def test_individual_crd_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", individual_crd="c" * 51)

    def test_requested_capabilities_over_20_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Alice", requested_capabilities=["advisory"] * 21
            )

    def test_requested_capabilities_exactly_20_passes(self):
        r = RIAOnboardingSubmitRequest(
            display_name="Alice", requested_capabilities=["advisory"] * 20
        )
        assert len(r.requested_capabilities) == 20


# ---------------------------------------------------------------------------
# RIAOnboardingVerifyNameRequest
# ---------------------------------------------------------------------------


class TestRIAOnboardingVerifyNameRequest:
    def test_valid_passes(self):
        r = RIAOnboardingVerifyNameRequest(query="Alice Smith")
        assert r.query == "Alice Smith"

    def test_query_empty_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="")

    def test_query_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="q" * 257)

    def test_crd_number_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="Alice", crd_number="c" * 51)


# ---------------------------------------------------------------------------
# RIAConsentRequestCreate
# ---------------------------------------------------------------------------


class TestRIAConsentRequestCreate:
    def _valid(self, **overrides) -> dict:
        base = dict(subject_user_id="uid_abc", scope_template_id="scope_001")
        return {**base, **overrides}

    def test_valid_defaults_pass(self):
        r = RIAConsentRequestCreate(**self._valid())
        assert r.requester_actor_type == "ria"
        assert r.subject_actor_type == "investor"

    def test_requester_actor_type_invalid_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(requester_actor_type="broker"))

    def test_subject_actor_type_invalid_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(subject_actor_type="admin"))

    def test_subject_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(subject_user_id="u" * 129))

    def test_scope_template_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(scope_template_id="s" * 129))

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(reason="r" * 1001))

    def test_firm_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(firm_id="f" * 129))


# ---------------------------------------------------------------------------
# RIAConsentBundleCreate
# ---------------------------------------------------------------------------


class TestRIAConsentBundleCreate:
    def _valid(self, **overrides) -> dict:
        base = dict(subject_user_id="uid_abc", scope_template_id="scope_001")
        return {**base, **overrides}

    def test_valid_passes(self):
        r = RIAConsentBundleCreate(**self._valid())
        assert r.selected_scopes == []

    def test_selected_scopes_over_50_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(**self._valid(selected_scopes=["scope"] * 51))

    def test_selected_account_ids_over_100_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(**self._valid(selected_account_ids=["acc"] * 101))

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(**self._valid(reason="r" * 1001))


# ---------------------------------------------------------------------------
# RIAPicksParseRequest
# ---------------------------------------------------------------------------


class TestRIAPicksParseRequest:
    def test_valid_passes(self):
        r = RIAPicksParseRequest(csv_content="ticker,price\nAAPL,180")
        assert r.csv_content.startswith("ticker")

    def test_csv_content_empty_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="")

    def test_csv_content_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="x" * (5_242_881))

    def test_csv_content_at_max_passes(self):
        r = RIAPicksParseRequest(csv_content="x" * 5_242_880)
        assert len(r.csv_content) == 5_242_880

    def test_avoid_rows_over_5000_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", avoid_rows=[{}] * 5001)

    def test_screening_sections_over_100_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", screening_sections=[{}] * 101)

    def test_source_filename_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", source_filename="f" * 257)

    def test_package_note_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", package_note="n" * 1001)


# ---------------------------------------------------------------------------
# RIAPicksSyncRequest
# ---------------------------------------------------------------------------


class TestRIAPicksSyncRequest:
    def test_valid_defaults_pass(self):
        r = RIAPicksSyncRequest()
        assert r.retire_legacy is True

    def test_top_picks_over_5000_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(top_picks=[{}] * 5001)

    def test_label_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(label="l" * 257)

    def test_package_note_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(package_note="n" * 1001)


# ---------------------------------------------------------------------------
# RIAInviteTarget
# ---------------------------------------------------------------------------


class TestRIAInviteTarget:
    def test_all_none_passes(self):
        t = RIAInviteTarget()
        assert t.email is None

    def test_email_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(email="e" * 321)

    def test_phone_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(phone="1" * 21)

    def test_investor_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(investor_user_id="u" * 129)

    def test_delivery_channel_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(delivery_channel="c" * 51)


# ---------------------------------------------------------------------------
# RIAInviteCreateRequest
# ---------------------------------------------------------------------------


class TestRIAInviteCreateRequest:
    def _valid(self, **overrides) -> dict:
        return {"scope_template_id": "scope_001", **overrides}

    def test_valid_passes(self):
        r = RIAInviteCreateRequest(**self._valid())
        assert r.targets == []

    def test_targets_over_500_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(**self._valid(targets=[{}] * 501))

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(**self._valid(reason="r" * 1001))

    def test_firm_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(**self._valid(firm_id="f" * 129))


# ---------------------------------------------------------------------------
# RIAMarketplaceDiscoverabilityRequest
# ---------------------------------------------------------------------------


class TestRIAMarketplaceDiscoverabilityRequest:
    def test_valid_passes(self):
        r = RIAMarketplaceDiscoverabilityRequest(enabled=True)
        assert r.enabled is True

    def test_headline_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAMarketplaceDiscoverabilityRequest(enabled=True, headline="h" * 513)

    def test_strategy_summary_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAMarketplaceDiscoverabilityRequest(enabled=True, strategy_summary="s" * 5001)

    def test_strategy_summary_at_max_passes(self):
        r = RIAMarketplaceDiscoverabilityRequest(enabled=True, strategy_summary="s" * 5000)
        assert len(r.strategy_summary) == 5000
