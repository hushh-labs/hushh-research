# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Acknowledged synchronous builds qualify; observed uncertainty stays fenced."""

import copy
import importlib
from datetime import datetime

import pytest

from tests.test_phone_rollback_release import FALLBACK, IMAGE, PRIMARY, ROOT, _revision

pytestmark = pytest.mark.feature_auth_reliability


@pytest.fixture
def submission(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    module = importlib.import_module("schema_origin")
    module._authorities()
    attempt = {"id": 42, "run_attempt": 2, "status": "completed"}
    job = {
        "status": "completed",
        "steps": [
            {
                "name": "Deploy backend using Cloud Build",
                "status": "completed",
                "conclusion": "success",
                "started_at": "2026-10-26T01:12:00Z",
                "completed_at": "2026-10-26T01:15:00Z",
            }
        ],
    }
    build = {
        "id": "01234567-0123-0123-0123-0123456789ab",
        "status": "SUCCESS",
        "createTime": "2026-10-26T01:12:01Z",
        "finishTime": "2026-10-26T01:14:59Z",
        "tags": ["phone-cold-42-2"],
        "steps": [{"id": "deploy-backend"}],
        "substitutions": {
            "_DEPLOY_ENV": "production",
            "_BACKEND_SERVICE": "consent-protocol",
            "_GITHUB_RUN_ID": "42",
            "_GITHUB_RUN_ATTEMPT": "2",
            "_DEPLOY_SHA": PRIMARY,
            "_PHONE_DEPLOY_PHASE": "cold",
            "_PHONE_ROLLBACK_SHA": FALLBACK,
            "_PHONE_ROLLBACK_IMAGE_REFERENCE": IMAGE,
        },
    }
    return module, attempt, job, build


def _timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


@pytest.mark.parametrize(
    "change",
    [
        None,
        "failed-cli",
        "duplicate",
        "wrong-attempt",
        "wrong-tag",
        "outside-window",
        "failed-build",
    ],
)
def test_only_exact_acknowledged_terminal_attempt_can_close_a_submission(submission, change):
    module, attempt, job, build = submission
    builds = [build]
    if change == "failed-cli":
        job["steps"][0]["conclusion"] = "failure"
    elif change == "duplicate":
        builds.append({**build, "id": "fedcba98-0123-0123-0123-0123456789ab"})
    elif change == "wrong-attempt":
        build["substitutions"]["_GITHUB_RUN_ATTEMPT"] = "3"
    elif change == "wrong-tag":
        build["tags"] = ["phone-cold-42-3"]
    elif change == "outside-window":
        build["finishTime"] = "2026-10-26T01:16:00Z"
    elif change == "failed-build":
        build["status"] = "FAILURE"
    if change:
        with pytest.raises(ValueError):
            module._acknowledged(
                attempt, job, builds, {"run_id": "99", "run_attempt": 1}, _timestamp
            )
    else:
        receipt = module._acknowledged(
            attempt, job, builds, {"run_id": "99", "run_attempt": 1}, _timestamp
        )
        assert receipt == {
            "run_id": "42",
            "run_attempt": 2,
            "build_id": build["id"],
            "source": FALLBACK,
            "image": IMAGE,
        }


def test_skipped_job_is_distinct_from_missing_steps_after_an_executed_job(submission):
    module, attempt, _job, _build = submission
    owner = {"run_id": "99", "run_attempt": 1}
    skipped = {"status": "completed", "conclusion": "skipped", "steps": []}
    assert module._acknowledged(attempt, skipped, [], owner, _timestamp) is None
    skipped["conclusion"] = "failure"
    with pytest.raises(ValueError, match="submission_unknown"):
        module._acknowledged(attempt, skipped, [], owner, _timestamp)
    skipped.pop("steps")
    skipped["conclusion"] = "skipped"
    with pytest.raises(ValueError, match="inventory_unknown"):
        module._acknowledged(attempt, skipped, [], owner, _timestamp)


@pytest.mark.parametrize("change", [None, "other-phase", "duplicate", "other-owner"])
def test_current_pre_submit_exemption_is_owned_and_bound_to_schema_phase(submission, change):
    module, attempt, _job, _build = submission
    attempt["status"] = "in_progress"
    owner = {"run_id": "42", "run_attempt": 2}
    job = {
        "status": "in_progress",
        "steps": [
            {"name": "Qualify initial cold schema boundary", "status": "in_progress"},
            {"name": "Deploy backend using Cloud Build", "status": "pending"},
        ],
    }
    if change == "other-phase":
        job["steps"][0]["name"] = "Other arbitrary work"
    elif change == "duplicate":
        job["steps"].append(copy.deepcopy(job["steps"][-1]))
    elif change == "other-owner":
        owner["run_attempt"] = 3
    if change:
        with pytest.raises(ValueError):
            module._acknowledged(attempt, job, [], owner, _timestamp)
    else:
        assert module._acknowledged(attempt, job, [], owner, _timestamp) is None


@pytest.mark.parametrize(
    "change", [None, "WORKING", "PENDING", "STATUS_UNKNOWN", "FAILURE", "inventory-changed"]
)
def test_bounded_build_readback_does_not_hide_active_or_uncertain_producers(
    submission, monkeypatch, change
):
    module, _attempt, _job, build = submission
    closed = importlib.import_module("workos_rollout")
    if change in {"WORKING", "PENDING", "STATUS_UNKNOWN", "FAILURE"}:
        build["status"] = change
    reads = []

    def document(command):
        reads.append(command)
        if command[2] == "describe":
            return copy.deepcopy(build)
        return [] if change == "inventory-changed" and len(reads) > 1 else [copy.deepcopy(build)]

    monkeypatch.setattr(closed, "_document", document)
    if change:
        with pytest.raises(ValueError):
            module._builds("2026-10-26T01:10:00Z")
    else:
        assert module._builds("2026-10-26T01:10:00Z") == [build]


@pytest.mark.parametrize("queued", [False, True])
def test_completed_boundary_run_with_late_build_is_not_skipped(submission, monkeypatch, queued):
    module, attempt, job, build = submission
    history = importlib.import_module("production_phone_lease")
    qualify = importlib.import_module("qualify_image")
    producer = {
        **attempt,
        "head_sha": PRIMARY,
        "created_at": "2026-10-26T01:00:00Z",
        "updated_at": "2026-10-26T01:15:01Z",
        "status": "completed",
    }
    boundary = {
        **producer,
        "id": 41,
        "created_at": "2026-10-26T00:00:00Z",
        "updated_at": "2026-10-26T00:30:00Z",
    }
    monkeypatch.setattr(module, "_builds", lambda _start: [build])
    waiting = {**producer, "id": 43, "status": "queued"}
    monkeypatch.setattr(
        history,
        "_history",
        lambda *_args: iter(([waiting] if queued else []) + [producer, boundary]),
    )
    monkeypatch.setattr(history, "_run", lambda _repository, listed, _api: listed)
    monkeypatch.setattr(
        history,
        "_attempt",
        lambda _repository, run, *_args: (attempt, {}, None if run["id"] == 43 else job),
    )
    monkeypatch.setattr(module._authorities(), "governed_dispatch", lambda *_args: True)
    source = b"      - name: Deploy backend using Cloud Build\n        run: |\n          set -euo pipefail\n          gcloud builds submit\n"
    monkeypatch.setattr(
        qualify, "run", lambda command: source if command[:2] == ["git", "show"] else b""
    )
    result = module.closed_submissions(
        {"run_id": "99", "run_attempt": 1}, start="2026-10-26T01:10:00Z", source_anchor="c" * 40
    )
    assert result["qualification"] == "passed"
    assert result["acknowledged_attempts"][0]["build_id"] == build["id"]


def test_prior_job_still_active_after_successful_build_is_not_settled(submission):
    module, attempt, job, build = submission
    attempt["status"] = job["status"] = "in_progress"
    with pytest.raises(ValueError, match="producer_unfinished"):
        module._acknowledged(attempt, job, [build], {"run_id": "99", "run_attempt": 1}, _timestamp)


def test_canonical_sidecar_digest_and_exact_launcher_cannot_be_replaced(submission, monkeypatch):
    module = importlib.import_module("schema_producers")
    row = _revision()
    row["metadata"]["uid"] = "revision-uid"
    row["spec"]["containers"][0]["name"] = "consent-protocol"
    source = (ROOT / "deploy/drive/deploy_worker_service_prod.sh").read_text()
    import re

    image = re.search(r'^readonly CLAMAV_IMAGE="([^"]+)"$', source, re.M)[1]
    scanner = {"name": "clamav", "image": image}
    row["spec"]["containers"].append(scanner)
    monkeypatch.setattr(module, "source_capable", lambda _sha: False)
    assert module._revision(row, "consent-protocol", PRIMARY)["launcher"] == "backend_image_default"
    scanner["image"] = IMAGE
    with pytest.raises(ValueError, match="sidecar_issuer_unknown"):
        module._revision(row, "consent-protocol", PRIMARY)
    contract = importlib.import_module("production_capacity_bridge_contract")
    launcher = {}
    contract.configure_clone_launcher(
        {"status": {"imageDigest": contract.FROZEN_IMAGE}}, launcher, [], contract.PROFILE
    )
    assert module._launcher(launcher, "consent-protocol") == "server:app"
    launcher["args"].extend(["--pythonpath", "/unreviewed"])
    with pytest.raises(ValueError, match="launcher_unknown"):
        module._launcher(launcher, "consent-protocol")


def test_acknowledged_phone_build_must_join_the_retained_issuer(submission, monkeypatch):
    from types import SimpleNamespace

    module = importlib.import_module("schema_qualification")
    monkeypatch.setattr(module, "source_capable", lambda _sha: True)
    receipt = {"source": FALLBACK, "image": IMAGE, "run_id": "42"}
    ports = SimpleNamespace(
        submissions=lambda: {"qualification": "passed", "acknowledged_attempts": [receipt]}
    )
    with pytest.raises(ValueError, match="acknowledged_issuer_missing"):
        module._submissions(ports, {"revisions": {}})
    assert (
        module._submissions(ports, {"revisions": {"retained": receipt}})["qualification"]
        == "passed"
    )
