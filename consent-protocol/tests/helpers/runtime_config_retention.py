"""Shared fixtures for runtime-configuration retention contracts."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

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


def load_plg_runtime_sync():
    path = Path(__file__).resolve().parents[3] / "scripts/ops/sync_backend_runtime_secrets.py"
    spec = importlib.util.spec_from_file_location("plg_runtime_sync", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
