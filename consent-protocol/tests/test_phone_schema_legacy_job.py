# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""A single old readiness job receives immutable source evidence, never an alias."""

import copy
import hashlib
import importlib
import io
import json
from types import SimpleNamespace
from zipfile import ZipFile

import pytest

from tests.test_phone_rollback_release import ROOT

pytestmark = pytest.mark.feature_auth_reliability


def _original_run(module):
    identity = {
        "id": module.RUN,
        "head_sha": module.HEAD,
        "head_branch": "main",
        "repository_id": 1,
        "head_repository_id": 1,
    }
    run = {
        "id": module.RUN,
        "run_attempt": 1,
        "head_sha": module.HEAD,
        "status": "completed",
        "conclusion": "success",
        "repository": {"id": 1},
        "head_repository": {"id": 1},
    }
    steps = [
        {"name": name, "status": "completed", "conclusion": "success"} for name in module.STEPS
    ]
    steps.append(
        {
            "name": "Upload production deploy artifacts",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-10-02T02:33:00Z",
            "completed_at": "2026-10-02T02:33:10Z",
        }
    )
    job = {
        "run_id": module.RUN,
        "run_attempt": 1,
        "head_sha": module.HEAD,
        "head_branch": "main",
        "name": "Deploy Production Scope",
        "status": "completed",
        "conclusion": "success",
        "steps": steps,
    }
    return identity, run, job


def _documents(module):
    expected = {
        "HUSHH_DEPLOY_ENV": "production",
        "HUSHH_DEPLOY_SOURCE": "deploy-production",
        "HUSHH_DEPLOY_SHA": module.SOURCE,
        "HUSHH_DEPLOY_RUN_ID": str(module.RUN),
    }
    revision = "consent-protocol-00226-hif"
    docs = {
        "prod-release-status.json": {
            "status": "healthy",
            "sha": module.SOURCE,
            "scope": "backend",
            "candidate": {"backend_revision": revision},
            "final": {"backend_revision": revision},
            "verification": {
                **{
                    k: "success"
                    for k in (
                        "runtime_parity",
                        "connected_systems",
                        "backend_provenance",
                        "backend_health",
                        "account_deletion_activation",
                    )
                },
                "account_deletion_activated": "true",
            },
        },
        "prod-backend-image.json": {
            "status": "pinned",
            "sha": module.SOURCE,
            "image_reference": module.IMAGE,
            "index_reference": module.IMAGE,
        },
        "prod-backend-candidate.json": {
            "metadata": {
                "name": revision,
                "labels": {"deploy-sha": module.SOURCE, "github-run-id": str(module.RUN)},
            },
            "spec": {"containers": [{"image": module.IMAGE}]},
            "status": {"imageDigest": module.IMAGE},
        },
        "prod-backend-provenance.json": {
            "status": "healthy",
            "ok": True,
            "mode": "live_traffic",
            "project": "hushh-pda",
            "region": "us-central1",
            "service": "consent-protocol",
            "expected": expected,
            "failures": [],
            "checked_revisions": [
                {
                    "revision": revision,
                    "traffic_percent": 100,
                    "ok": True,
                    "mismatches": [],
                    "env": expected.copy(),
                }
            ],
        },
    }
    return docs


def _archive_ports(state, identity, monkeypatch):
    module, _producer, authority, run, job, docs = (
        state.module,
        state.producer,
        state.authority,
        state.run,
        state.job,
        state.docs,
    )

    def archive():
        stream = io.BytesIO()
        with ZipFile(stream, "w") as zipped:
            for name, document in docs.items():
                zipped.writestr(name, json.dumps(document))
        return stream.getvalue()

    content = archive()
    artifact = {
        "id": module.ARTIFACT,
        "name": f"prod-release-{module.RUN}",
        "expired": False,
        "workflow_run": identity,
        "created_at": "2026-10-02T02:33:05Z",
        "size_in_bytes": len(content),
        "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
    }
    state.artifact, state.archive = artifact, archive
    # Synthetic archive, same strict native digest/attempt/window owners.
    monkeypatch.setattr(module, "DIGEST", artifact["digest"])

    def api(_repository, endpoint):
        state.reads.append(endpoint)
        if endpoint == f"runs/{module.RUN}":
            return (
                {**run, "run_attempt": 2}
                if state.changed and state.reads.count(endpoint) > 1
                else copy.deepcopy(run)
            )
        if endpoint.endswith("/artifacts?per_page=100"):
            return {"total_count": 1, "artifacts": [copy.deepcopy(artifact)]}
        if endpoint.endswith("/attempts/1/jobs?per_page=100"):
            return {"total_count": 1, "jobs": [copy.deepcopy(job)]}
        raise AssertionError(endpoint)

    monkeypatch.setattr(authority, "uncached_api", api)
    monkeypatch.setattr(authority, "governed_dispatch", lambda *_args: True)
    monkeypatch.setattr(
        authority.retention,
        "run_command",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=state.archive()),
    )


def _live_job(module):
    return {
        "metadata": {"name": module.NAME, "uid": module.UID, "creationTimestamp": module.CREATED},
        "spec": {
            "template": {
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "image": module.IMAGE,
                                    "command": ["python3"],
                                    "args": ["scripts/verify_managed_vertex_runtime.py"],
                                }
                            ]
                        }
                    }
                }
            }
        },
    }


@pytest.fixture
def legacy(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    module = importlib.import_module("schema_legacy_job")
    producer = importlib.import_module("schema_producers")
    authority = producer._authorities()
    identity, run, job = _original_run(module)
    docs = _documents(module)
    state = SimpleNamespace(
        module=module,
        producer=producer,
        authority=authority,
        run=run,
        job=job,
        docs=docs,
        reads=[],
        changed=False,
        artifact=None,
    )

    _archive_ports(state, identity, monkeypatch)
    state.live_job = _live_job(module)
    monkeypatch.setattr(module, "SPEC_DIGEST", producer.fingerprint(state.live_job["spec"]))
    return state


@pytest.mark.parametrize(
    "changed",
    [
        None,
        "name",
        "uid",
        "created",
        "image",
        "command",
        "args",
        "sidecar",
        "env",
        "volume",
        "runtime-account",
        "mapping",
        "capable",
        "git-error",
    ],
)
def test_job_source_exception_never_becomes_global_image_authority(legacy, monkeypatch, changed):
    s, m = legacy, legacy.module
    job, images = s.live_job, {}
    container = job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    if changed in {"name", "uid", "created"}:
        job["metadata"][{"created": "creationTimestamp"}.get(changed, changed)] = "different"
    elif changed in {"image", "command", "args"}:
        container[changed] = "different" if changed == "image" else ["different"]
    elif changed == "sidecar":
        job["spec"]["template"]["spec"]["template"]["spec"]["containers"].append(container.copy())
    elif changed == "env":
        container["env"] = [{"name": "PYTHONPATH", "value": "/mounted"}]
    elif changed == "volume":
        job["spec"]["template"]["spec"]["template"]["spec"]["volumes"] = [{}]
        container["volumeMounts"] = [{}]
    elif changed == "runtime-account":
        job["spec"]["template"]["spec"]["template"]["spec"]["serviceAccountName"] = "different"
    elif changed == "mapping":
        images[m.IMAGE] = "e" * 40

    def check(sha):
        assert sha == m.SOURCE
        if changed == "git-error":
            raise ValueError("source_unavailable")
        return changed == "capable"

    monkeypatch.setattr(s.producer, "source_capable", check)
    if changed:
        with pytest.raises(ValueError):
            s.producer._job(job, images)
    else:
        result = s.producer._job(job, images)
        assert result["source"] == m.SOURCE
        assert result["source_provenance"]["artifact_id"] == m.ARTIFACT
        assert images == {}
        other = copy.deepcopy(job)
        other["metadata"]["name"] = "genai-ready-other"
        with pytest.raises(ValueError):
            s.producer._job(other, images)


@pytest.mark.parametrize(
    "changed",
    [
        None,
        "attempt",
        "head",
        "status",
        "governance",
        "expired",
        "artifact",
        "digest",
        "upload",
        "gate",
        "replayed",
    ],
)
def test_original_job_source_requires_fresh_exact_attempt_and_immutable_archive(
    legacy, monkeypatch, changed
):
    s, m = legacy, legacy.module
    if changed == "attempt":
        s.run["run_attempt"] = 2
    elif changed == "head":
        s.run["head_sha"] = "e" * 40
    elif changed == "status":
        s.run["conclusion"] = "failure"
    elif changed == "governance":
        monkeypatch.setattr(s.authority, "governed_dispatch", lambda *_args: False)
    elif changed == "expired":
        s.artifact["expired"] = True
    elif changed == "artifact":
        s.artifact["id"] += 1
    elif changed == "digest":
        s.docs["prod-release-status.json"]["sha"] = "e" * 40
    elif changed == "upload":
        s.job["steps"][-1]["conclusion"] = "failure"
    elif changed == "gate":
        s.job["steps"][0]["conclusion"] = "skipped"
    elif changed == "replayed":
        s.changed = True
    if changed:
        with pytest.raises((ValueError, s.authority.retention.UnsafeState)):
            m.original_source()
    else:
        assert m.original_source()["artifact_digest"] == m.DIGEST
        assert s.reads.count(f"runs/{m.RUN}") == 2


@pytest.mark.parametrize(
    "changed", ["unhealthy", "source", "candidate", "image", "run", "provenance", "traffic"]
)
def test_original_source_documents_must_agree_independently_of_control_sha(legacy, changed):
    s, m = legacy, legacy.module
    release, image, candidate, provenance = s.docs.values()
    if changed == "unhealthy":
        release["status"] = "pending_activation"
    elif changed == "source":
        release["sha"] = m.HEAD
    elif changed == "candidate":
        release["final"]["backend_revision"] = "consent-protocol-other"
    elif changed == "image":
        candidate["status"]["imageDigest"] = "different"
    elif changed == "run":
        candidate["metadata"]["labels"]["github-run-id"] = "42"
    elif changed == "provenance":
        provenance["expected"]["HUSHH_DEPLOY_SHA"] = m.HEAD
    elif changed == "traffic":
        provenance["checked_revisions"][0]["traffic_percent"] = 0
    with pytest.raises(ValueError):
        m.qualify_documents(release, image, candidate, provenance)
