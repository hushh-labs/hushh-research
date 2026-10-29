# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Reviewed historical shapes preserve complete producer and submission checks."""

import copy
import importlib
import json
import subprocess
from types import SimpleNamespace

import pytest

from tests.test_phone_rollback_release import ROOT
from tests.test_phone_schema_origin import _timestamp
from tests.test_phone_schema_origin import restoration_history as shared_history
from tests.test_phone_schema_origin import submission as shared_submission
from tests.test_production_restoration_operation import _history_authority

pytestmark = pytest.mark.feature_auth_reliability
submission = shared_submission
restoration_history = shared_history


@pytest.mark.parametrize(
    "changed",
    [None, "unknown", "record", "project", "producer", "grep-error", "scope", "git-error"],
)
@pytest.mark.parametrize("main", [True, False])
def test_only_reviewed_parallel_predecessor_with_equal_producer_scope_is_non_phone(
    monkeypatch, tmp_path, request, changed, main
):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    module = importlib.import_module("schema_producers")
    module.source_capable.cache_clear()
    request.addfinalizer(module.source_capable.cache_clear)
    authority, record = _history_authority(monkeypatch, tmp_path)
    source = "e" * 40 if changed == "unknown" else record["previousSha"]
    scans, diffs = [], []

    def run(command):
        if command[1] == "diff":
            diffs.append(command)
            assert command == [
                "git",
                "diff",
                "--exit-code",
                module.SOURCE_ANCHOR + "^",
                source,
                "--",
                *authority["PHONE_PRODUCER_PATHS"],
            ]
            if changed in {"scope", "git-error"}:
                raise subprocess.CalledProcessError(1 if changed == "scope" else 128, command)
            return b""
        if command[1] == "cat-file":
            return b""
        if command[-1] == "origin/main" and main:
            return b""
        raise subprocess.CalledProcessError(1, command)

    def scan(command, **_kwargs):
        scans.append(command)
        assert command[4] == source
        return SimpleNamespace(
            returncode=0 if changed == "producer" else 128 if changed == "grep-error" else 1,
            stdout="producer.py" if changed == "producer" else "",
            stderr="",
        )

    globals_ = authority["qualify_source"].__globals__
    monkeypatch.setitem(globals_, "subprocess", SimpleNamespace(run=scan))
    monkeypatch.setattr(module, "run", run)
    monkeypatch.setattr(module, "run_path", lambda _path: authority)
    if changed == "record":
        record["previousServices"]["consent-protocol"]["sha"] = "f" * 40
        globals_["RECORD"].write_text(json.dumps(record))
    if changed == "project":
        monkeypatch.setattr(module, "PROJECT", "hushh-pda-uat")
    if changed == "unknown" and main:
        assert module.source_capable(source) is True
        assert not scans and not diffs
    elif changed:
        with pytest.raises((ValueError, subprocess.CalledProcessError)):
            module.source_capable(source)
    else:
        assert module.source_capable(source) is False
        assert len(scans) == len(diffs) == 1
        # History classification does not expand restoration deployment authority.
        with pytest.raises(ValueError):
            authority["qualify_source"](source)


@pytest.mark.parametrize(
    "changed", [None, "project", "namespace", "method", "alias", "type", "extra", "job"]
)
def test_observed_v1_create_parent_requires_exact_project_and_envelope(monkeypatch, changed):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    closed = importlib.import_module("workos_rollout")
    request = {
        "@type": "type.googleapis.com/google.cloud.run.v1.CreateServiceRequest",
        "parent": "namespaces/hushh-pda",
        "service": {"metadata": {}, "spec": {"template": {"spec": {}}}},
    }
    payload = {"methodName": "google.cloud.run.v1.Services.CreateService", "request": request}
    if changed == "project":
        request["parent"] = "namespaces/hushh-pda-uat"
    elif changed == "namespace":
        request["service"]["metadata"]["namespace"] = "hushh-pda-uat"
    elif changed == "method":
        payload["methodName"] = "google.cloud.run.v1.Services.ReplaceService"
    elif changed == "alias":
        payload["methodName"] = "/Services.CreateService"
    elif changed == "type":
        request["@type"] = "type.googleapis.com/google.cloud.run.v2.CreateServiceRequest"
    elif changed == "extra":
        request["unknown"] = True
    if changed:
        with pytest.raises(ValueError):
            closed._audit_templates(
                {"protoPayload": payload},
                project="hushh-pda",
                kind="Job" if changed == "job" else "Service",
            )
    else:
        assert closed._audit_templates({"protoPayload": payload}, project="hushh-pda") == [
            (request["service"]["spec"]["template"], None, False)
        ]


@pytest.mark.parametrize("changed", [None, "duration", "active", "missing-end", "invalid"])
def test_terminal_skipped_submission_equal_timestamp_is_not_an_executed_build(submission, changed):
    module, attempt, job, _build = submission
    step = job["steps"][0]
    step.update(conclusion="skipped", completed_at=step["started_at"])
    if changed == "duration":
        step["completed_at"] = "2026-10-26T01:12:01Z"
    elif changed == "active":
        job["status"] = "in_progress"
    elif changed == "missing-end":
        step.pop("completed_at")
    elif changed == "invalid":
        step["started_at"] = step["completed_at"] = "invalid"

    def action():
        return module._acknowledged(
            attempt, job, [], {"run_id": "99", "run_attempt": 1}, _timestamp
        )

    if changed:
        with pytest.raises(ValueError):
            action()
    else:
        assert action() is None


def test_metadata_projection_preserves_full_bounded_build_describes(submission, monkeypatch):
    module, _attempt, _job, build = submission
    closed = importlib.import_module("workos_rollout")
    rows = [copy.deepcopy(build), copy.deepcopy(build)]
    rows[1]["id"] = "fedcba98-0123-0123-0123-0123456789ab"
    for row in rows:
        row["steps"][0]["args"] = ["x" * 9000] * 70
    assert len(json.dumps(rows).encode()) > 1024 * 1024
    assert all(len(json.dumps(row).encode()) < 1024 * 1024 for row in rows)
    described = []

    def run(command, **_kwargs):
        if command[2] == "list":
            value = (
                [{k: row[k] for k in ("id", "status", "createTime")} for row in rows]
                if command[-1] == "--format=json(id,status,createTime)"
                else rows
            )
        else:
            described.append(command[3])
            value = next(row for row in rows if row["id"] == command[3])
        content = json.dumps(value).encode()
        if len(content) > 1024 * 1024:
            raise ValueError("phone_image_evidence_exceeds_bound")
        return content

    monkeypatch.setattr(closed, "run", run)
    assert module._builds("2026-10-26T01:10:00Z") == rows
    assert described == [row["id"] for row in rows]


@pytest.mark.parametrize(
    "changed", [None, "byte", "trailing", "async", "duplicate", "failed", "unmatched"]
)
def test_exact_historical_terminal_submit_still_requires_all_build_acknowledgements(
    restoration_history, monkeypatch, changed
):
    module, case, builds = restoration_history
    source = subprocess.check_output(  # noqa: S603 -- exact reviewed immutable Git source, no shell.
        ["git", "show", "7d5546e471f2e168a898cd21c9abd7f1e8aaa9cc:" + module.WORKFLOW], cwd=ROOT
    )
    if changed == "byte":
        source += b"\n"
    elif changed == "trailing":
        source = source.replace(b"gcloud builds submit", b"true\n          gcloud builds submit")
    elif changed == "async":
        source = source.replace(b"gcloud builds submit", b"gcloud builds submit --async")
    elif changed == "duplicate":
        source = source.replace(
            b"gcloud builds submit", b"gcloud builds submit\n          gcloud builds submit"
        )
    case.sources.update({key: source for key in case.sources})
    # This test owns synchronous submit proof, not the separate restoration exception.
    history = importlib.import_module("production_phone_lease")
    monkeypatch.setattr(history, "_restoration_nonproducer", lambda *_args: False)
    case.runs[0]["run_attempt"] = 1
    case.attempts[(300, 1)]["head_sha"] = case.runs[0]["head_sha"]
    case.jobs[(300, 1)]["jobs"][0]["name"] = "Deploy Production Scope"
    if changed == "failed":
        next(s for s in case.jobs[(300, 1)]["jobs"][0]["steps"] if s["name"] == history.DEPLOY)[
            "conclusion"
        ] = "failure"
    if changed == "unmatched":
        builds.append({**builds[0], "id": "fedcba98-0123-0123-0123-0123456789ab"})
    if changed:
        with pytest.raises(ValueError):
            module.closed_submissions(
                {"run_id": "99", "run_attempt": 1},
                start="2026-10-21T00:00:00Z",
                source_anchor="c" * 40,
            )
    else:
        assert (
            module.closed_submissions(
                {"run_id": "99", "run_attempt": 1},
                start="2026-10-21T00:00:00Z",
                source_anchor="c" * 40,
            )["qualification"]
            == "passed"
        )
