"""
Tests that RefreshExportUploadRequest enforces max_length on encryptedData.

Canonical attach point:
    api.routes.consent.RefreshExportUploadRequest (consumed by upload_refresh_export)
    -> POST /api/consent/refresh-export/upload
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.consent import RefreshExportUploadRequest

_VALID_BASE = dict(
    userId="user_abc",
    consentToken="tok_" + "x" * 20,
    encryptedIv="a" * 16,
    encryptedTag="b" * 16,
    wrappedExportKey="c" * 44,
    wrappedKeyIv="d" * 16,
    wrappedKeyTag="e" * 16,
    senderPublicKey="f" * 44,
)


class TestRefreshExportUploadBounds:
    """Verifies that encryptedData is rejected when it exceeds 10 MB."""

    def test_oversized_encrypted_data_raises_validation_error(self):
        oversized = "x" * 10_000_001
        with pytest.raises(ValidationError) as exc_info:
            RefreshExportUploadRequest(**_VALID_BASE, encryptedData=oversized)

        errors = exc_info.value.errors()
        field_errors = [e for e in errors if "encryptedData" in str(e.get("loc", ""))]
        assert field_errors, f"Expected encryptedData error, got: {errors}"

    def test_max_allowed_encrypted_data_is_accepted(self):
        at_limit = "x" * 10_000_000
        model = RefreshExportUploadRequest(**_VALID_BASE, encryptedData=at_limit)
        assert len(model.encryptedData) == 10_000_000

    def test_empty_encrypted_data_is_rejected(self):
        with pytest.raises(ValidationError) as exc_info:
            RefreshExportUploadRequest(**_VALID_BASE, encryptedData="")

        errors = exc_info.value.errors()
        field_errors = [e for e in errors if "encryptedData" in str(e.get("loc", ""))]
        assert field_errors

    def test_normal_encrypted_data_is_accepted(self):
        normal = "x" * 1000
        model = RefreshExportUploadRequest(**_VALID_BASE, encryptedData=normal)
        assert model.encryptedData == normal
