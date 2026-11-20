# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit tests for HushOne Inc. Microsoft OAuth org cutover and Firebase IdP parity."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_FIREBASE_SYNC_PATH = _ROOT / "scripts" / "ops" / "sync_microsoft_identity_idp.py"
_RUNTIME_SYNC_PATH = _ROOT / "scripts" / "ops" / "sync_backend_runtime_secrets.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cloud_connect_client_id_matches_hushone_org_app():
    sync_mod = _load("sync_backend_runtime_secrets", _RUNTIME_SYNC_PATH)
    cfg = sync_mod._azure_owner_cloud_config("hushh-pda-dev", "https://dev.one.hussh.ai")
    assert cfg["hussh_azure_app_client_id"] == "4a6188ee-2a5b-4ed8-b650-35e4d560f72d"
    assert (
        cfg["hussh_azure_oauth_redirect_uri"]
        == "https://dev.one.hussh.ai/one/setup/cloud/azure/return"
    )


def test_firebase_microsoft_idp_verify_and_redaction(capsys):
    mod = _load("sync_firebase_microsoft_idp", _FIREBASE_SYNC_PATH)
    secret_sentinel = "super-secret-do-not-print"  # noqa: S105
    expected_cid = "da24bfba-1f80-47af-8444-7cee96efef18"

    def fake_secret(project: str, name: str) -> str:
        if name == mod.CLIENT_ID_SECRET:
            return expected_cid
        if name == mod.CLIENT_SECRET_NAME:
            return secret_sentinel
        raise KeyError(name)

    def fake_http(url: str, *, token: str, project: str, method: str = "GET", payload=None):
        assert project == "hushh-pda"
        assert token == "tok"
        if method == "GET":
            return {"enabled": True, "clientId": expected_cid, "clientSecret": "redacted"}
        raise AssertionError(f"unexpected method {method}")

    res = mod.reconcile_firebase_microsoft_idp(
        "hushh-pda",
        apply=False,
        token_provider=lambda: "tok",
        secret_reader=fake_secret,
        http_json=fake_http,
    )
    assert res["inSync"] is True
    assert res["clientId"] == expected_cid
    assert secret_sentinel not in str(res)


def test_firebase_microsoft_idp_detects_drift_and_rejects_bad_guid():
    mod = _load("sync_firebase_microsoft_idp", _FIREBASE_SYNC_PATH)
    with pytest.raises(ValueError):
        mod.validate_client_id("not-a-guid")

    res = mod.reconcile_firebase_microsoft_idp(
        "hushh-pda-dev",
        apply=False,
        token_provider=lambda: "tok",
        secret_reader=lambda _p, n: (
            "da24bfba-1f80-47af-8444-7cee96efef18" if n == mod.CLIENT_ID_SECRET else "sec"
        ),
        http_json=lambda *_a, **_k: {
            "enabled": True,
            "clientId": "3e8a9459-2dae-4eb2-a33d-235ccd7360ea",
            "clientSecret": "x",
        },
    )
    assert res["inSync"] is False
