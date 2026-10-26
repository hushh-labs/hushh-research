# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""A qualified phone fallback cannot bypass retained document reader authority.

Kept focused because the existing release contract suite is at its module limit.
"""

import json
import sys

import pytest

from tests.helpers.deployment_cli import cloudrun_revision
from tests.test_protected_document_release_contract import reader_repository as reader_repository


@pytest.fixture
def binding_case(monkeypatch, tmp_path, reader_repository):
    module, old, reader, _git = reader_repository
    report = {
        "configured": True,
        "enabled": False,
        "bootstrapEmpty": True,
        "project": "hushh-pda",
        "readerAncestor": reader,
        "targetSha": reader,
        "previous": {
            name: {
                "revision": name + "-old",
                "sha": old,
                "image": "image@sha256:" + "b" * 64,
                "readerCompatible": False,
            }
            for name in module.SERVICES
        },
    }
    qualified = {
        "schema_version": 1,
        "qualification": "passed",
        "project": "hushh-pda",
        "region": "us-central1",
        "revision": "consent-protocol-qualified",
        "source": reader,
        "image": "image@sha256:" + "a" * 64,
    }
    actual = cloudrun_revision(
        name=qualified["revision"],
        service="consent-protocol",
        sha=reader,
    )
    report_path, phone_path = tmp_path / "documents.json", tmp_path / "phone.json"
    calls = []

    def cloud(*args):
        calls.append(args)
        assert args == (
            "run",
            "revisions",
            "describe",
            qualified["revision"],
            "--project=hushh-pda",
            "--region=us-central1",
            "--format=json",
        )
        return json.dumps(actual)

    monkeypatch.setattr(module, "_cloud", cloud)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "resolve",
            "--project",
            "hushh-pda",
            "--environment",
            "production",
            "--required-ancestor",
            reader,
            "--rollback-report",
            str(report_path),
            "--rebind-backend-report",
            str(phone_path),
        ],
    )

    def execute():
        report_path.write_text(json.dumps(report))
        phone_path.write_text(json.dumps(qualified))
        return module.main()

    return module, old, reader, report, qualified, actual, report_path, calls, execute


def test_rebind_preserves_other_readers_and_bootstrap_boundary(binding_case):
    module, _old, reader, report, qualified, _actual, path, calls, execute = binding_case
    assert execute() == 0
    updated = json.loads(path.read_text())
    expected = json.loads(json.dumps(report))
    expected["previous"]["consent-protocol"] = {
        "revision": qualified["revision"],
        "sha": reader,
        "image": qualified["image"],
        "readerCompatible": True,
    }
    assert updated == expected
    assert len(calls) == 1
    module.assert_rollback(
        updated,
        project="hushh-pda",
        service="consent-protocol",
        revision=qualified["revision"],
    )
    with pytest.raises(ValueError, match="verified baseline"):
        module.assert_rollback(
            updated,
            project="hushh-pda",
            service="consent-protocol",
            revision="unselected",
        )
    assert not list(path.parent.glob(path.name + ".*"))


@pytest.mark.parametrize(
    "invalid",
    [
        "schema",
        "qualification",
        "project",
        "region",
        "revision",
        "source",
        "image",
        "cloud-name",
        "cloud-service",
        "cloud-source",
        "cloud-image",
        "report-project",
        "report-reader",
        "report-unconfigured",
        "missing-backend",
    ],
)
def test_rebind_refuses_unverified_or_mismatched_identity(binding_case, invalid):
    _module, _old, _reader, report, qualified, actual, path, _calls, execute = binding_case
    if invalid in {"schema", "qualification", "project", "region", "revision", "source", "image"}:
        key = "schema_version" if invalid == "schema" else invalid
        qualified[key] = {"schema": True, "revision": "invalid/name"}.get(invalid, "wrong")
    elif invalid == "cloud-name":
        actual["metadata"]["name"] = "consent-protocol-unselected"
    elif invalid == "cloud-service":
        actual["metadata"]["labels"]["serving.knative.dev/service"] = "hushh-webapp"
    elif invalid == "cloud-source":
        actual["metadata"]["labels"]["deploy-sha"] = "f" * 40
    elif invalid == "cloud-image":
        actual["spec"]["containers"][0]["image"] = "image@sha256:" + "f" * 64
    elif invalid == "report-project":
        report["project"] = "hushh-pda-uat"
    elif invalid == "report-reader":
        report["readerAncestor"] = "f" * 40
    elif invalid == "report-unconfigured":
        report["configured"] = False
    else:
        del report["previous"]["consent-protocol"]
    with pytest.raises(SystemExit) as refused:
        execute()
    assert refused.value.code == 1
    assert json.loads(path.read_text()) == report
    assert not list(path.parent.glob(path.name + ".*"))


def test_rebind_requires_actual_reader_support_with_guard_negative_control(
    monkeypatch, binding_case
):
    module, old, _reader, report, qualified, actual, path, _calls, execute = binding_case
    qualified["source"] = old
    actual["metadata"]["labels"]["deploy-sha"] = old

    def assert_denied():
        with pytest.raises(SystemExit) as refused:
            execute()
        assert refused.value.code == 1
        assert json.loads(path.read_text()) == report

    assert_denied()
    # Removing only the canonical reader check lets a phone-qualified pre-reader
    # image replace the baseline. The same security assertion must then fail.
    monkeypatch.setattr(module, "reader_supported", lambda *_args: True)
    with pytest.raises(pytest.fail.Exception):
        assert_denied()


def test_rebind_atomic_failure_preserves_report_and_removes_temporary(monkeypatch, binding_case):
    _module, _old, _reader, report, _qualified, _actual, path, _calls, execute = binding_case

    def fail_replace(*_args):
        raise OSError("synthetic atomic replacement failure")

    monkeypatch.setattr(type(path), "replace", fail_replace)
    with pytest.raises(SystemExit) as refused:
        execute()
    assert refused.value.code == 1
    assert json.loads(path.read_text()) == report
    assert not list(path.parent.glob(path.name + ".*"))
