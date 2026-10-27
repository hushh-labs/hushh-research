"""Environment-pinned runtime settings survive the real deployment writer."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from hushh_mcp import runtime_settings
from tests.helpers.runtime_config_writer import configuration_arguments, configuration_reader

CANDIDATE_SECRET_NAME = "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_17_1"


def _write_configuration(
    monkeypatch,
    module,
    environment,
    candidate,
    stored,
    *,
    candidate_only=False,
    candidate_payload=None,
):
    project = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat", "production": "hushh-pda"}[
        environment
    ]
    origin = (
        "https://one.hussh.ai"
        if environment == "production"
        else f"https://{environment}.one.hussh.ai"
    )
    existing = {
        "environment": environment,
        "google_cloud_project": project,
        "unowned_configuration": "must not be retained",
        "one_plg_export_account_ids": ["synthetic-private-cohort"],
        **stored,
    }
    writes = {}
    monkeypatch.setattr(module, "_mirror_directory_key", lambda **_: None)
    monkeypatch.setattr(module, "_resolve_secret", lambda *_: None)
    monkeypatch.setattr(module, "_sync_oauth_redirects", lambda *_: [])
    monkeypatch.setattr(
        module,
        "_read_secret",
        lambda _, name: json.dumps(existing) if name == "BACKEND_RUNTIME_CONFIG_JSON" else "",
    )
    monkeypatch.setattr(
        module, "_upsert_secret", lambda _, name, value: writes.update({name: value})
    )

    arguments = configuration_arguments(project, environment, origin)
    target = "BACKEND_RUNTIME_CONFIG_JSON"
    if candidate:
        target = "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_17_1"
        arguments["production-drive-candidate-secret"] = target
    monkeypatch.setattr(
        module,
        "_run",
        configuration_reader(
            project=project,
            existing=existing,
            target=target,
            candidate_only=candidate_only,
            candidate_payload=candidate_payload,
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [str(module.__file__)]
        + [item for key, value in arguments.items() for item in ("--" + key, value)],
    )
    if candidate_only:
        sys.argv.append("--production-drive-candidate-only")

        def forbidden(*_args, **_kwargs):
            pytest.fail("Candidate-only mode reached a shared secret mutation")

        for name in ("_mirror_directory_key", "_resolve_secret", "_sync_oauth_redirects"):
            monkeypatch.setattr(module, name, forbidden)
    assert module.main() == 0
    return writes, target


@pytest.fixture
def plg_runtime_sync():
    path = Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py"
    spec = importlib.util.spec_from_file_location("plg_runtime_sync", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.feature_auth_reliability
def test_listener_isolation_rollback_survives_the_deployment_writer(monkeypatch, plg_runtime_sync):
    writes, target = _write_configuration(
        monkeypatch,
        plg_runtime_sync,
        "uat",
        False,
        {"auth_db_listener_isolation_enabled": False},
    )
    assert json.loads(writes[target])["auth_db_listener_isolation_enabled"] is False


@pytest.mark.parametrize(
    ("environment", "candidate", "stored", "expected"),
    [
        ("uat", False, {}, (False, False, False, False, False)),
        ("production", False, {}, (False, False, False, False, False)),
        ("dev", False, {}, (False, False, False, False, False)),
        (
            "dev",
            False,
            {
                "pod_dev_inference_bridge_json": ' {"project":"hushh-vertex-personal54",'
                '"serviceAccount":"one-pod-fixture@synthetic-project.iam.gserviceaccount.com"} '
            },
            (False, False, False, False, False),
        ),
        (
            "production",
            True,
            {
                "one_plg_export_enabled": True,
                "one_plg_activity_enabled": "false",
                "one_plg_activity_all_registered": True,
                "one_plg_audience_enabled": "true",
                "one_plg_subscription_enabled": True,
            },
            (True, False, True, True, True),
        ),
        (
            "production",
            False,
            {"one_plg_export_enabled": "false", "one_plg_activity_enabled": True},
            (False, True, False, False, False),
        ),
    ],
)
def test_retained_settings_survive_actual_config_writer_and_hydration(
    monkeypatch, plg_runtime_sync, environment, candidate, stored, expected
):
    writes, target = _write_configuration(
        monkeypatch, plg_runtime_sync, environment, candidate, stored
    )
    actual = json.loads(writes[target])
    keys = (
        "one_plg_export_enabled",
        "one_plg_activity_enabled",
        "one_plg_activity_all_registered",
        "one_plg_audience_enabled",
        "one_plg_subscription_enabled",
    )
    assert tuple(actual[key] for key in keys) == expected
    assert all(isinstance(actual[key], bool) for key in keys)
    assert "unowned_configuration" not in actual
    assert "one_plg_export_account_ids" not in actual
    bridge_key = "pod_dev_inference_bridge_json"
    assert actual.get(bridge_key) == stored.get(bridge_key)
    if candidate:
        assert "BACKEND_RUNTIME_CONFIG_JSON" not in writes
    monkeypatch.setattr(runtime_settings.os, "environ", os.environ.copy())
    monkeypatch.delenv("HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON", raising=False)
    for key in keys:
        monkeypatch.delenv(key.upper(), raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", writes[target])
    runtime_settings.hydrate_runtime_environment()
    assert tuple(os.environ[key.upper()] for key in keys) == tuple(
        str(value).lower() for value in expected
    )
    stored_bridge = stored.get(bridge_key)
    assert os.environ.get("HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON") == (
        stored_bridge.strip() if stored_bridge is not None else None
    )


@pytest.mark.parametrize(
    ("project", "environment", "stored_project", "stored_environment"),
    [
        ("hushh-pda-uat", "uat", "hushh-pda-dev", "dev"),
        ("hushh-pda-dev", "production", "hushh-pda-dev", "dev"),
        ("hushh-pda-dev", "dev", "hushh-pda-uat", "dev"),
        ("hushh-pda-dev", "dev", "hushh-pda-dev", "production"),
    ],
)
def test_dev_bridge_retention_refuses_cross_lane_configuration(
    plg_runtime_sync, project, environment, stored_project, stored_environment
):
    with pytest.raises(ValueError, match="dev environment and project"):
        plg_runtime_sync._retained_dev_inference_bridge(
            {
                "pod_dev_inference_bridge_json": "{}",
                "environment": stored_environment,
                "google_cloud_project": stored_project,
            },
            project=project,
            environment=environment,
        )


@pytest.mark.parametrize("value", [None, {}, "", " " * 10, "x" * 1025])
def test_dev_bridge_retention_refuses_invalid_envelopes(plg_runtime_sync, value):
    with pytest.raises(ValueError, match="bounded configuration string"):
        plg_runtime_sync._retained_dev_inference_bridge(
            {
                "pod_dev_inference_bridge_json": value,
                "environment": "dev",
                "google_cloud_project": "hushh-pda-dev",
            },
            project="hushh-pda-dev",
            environment="dev",
        )


@pytest.mark.parametrize(
    "key",
    [
        "one_plg_export_enabled",
        "one_plg_activity_enabled",
        "one_plg_activity_all_registered",
        "one_plg_audience_enabled",
        "one_plg_subscription_enabled",
    ],
)
@pytest.mark.parametrize("value", [None, 0, 1, [], {}, "yes", "True"])
def test_plg_activation_rejects_ambiguous_values(plg_runtime_sync, key, value):
    with pytest.raises(ValueError, match="explicit boolean"):
        plg_runtime_sync._retained_plg_config(
            {key: value}, project="hushh-pda", environment="production"
        )


@pytest.mark.parametrize(
    ("project", "environment", "stored_environment", "stored_project"),
    [
        ("hushh-pda-uat", "uat", "production", "hushh-pda"),
        ("hushh-pda-uat", "production", "production", "hushh-pda"),
        ("hushh-pda", "production", "uat", "hushh-pda"),
        ("hushh-pda", "production", "production", "hushh-pda-uat"),
    ],
)
@pytest.mark.parametrize(
    "key",
    [
        "one_plg_activity_enabled",
        "one_plg_activity_all_registered",
        "one_plg_audience_enabled",
        "one_plg_subscription_enabled",
    ],
)
def test_plg_activation_cannot_cross_environment_or_project(
    plg_runtime_sync, project, environment, stored_environment, stored_project, key
):
    with pytest.raises(ValueError, match="production environment and project"):
        plg_runtime_sync._retained_plg_config(
            {
                key: True,
                "environment": stored_environment,
                "google_cloud_project": stored_project,
            },
            project=project,
            environment=environment,
        )


def test_referral_scheduler_configuration_survives_sync_and_hydration(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py"
    spec = importlib.util.spec_from_file_location("referral_runtime_sync", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    existing = {
        "environment": "uat",
        "referral_scoring_drain_enabled": True,
        "referral_scoring_drain_scheduler_audience": "https://api.uat.hushh.ai",
        "referral_scoring_drain_scheduler_project_id": "hushh-pda-uat",
        "referral_scoring_drain_scheduler_service_account_email": "referral-scoring-sched@hushh-pda-uat.iam.gserviceaccount.com",
        "unowned_configuration": "must not be retained",
    }
    retained = module._retained_referral_config(
        existing, project="hushh-pda-uat", environment="uat"
    )
    assert "unowned_configuration" not in retained
    for key in retained:
        monkeypatch.delenv(key.upper(), raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps(retained))
    runtime_settings.hydrate_runtime_environment()
    assert os.environ["REFERRAL_SCORING_DRAIN_ENABLED"] == "true"
    assert os.environ["REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE"] == "https://api.uat.hushh.ai"
    with pytest.raises(ValueError, match="different environment"):
        module._retained_referral_config(existing, project="hushh-pda", environment="production")
    existing["referral_scoring_drain_scheduler_audience"] = "https://untrusted.example"
    with pytest.raises(ValueError, match="scheduler identity"):
        module._retained_referral_config(existing, project="hushh-pda-uat", environment="uat")


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize(
    "environment,project", [("uat", "hushh-pda-uat"), ("production", "hushh-pda")]
)
def test_document_delivery_storage_survives_real_writer_and_admission_pause(
    monkeypatch, plg_runtime_sync, enabled, environment, project
):
    stored = {
        "protected_document_delivery": enabled,
        "document_delivery_bucket": f"{project}-document-delivery",
        "document_delivery_bucket_identity": "a" * 64,
    }
    writes, target = _write_configuration(monkeypatch, plg_runtime_sync, environment, False, stored)
    actual = json.loads(writes[target])
    assert {key: actual[key] for key in stored} == stored
    monkeypatch.setattr(runtime_settings.os, "environ", os.environ.copy())
    for name in (
        "PROTECTED_DOCUMENT_DELIVERY_ENABLED",
        "DOCUMENT_DELIVERY_BUCKET",
        "DOCUMENT_DELIVERY_BUCKET_IDENTITY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", writes[target])
    runtime_settings.hydrate_runtime_environment()
    runtime_settings.get_app_runtime_settings.cache_clear()
    try:
        settings = runtime_settings.get_app_runtime_settings()
        assert settings.document_delivery_bucket == stored["document_delivery_bucket"]
        assert settings.document_delivery_bucket_identity == "a" * 64
        assert os.environ["PROTECTED_DOCUMENT_DELIVERY_ENABLED"] == str(enabled).lower()
    finally:
        runtime_settings.get_app_runtime_settings.cache_clear()


@pytest.mark.parametrize(
    "correction",
    [
        {"google_cloud_project": "hushh-pda"},
        {"environment": "production"},
        {"document_delivery_bucket": "hushh-pda-document-delivery"},
        {"document_delivery_bucket_identity": ""},
        {"protected_document_delivery": 1},
    ],
)
def test_document_delivery_retention_rejects_cross_lane_or_ambiguous_authority(correction):
    from runpy import run_path

    retain = run_path(
        str(Path(__file__).resolve().parents[2] / "scripts/ops/runtime_config_retention.py")
    )["retained_settings"]
    stored = {
        "environment": "uat",
        "google_cloud_project": "hushh-pda-uat",
        "protected_document_delivery": True,
        "document_delivery_bucket": "hushh-pda-uat-document-delivery",
        "document_delivery_bucket_identity": "a" * 64,
        **correction,
    }
    with pytest.raises(ValueError, match="Document delivery"):
        retain(stored, project="hushh-pda-uat", environment="uat")


@pytest.mark.parametrize("reuse", [False, True])
def test_candidate_only_uses_real_builder_and_retention_without_shared_writes(
    monkeypatch, plg_runtime_sync, reuse
):
    stored = {
        "one_plg_activity_enabled": True,
        "auth_db_listener_isolation_enabled": False,
        "protected_document_delivery": True,
        "document_delivery_bucket": "hushh-pda-document-delivery",
        "document_delivery_bucket_identity": "a" * 64,
    }
    normal, target = _write_configuration(monkeypatch, plg_runtime_sync, "production", True, stored)
    expected = json.loads(normal[target])
    writes, actual_target = _write_configuration(
        monkeypatch,
        plg_runtime_sync,
        "production",
        True,
        stored,
        candidate_only=True,
        candidate_payload=expected if reuse else None,
    )
    assert actual_target == target
    assert writes == ({} if reuse else {target: normal[target]})
    assert expected["one_plg_activity_enabled"] is True
    assert expected["auth_db_listener_isolation_enabled"] is False
    assert expected["document_delivery_bucket_identity"] == "a" * 64
    assert "unowned_configuration" not in expected


def test_existing_candidate_mismatch_never_appends_a_version(plg_runtime_sync):
    from argparse import Namespace

    args = Namespace(
        project="hushh-pda",
        environment="production",
        production_drive_candidate_only=True,
        production_drive_candidate_secret=CANDIDATE_SECRET_NAME,
    )

    def read(command, **_kwargs):
        return subprocess.CompletedProcess(
            command, 0, json.dumps({"environment": "production"}), ""
        )

    def forbidden(*_args):
        pytest.fail("Existing candidate must not receive another version")

    with pytest.raises(ValueError, match="differs from requested policy"):
        plg_runtime_sync._production_drive_candidate["sync_candidate_only"](
            args,
            {"environment": "production", "google_cloud_project": "hushh-pda"},
            read,
            forbidden,
        )


@pytest.mark.parametrize(
    "access_error,describe_error",
    [
        ("PERMISSION_DENIED", ""),
        ("UNAVAILABLE", ""),
        ("NOT_FOUND", "PERMISSION_DENIED"),
        ("NOT_FOUND", ""),
    ],
)
def test_candidate_only_read_failures_never_create_or_update(
    access_error, describe_error, plg_runtime_sync
):
    from argparse import Namespace

    args = Namespace(
        project="hushh-pda",
        environment="production",
        production_drive_candidate_only=True,
        production_drive_candidate_secret=CANDIDATE_SECRET_NAME,
    )

    def read(command, **_kwargs):
        error = access_error if "access" in command else describe_error
        return subprocess.CompletedProcess(command, 1 if error else 0, "", error)

    def forbidden(*_args):
        pytest.fail("Unverified candidate must not be written")

    with pytest.raises(ValueError, match="verified"):
        plg_runtime_sync._production_drive_candidate["sync_candidate_only"](
            args,
            {"environment": "production", "google_cloud_project": "hushh-pda"},
            read,
            forbidden,
        )


def test_candidate_only_mutation_guard_detects_normal_sync_fallthrough(
    monkeypatch, plg_runtime_sync
):
    import inspect
    from types import CodeType, FunctionType

    source = inspect.getsource(plg_runtime_sync.main)
    boundary = '    if args.production_drive_candidate_only:\n        return _production_drive_candidate["sync_candidate_only"](args, config, _run, _upsert_secret)\n'
    assert source.count(boundary) == 1
    # Negative control changes this isolated module in memory, never disk/runtime.
    code = compile(source.replace(boundary, ""), "candidate-only-negative-control", "exec")
    function = next(
        value for value in code.co_consts if isinstance(value, CodeType) and value.co_name == "main"
    )
    plg_runtime_sync.main = FunctionType(function, plg_runtime_sync.__dict__)
    with pytest.raises(pytest.fail.Exception, match="shared secret mutation"):
        _write_configuration(
            monkeypatch, plg_runtime_sync, "production", True, {}, candidate_only=True
        )
