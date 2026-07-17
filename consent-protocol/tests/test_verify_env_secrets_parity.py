from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/ops/verify-env-secrets-parity.py"
SPEC = importlib.util.spec_from_file_location("verify_env_secrets_parity", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
parity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parity)


def _revision(service: str) -> dict[str, object]:
    return {
        "metadata": {"labels": {"serving.knative.dev/service": service}},
        "spec": {
            "template": {
                "spec": {"containers": [{"env": [{"name": "DB_POOL_MAX_SIZE", "value": "8"}]}]}
            }
        },
    }


def test_candidate_revision_is_inspected_before_it_serves(monkeypatch) -> None:
    monkeypatch.setattr(parity, "_describe_run_revision", lambda *_args: _revision("backend"))

    env, revisions = parity._selected_container_env_map(
        "project", "region", "backend", {}, "backend-00001-candidate"
    )

    assert revisions == ["backend-00001-candidate"]
    assert env["DB_POOL_MAX_SIZE"]["value"] == "8"


def test_candidate_revision_from_another_service_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(parity, "_describe_run_revision", lambda *_args: _revision("frontend"))

    env, revisions = parity._selected_container_env_map(
        "project", "region", "backend", {}, "frontend-00001-candidate"
    )

    assert revisions == ["frontend-00001-candidate"]
    assert env == {}


def test_firebase_project_contract_accepts_matching_admin_and_client_projects(
    monkeypatch,
) -> None:
    values = {
        "FIREBASE_ADMIN_CREDENTIALS_JSON": '{"project_id":"one-uat"}',
        "NEXT_PUBLIC_FIREBASE_PROJECT_ID": "one-uat",
    }
    monkeypatch.setattr(parity, "_read_secret_value", lambda _project, key: values.get(key))

    assert parity._firebase_project_contract("project") == {
        "status": "valid",
        "credentials": "valid",
    }


def test_firebase_project_contract_fails_closed_on_project_mismatch(monkeypatch) -> None:
    values = {
        "FIREBASE_ADMIN_CREDENTIALS_JSON": '{"project_id":"wrong-project"}',
        "NEXT_PUBLIC_FIREBASE_PROJECT_ID": "one-uat",
    }
    monkeypatch.setattr(parity, "_read_secret_value", lambda _project, key: values.get(key))

    assert parity._firebase_project_contract("project") == {
        "status": "mismatch",
        "credentials": "mismatch",
    }
