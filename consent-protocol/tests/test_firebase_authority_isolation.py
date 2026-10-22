# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from api.utils import firebase_admin as authority
from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle
from hushh_mcp.services.enterprise_sso.errors import EnterpriseSsoError
from hushh_mcp.services.enterprise_sso.firebase_identity import FirebaseAdminIdentity


@pytest.mark.parametrize(
    "environment,profile,project,allowed",
    [
        ("production", "prod", "hushh-pda", True),
        ("uat", "uat", "hushh-pda-uat", True),
        ("development", "local", "hushh-pda-uat", True),
        ("uat", "uat", "hushh-pda", False),
        ("development", "local", "hushh-pda", False),
        ("production", "prod", "hushh-pda-uat", False),
        ("uat", "prod", "hushh-pda", False),
        ("production", "uat", "hushh-pda", False),
        ("unknown", "", "hushh-pda-uat", False),
        ("uat", "uat", None, False),
    ],
)
def test_identity_mutation_authority_matrix(monkeypatch, environment, profile, project, allowed):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("APP_RUNTIME_PROFILE", profile)
    app = SimpleNamespace(project_id=project)
    if allowed:
        authority.assert_firebase_identity_mutation_allowed(app)
    else:
        with pytest.raises(authority.FirebaseAuthorityError, match="firebase_authority_mismatch"):
            authority.assert_firebase_identity_mutation_allowed(app)


def test_existing_default_app_cannot_override_canonical_credentials(monkeypatch):
    monkeypatch.setenv(
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        json.dumps({"type": "service_account", "project_id": "hushh-pda-uat"}),
    )
    monkeypatch.setattr(
        authority, "_get_existing_app", lambda *_: SimpleNamespace(project_id="hushh-pda")
    )
    with pytest.raises(authority.FirebaseAuthorityError):
        authority.ensure_firebase_admin()


def test_adc_project_mismatch_cannot_fall_back_to_an_existing_app(monkeypatch):
    import firebase_admin
    from firebase_admin import credentials

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "prod")
    monkeypatch.setattr(authority, "_get_existing_app", lambda *_: None)
    monkeypatch.setattr(credentials, "ApplicationDefault", lambda: object())
    monkeypatch.setattr(
        firebase_admin,
        "initialize_app",
        lambda *_a, **_k: SimpleNamespace(project_id="hushh-pda-uat"),
    )
    with pytest.raises(authority.FirebaseAuthorityError):
        authority.ensure_firebase_admin()


@pytest.mark.parametrize(
    "environment,project,expected",
    [
        ("uat", "hushh-pda", "retry_pending"),
        ("uat", "hushh-pda-uat", "deleted"),
        ("production", "hushh-pda", "deleted"),
    ],
)
def test_cleanup_preserves_shared_prod_identity_and_keeps_pending_work(
    monkeypatch, environment, project, expected
):
    from firebase_admin import auth

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "prod" if environment == "production" else "uat")
    app = SimpleNamespace(project_id=project)
    monkeypatch.setattr(lifecycle, "get_firebase_auth_app", lambda: app)
    delete, update, revoke = MagicMock(), MagicMock(), MagicMock()
    monkeypatch.setattr(auth, "delete_user", delete)
    monkeypatch.setattr(auth, "update_user", update)
    monkeypatch.setattr(auth, "revoke_refresh_tokens", revoke)
    service = lifecycle.AccountDeletionLifecycleService()
    result = asyncio.run(service.delete_or_quarantine_firebase_identity("unchanged-fixture-uid"))
    assert result.outcome == expected
    if expected == "retry_pending":
        assert result.classification == "firebase_authority_mismatch"
        quarantine = asyncio.run(service.quarantine_firebase_identity("unchanged-fixture-uid"))
        assert quarantine.outcome == "quarantine_incomplete"
        delete.assert_not_called()
        update.assert_not_called()
        revoke.assert_not_called()
    else:
        delete.assert_called_once_with("unchanged-fixture-uid", app=app)


@pytest.mark.parametrize("initialization_refused", [False, True])
def test_uat_sso_cannot_deprovision_or_rewrite_shared_prod_claims(
    monkeypatch, initialization_refused
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    sdk = MagicMock()
    sdk.UserNotFoundError = type("FixtureNotFound", (Exception,), {})
    app = SimpleNamespace(project_id="hushh-pda")
    identity = FirebaseAdminIdentity()

    def auth_context():
        if initialization_refused:
            raise authority.FirebaseAuthorityError("firebase_authority_mismatch")
        return sdk, app

    monkeypatch.setattr(identity, "_auth", auth_context)
    with pytest.raises(EnterpriseSsoError) as refused:
        asyncio.run(identity.merge_claims("same-uid", {"workosDeprovisionedAt": 1}))
    assert refused.value.status_code == 503
    assert asyncio.run(identity.revoke_sessions("same-uid")) is False
    sdk.set_custom_user_claims.assert_not_called()
    sdk.update_user.assert_not_called()
    sdk.delete_user.assert_not_called()
    sdk.revoke_refresh_tokens.assert_not_called()
