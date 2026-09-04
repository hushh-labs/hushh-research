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


def _cloud_run_revision(service: str) -> dict[str, object]:
    return {
        "metadata": {"labels": {"serving.knative.dev/service": service}},
        "spec": {"containers": [{"env": [{"name": "DB_POOL_MAX_SIZE", "value": "8"}]}]},
    }


def test_candidate_revision_is_inspected_before_it_serves(monkeypatch) -> None:
    monkeypatch.setattr(parity, "_describe_run_revision", lambda *_args: _revision("backend"))

    env, revisions = parity._selected_container_env_map(
        "project", "region", "backend", {}, "backend-00001-candidate"
    )

    assert revisions == ["backend-00001-candidate"]
    assert env["DB_POOL_MAX_SIZE"]["value"] == "8"


def test_cloud_run_candidate_revision_shape_is_inspected_before_it_serves(monkeypatch) -> None:
    monkeypatch.setattr(
        parity, "_describe_run_revision", lambda *_args: _cloud_run_revision("backend")
    )

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


def test_scoped_frontend_candidate_skips_untouched_backend_parity() -> None:
    assert parity._parity_targets("", "frontend-00001-candidate") == (False, True)


def test_scoped_backend_candidate_skips_untouched_frontend_parity() -> None:
    assert parity._parity_targets("backend-00001-candidate", "") == (True, False)


def test_legacy_parity_without_candidates_remains_full_stack() -> None:
    assert parity._parity_targets(None, None) == (True, True)


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


def test_firebase_project_contract_accepts_exact_expected_project(monkeypatch) -> None:
    values = {
        "FIREBASE_ADMIN_CREDENTIALS_JSON": '{"project_id":"hushh-pda"}',
        "NEXT_PUBLIC_FIREBASE_PROJECT_ID": "hushh-pda",
    }
    monkeypatch.setattr(parity, "_read_secret_value", lambda _project, key: values.get(key))

    assert parity._firebase_project_contract(
        "hushh-pda-uat",
        expected_project="hushh-pda",
    ) == {
        "status": "valid",
        "credentials": "valid",
        "expected": "valid",
    }


def test_firebase_project_contract_rejects_matching_but_unexpected_project(monkeypatch) -> None:
    values = {
        "FIREBASE_ADMIN_CREDENTIALS_JSON": '{"project_id":"hushh-pda-uat"}',
        "NEXT_PUBLIC_FIREBASE_PROJECT_ID": "hushh-pda-uat",
    }
    monkeypatch.setattr(parity, "_read_secret_value", lambda _project, key: values.get(key))

    assert parity._firebase_project_contract(
        "hushh-pda-uat",
        expected_project="hushh-pda",
    ) == {
        "status": "unexpected_project",
        "credentials": "valid",
        "expected": "mismatch",
    }
