"""Tests for the pure/guard logic of the Cloud Run REST client.

The HTTP paths are exercised end-to-end by the live GCP validation (dev-only);
here we cover the pure helpers + the fail-closed guards.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.gcp_run_client import GcpRunClient, load_operator_credentials


def test_service_url_extraction():
    assert GcpRunClient.service_url({"status": {"url": "https://x.run.app"}}) == "https://x.run.app"
    assert GcpRunClient.service_url(None) is None
    assert GcpRunClient.service_url({}) is None
    assert GcpRunClient.service_url({"status": {}}) is None


def test_load_operator_credentials_requires_env(monkeypatch):
    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    with pytest.raises(RuntimeError):
        load_operator_credentials()


def test_client_requires_project():
    # Guard fires before any credential work (credentials passed to skip loading).
    with pytest.raises(RuntimeError):
        GcpRunClient(project="", region="us-central1", credentials=object())
