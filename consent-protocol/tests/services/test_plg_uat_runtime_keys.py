"""The already mounted UAT read secret carries separate, closed read authorities."""

import hashlib
import hmac
import json
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import plg
from hushh_mcp.services import attempt_email, plg_audience

OWNER = "fixture-only-uat-owner-read-key-32-characters"
DIRECTORY = "fixture-only-uat-directory-read-key-32-characters"


def bundle(**overrides):
    return json.dumps(
        {
            "version": 1,
            "environment": "uat",
            "project": "hushh-pda-uat",
            "ownerReadKey": OWNER,
            "audienceReadKey": DIRECTORY,
            "audienceEnabled": True,
            **overrides,
        }
    )


@pytest.fixture
def uat(monkeypatch):
    for name in (
        "ONE_PLG_EXPORT_SECRET",
        "ONE_PLG_OWNER_EXPORT_SECRET",
        "ONE_PLG_DEV_EXPORT_SECRET",
        "ONE_PLG_AUDIENCE_SECRET",
        "ONE_PLG_UAT_AUDIENCE_SECRET",
        "ONE_PLG_UAT_AUDIENCE_ENABLED",
        "ONE_PLG_SUBSCRIPTION_SECRET",
        "ONE_PLG_ATTEMPT_EMAIL_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in {
        "ENVIRONMENT": "uat",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda-uat",
        "ONE_PLG_ACTIVITY_ENABLED": "true",
        "ONE_PLG_ACTIVITY_UAT_ENABLED": "true",
        "ONE_PLG_ACTIVITY_ALL_REGISTERED": "false",
        "ONE_PLG_UAT_EXPORT_ENABLED": "true",
        "ONE_PLG_UAT_EXPORT_SECRET": bundle(),
    }.items():
        monkeypatch.setenv(name, value)


def test_existing_binding_resolves_separate_uat_read_keys(uat):
    assert plg._nonproduction_export_scope("uat") == (OWNER, None)
    assert plg_audience.uat_audience_secret() == DIRECTORY


def test_bundle_directory_signature_cannot_be_substituted_by_owner_or_worker(uat, monkeypatch):
    app = FastAPI()
    app.include_router(plg.router)
    source = AsyncMock(return_value={"rows": [], "environment": "uat"})
    monkeypatch.setattr(plg, "audience_page", source)
    raw = json.dumps({"agentId": "agent_one"})
    timestamp = str(int(time.time() * 1000))
    with TestClient(app) as client:
        for key, purpose, expected in (
            (OWNER, "audience-uat", 401),
            (DIRECTORY, "audience", 401),
            (DIRECTORY, "attempt-emails.uat.pull", 401),
            (DIRECTORY, "audience-uat", 200),
        ):
            signature = hmac.new(
                key.encode(), f"{purpose}\n{timestamp}\n{raw}".encode(), hashlib.sha256
            ).hexdigest()
            response = client.post(
                "/api/one/plg/audience-uat",
                content=raw,
                headers={
                    "Content-Type": "application/json",
                    "X-PLG-Timestamp": timestamp,
                    "X-PLG-Signature": signature,
                },
            )
            assert response.status_code == expected
    source.assert_awaited_once()


@pytest.mark.parametrize(
    "changes",
    [
        {"version": True},
        {"version": 2},
        {"environment": "production"},
        {"project": "hushh-pda"},
        {"audienceEnabled": "true"},
        {"ownerReadKey": "short"},
        {"audienceReadKey": OWNER},
        {"audienceReadKey": "x" * 513},
        {"ownerReadKey": OWNER + "\n"},
        {"deliveryAuthorized": True},
        {"workerKey": "x" * 40},
    ],
)
def test_invalid_bundle_never_falls_back_to_signing_with_json(uat, monkeypatch, changes):
    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", bundle(**changes))
    with pytest.raises(HTTPException) as failure:
        plg._nonproduction_export_scope("uat")
    assert failure.value.status_code == 404
    assert plg_audience.uat_audience_secret() is None


@pytest.mark.parametrize(
    "raw", ["{bad" + "x" * 40, "[]", "x" * 4097, bundle()[:-1] + ',"version":1}']
)
def test_malformed_or_duplicate_configuration_closes_both_reads(uat, monkeypatch, raw):
    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", raw)
    with pytest.raises(HTTPException):
        plg._nonproduction_export_scope("uat")
    assert plg_audience.uat_audience_secret() is None


@pytest.mark.parametrize(
    "name,value",
    [("ONE_PLG_UAT_AUDIENCE_SECRET", DIRECTORY), ("ONE_PLG_UAT_AUDIENCE_ENABLED", "false")],
)
def test_mixed_legacy_and_bundle_configuration_is_rejected(uat, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(HTTPException):
        plg._nonproduction_export_scope("uat")
    assert plg_audience.uat_audience_secret() is None


def test_disabling_directory_keeps_separate_owner_read_authority(uat, monkeypatch):
    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", bundle(audienceEnabled=False))
    assert plg._nonproduction_export_scope("uat") == (OWNER, None)
    assert plg_audience.uat_audience_secret() is None


@pytest.mark.parametrize("key", [OWNER, DIRECTORY, bundle()])
def test_attempt_worker_cannot_use_a_read_key_or_the_mounted_envelope(uat, monkeypatch, key):
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_SECRET", key)
    with pytest.raises(PermissionError):
        attempt_email.worker_authority()


@pytest.mark.parametrize(
    "name,value",
    [
        ("ENVIRONMENT", "production"),
        ("GOOGLE_CLOUD_PROJECT", "hushh-pda"),
        ("ONE_PLG_ACTIVITY_ENABLED", "false"),
        ("ONE_PLG_ACTIVITY_UAT_ENABLED", "false"),
        ("ONE_PLG_ACTIVITY_ALL_REGISTERED", "true"),
    ],
)
def test_bundle_cannot_activate_a_wrong_lane_or_disabled_collection(uat, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(HTTPException):
        plg._nonproduction_export_scope("uat")
    assert plg_audience.uat_audience_secret() is None


@pytest.mark.parametrize("key", [OWNER, DIRECTORY])
def test_production_owner_key_cannot_reuse_nested_uat_key(uat, monkeypatch, key):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_OWNER_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_OWNER_ACCOUNT_IDS", "owner")
    monkeypatch.setenv("ONE_PLG_OWNER_EXPORT_SECRET", key)
    with pytest.raises(HTTPException):
        plg._owner_export_scope("production")


def test_flat_uat_keys_keep_existing_explicit_activation(uat, monkeypatch):
    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", OWNER)
    monkeypatch.setenv("ONE_PLG_UAT_AUDIENCE_SECRET", DIRECTORY)
    assert plg._nonproduction_export_scope("uat") == (OWNER, None)
    assert plg_audience.uat_audience_secret() is None
    monkeypatch.setenv("ONE_PLG_UAT_AUDIENCE_ENABLED", "true")
    assert plg_audience.uat_audience_secret() == DIRECTORY
