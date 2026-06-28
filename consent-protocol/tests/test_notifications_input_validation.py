"""Tests for push notification endpoint input bounds (CWE-400).

Validates Pydantic model field length constraints on the RegisterPushTokenRequest
and UnregisterPushTokenRequest models introduced to replace raw dict body parsing.

Bugs fixed:
- Device token field had no max_length (FCM: 163 chars, APNs: 128 chars hex)
- user_id field had no max_length
- Synchronous PushTokensService calls were not wrapped in run_in_threadpool

Canonical attach points:
- POST /api/notifications/register (api/routes/notifications.py)
- DELETE /api/notifications/unregister (api/routes/notifications.py)
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.notifications import (
    _MAX_PUSH_TOKEN_LENGTH,
    _MAX_USER_ID_LENGTH,
    RegisterPushTokenRequest,
    UnregisterPushTokenRequest,
)


class TestRegisterPushTokenRequestBounds:
    """Validate field bounds on RegisterPushTokenRequest."""

    def test_token_at_max_length_accepted(self):
        """Verify token at exactly max_length is accepted."""
        req = RegisterPushTokenRequest(
            user_id="user123",
            token="t" * _MAX_PUSH_TOKEN_LENGTH,
        )
        assert len(req.token) == _MAX_PUSH_TOKEN_LENGTH

    def test_token_over_max_length_rejected(self):
        """Verify token exceeding max_length raises ValidationError."""
        with pytest.raises(ValidationError):
            RegisterPushTokenRequest(
                user_id="user123",
                token="t" * (_MAX_PUSH_TOKEN_LENGTH + 1),
            )

    def test_empty_token_rejected(self):
        """Verify empty token (min_length=1) raises ValidationError."""
        with pytest.raises(ValidationError):
            RegisterPushTokenRequest(user_id="user123", token="")

    def test_user_id_at_max_length_accepted(self):
        """Verify user_id at exactly max_length is accepted."""
        req = RegisterPushTokenRequest(
            user_id="u" * _MAX_USER_ID_LENGTH,
            token="t" * 10,
        )
        assert len(req.user_id) == _MAX_USER_ID_LENGTH

    def test_user_id_over_max_length_rejected(self):
        """Verify user_id exceeding max_length raises ValidationError."""
        with pytest.raises(ValidationError):
            RegisterPushTokenRequest(
                user_id="u" * (_MAX_USER_ID_LENGTH + 1),
                token="t" * 10,
            )

    def test_empty_user_id_rejected(self):
        """Verify empty user_id (min_length=1) raises ValidationError."""
        with pytest.raises(ValidationError):
            RegisterPushTokenRequest(user_id="", token="t" * 10)

    def test_platform_defaults_to_web(self):
        """Verify default platform is web."""
        req = RegisterPushTokenRequest(user_id="user123", token="t" * 10)
        assert req.platform == "web"

    def test_valid_platforms_accepted(self):
        """Verify all valid platforms are accepted."""
        for platform in ("web", "ios", "android"):
            req = RegisterPushTokenRequest(
                user_id="user123",
                token="t" * 10,
                platform=platform,
            )
            assert req.platform == platform

    def test_invalid_platform_rejected(self):
        """Verify unsupported platform value raises ValidationError."""
        with pytest.raises(ValidationError):
            RegisterPushTokenRequest(
                user_id="user123",
                token="t" * 10,
                platform="desktop",
            )

    def test_realistic_fcm_token_accepted(self):
        """Verify realistic FCM token length (163 chars) is accepted."""
        fcm_token = "c" * 163
        req = RegisterPushTokenRequest(user_id="user123", token=fcm_token, platform="android")
        assert len(req.token) == 163

    def test_realistic_apns_token_accepted(self):
        """Verify realistic APNs hex device token length (128 chars) is accepted."""
        apns_token = "a" * 128
        req = RegisterPushTokenRequest(user_id="user123", token=apns_token, platform="ios")
        assert len(req.token) == 128


class TestUnregisterPushTokenRequestBounds:
    """Validate field bounds on UnregisterPushTokenRequest."""

    def test_user_id_over_max_length_rejected(self):
        """Verify oversized user_id in unregister request raises ValidationError."""
        with pytest.raises(ValidationError):
            UnregisterPushTokenRequest(user_id="u" * (_MAX_USER_ID_LENGTH + 1))

    def test_user_id_at_max_length_accepted(self):
        """Verify user_id at exactly max_length is accepted."""
        req = UnregisterPushTokenRequest(user_id="u" * _MAX_USER_ID_LENGTH)
        assert len(req.user_id) == _MAX_USER_ID_LENGTH

    def test_user_id_defaults_to_none(self):
        """Verify user_id defaults to None when not provided."""
        req = UnregisterPushTokenRequest()
        assert req.user_id is None

    def test_platform_defaults_to_none(self):
        """Verify platform defaults to None (remove all platforms)."""
        req = UnregisterPushTokenRequest(user_id="user123")
        assert req.platform is None

    def test_invalid_platform_rejected(self):
        """Verify unsupported platform value raises ValidationError."""
        with pytest.raises(ValidationError):
            UnregisterPushTokenRequest(user_id="user123", platform="fax")
