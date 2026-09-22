from __future__ import annotations

import json

import pytest

from hushh_mcp import runtime_settings
from hushh_mcp.services.connector_feature_admission import (
    FEATURES,
    connector_feature_enabled,
    connector_features,
)


@pytest.fixture(autouse=True)
def closed_by_default(monkeypatch):
    for name in (*FEATURES.values(), "CONNECTOR_INTERNAL_OWNER_COHORT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENVIRONMENT", "test")


def test_unconfigured_flags_deny_every_owner():
    assert not any(connector_features("owner").values())
    assert not connector_feature_enabled("google_drive_chat_writes", "owner")
    assert not connector_feature_enabled("google_drive_downloads", "owner")


@pytest.mark.parametrize(
    "cohort", ["", "all", "*", "owner,", ",owner", "owner,all", "owner,malformed owner"]
)
def test_malformed_cohort_denies_even_with_enabled_flag(monkeypatch, cohort):
    monkeypatch.setenv("GOOGLE_DRIVE_CONNECTION", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", cohort)
    assert not connector_feature_enabled("google_drive_connection", "owner")


def test_owner_membership_and_flags_are_independent(monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_CONNECTION", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,second-owner")
    assert connector_feature_enabled("google_drive_connection", "owner")
    assert not connector_feature_enabled("google_drive_connection", "other-owner")
    assert not connector_feature_enabled("gmail_chat_reads", "owner")
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert not connector_feature_enabled("google_drive_connection", "owner")


def test_structured_hosted_runtime_hydrates_flags_without_exposing_cohort(monkeypatch):
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(
            {
                "environment": "test",
                "google_drive_connection": True,
                "gmail_chat_reads": True,
                "connector_internal_owner_cohort": ["owner"],
            }
        ),
    )
    runtime_settings.hydrate_runtime_environment()
    features = connector_features("owner")
    assert features["google_drive_connection"] and features["gmail_chat_reads"]
    assert "owner" not in str(features)
