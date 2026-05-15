"""Hermetic bounds tests for consent-route Pydantic models.

No I/O — pure model-level validation only.
"""

import pytest
from pydantic import ValidationError

from api.routes.consent import (
    CancelConsentRequest,
    GenericConsentRequestCreate,
    PendingConsentOpenedRequest,
    RefreshExportFailureRequest,
    RefreshExportUploadRequest,
    RelationshipDisconnectRequest,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_LONG = "x" * 1000


def _upload_valid(**kw) -> dict:
    base = dict(
        userId="u1",
        consentToken="ct1",
        encryptedData="data",
        encryptedIv="iv",
        encryptedTag="tag",
        wrappedExportKey="wek",
        wrappedKeyIv="wiv",
        wrappedKeyTag="wtag",
        senderPublicKey="spk",
    )
    return {**base, **kw}


# ---------------------------------------------------------------------------
# CancelConsentRequest
# ---------------------------------------------------------------------------


class TestCancelConsentRequest:
    def test_valid(self):
        m = CancelConsentRequest(userId="u1", requestId="r1")
        assert m.userId == "u1"

    def test_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            CancelConsentRequest(userId="", requestId="r1")

    def test_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            CancelConsentRequest(userId="a" * 129, requestId="r1")

    def test_user_id_max_accepted(self):
        CancelConsentRequest(userId="a" * 128, requestId="r1")

    def test_request_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            CancelConsentRequest(userId="u1", requestId="")

    def test_request_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            CancelConsentRequest(userId="u1", requestId="a" * 129)

    def test_request_id_max_accepted(self):
        CancelConsentRequest(userId="u1", requestId="a" * 128)


# ---------------------------------------------------------------------------
# PendingConsentOpenedRequest
# ---------------------------------------------------------------------------


class TestPendingConsentOpenedRequest:
    def test_valid_minimal(self):
        m = PendingConsentOpenedRequest(userId="u1")
        assert m.requestId is None

    def test_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            PendingConsentOpenedRequest(userId="")

    def test_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            PendingConsentOpenedRequest(userId="a" * 129)

    def test_request_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            PendingConsentOpenedRequest(userId="u1", requestId="a" * 129)

    def test_bundle_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            PendingConsentOpenedRequest(userId="u1", bundleId="b" * 129)

    def test_opened_via_too_long_rejected(self):
        with pytest.raises(ValidationError):
            PendingConsentOpenedRequest(userId="u1", openedVia="o" * 65)

    def test_opened_via_max_accepted(self):
        PendingConsentOpenedRequest(userId="u1", openedVia="o" * 64)

    def test_all_optionals_none_accepted(self):
        PendingConsentOpenedRequest(userId="u1", requestId=None, bundleId=None, openedVia=None)


# ---------------------------------------------------------------------------
# GenericConsentRequestCreate
# ---------------------------------------------------------------------------


class TestGenericConsentRequestCreate:
    def _valid(self, **kw):
        base = dict(subject_user_id="user123", scope_template_id="template.v1")
        return GenericConsentRequestCreate(**{**base, **kw})

    def test_valid_defaults(self):
        m = self._valid()
        assert m.requester_actor_type == "ria"
        assert m.subject_actor_type == "investor"

    def test_subject_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            GenericConsentRequestCreate(subject_user_id="", scope_template_id="t1")

    def test_subject_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            GenericConsentRequestCreate(subject_user_id="a" * 129, scope_template_id="t1")

    def test_scope_template_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            GenericConsentRequestCreate(subject_user_id="u1", scope_template_id="")

    def test_scope_template_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            GenericConsentRequestCreate(subject_user_id="u1", scope_template_id="t" * 257)

    def test_selected_scope_too_long_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(selected_scope="s" * 257)

    def test_requester_actor_type_invalid_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(requester_actor_type="developer")

    def test_requester_actor_type_investor_accepted(self):
        self._valid(requester_actor_type="investor")

    def test_requester_actor_type_ria_accepted(self):
        self._valid(requester_actor_type="ria")

    def test_subject_actor_type_invalid_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(subject_actor_type="admin")

    def test_duration_mode_too_long_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(duration_mode="m" * 65)

    def test_duration_hours_zero_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(duration_hours=0)

    def test_duration_hours_over_year_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(duration_hours=8761)

    def test_duration_hours_max_accepted(self):
        self._valid(duration_hours=8760)

    def test_reason_too_long_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(reason="r" * 1001)

    def test_reason_max_accepted(self):
        self._valid(reason="r" * 1000)

    def test_firm_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(firm_id="f" * 129)


# ---------------------------------------------------------------------------
# RelationshipDisconnectRequest
# ---------------------------------------------------------------------------


class TestRelationshipDisconnectRequest:
    def test_valid_all_none(self):
        m = RelationshipDisconnectRequest()
        assert m.investor_user_id is None

    def test_investor_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RelationshipDisconnectRequest(investor_user_id="a" * 129)

    def test_investor_user_id_max_accepted(self):
        RelationshipDisconnectRequest(investor_user_id="a" * 128)

    def test_ria_profile_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RelationshipDisconnectRequest(ria_profile_id="r" * 129)

    def test_ria_profile_id_max_accepted(self):
        RelationshipDisconnectRequest(ria_profile_id="r" * 128)


# ---------------------------------------------------------------------------
# RefreshExportUploadRequest
# ---------------------------------------------------------------------------


class TestRefreshExportUploadRequest:
    def test_valid(self):
        m = RefreshExportUploadRequest(**_upload_valid())
        assert m.userId == "u1"

    def test_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(userId=""))

    def test_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(userId="a" * 129))

    def test_consent_token_empty_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(consentToken=""))

    def test_consent_token_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(consentToken="t" * 2049))

    def test_consent_token_max_accepted(self):
        RefreshExportUploadRequest(**_upload_valid(consentToken="t" * 2048))

    def test_encrypted_data_empty_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(encryptedData=""))

    def test_encrypted_iv_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(encryptedIv="i" * 257))

    def test_encrypted_tag_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(encryptedTag="t" * 257))

    def test_wrapped_export_key_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(wrappedExportKey="k" * 8193))

    def test_sender_public_key_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(senderPublicKey="s" * 8193))

    def test_wrapping_alg_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(wrappingAlg="a" * 65))

    def test_connector_key_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(connectorKeyId="c" * 129))

    def test_source_content_revision_zero_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(sourceContentRevision=0))

    def test_source_manifest_revision_zero_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**_upload_valid(sourceManifestRevision=0))

    def test_source_revisions_valid(self):
        RefreshExportUploadRequest(
            **_upload_valid(sourceContentRevision=1, sourceManifestRevision=5)
        )


# ---------------------------------------------------------------------------
# RefreshExportFailureRequest
# ---------------------------------------------------------------------------


class TestRefreshExportFailureRequest:
    def test_valid(self):
        m = RefreshExportFailureRequest(userId="u1", consentToken="ct1")
        assert m.lastError is None

    def test_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportFailureRequest(userId="", consentToken="ct1")

    def test_user_id_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportFailureRequest(userId="a" * 129, consentToken="ct1")

    def test_consent_token_empty_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportFailureRequest(userId="u1", consentToken="")

    def test_consent_token_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportFailureRequest(userId="u1", consentToken="t" * 2049)

    def test_last_error_too_long_rejected(self):
        with pytest.raises(ValidationError):
            RefreshExportFailureRequest(userId="u1", consentToken="ct1", lastError="e" * 2001)

    def test_last_error_max_accepted(self):
        RefreshExportFailureRequest(userId="u1", consentToken="ct1", lastError="e" * 2000)

    def test_last_error_none_accepted(self):
        RefreshExportFailureRequest(userId="u1", consentToken="ct1", lastError=None)
