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


def _upload_valid(**overrides):
    base = {
        "userId": "user_1",
        "consentToken": "token_1",
        "encryptedData": "ciphertext",
        "encryptedIv": "iv",
        "encryptedTag": "tag",
        "wrappedExportKey": "key",
        "wrappedKeyIv": "key_iv",
        "wrappedKeyTag": "key_tag",
        "senderPublicKey": "public_key",
    }
    return {**base, **overrides}


def test_cancel_consent_request_rejects_empty_and_long_ids():
    CancelConsentRequest(userId="u" * 128, requestId="r" * 128)
    with pytest.raises(ValidationError):
        CancelConsentRequest(userId="", requestId="request")
    with pytest.raises(ValidationError):
        CancelConsentRequest(userId="user", requestId="r" * 129)


def test_pending_consent_opened_request_bounds_optional_strings():
    PendingConsentOpenedRequest(userId="user", openedVia="o" * 64)
    with pytest.raises(ValidationError):
        PendingConsentOpenedRequest(userId="user", requestId="r" * 129)
    with pytest.raises(ValidationError):
        PendingConsentOpenedRequest(userId="user", bundleId="b" * 129)
    with pytest.raises(ValidationError):
        PendingConsentOpenedRequest(userId="user", openedVia="o" * 65)


def test_generic_consent_request_bounds_actor_duration_and_text():
    GenericConsentRequestCreate(
        subject_user_id="user",
        scope_template_id="template",
        requester_actor_type="investor",
        duration_hours=8760,
        reason="r" * 1000,
    )
    with pytest.raises(ValidationError):
        GenericConsentRequestCreate(subject_user_id="", scope_template_id="template")
    with pytest.raises(ValidationError):
        GenericConsentRequestCreate(
            subject_user_id="user",
            scope_template_id="template",
            duration_hours=0,
        )
    with pytest.raises(ValidationError):
        GenericConsentRequestCreate(
            subject_user_id="user",
            scope_template_id="template",
            reason="r" * 1001,
        )


def test_relationship_disconnect_request_bounds_optional_ids():
    RelationshipDisconnectRequest(investor_user_id="i" * 128, ria_profile_id="r" * 128)
    with pytest.raises(ValidationError):
        RelationshipDisconnectRequest(investor_user_id="i" * 129)
    with pytest.raises(ValidationError):
        RelationshipDisconnectRequest(ria_profile_id="r" * 129)


def test_refresh_export_upload_request_bounds_large_fields():
    RefreshExportUploadRequest(
        **_upload_valid(
            consentToken="t" * 2048,
            wrappedExportKey="k" * 8192,
            senderPublicKey="s" * 8192,
            sourceContentRevision=1,
            sourceManifestRevision=1,
        )
    )
    with pytest.raises(ValidationError):
        RefreshExportUploadRequest(**_upload_valid(consentToken=""))
    with pytest.raises(ValidationError):
        RefreshExportUploadRequest(**_upload_valid(wrappedExportKey="k" * 8193))
    with pytest.raises(ValidationError):
        RefreshExportUploadRequest(**_upload_valid(sourceContentRevision=0))


def test_refresh_export_failure_request_bounds_error_text():
    RefreshExportFailureRequest(userId="user", consentToken="t" * 2048, lastError="e" * 2000)
    with pytest.raises(ValidationError):
        RefreshExportFailureRequest(userId="", consentToken="token")
    with pytest.raises(ValidationError):
        RefreshExportFailureRequest(userId="user", consentToken="t" * 2049)
    with pytest.raises(ValidationError):
        RefreshExportFailureRequest(userId="user", consentToken="token", lastError="e" * 2001)
