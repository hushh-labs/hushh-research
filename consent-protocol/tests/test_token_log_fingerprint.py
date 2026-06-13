# tests/test_token_log_fingerprint.py
"""
Canonical attach point:
  hushh_mcp.services.consent_db._token_fingerprint
  -> hushh_mcp.services.consent_db.ConsentDBService.store_consent_export
  -> api.routes.consent.approve_consent -> POST /api/consent/{requestId}/approve

Proves that log statements in ConsentDBService no longer emit raw token
prefix slices; instead they emit a 12-character SHA-256 hex fingerprint that
cannot be used to reconstruct or brute-force the original token value.
"""

import hashlib
import logging

from hushh_mcp.services.consent_db import _token_fingerprint

_SAMPLE_TOKEN_STR = "hushh_consent:abc123def456.sig"  # noqa: S105
_SAMPLE_TOKEN_SECRET = "hushh_consent:realsecretvalue.invalidsig"  # noqa: S105
_SAMPLE_TOKEN_DELETE = "hushh_consent:secretdeletetoken.fakesig"  # noqa: S105


class TestTokenLogFingerprint:
    """_token_fingerprint must return a 12-char hex digest, not the raw prefix."""

    def test_fingerprint_is_twelve_hex_chars(self):
        fp = _token_fingerprint(_SAMPLE_TOKEN_STR)
        assert len(fp) == 12
        assert all(c in "0123456789abcdef" for c in fp)

    def test_fingerprint_matches_sha256(self):
        expected = hashlib.sha256(_SAMPLE_TOKEN_STR.encode()).hexdigest()[:12]
        assert _token_fingerprint(_SAMPLE_TOKEN_STR) == expected

    def test_raw_prefix_not_equal_to_fingerprint(self):
        fp = _token_fingerprint(_SAMPLE_TOKEN_STR)
        raw_prefix = _SAMPLE_TOKEN_STR[:12]
        assert fp != raw_prefix, "Fingerprint must not equal raw token prefix"

    def test_store_consent_export_logs_fingerprint_not_raw(self, caplog):
        """store_consent_export must log the fingerprint, not the raw token value."""
        consent_str = _SAMPLE_TOKEN_SECRET
        fp = _token_fingerprint(consent_str)

        from unittest.mock import MagicMock, patch

        service_path = "hushh_mcp.services.consent_db.ConsentDBService._get_supabase"
        with caplog.at_level(logging.ERROR, logger="hushh_mcp.services.consent_db"):
            with patch(service_path) as mock_sb:
                # Force the wrapped-key-bundle guard to log by passing None bundle
                mock_sb.return_value = MagicMock()
                import asyncio

                from hushh_mcp.services.consent_db import ConsentDBService

                svc = ConsentDBService()
                result = asyncio.run(
                    svc.store_consent_export(
                        user_id="user-1",
                        consent_token=consent_str,
                        encrypted_data="enc",
                        iv="iv",
                        tag="tag",
                        wrapped_key_bundle=None,
                        expires_at_ms=9999999999999,
                    )
                )

        assert result is False
        log_text = " ".join(caplog.messages)
        assert "realsecretvalue" not in log_text, "Raw token must not appear in logs"
        assert fp in log_text, "SHA-256 fingerprint must appear in logs"

    def test_delete_consent_export_logs_fingerprint_not_raw(self, caplog):
        """delete_consent_export must log fingerprint, not the raw token prefix."""
        consent_str = _SAMPLE_TOKEN_DELETE
        fp = _token_fingerprint(consent_str)

        from unittest.mock import MagicMock, patch

        with caplog.at_level(logging.INFO, logger="hushh_mcp.services.consent_db"):
            with patch(
                "hushh_mcp.services.consent_db.ConsentDBService._get_supabase"
            ) as mock_sb:
                mock_sb.return_value = MagicMock()
                import asyncio

                from hushh_mcp.services.consent_db import ConsentDBService

                svc = ConsentDBService()
                asyncio.run(svc.delete_consent_export(consent_token=consent_str))

        log_text = " ".join(caplog.messages)
        assert "secretdeletetoken" not in log_text, "Raw token slice must not appear in logs"
        assert fp in log_text, "SHA-256 fingerprint must appear in logs"
