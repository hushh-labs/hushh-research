from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

import pytest
import yaml

from hushh_mcp import runtime_settings
from tests._deploy_contract import backend_deploy_surface

SYNC_SCRIPT = Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py"


def _module():
    spec = importlib.util.spec_from_file_location("sync_backend_runtime_secrets", SYNC_SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _unset_for_this_test(monkeypatch, name: str) -> None:
    """Unset ``name`` and restore its prior state after the test.

    ``delenv`` of an absent variable registers no undo, and hydration writes
    with ``os.environ.setdefault``, so a bare delete lets the hydrated value
    leak into every later test in the session.
    """
    monkeypatch.setenv(name, "x")
    monkeypatch.delenv(name)


def test_passkey_rp_ids_are_derived_from_the_active_frontend_origin():
    module = _module()

    assert module._canonical_passkey_allowed_rp_ids("https://dev.one.hushh.ai") == (
        "localhost,127.0.0.1,dev.one.hushh.ai"
    )
    assert module._canonical_passkey_allowed_rp_ids("https://uat.one.hushh.ai/") == (
        "localhost,127.0.0.1,uat.one.hushh.ai"
    )
    assert module._canonical_passkey_allowed_rp_ids("https://one.hushh.ai") == (
        "localhost,127.0.0.1,one.hushh.ai"
    )
    assert module._canonical_passkey_allowed_rp_ids("http://localhost:3000") == (
        "localhost,127.0.0.1"
    )


def test_passkey_rp_origin_must_be_a_bare_http_origin():
    module = _module()

    with pytest.raises(ValueError, match=r"canonical HTTP\(S\) origin"):
        module._canonical_passkey_allowed_rp_ids("https://uat.one.hushh.ai/login")


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
            _unset_for_this_test(monkeypatch, env_name)
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


def _uat_lane_args() -> argparse.Namespace:
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
    return args


def test_voice_mail_reply_switch_is_generated_off_unless_a_lane_turns_it_on(monkeypatch):
    """The reply switch must survive the deploy hop, and only where it is asked for.

    Hosted lanes set only BACKEND_RUNTIME_CONFIG_JSON, regenerated on every
    deploy. A key the generator emits but the runtime map forgets would leave
    reply dark in UAT while the deploy said it was on; a generator default of
    on would ship it to every lane that never asked.
    """
    from hushh_mcp.one_voice.config import voice_mail_reply_enabled

    module = _module()
    args = _uat_lane_args()
    assert module._build_backend_runtime_config(args)["one_voice_mail_reply_enabled"] == "false"

    args.one_voice_mail_reply_enabled = "true"
    generated = module._build_backend_runtime_config(args)["one_voice_mail_reply_enabled"]
    assert generated == "true"

    _unset_for_this_test(monkeypatch, "ONE_VOICE_MAIL_REPLY_ENABLED")
    assert voice_mail_reply_enabled() is False
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON", json.dumps({"one_voice_mail_reply_enabled": generated})
    )
    runtime_settings.hydrate_runtime_environment()
    assert voice_mail_reply_enabled() is True


def test_production_workflow_pins_voice_mail_reply_off():
    root = Path(__file__).resolve().parents[2]
    production = (root / ".github/workflows/deploy-production.yml").read_text()
    uat = (root / ".github/workflows/deploy-uat.yml").read_text()
    assert '--one-voice-mail-reply-enabled "false"' in production
    assert (
        "--one-voice-mail-reply-enabled \"${{ vars.ONE_VOICE_MAIL_REPLY_ENABLED_UAT || 'true' }}\""
        in uat
    )


_MAIL_PART_TWO_SWITCHES = (
    ("one_voice_mail_schedule_send_enabled", "ONE_VOICE_MAIL_SCHEDULE_SEND_ENABLED"),
    ("one_voice_mail_drafts_enabled", "ONE_VOICE_MAIL_DRAFTS_ENABLED"),
    ("mail_scheduled_drain_enabled", "MAIL_SCHEDULED_DRAIN_ENABLED"),
)


@pytest.mark.parametrize(("key", "env_name"), _MAIL_PART_TWO_SWITCHES)
def test_mail_part_two_switches_are_generated_off_unless_a_lane_turns_them_on(
    monkeypatch, key, env_name
):
    """Scheduled send, drafts and the drain survive the deploy hop, only where asked.

    A key the generator emits but the runtime map forgets leaves the capability
    dark in UAT while the deploy said it was on; a generator default of on ships
    a server-side send to every lane that never asked.
    """
    module = _module()
    args = _uat_lane_args()
    assert module._build_backend_runtime_config(args)[key] == "false"

    setattr(args, key, "true")
    generated = module._build_backend_runtime_config(args)[key]
    assert generated == "true"

    _unset_for_this_test(monkeypatch, env_name)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps({key: generated}))
    runtime_settings.hydrate_runtime_environment()
    assert os.environ.get(env_name) == "true"


@pytest.mark.parametrize(("key", "_env_name"), _MAIL_PART_TWO_SWITCHES)
def test_production_pins_mail_part_two_switches_off_and_uat_turns_them_on(key, _env_name):
    root = Path(__file__).resolve().parents[2]
    production = (root / ".github/workflows/deploy-production.yml").read_text()
    uat = (root / ".github/workflows/deploy-uat.yml").read_text()
    flag = "--" + key.replace("_", "-")
    assert f'{flag} "false"' in production
    assert f"{flag} \"${{{{ vars.{key.upper()}_UAT || 'true' }}}}\"" in uat


@pytest.mark.parametrize(
    "prefix,missing",
    [("", False), ("SCOPE_COMMERCE_SANDBOX_", False), ("SCOPE_COMMERCE_SANDBOX_", True)],
)
def test_frontend_rate_limit_binding_uses_only_selected_namespace(tmp_path, prefix, missing):
    root = Path(__file__).resolve().parents[2]
    config = yaml.safe_load((root / "deploy/frontend.cloudbuild.yaml").read_text())
    step = next(step for step in config["steps"] if step["id"] == "deploy-frontend")
    block = (
        step["args"][-1]
        .split('if [[ -n "${_RATE_LIMIT_STORAGE_URI_SECRET}" ]]; then', 1)[1]
        .split("\nfi", 1)[0]
    )
    block = 'if [[ -n "${_RATE_LIMIT_STORAGE_URI_SECRET}" ]]; then' + block + "\nfi"
    block = block.replace("${_SECRET_PREFIX}", prefix).replace(
        "${_RATE_LIMIT_STORAGE_URI_SECRET}", "RATE_LIMIT_STORAGE_URI"
    )
    trace = tmp_path / "calls"
    script = 'gcloud() { printf "%s\\n" "$*" >> "$CALLS"; return "$RESULT"; }; secrets=base;\n'
    result = subprocess.run(  # noqa: S603 - actual deployment binding with hermetic cloud function
        ["bash", "-eu", "-c", script + block + '\nprintf "%s" "$secrets"'],
        env={
            **os.environ,
            "PROJECT_ID": "synthetic",
            "CALLS": str(trace),
            "RESULT": "1" if missing else "0",
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == (1 if missing else 0)
    assert trace.read_text().splitlines() == [
        f"secrets describe {prefix}RATE_LIMIT_STORAGE_URI --project=synthetic"
    ]
    if not missing:
        assert result.stdout == f"base,RATE_LIMIT_STORAGE_URI={prefix}RATE_LIMIT_STORAGE_URI:latest"


def test_runtime_binding_gate_accepts_selected_namespace_and_rejects_missing_or_wrong_sources(
    tmp_path,
):
    root = Path(__file__).resolve().parents[2]
    gate = (root / "scripts/ci/runtime-contract-check.sh").read_text()
    match = re.search(r"(?ms)^has_frontend_secret_binding\(\) \{.*?^\}", gate)
    assert match is not None
    fixture = tmp_path / "frontend.cloudbuild.yaml"
    original = (root / "deploy/frontend.cloudbuild.yaml").read_text()
    required = {
        "BACKEND_URL": "BACKEND_URL",
        "DEVELOPER_API_URL": "BACKEND_URL",
        "APPLE_TEAM_ID": "APPLE_TEAM_ID",
        "NEXT_PUBLIC_IOS_BUNDLE_ID": "NEXT_PUBLIC_IOS_BUNDLE_ID",
        "NEXT_PUBLIC_ANDROID_APP_ID": "NEXT_PUBLIC_ANDROID_APP_ID",
        "ANDROID_SHA256_CERT_FINGERPRINTS": "ANDROID_SHA256_CERT_FINGERPRINTS",
    }

    def admitted(source, target, secret):
        fixture.write_text(source)
        script = (
            f"frontend_cloudbuild={shlex.quote(str(fixture))}\n"
            + match.group()
            + f"\nhas_frontend_secret_binding {shlex.quote(target)} {shlex.quote(secret)}"
        )
        return (
            subprocess.run(  # noqa: S603 - real gate predicate, synthetic source fixture
                ["bash", "-eu", "-c", script],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            ).returncode
            == 0
        )

    for target, secret in required.items():
        assert admitted(original, target, secret)
        assert admitted(original.replace("${_SECRET_PREFIX}", ""), target, secret)
        binding = f"{target}=${{_SECRET_PREFIX}}{secret}:latest"
        assert not admitted(original.replace(binding, ""), target, secret)
        assert not admitted(
            original.replace(binding, f"{target}=OTHER_SECRET:latest"), target, secret
        )
        assert not admitted(
            original.replace(binding, f"{target}=${{_OTHER_PREFIX}}{secret}:latest"), target, secret
        )
