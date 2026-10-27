"""Candidate-only production Drive configuration never touches shared secrets."""

import json
import subprocess

import pytest

from tests.helpers.runtime_config_retention import (
    CANDIDATE_SECRET_NAME,
    _write_configuration,
    load_plg_runtime_sync,
)


@pytest.fixture
def plg_runtime_sync():
    return load_plg_runtime_sync()


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
