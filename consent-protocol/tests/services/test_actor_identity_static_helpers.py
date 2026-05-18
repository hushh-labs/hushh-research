"""Behavioral tests for ActorIdentityService pure static helper methods.

These methods are security-critical gate-keepers in the identity / alias
verification flow and have no existing test coverage. They are pure functions
that require no DB or network access.

Covers:
- _looks_like_firebase_uid: length gate, prefix deny-list, character rules
- _normalize_email_alias: valid/invalid email, length caps, casing, @ rules
- _is_stale: datetime parsing, timezone handling, staleness boundary
- _hash_alias_verification_code: determinism, whitespace stripping, case fold,
  empty-code rejection
- _normalize_row: field mapping, empty/None handling, boolean coercion
- _normalize_alias_row: field mapping, None passthrough for optional fields
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services.actor_identity_service import (
    _IDENTITY_STALE_AFTER,
    ActorIdentityAliasError,
    ActorIdentityService,
)

svc = ActorIdentityService()

# ---------------------------------------------------------------------------
# _looks_like_firebase_uid
# ---------------------------------------------------------------------------


class TestLooksLikeFirebaseUid:
    def test_valid_uid_accepted(self):
        # Firebase UIDs are 28 alphanumeric chars
        assert ActorIdentityService._looks_like_firebase_uid("A" * 28) is True

    def test_minimum_length_20_accepted(self):
        assert ActorIdentityService._looks_like_firebase_uid("A" * 20) is True

    def test_uid_too_short_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("A" * 19) is False

    def test_empty_string_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("") is False

    def test_whitespace_only_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("   ") is False

    def test_email_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("user@example.com") is False

    def test_uid_with_colon_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("ria:user-1234567890123456") is False

    def test_uid_with_slash_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("agent/user-1234567890123456") is False

    def test_uid_with_space_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("user id 1234567890123456") is False

    def test_ria_prefix_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("ria_agent_user_1234567890") is False

    def test_ria_dash_prefix_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("ria-agent-1234567890123456") is False

    def test_dev_prefix_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("dev_user_123456789012345") is False

    def test_app_prefix_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("app_user_123456789012345") is False

    def test_agent_prefix_rejected(self):
        assert ActorIdentityService._looks_like_firebase_uid("agent_user_12345678901234") is False

    def test_valid_uid_with_mixed_case(self):
        assert ActorIdentityService._looks_like_firebase_uid("aBcDeFgHiJkLmNoPqRsTuVwXyZ12") is True


# ---------------------------------------------------------------------------
# _normalize_email_alias
# ---------------------------------------------------------------------------


class TestNormalizeEmailAlias:
    def test_valid_email_lowercased(self):
        result = ActorIdentityService._normalize_email_alias("User@Example.COM")
        assert result == "user@example.com"

    def test_valid_email_stripped(self):
        result = ActorIdentityService._normalize_email_alias("  user@example.com  ")
        assert result == "user@example.com"

    def test_none_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias(None)
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_empty_string_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_missing_at_sign_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("nodomain.com")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_multiple_at_signs_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("a@b@c.com")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_domain_without_dot_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("user@nodot")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_email_too_long_raises(self):
        long_local = "a" * 310
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias(f"{long_local}@example.com")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_email_with_internal_space_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("user name@example.com")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_empty_local_part_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("@example.com")
        assert exc.value.code == "EMAIL_ALIAS_INVALID"

    def test_status_code_is_422(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._normalize_email_alias("bad")
        assert exc.value.status_code == 422


# ---------------------------------------------------------------------------
# _is_stale
# ---------------------------------------------------------------------------


class TestIsStale:
    def test_none_identity_is_stale(self):
        assert ActorIdentityService._is_stale(None) is True

    def test_empty_dict_is_stale(self):
        assert ActorIdentityService._is_stale({}) is True

    def test_missing_last_synced_at_is_stale(self):
        assert ActorIdentityService._is_stale({"user_id": "abc"}) is True

    def test_none_last_synced_at_is_stale(self):
        assert ActorIdentityService._is_stale({"last_synced_at": None}) is True

    def test_fresh_datetime_is_not_stale(self):
        fresh = datetime.now(timezone.utc) - timedelta(hours=1)
        assert ActorIdentityService._is_stale({"last_synced_at": fresh}) is False

    def test_old_datetime_is_stale(self):
        old = datetime.now(timezone.utc) - _IDENTITY_STALE_AFTER - timedelta(seconds=1)
        assert ActorIdentityService._is_stale({"last_synced_at": old}) is True

    def test_boundary_exactly_at_threshold_is_stale(self):
        # exactly at threshold means >= threshold → stale
        at_threshold = datetime.now(timezone.utc) - _IDENTITY_STALE_AFTER
        assert ActorIdentityService._is_stale({"last_synced_at": at_threshold}) is True

    def test_naive_datetime_treated_as_utc(self):
        fresh_naive = datetime.now() - timedelta(hours=1)  # no tzinfo
        assert ActorIdentityService._is_stale({"last_synced_at": fresh_naive}) is False

    def test_iso_string_fresh(self):
        fresh_iso = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        assert ActorIdentityService._is_stale({"last_synced_at": fresh_iso}) is False

    def test_iso_string_old(self):
        old_iso = (
            datetime.now(timezone.utc) - _IDENTITY_STALE_AFTER - timedelta(seconds=10)
        ).isoformat()
        assert ActorIdentityService._is_stale({"last_synced_at": old_iso}) is True

    def test_z_suffix_iso_string(self):
        fresh_z = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        assert ActorIdentityService._is_stale({"last_synced_at": fresh_z}) is False

    def test_invalid_string_is_stale(self):
        assert ActorIdentityService._is_stale({"last_synced_at": "not-a-date"}) is True


# ---------------------------------------------------------------------------
# _hash_alias_verification_code
# ---------------------------------------------------------------------------


class TestHashAliasVerificationCode:
    def _expected_hash(
        self,
        *,
        user_id: str,
        email_normalized: str,
        verification_code: str,
        secret: str,
    ) -> str:
        normalized_code = "".join(verification_code.split()).lower()
        material = f"{secret}:{user_id}:{email_normalized}:{normalized_code}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def test_produces_sha256_hex_digest(self):
        result = ActorIdentityService._hash_alias_verification_code(
            user_id="uid123",
            email_normalized="user@example.com",
            verification_code="123456",
        )
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)

    def test_same_inputs_produce_same_hash(self):
        kwargs = dict(
            user_id="uid123",
            email_normalized="user@example.com",
            verification_code="123456",
        )
        assert ActorIdentityService._hash_alias_verification_code(
            **kwargs
        ) == ActorIdentityService._hash_alias_verification_code(**kwargs)

    def test_whitespace_in_code_stripped(self):
        h1 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid", email_normalized="a@b.com", verification_code="123 456"
        )
        h2 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid", email_normalized="a@b.com", verification_code="123456"
        )
        assert h1 == h2

    def test_code_case_folded(self):
        h1 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid", email_normalized="a@b.com", verification_code="ABCDEF"
        )
        h2 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid", email_normalized="a@b.com", verification_code="abcdef"
        )
        assert h1 == h2

    def test_different_user_ids_produce_different_hashes(self):
        h1 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid1", email_normalized="a@b.com", verification_code="123456"
        )
        h2 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid2", email_normalized="a@b.com", verification_code="123456"
        )
        assert h1 != h2

    def test_different_emails_produce_different_hashes(self):
        h1 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid", email_normalized="a@b.com", verification_code="123456"
        )
        h2 = ActorIdentityService._hash_alias_verification_code(
            user_id="uid", email_normalized="c@d.com", verification_code="123456"
        )
        assert h1 != h2

    def test_empty_code_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._hash_alias_verification_code(
                user_id="uid",
                email_normalized="a@b.com",
                verification_code="",
            )
        assert exc.value.code == "EMAIL_ALIAS_CODE_REQUIRED"

    def test_whitespace_only_code_raises(self):
        with pytest.raises(ActorIdentityAliasError) as exc:
            ActorIdentityService._hash_alias_verification_code(
                user_id="uid",
                email_normalized="a@b.com",
                verification_code="   ",
            )
        assert exc.value.code == "EMAIL_ALIAS_CODE_REQUIRED"

    def test_hash_uses_env_secret(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("ACCOUNT_EMAIL_ALIAS_VERIFICATION_SECRET", "my-custom-secret")
        result = ActorIdentityService._hash_alias_verification_code(
            user_id="uid",
            email_normalized="a@b.com",
            verification_code="123456",
        )
        expected = self._expected_hash(
            user_id="uid",
            email_normalized="a@b.com",
            verification_code="123456",
            secret="my-custom-secret",  # noqa: S106
        )
        assert result == expected


# ---------------------------------------------------------------------------
# _normalize_row
# ---------------------------------------------------------------------------


class TestNormalizeRow:
    def test_maps_all_fields(self):
        now = datetime.now(timezone.utc)
        row = {
            "user_id": "uid1",
            "display_name": "Alice",
            "email": "alice@example.com",
            "phone_number": "+15005550101",
            "photo_url": "https://example.com/pic.jpg",
            "email_verified": True,
            "phone_verified": False,
            "source": "firebase_auth",
            "last_synced_at": now,
            "created_at": now,
            "updated_at": now,
        }
        result = ActorIdentityService._normalize_row(row)
        assert result["user_id"] == "uid1"
        assert result["display_name"] == "Alice"
        assert result["email"] == "alice@example.com"
        assert result["phone_number"] == "+15005550101"
        assert result["email_verified"] is True
        assert result["phone_verified"] is False
        assert result["source"] == "firebase_auth"

    def test_empty_row_returns_empty_dict(self):
        result = ActorIdentityService._normalize_row({})
        assert result == {}

    def test_none_row_returns_empty_dict(self):
        result = ActorIdentityService._normalize_row(None)
        assert result == {}

    def test_none_display_name_returns_none(self):
        result = ActorIdentityService._normalize_row({"user_id": "uid", "display_name": None})
        assert result["display_name"] is None

    def test_empty_display_name_returns_none(self):
        result = ActorIdentityService._normalize_row({"user_id": "uid", "display_name": ""})
        assert result["display_name"] is None

    def test_whitespace_display_name_returns_none(self):
        result = ActorIdentityService._normalize_row({"user_id": "uid", "display_name": "   "})
        assert result["display_name"] is None

    def test_source_defaults_to_unknown(self):
        result = ActorIdentityService._normalize_row({"user_id": "uid"})
        assert result["source"] == "unknown"

    def test_email_verified_defaults_to_false(self):
        result = ActorIdentityService._normalize_row({"user_id": "uid"})
        assert result["email_verified"] is False

    def test_phone_verified_defaults_to_false(self):
        result = ActorIdentityService._normalize_row({"user_id": "uid"})
        assert result["phone_verified"] is False


# ---------------------------------------------------------------------------
# _normalize_alias_row
# ---------------------------------------------------------------------------


class TestNormalizeAliasRow:
    def test_maps_all_required_fields(self):
        now = datetime.now(timezone.utc)
        row = {
            "alias_id": "alias_1",
            "user_id": "uid1",
            "email": "user@example.com",
            "email_normalized": "user@example.com",
            "verification_status": "verified",
            "verification_source": "user_verified",
            "source_ref": None,
            "verification_requested_at": now,
            "verified_at": now,
            "revoked_at": None,
            "last_matched_at": None,
            "created_at": now,
            "updated_at": now,
        }
        result = ActorIdentityService._normalize_alias_row(row)
        assert result["alias_id"] == "alias_1"
        assert result["user_id"] == "uid1"
        assert result["email"] == "user@example.com"
        assert result["email_normalized"] == "user@example.com"
        assert result["verification_status"] == "verified"

    def test_optional_datetime_fields_passthrough_none(self):
        result = ActorIdentityService._normalize_alias_row(
            {
                "alias_id": "",
                "user_id": "uid",
                "email": "",
                "email_normalized": "",
                "verification_status": "",
                "verification_source": "",
                "source_ref": None,
                "verification_requested_at": None,
                "verified_at": None,
                "revoked_at": None,
                "last_matched_at": None,
                "created_at": None,
                "updated_at": None,
            }
        )
        assert result["verified_at"] is None
        assert result["revoked_at"] is None
        assert result["source_ref"] is None

    def test_empty_row_produces_empty_strings(self):
        result = ActorIdentityService._normalize_alias_row({})
        assert result["alias_id"] == ""
        assert result["user_id"] == ""
        assert result["verification_status"] == ""
