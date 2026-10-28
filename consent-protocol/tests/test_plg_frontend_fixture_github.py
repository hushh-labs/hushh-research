"""Hosted evidence tests are synthetic and never authorize cloud mutations."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
import frontend_fixture_github as hosted  # noqa: E402


def fixture(monkeypatch, tmp_path):
    (tmp_path / "config").mkdir()
    (tmp_path / "config/ci-governance.json").write_text(
        json.dumps(
            {env: {"manual_dispatch_users": ["operator"]} for env in ("dev", "uat", "production")}
        )
    )
    monkeypatch.setattr(hosted.validation, "ROOT", tmp_path)
    monkeypatch.setattr(hosted.validation.source.backend, "_git", lambda *args: b"reviewed")
    monkeypatch.setattr(hosted, "_reviewed_authority", lambda sha, workflow: None)
    doc = {"kind": "synthetic-fixture-intent"}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("intent.json", json.dumps(doc))
    raw = stream.getvalue()
    repo = hosted.validation.transport.REPOSITORY
    run = {
        "id": 123,
        "run_attempt": 2,
        "path": hosted.WORKFLOWS["uat"],
        "workflow_id": 99,
        "head_sha": "a" * 40,
        "head_branch": "main",
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "failure",
        "updated_at": "2026-10-28T00:02:00Z",
        "repository": {"full_name": repo, "id": hosted.REPOSITORY_ID},
        "head_repository": {"full_name": repo, "id": hosted.REPOSITORY_ID},
        "actor": {"login": "operator"},
        "triggering_actor": {"login": "operator"},
    }
    step = {
        "name": "Publish immutable fixture stage intent",
        "status": "completed",
        "conclusion": "success",
        "started_at": "2026-10-28T00:00:00Z",
        "completed_at": "2026-10-28T00:01:00Z",
    }
    job = {
        "name": "PLG Private Frontend Fixture",
        "head_sha": run["head_sha"],
        "run_id": 123,
        "run_attempt": 2,
        "status": "completed",
        "conclusion": "failure",
        "steps": [step],
    }
    item = {
        "name": "plg-frontend-uat-intent-123-2",
        "id": 22,
        "expired": False,
        "workflow_run": {"id": 123, "head_sha": run["head_sha"]},
        "size_in_bytes": len(raw),
        "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "created_at": "2026-10-28T00:00:30Z",
    }
    payload = {
        "runs/123/attempts/2": run,
        "workflows/plg-frontend-uat.yml": {"id": 99, "path": hosted.WORKFLOWS["uat"]},
        "runs/123/attempts/2/jobs?per_page=100": {"total_count": 1, "jobs": [job]},
        "runs/123/artifacts?per_page=100": {"total_count": 1, "artifacts": [item]},
        "artifacts/22/zip": raw,
    }

    class Fake:
        def read(self, path, **kwargs):
            if path.endswith("/zip"):
                assert kwargs == {"binary": True}
            return payload[path]

    return Fake(), payload


def read_intent(client):
    run, job = hosted._run(
        client,
        123,
        2,
        "PLG Private Frontend Fixture",
        {"Publish immutable fixture stage intent"},
        "uat",
        success=False,
    )
    return hosted._artifact(
        client,
        run,
        job,
        "plg-frontend-uat-intent",
        "Publish immutable fixture stage intent",
        "intent.json",
    )


def test_failed_attempt_can_publish_authenticated_intent(monkeypatch, tmp_path):
    client, _ = fixture(monkeypatch, tmp_path)
    item, document = read_intent(client)
    assert item["id"] == 22 and document == {"kind": "synthetic-fixture-intent"}


@pytest.mark.parametrize(
    "case",
    [
        "workflow",
        "actor",
        "attempt",
        "step",
        "artifact_digest",
        "artifact_sha",
        "artifact_expired",
        "cross_environment",
        "job_id",
        "duplicate_step",
        "pagination",
        "bad_time",
        "repository_id",
        "job_attempt",
        "environment_actor",
        "cross_workflow",
    ],
)
def test_untrusted_hosted_metadata_is_refused(monkeypatch, tmp_path, case):
    client, payload = fixture(monkeypatch, tmp_path)
    run = payload["runs/123/attempts/2"]
    job = payload["runs/123/attempts/2/jobs?per_page=100"]["jobs"][0]
    item = payload["runs/123/artifacts?per_page=100"]["artifacts"][0]
    if case == "workflow":
        run["workflow_id"] = 98
    if case == "actor":
        run["triggering_actor"]["login"] = "unknown"
    if case == "attempt":
        run["run_attempt"] = 1
    if case == "step":
        job["steps"][0]["conclusion"] = "failure"
    if case == "artifact_digest":
        item["digest"] = "sha256:" + "0" * 64
    if case == "artifact_sha":
        item["workflow_run"]["head_sha"] = "0" * 40
    if case == "artifact_expired":
        item["expired"] = True
    if case == "cross_environment":
        item["name"] = "plg-frontend-dev-intent-123-2"
    if case == "job_id":
        job["run_id"] = 124
    if case == "job_attempt":
        job["run_attempt"] = 1
    if case == "duplicate_step":
        job["steps"].append(dict(job["steps"][0]))
    if case == "pagination":
        payload["runs/123/artifacts?per_page=100"]["total_count"] = 2
    if case == "bad_time":
        item["created_at"] = "not-a-time"
    if case == "repository_id":
        run["head_repository"]["id"] += 1
    if case == "environment_actor":
        (tmp_path / "config/ci-governance.json").write_text(
            json.dumps(
                {
                    "uat": {"manual_dispatch_users": ["different"]},
                    "production": {"manual_dispatch_users": ["operator"]},
                }
            )
        )
    if case == "cross_workflow":
        run["path"] = ".github/workflows/other.yml"
    with pytest.raises(hosted.Refused):
        read_intent(client)


@pytest.mark.parametrize("kind", ["traversal", "duplicate_json", "symlink", "bad_zip"])
def test_hosted_reader_rejects_untrusted_archive(monkeypatch, tmp_path, kind):
    client, payload = fixture(monkeypatch, tmp_path)
    item = payload["runs/123/artifacts?per_page=100"]["artifacts"][0]
    stream = io.BytesIO()
    if kind == "bad_zip":
        raw = b"not a zip"
    else:
        with zipfile.ZipFile(stream, "w") as archive:
            name = "../intent.json" if kind == "traversal" else "intent.json"
            info = zipfile.ZipInfo(name)
            if kind == "symlink":
                info.create_system = 3
                info.external_attr = 0o120777 << 16
            archive.writestr(info, '{"key": 1, "key": 2}' if kind == "duplicate_json" else "{}")
        raw = stream.getvalue()
    item.update(size_in_bytes=len(raw), digest="sha256:" + hashlib.sha256(raw).hexdigest())
    payload["artifacts/22/zip"] = raw
    with pytest.raises(hosted.Refused):
        read_intent(client)


def test_authority_rejects_main_or_checkout_drift(monkeypatch, tmp_path):
    source = tmp_path / "authority.txt"
    source.write_bytes(b"reviewed")
    monkeypatch.setattr(hosted.validation, "ROOT", tmp_path)
    monkeypatch.setattr(hosted, "AUTHORITY", ())
    monkeypatch.setattr(hosted.validation.source.backend, "_git", lambda *args: b"reviewed")
    hosted._reviewed_authority("a" * 40, "authority.txt")
    source.write_bytes(b"changed")
    with pytest.raises(hosted.Refused):
        hosted._reviewed_authority("a" * 40, "authority.txt")
