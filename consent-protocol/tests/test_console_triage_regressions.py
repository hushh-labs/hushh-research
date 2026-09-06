"""Regressions from the 2026-08-08 UAT console triage.

Three failure modes seen live: a just-deleted account's replayed token turned
into a 500, discovery-only PKM domains sent every app entry into a doomed
upgrade run, and all Firebase-authenticated users shared one rate-limit
bucket through the Next.js proxy IP.
"""

from __future__ import annotations

import base64
import json

import pytest
from fastapi import HTTPException

from api.middlewares.observability import _unverified_jwt_subject
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.pkm_upgrade_service import PkmUpgradeService
from tests.test_pkm_upgrade_service import _FakePkmService


def test_deleted_account_token_is_401_not_500(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "hushh-pda"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def fake_verify(token: str, app=None, check_revoked: bool = False):
        raise firebase_auth.UserNotFoundError("No user record found")

    monkeypatch.setattr(firebase_auth, "verify_id_token", fake_verify)

    with pytest.raises(HTTPException) as excinfo:
        verify_firebase_bearer("Bearer replayed-after-deletion")
    assert excinfo.value.status_code == 401
    assert excinfo.value.detail == {
        "code": "AUTH_ACCOUNT_NOT_FOUND",
        "message": "Account not found",
    }


@pytest.mark.asyncio
async def test_discovery_only_domain_is_not_upgradable():
    # A server-side summary flag (e.g. a claim's has_regulator_profile) lists
    # the domain in the index before any encrypted blob exists. There is
    # nothing to upgrade — a run would fail on the missing blob forever.
    service = PkmUpgradeService()
    service._pkm_service = _FakePkmService(has_blob=False)

    async def _no_runs(_user_id: str):
        return None

    service._get_latest_run = _no_runs  # type: ignore[method-assign]

    status = await service.build_status("user_123")

    assert status["upgradable_domains"] == []


@pytest.mark.asyncio
async def test_missing_manifest_with_blob_still_bootstraps():
    # The inverse must keep working: legacy data (blob, no manifest) upgrades.
    service = PkmUpgradeService()
    service._pkm_service = _FakePkmService(has_blob=True)

    async def _no_runs(_user_id: str):
        return None

    service._get_latest_run = _no_runs  # type: ignore[method-assign]

    status = await service.build_status("user_123")

    assert [d["domain"] for d in status["upgradable_domains"]] == ["financial"]


def _jwt_with_claims(claims: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{body}.signature"


def test_firebase_bearer_gets_its_own_rate_limit_bucket():
    assert _unverified_jwt_subject(_jwt_with_claims({"sub": "uid_abc"})) == "uid_abc"
    assert _unverified_jwt_subject(_jwt_with_claims({"user_id": "uid_xyz"})) == "uid_xyz"


def test_malformed_tokens_fall_back_to_ip_bucket():
    assert _unverified_jwt_subject("not-a-jwt") is None
    assert _unverified_jwt_subject("a.b") is None
    assert _unverified_jwt_subject(_jwt_with_claims({"sub": "x" * 200})) is None
    assert _unverified_jwt_subject("h." + "!!notbase64!!" + ".s") is None
