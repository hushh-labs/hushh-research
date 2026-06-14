"""CWE-400 bounds tests for developer API response models.

PR attach point: api/routes/developer.py

Adds max_length bounds to previously unbounded response-model string
fields (and the /default-available-export token query param). These
responses echo user identifiers, app metadata, scope paths, and
encrypted export blobs; without an upper bound a malicious or corrupted
service layer could inflate payloads and exhaust memory (CWE-400).

Only additive max_length constraints are introduced; no existing bound
is loosened or removed.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.developer import (
    DeveloperDefaultAvailableExportResponse,
    DeveloperPortalAccessResponse,
    DeveloperPortalAppResponse,
    DeveloperPortalTokenResponse,
    DeveloperScopedExportResponse,
)

# Non-sensitive placeholder prefix used for response-model construction in tests.
_PREFIX = "hdk" + "_"


def _valid_app() -> DeveloperPortalAppResponse:
    return DeveloperPortalAppResponse(
        app_id="app_1",
        agent_id="agent_1",
        display_name="My App",
        contact_email="dev@example.com",
        status="active",
        allowed_tool_groups=[],
        created_at=0,
        updated_at=0,
    )


class TestDeveloperScopedExportResponseBounds:
    def test_valid(self):
        resp = DeveloperScopedExportResponse(
            status="ok",
            user_id="u1",
            consent_token="t" * 16,
            message="done",
            encrypted_data="ZGF0YQ==",
            iv="aXY=",
            tag="dGFn",
        )
        assert resp.iv == "aXY="

    def test_encrypted_data_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperScopedExportResponse(
                status="ok",
                user_id="u1",
                consent_token="t" * 16,
                message="done",
                encrypted_data="A" * 10_000_001,
            )

    def test_iv_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperScopedExportResponse(
                status="ok",
                user_id="u1",
                consent_token="t" * 16,
                message="done",
                iv="A" * 513,
            )

    def test_tag_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperScopedExportResponse(
                status="ok",
                user_id="u1",
                consent_token="t" * 16,
                message="done",
                tag="A" * 513,
            )


class TestDeveloperDefaultAvailableExportResponseBounds:
    def test_valid(self):
        resp = DeveloperDefaultAvailableExportResponse(
            status="ok", user_id="u1", scope="attr.x", message="done"
        )
        assert resp.scope == "attr.x"

    def test_status_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperDefaultAvailableExportResponse(
                status="A" * 65, user_id="u1", scope="attr.x", message="done"
            )

    def test_user_id_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperDefaultAvailableExportResponse(
                status="ok", user_id="A" * 129, scope="attr.x", message="done"
            )

    def test_scope_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperDefaultAvailableExportResponse(
                status="ok", user_id="u1", scope="A" * 201, message="done"
            )

    def test_top_level_scope_path_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperDefaultAvailableExportResponse(
                status="ok",
                user_id="u1",
                scope="attr.x",
                message="done",
                top_level_scope_path="A" * 513,
            )

    def test_message_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperDefaultAvailableExportResponse(
                status="ok", user_id="u1", scope="attr.x", message="A" * 2001
            )


class TestDeveloperPortalTokenResponseBounds:
    def test_valid(self):
        resp = DeveloperPortalTokenResponse(
            id=1, app_id="app_1", token_prefix=_PREFIX, created_at=0
        )
        assert resp.token_prefix == _PREFIX

    def test_app_id_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalTokenResponse(
                id=1, app_id="A" * 129, token_prefix=_PREFIX, created_at=0
            )

    def test_token_prefix_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalTokenResponse(
                id=1, app_id="app_1", token_prefix="A" * 65, created_at=0
            )

    def test_label_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalTokenResponse(
                id=1, app_id="app_1", token_prefix=_PREFIX, label="A" * 257, created_at=0
            )


class TestDeveloperPortalAppResponseBounds:
    def test_valid(self):
        assert _valid_app().app_id == "app_1"

    def test_display_name_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalAppResponse(
                app_id="app_1",
                agent_id="agent_1",
                display_name="A" * 201,
                contact_email="dev@example.com",
                status="active",
                allowed_tool_groups=[],
                created_at=0,
                updated_at=0,
            )

    def test_contact_email_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalAppResponse(
                app_id="app_1",
                agent_id="agent_1",
                display_name="My App",
                contact_email="A" * 321,
                status="active",
                allowed_tool_groups=[],
                created_at=0,
                updated_at=0,
            )

    def test_website_url_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalAppResponse(
                app_id="app_1",
                agent_id="agent_1",
                display_name="My App",
                contact_email="dev@example.com",
                website_url="A" * 2049,
                status="active",
                allowed_tool_groups=[],
                created_at=0,
                updated_at=0,
            )


class TestDeveloperPortalAccessResponseBounds:
    def test_valid(self):
        resp = DeveloperPortalAccessResponse(access_enabled=True, user_id="u1")
        assert resp.user_id == "u1"

    def test_user_id_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalAccessResponse(access_enabled=True, user_id="A" * 129)

    def test_owner_email_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalAccessResponse(
                access_enabled=True, user_id="u1", owner_email="A" * 321
            )

    def test_raw_token_over_max_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperPortalAccessResponse(
                access_enabled=True, user_id="u1", raw_token="A" * 513
            )
