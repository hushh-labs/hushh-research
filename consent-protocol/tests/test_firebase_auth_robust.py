from __future__ import annotations

import os
import sys

# Ensure root directory is in sys.path before importing api/routes/etc
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from fastapi import HTTPException

from api.utils.firebase_auth import verify_firebase_bearer


def test_verify_firebase_bearer_audience_mismatch(monkeypatch):
    import firebase_admin.auth as firebase_auth

    project_id = "target-firebase-project-123"
    bearer_value = "token_with_wrong_audience"

    # Mock ensure_firebase_auth_admin to return a valid configuration with the project ID
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, project_id),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    # Mock firebase verification to return a mismatched audience
    def mock_verify_id_token(token: str, app=None):
        return {
            "uid": "user_abc",
            "aud": "wrong-project-456",
            "iss": f"https://securetoken.google.com/{project_id}",
        }

    monkeypatch.setattr(firebase_auth, "verify_id_token", mock_verify_id_token)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer(f"Bearer {bearer_value}")

    assert exc.value.status_code == 401
    assert "audience" in exc.value.detail.lower()


def test_verify_firebase_bearer_issuer_mismatch(monkeypatch):
    import firebase_admin.auth as firebase_auth

    project_id = "target-firebase-project-123"
    bearer_value = "token_with_wrong_issuer"

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, project_id),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    # Mock firebase verification to return a mismatched issuer
    def mock_verify_id_token(token: str, app=None):
        return {
            "uid": "user_abc",
            "aud": project_id,
            "iss": "https://securetoken.google.com/wrong-project-456",
        }

    monkeypatch.setattr(firebase_auth, "verify_id_token", mock_verify_id_token)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer(f"Bearer {bearer_value}")

    assert exc.value.status_code == 401
    assert "issuer" in exc.value.detail.lower()


def test_verify_firebase_bearer_valid_audience_and_issuer(monkeypatch):
    import firebase_admin.auth as firebase_auth

    project_id = "target-firebase-project-123"
    bearer_value = "completely_valid_token"

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, project_id),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    # Mock firebase verification to return matching audience and issuer
    def mock_verify_id_token(token: str, app=None):
        return {
            "uid": "user_abc",
            "aud": project_id,
            "iss": f"https://securetoken.google.com/{project_id}",
        }

    monkeypatch.setattr(firebase_auth, "verify_id_token", mock_verify_id_token)

    uid = verify_firebase_bearer(f"Bearer {bearer_value}")
    assert uid == "user_abc"
