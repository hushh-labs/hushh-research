"""Preflight proposals remain local and do not authorize submission."""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
import frontend_fixture_producer as producer  # noqa: E402
import frontend_hosted_preflight as preflight  # noqa: E402


def environment(monkeypatch):
    for name, value in {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_WORKFLOW_REF": "hushh-labs/hushh-research/.github/workflows/plg-frontend-uat.yml@refs/heads/main",
        "GITHUB_SHA": "a" * 40,
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
    }.items():
        monkeypatch.setenv(name, value)


def install(monkeypatch, *, changed=False):
    monkeypatch.setattr(preflight.release, "reviewed_inputs", lambda _attempt: {"reviewed": "hash"})
    monkeypatch.setattr(
        preflight.release.frontend_validation, "verify", lambda *_args: {"runId": 42}
    )
    calls = []

    def snapshot(_environment, *, fixture_backend=False):
        calls.append(1)
        return {"inventory": {}, "snapshot": len(calls) if changed else 1}

    monkeypatch.setattr(preflight.secrets, "snapshot", snapshot)

    def prepare(_attempt, _run, _inventory, path, *, fixture_backend=False):
        path.write_bytes(b"archive")
        return b"derived", {"kind": "proposed", "sourceValidation": {"runId": 42}}

    monkeypatch.setattr(preflight.pinned, "prepare_local", prepare)
    monkeypatch.setattr(preflight.release.source.backend, "_git", lambda *_args: b"reviewed")
    monkeypatch.setattr(
        preflight.fixture,
        "reviewed_bundle",
        lambda _attempt, _pair, recipe, _authority: (recipe, {"providerVerified": False}),
    )
    monkeypatch.setattr(
        preflight.caller, "proposed_build_intent", lambda *_args: {"maySubmit": False}
    )
    return calls


def test_preflight_writes_only_local_proposal_and_denies_duplicate(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    calls = install(monkeypatch)
    result = preflight.prepare("uat", 42, runner_temp=tmp_path)
    assert result["status"] == "local-proposal" and not result["maySubmit"]
    folder = Path(result["directory"])
    assert (folder / "source.tar.gz").read_bytes() == b"archive"
    assert (folder / "build.yaml").read_bytes() == b"derived"
    assert json.loads((folder / "intent.json").read_text()) == {"maySubmit": False}
    assert len(calls) == 2
    with pytest.raises(FileExistsError):
        preflight.prepare("uat", 42, runner_temp=tmp_path)


def test_wrong_hosted_workflow_fails_before_provider_read(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    calls = install(monkeypatch)
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", "unreviewed")
    with pytest.raises(preflight.release.Refused):
        preflight.prepare("uat", 42, runner_temp=tmp_path)
    assert not calls


def test_changed_provider_snapshot_refuses_and_retains_untrusted_directory(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    install(monkeypatch, changed=True)
    with pytest.raises(preflight.release.Refused, match="metadata changed"):
        preflight.prepare("uat", 42, runner_temp=tmp_path)
    folder = tmp_path / "plg-frontend-preflight-uat-123-2"
    assert (folder / "source.tar.gz").exists()
    assert not (folder / "intent.json").exists()


def test_untrusted_output_directory_is_rejected_before_provider_read(monkeypatch, tmp_path):
    environment(monkeypatch)
    calls = install(monkeypatch)
    elsewhere = tmp_path / "other"
    elsewhere.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    with pytest.raises(preflight.release.Refused, match="directory invalid"):
        preflight.prepare("uat", 42, runner_temp=elsewhere)
    assert not calls


def test_unbound_preflight_removes_and_rejects_unexpected_identity_token(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("PLG_QUALIFICATION_ID_TOKEN", "synthetic-stale-token")
    calls = install(monkeypatch)
    with pytest.raises(preflight.release.Refused, match="unexpected backend token"):
        preflight.prepare("uat", 42, runner_temp=tmp_path)
    assert "PLG_QUALIFICATION_ID_TOKEN" not in __import__("os").environ
    assert not calls


def test_invalid_backend_run_removes_identity_token_before_refusing(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("PLG_QUALIFICATION_ID_TOKEN", "synthetic-stale-token")
    calls = install(monkeypatch)
    with pytest.raises(preflight.release.Refused, match="backend run invalid"):
        preflight.prepare("uat", 42, runner_temp=tmp_path, backend_run=0)
    assert "PLG_QUALIFICATION_ID_TOKEN" not in __import__("os").environ
    assert not calls


def test_changed_source_validation_after_metadata_refuses(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    install(monkeypatch)
    monkeypatch.setattr(
        preflight.release.frontend_validation, "verify", lambda *_args: {"runId": 43}
    )
    with pytest.raises(preflight.release.Refused, match="metadata changed"):
        preflight.prepare("uat", 42, runner_temp=tmp_path)
    folder = tmp_path / "plg-frontend-preflight-uat-123-2"
    assert not (folder / "intent.json").exists()


def test_bound_pair_is_rechecked_without_recording_identity_token(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    dummy_token = "synthetic-fixture-token"
    monkeypatch.setenv("PLG_QUALIFICATION_ID_TOKEN", dummy_token)
    install(monkeypatch)
    authority = {
        name: "a" * 64
        for name in ("deploy/frontend-image.cloudbuild.yaml", *preflight.release.OVERLAYS)
    }
    monkeypatch.setattr(preflight.release, "reviewed_inputs", lambda _attempt: authority)
    calls = []

    def inspect(_environment, run_id, *, id_token):
        assert run_id == 55 and id_token == dummy_token
        calls.append(1)
        return {
            "freshHealthProbeAttempted": True,
            "freshAllowPolicyReadAttempted": True,
            "providerVerified": False,
        }

    monkeypatch.setattr(preflight.backend_pair, "inspect", inspect)
    monkeypatch.setattr(
        preflight.backend_target, "bind", lambda *_args, **_kwargs: (b"bound", {"maySubmit": False})
    )
    result = preflight.prepare("uat", 42, runner_temp=tmp_path, backend_run=55)
    assert len(calls) == 2 and not result["maySubmit"]
    assert "PLG_QUALIFICATION_ID_TOKEN" not in __import__("os").environ
    folder = Path(result["directory"])
    assert (folder / "build.yaml").read_bytes() == b"bound"
    assert dummy_token not in (folder / "prepared.json").read_text()
    assert dummy_token not in (folder / "intent.json").read_text()


def test_bound_pair_changes_abort_before_publishing_intent(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("PLG_QUALIFICATION_ID_TOKEN", "synthetic-fixture-token")
    install(monkeypatch)
    authority = {
        name: "a" * 64
        for name in ("deploy/frontend-image.cloudbuild.yaml", *preflight.release.OVERLAYS)
    }
    monkeypatch.setattr(preflight.release, "reviewed_inputs", lambda _attempt: authority)
    calls = []

    def inspect(*_args, **_kwargs):
        calls.append(1)
        return {
            "freshHealthProbeAttempted": True,
            "freshAllowPolicyReadAttempted": True,
            "uid": len(calls),
        }

    monkeypatch.setattr(preflight.backend_pair, "inspect", inspect)
    monkeypatch.setattr(
        preflight.backend_target, "bind", lambda *_args, **_kwargs: (b"bound", {"maySubmit": False})
    )
    with pytest.raises(preflight.release.Refused, match="backend changed"):
        preflight.prepare("uat", 42, runner_temp=tmp_path, backend_run=55)
    assert not (tmp_path / "plg-frontend-preflight-uat-123-2" / "intent.json").exists()


def test_bound_pair_rechecks_secret_snapshot_after_backend_observation(monkeypatch, tmp_path):
    environment(monkeypatch)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("PLG_QUALIFICATION_ID_TOKEN", "synthetic-fixture-token")
    install(monkeypatch)
    authority = {
        name: "a" * 64
        for name in ("deploy/frontend-image.cloudbuild.yaml", *preflight.release.OVERLAYS)
    }
    monkeypatch.setattr(preflight.release, "reviewed_inputs", lambda _attempt: authority)
    pair = {"freshHealthProbeAttempted": True, "freshAllowPolicyReadAttempted": True}
    monkeypatch.setattr(preflight.backend_pair, "inspect", lambda *_args, **_kwargs: pair)
    monkeypatch.setattr(
        preflight.backend_target, "bind", lambda *_args, **_kwargs: (b"bound", {"maySubmit": False})
    )
    calls = []

    def snapshot(_environment, *, fixture_backend=False):
        calls.append(1)
        return {"inventory": {}, "state": "changed" if len(calls) == 3 else "stable"}

    monkeypatch.setattr(preflight.secrets, "snapshot", snapshot)
    with pytest.raises(preflight.release.Refused, match="final metadata changed"):
        preflight.prepare("uat", 42, runner_temp=tmp_path, backend_run=55)
    assert not (tmp_path / "plg-frontend-preflight-uat-123-2" / "intent.json").exists()


def test_concrete_producer_refuses_before_any_cloud_write_without_shared_guard(
    monkeypatch, tmp_path
):
    attempt = preflight.release.Attempt("dev", "a" * 40, "123", "2")
    monkeypatch.setattr(
        __import__("frontend_fixture_build"),
        "inspect_inputs",
        lambda *_args: ({}, b"recipe", {}, b"original", {}),
    )
    (tmp_path / "intent.json").write_text("{}")

    class Cloud:
        def command(self, *_args, **_kwargs):
            pytest.fail("An unresolved submission guard must precede all writes")

    with pytest.raises(preflight.release.Refused, match="Fixture hosted context"):
        producer.build(attempt, tmp_path, cloud=Cloud())
