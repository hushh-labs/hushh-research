from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path

from hushh_mcp import runtime_settings
from tests._deploy_contract import backend_deploy_surface

SYNC_SCRIPT = Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py"


def _module():
    spec = importlib.util.spec_from_file_location("sync_backend_runtime_secrets", SYNC_SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_generator_and_runtime_hydrate_every_hushh_tech_policy_key(monkeypatch):
    module = _module()
    args = argparse.Namespace(
        **{
            key: ""
            for key in (
                "environment project db_host db_port db_name db_unix_socket "
                "cloudsql_instance_connection_name consent_sse_enabled sync_remote_enabled "
                "developer_api_enabled remote_mcp_enabled cors_allowed_origins "
                "obs_data_stale_ratio_threshold passkey_allowed_rp_ids plaid_env "
                "plaid_client_name plaid_country_codes plaid_webhook_url plaid_redirect_path "
                "plaid_redirect_uri plaid_tx_history_days one_location_read_only_state_enabled "
                "one_location_nearby_presence_mode one_location_nearby_presence_cohort "
                "consent_center_summary_v2_enabled db_bulk_batching_enabled "
                "hushh_trusted_device_enabled hushh_trusted_device_uat_allowlist "
                "advisors_api_base_url insurance_agents_api_base_url nws_nearby_api_base_url "
                "nws_nearby_v4_api_base_url one_places_directory_enabled"
            ).split()
        }
    )
    args.environment = "uat"
    args.project = "hushh-pda-uat"
    args.hushh_tech_client_enabled = "true"
    args.hushh_tech_developer_app_id = "app_hushh_tech_uat"
    args.hushh_tech_allowed_audience = "hushh-tech-uat"
    args.hushh_tech_allowed_redirect_uris = "https://uat.hushhtech.com/auth/hushh-research/callback"
    args.hushh_tech_allowed_consent_scopes = "attr.identity.name"
    args.hushh_tech_uat_firebase_uid_allowlist = "firebase-a,firebase-b"
    args.hushh_tech_shadow_max_age_ms = "604800000"
    args.hushh_tech_trusted_proxy_hops = "1"
    args.hushh_tech_proxy_audience = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
    args.hushh_tech_trusted_proxy_service_accounts = (
        "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
    )
    config = module._build_backend_runtime_config(args)

    expected = {
        "hushh_tech_client_enabled": "true",
        "hushh_tech_developer_app_id": "app_hushh_tech_uat",
        "hushh_tech_allowed_audience": "hushh-tech-uat",
        "hushh_tech_allowed_redirect_uris": (
            "https://uat.hushhtech.com/auth/hushh-research/callback"
        ),
        "hushh_tech_allowed_consent_scopes": "attr.identity.name",
        "hushh_tech_uat_firebase_uid_allowlist": "firebase-a,firebase-b",
        "hushh_tech_shadow_max_age_ms": "604800000",
        "hushh_tech_trusted_proxy_hops": "1",
        "hushh_tech_proxy_audience": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
        "hushh_tech_trusted_proxy_service_accounts": (
            "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        ),
    }
    assert {key: config[key] for key in expected} == expected

    for env_name in runtime_settings._BACKEND_RUNTIME_ENV_MAP.values():
        if env_name.startswith("HUSSH_TECH_"):
            monkeypatch.delenv(env_name, raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps(expected))
    runtime_settings.hydrate_runtime_environment()

    assert os.environ["HUSSH_TECH_CLIENT_ENABLED"] == "true"
    assert os.environ["HUSSH_TECH_DEVELOPER_APP_ID"] == "app_hushh_tech_uat"
    assert os.environ["HUSSH_TECH_TRUSTED_PROXY_HOPS"] == "1"
    assert os.environ["HUSSH_TECH_ALLOWED_AUDIENCE"] == "hushh-tech-uat"
    assert (
        os.environ["HUSSH_TECH_ALLOWED_REDIRECT_URIS"]
        == "https://uat.hushhtech.com/auth/hushh-research/callback"
    )
    assert os.environ["HUSSH_TECH_ALLOWED_CONSENT_SCOPES"] == "attr.identity.name"
    assert os.environ["HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST"] == "firebase-a,firebase-b"
    assert os.environ["HUSSH_TECH_SHADOW_MAX_AGE_MS"] == "604800000"
    assert os.environ["HUSSH_TECH_PROXY_AUDIENCE"] == (
        "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
    )
    assert os.environ["HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS"] == (
        "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
    )


def test_production_workflow_pins_client_flag_off():
    workflow = Path(__file__).resolve().parents[2] / ".github/workflows/deploy-production.yml"
    assert '--hushh-tech-client-enabled "false"' in workflow.read_text()
    assert '--hushh-tech-allowed-consent-scopes ""' in workflow.read_text()


def test_uat_cloud_run_binds_launch_pepper_only_as_optional_secret():
    # The deploy body lives in scripts/deploy/backend-deploy.sh (extracted from the
    # cloudbuild for Cloud Build's 10,000-char step-arg cap), and this repo names the
    # secret-binding helper append_optional_secret. Read the whole deploy surface.
    cloudbuild = backend_deploy_surface()
    workflow = (
        Path(__file__).resolve().parents[2] / ".github/workflows/deploy-uat.yml"
    ).read_text()
    assert (
        'append_optional_secret "${_HUSHH_TECH_LAUNCH_PEPPER_SECRET}" "HUSSH_TECH_LAUNCH_PEPPER"'
        in cloudbuild
    )
    assert "_HUSHH_TECH_LAUNCH_PEPPER_SECRET=HUSSH_TECH_LAUNCH_PEPPER" in workflow
    assert "HUSSH_TECH_LAUNCH_PEPPER=" not in workflow
    assert (
        'append_optional_secret "${_RATE_LIMIT_STORAGE_URI_SECRET}" "RATE_LIMIT_STORAGE_URI"'
        in cloudbuild
    )
    assert "_RATE_LIMIT_STORAGE_URI_SECRET=RATE_LIMIT_STORAGE_URI" in workflow
    assert "RATE_LIMIT_STORAGE_URI=" not in workflow
    assert 'cmd+=("--vpc-connector=${_VPC_CONNECTOR}"' in cloudbuild
    assert "_VPC_CONNECTOR=${{ vars.UAT_VPC_CONNECTOR || '' }}" in workflow
    assert "_RATE_LIMIT_STORAGE_URI_SECRET=RATE_LIMIT_STORAGE_URI" in workflow
    assert "_HUSHH_TECH_PROXY_AUDIENCE=${{ env.CONSENT_API_RUNTIME_ORIGIN }}" in workflow
    assert (
        "_FRONTEND_RUNTIME_SERVICE_ACCOUNT=${{ env.FRONTEND_RUNTIME_SERVICE_ACCOUNT }}" in workflow
    )
    assert (
        "RATE_LIMIT_STORAGE_URI=${_RATE_LIMIT_STORAGE_URI_SECRET}:latest"
        in (Path(__file__).resolve().parents[2] / "deploy/frontend.cloudbuild.yaml").read_text()
    )
