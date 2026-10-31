"""Account-settings, setup-progress, and display-name routes."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import account
from api.routes.one import location_settings as location
from hushh_mcp.services.one_location_account_settings_service import (
    AccountSettings,
    SharingTransition,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_setup_service import SetupProgress


class _SettingsDouble:
    def __init__(self):
        self.state = AccountSettings(user_id="owner-1")
        self.calls: list[tuple] = []

    def get(self, *, user_id):
        return self.state

    def record_consent(self, *, user_id, consent_version):
        self.calls.append(("consent", consent_version))
        self.state = AccountSettings(
            user_id=user_id,
            sharing_consent_version=consent_version,
            sharing_consent_accepted_at="now",
        )
        return self.state

    def record_os_permission(self, *, user_id, state):
        self.calls.append(("os", state))
        return self.state

    def set_precision(self, *, user_id, precision):
        self.calls.append(("precision", precision))
        self.state = AccountSettings(
            user_id=user_id, precision=precision, sharing_state=self.state.sharing_state
        )
        return self.state

    def set_sharing_state(self, *, user_id, state, include_sos, consent_version):
        self.calls.append(("sharing", state, include_sos))
        if state == "on" and not (self.state.sharing_consent_accepted_at or consent_version):
            raise OneLocationAgentError(
                "LOCATION_SHARING_CONSENT_REQUIRED", "Accept consent first.", status_code=409
            )
        self.state = AccountSettings(
            user_id=user_id, sharing_state=state, precision=self.state.precision
        )
        return SharingTransition(
            settings=self.state,
            changed=True,
            revoked_grant_ids=("g1",) if state == "off" else (),
        )


class _SetupDouble:
    def __init__(self):
        self.progress = SetupProgress(user_id="owner-1")

    def get(self, *, user_id):
        return self.progress

    def start(self, *, user_id):
        self.progress = SetupProgress(user_id=user_id, step="intro", started_at="t0")
        return self.progress

    def accept_consent(self, *, user_id, consent_version):
        self.progress = SetupProgress(
            user_id=user_id,
            step="consent",
            started_at="t0",
            consent_version=consent_version,
            consent_accepted_at="t1",
        )
        return self.progress

    def record_os_permission(self, *, user_id, state):
        if self.progress.consent_accepted_at is None:
            raise OneLocationAgentError(
                "LOCATION_SETUP_CONSENT_REQUIRED", "Consent first.", status_code=409
            )
        self.progress = SetupProgress(
            user_id=user_id,
            step="os_permission",
            started_at="t0",
            consent_version=self.progress.consent_version,
            consent_accepted_at="t1",
            os_permission_state=state,
        )
        return self.progress

    def set_precision(self, *, user_id, precision):
        return self.progress

    def confirm_recipient_key(self, *, user_id):
        return self.progress

    def complete(self, *, user_id):
        return self.progress


@pytest.fixture
def doubles(monkeypatch):
    settings = _SettingsDouble()
    setup = _SetupDouble()
    monkeypatch.setattr(location, "_account_settings_service", lambda: settings)
    monkeypatch.setattr(location, "_setup_service", lambda: setup)
    return SimpleNamespace(settings=settings, setup=setup)


def _app(*, authenticated: bool = True) -> FastAPI:
    app = FastAPI()
    app.include_router(location.router)
    if authenticated:
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-1"}
    return app


def test_account_settings_require_vault_owner_token(doubles):
    response = TestClient(_app(authenticated=False)).get("/api/one/location/account-settings")
    assert response.status_code in {401, 403}


def test_account_settings_default_is_unset_and_not_enabled(doubles):
    body = TestClient(_app()).get("/api/one/location/account-settings").json()
    assert body["settings"]["sharing_state"] == "unset"
    assert body["settings"]["sharing_enabled"] is False
    assert body["settings"]["precision"] == "precise"


def test_turning_sharing_on_requires_consent(doubles):
    response = TestClient(_app()).patch(
        "/api/one/location/account-settings", json={"sharingState": "on"}
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "LOCATION_SHARING_CONSENT_REQUIRED"


def test_turning_sharing_off_reports_the_revocations(doubles):
    body = (
        TestClient(_app())
        .patch(
            "/api/one/location/account-settings",
            json={"sharingState": "off", "precision": "approximate"},
        )
        .json()
    )
    assert body["settings"]["sharing_state"] == "off"
    assert body["settings"]["precision"] == "approximate"
    assert body["transition"]["revoked_grant_ids"] == ["g1"]
    assert ("precision", "approximate") in doubles.settings.calls
    assert ("sharing", "off", False) in doubles.settings.calls


def test_account_settings_rejects_unknown_fields(doubles):
    response = TestClient(_app()).patch(
        "/api/one/location/account-settings", json={"latitude": 1.0}
    )
    assert response.status_code == 422


def test_setup_progress_start_then_consent_then_permission(doubles):
    client = TestClient(_app())
    body = client.get("/api/one/location/setup-progress").json()["progress"]
    assert body["started"] is False and body["step"] == "intro"

    body = client.patch("/api/one/location/setup-progress", json={"action": "start"}).json()[
        "progress"
    ]
    assert body["started"] is True

    response = client.patch(
        "/api/one/location/setup-progress",
        json={"action": "record_os_permission", "osPermissionState": "granted"},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "LOCATION_SETUP_CONSENT_REQUIRED"

    body = client.patch(
        "/api/one/location/setup-progress",
        json={"action": "accept_consent", "consentVersion": "location-sharing-v1"},
    ).json()["progress"]
    assert body["step"] == "consent"

    body = client.patch(
        "/api/one/location/setup-progress",
        json={"action": "record_os_permission", "osPermissionState": "granted"},
    ).json()["progress"]
    assert body["step"] == "os_permission"
    assert body["next_step"] == "precision"


def test_setup_consent_requires_a_version(doubles):
    response = TestClient(_app()).patch(
        "/api/one/location/setup-progress", json={"action": "accept_consent"}
    )
    assert response.status_code == 422


def test_display_name_route_validates_and_returns_identity(monkeypatch):
    calls = []

    async def _update(self, user_id, display_name):
        calls.append((user_id, display_name))
        if "@" in display_name:
            raise ValueError("Display name cannot contain links or handles.")
        return {"user_id": user_id, "display_name": display_name}

    monkeypatch.setattr(account.ActorIdentityService, "update_display_name", _update)
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    client = TestClient(app)

    ok = client.patch("/api/account/identity/display-name", json={"display_name": "Ayesha S"})
    assert ok.status_code == 200
    assert ok.json()["identity"]["display_name"] == "Ayesha S"

    bad = client.patch("/api/account/identity/display-name", json={"display_name": "@ayesha"})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "DISPLAY_NAME_INVALID"
    assert calls[0] == ("firebase_uid_123", "Ayesha S")
