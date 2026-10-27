"""Reject incomplete, stale, or untrusted hosted frontend validation evidence."""

import copy
import hashlib
import importlib.util
import io
import json
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "frontend_validation", ROOT / "deploy/plg/frontend_validation.py"
)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def run():
    return {
        "id": 10,
        "path": v.WORKFLOW,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "display_title": v.TITLE,
        "repository": {"full_name": v.REPOSITORY, "id": 8},
        "head_repository": {"full_name": v.REPOSITORY, "id": 8},
        "workflow_id": 7,
        "run_attempt": 1,
        "head_sha": "a" * 40,
        "actor": {"login": "owner"},
        "triggering_actor": {"login": "owner"},
        "status": "completed",
        "conclusion": "success",
        "updated_at": "2026-10-28T00:00:00Z",
    }


def report():
    return {
        "schemaVersion": 1,
        "sourceSha": v.source.SOURCE_SHA,
        "back": {"files": 16, "passed": 494, "failed": 0, "pending": 0},
        "privacy": {"files": 4, "passed": 119, "failed": 0, "pending": 0},
    }


def jobs(r):
    return {
        "total_count": len(v.JOB_STEPS),
        "jobs": [
            {
                "name": name,
                "run_id": r["id"],
                "head_sha": r["head_sha"],
                "status": "completed",
                "conclusion": "success",
                "steps": [
                    {"name": step, "status": "completed", "conclusion": "success"} for step in steps
                ],
            }
            for name, steps in v.JOB_STEPS.items()
        ],
    }


def test_governed_exact_run():
    v.qualify_run(run(), {"id": 7, "path": v.WORKFLOW}, 10, {"owner"})


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", True),
        ("path", "other"),
        ("event", "push"),
        ("head_branch", "other"),
        ("display_title", "other"),
        ("workflow_id", True),
        ("run_attempt", True),
        ("head_sha", "bad"),
        ("actor", {"login": "other"}),
        ("triggering_actor", {"login": "other"}),
        ("status", "in_progress"),
        ("conclusion", "failure"),
        ("head_repository", {"full_name": v.REPOSITORY, "id": 9}),
    ],
)
def test_bad_run_refused(field, value):
    r = run()
    r[field] = value
    with pytest.raises(v.Refused):
        v.qualify_run(r, {"id": 7, "path": v.WORKFLOW}, 10, {"owner"})


def test_required_jobs_and_steps():
    r = run()
    inventory = jobs(r)
    v.qualify_jobs(inventory, r)
    for mutation in ("missing", "duplicate", "skipped", "wrong_sha"):
        bad = copy.deepcopy(inventory)
        if mutation == "missing":
            bad["jobs"][0]["steps"].pop()
        elif mutation == "duplicate":
            bad["jobs"][0]["steps"].append(copy.deepcopy(bad["jobs"][0]["steps"][0]))
        elif mutation == "skipped":
            bad["jobs"][0]["steps"][0]["conclusion"] = "skipped"
        else:
            bad["jobs"][0]["head_sha"] = "b" * 40
        with pytest.raises(v.Refused):
            v.qualify_jobs(bad, r)


def test_exact_report_and_types():
    v.qualify_test_report(report(), v.source.SOURCE_SHA)
    for key, value in [("passed", 493), ("pending", 1), ("failed", False)]:
        bad = report()
        bad["back"][key] = value
        with pytest.raises(v.Refused):
            v.qualify_test_report(bad, v.source.SOURCE_SHA)
    bad = report()
    bad["sourceSha"] = "0" * 40
    with pytest.raises(v.Refused):
        v.qualify_test_report(bad, v.source.SOURCE_SHA)
    assert not v._same_json({"authorized": False}, {"authorized": 0})


def test_paginated_inventory_is_complete_and_stable():
    rows = [{"id": n} for n in range(1, 102)]

    def read(path):
        return {
            "total_count": 101,
            "workflow_runs": rows[:100] if path.endswith("page=1") else rows[100:],
        }

    assert v._inventory(read, "runs?branch=main") == rows
    with pytest.raises(v.Refused):
        v._inventory(lambda path: {"total_count": 2001, "workflow_runs": []}, "runs?branch=main")
    with pytest.raises(v.Refused):
        v._inventory(
            lambda path: {"total_count": 2, "workflow_runs": [{"id": 1}, {"id": 1}]},
            "runs?branch=main",
        )

    def unstable(path):
        return {
            "total_count": 101 if path.endswith("page=1") else 102,
            "workflow_runs": rows[:100] if path.endswith("page=1") else rows[100:],
        }

    with pytest.raises(v.Refused):
        v._inventory(unstable, "runs?branch=main")


def security_worker(id, status="completed", conclusion="success", updated="2026-10-28T00:00:00Z"):
    return {
        "id": id,
        "run_attempt": 1,
        "head_sha": "a" * 40,
        "status": status,
        "conclusion": conclusion,
        "updated_at": updated,
        "display_title": f"Security alerts for 11 / 1 / {v.source.SOURCE_SHA}",
    }


def test_security_requires_latest_exact_success(monkeypatch):
    rows = [security_worker(1)]

    class Client:
        def read(self, path):
            if "/runs?" in path:
                return {"total_count": len(rows), "workflow_runs": rows}
            return {"id": 7}

    monkeypatch.setattr(v.security_authority, "verify_source", lambda *a: {"source": "verified"})
    monkeypatch.setattr(v.security_receipt, "consume", lambda *a: {"result": "passed"})
    client = Client()
    assert v.verify_security(11, 1, v.source.SOURCE_SHA, client)["source"]["run_id"] == 11
    with pytest.raises(v.Refused):
        v.verify_security(11, 1, "0" * 40, client)
    rows.append(security_worker(2, "queued", None, "2026-10-28T00:01:00Z"))
    with pytest.raises(v.Refused):
        v.verify_security(11, 1, v.source.SOURCE_SHA, client)


def artifact(item_id, prefix, value, r):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("acceptance.json", json.dumps(value))
    raw = buffer.getvalue()
    metadata = {
        "id": item_id,
        "name": f"{prefix}-{r['id']}-{r['run_attempt']}",
        "expired": False,
        "workflow_run": {"id": r["id"]},
        "size_in_bytes": len(raw),
        "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
    }
    return metadata, raw


def test_consumer_checks_real_artifact_integrity_and_latest_run(monkeypatch):
    r = run()
    admitted = {
        "sourceSha": v.source.SOURCE_SHA,
        "baselineSha": "b" * 40,
        "recordSha256": "c" * 64,
        "backendRecordSha256": "d" * 64,
        "authorityFiles": {},
        "security": {"source": {"run_id": 11, "attempt": 1, "head_sha": v.source.SOURCE_SHA}},
        "sourceQualified": True,
        "trafficAuthorized": False,
        "environmentAccepted": False,
        "customerSendingAuthorized": False,
    }
    ai, ab = artifact(21, "plg-frontend-admission", admitted, r)
    ti, tb = artifact(22, "plg-frontend-tests", report(), r)
    fi, fb = artifact(
        23, "plg-frontend-source-validation", v._receipt(r, admitted, ai, ti, report()), r
    )
    inventory = {"total_count": 3, "artifacts": [ai, ti, fi]}
    runs = [r]

    class Client:
        cache = {}

        def read(self, path, binary=False):
            if path.startswith("workflows/") and "/runs?" in path:
                return {"total_count": len(runs), "workflow_runs": runs}
            if path.startswith("workflows/"):
                return {"id": 7, "path": v.WORKFLOW}
            if path == "runs/10":
                return r
            if "/jobs?" in path:
                return jobs(r)
            if "/artifacts?" in path:
                return inventory
            return {21: ab, 22: tb, 23: fb}[int(path.split("/")[1])]

    monkeypatch.setattr(v, "_allowed_actors", lambda: {"owner"})
    monkeypatch.setattr(v, "admission", lambda *a, **kw: admitted)
    monkeypatch.setattr(v, "qualify_definition", lambda *a: None)
    client = Client()
    result = v.verify(10, v.source.SOURCE_SHA, client)
    assert result["status"] == "validated" and result["trafficAuthorized"] is False
    original_digest = fi["digest"]
    fi["digest"] = "sha256:" + "0" * 64
    with pytest.raises(v.transport.Refused):
        v.verify(10, v.source.SOURCE_SHA, client)
    fi["digest"] = original_digest
    newer = copy.deepcopy(r)
    newer.update(id=11, status="queued", conclusion=None, updated_at="2026-10-28T00:01:00Z")
    runs.append(newer)
    with pytest.raises(v.Refused):
        v.verify(10, v.source.SOURCE_SHA, client)


def test_workflow_separates_untrusted_build_from_authority():
    import yaml

    document = yaml.safe_load((ROOT / v.WORKFLOW).read_text(encoding="utf-8"))
    assert set(document["jobs"]) == {"admit", "frontend", "gate"}
    for job in document["jobs"].values():
        assert {step["name"] for step in job["steps"]} == v.JOB_STEPS[job["name"]]
    candidate = document["jobs"]["frontend"]
    assert candidate["needs"] == ["admit"]
    assert all("GH_TOKEN" not in step.get("env", {}) for step in candidate["steps"])
    checkout = candidate["steps"][0]
    assert checkout["with"]["path"] == "source"
    assert checkout["with"]["persist-credentials"] is False
    assert "web-core-check.sh" in next(
        step["run"] for step in candidate["steps"] if step["name"] == "Run canonical web core"
    )
    gate = document["jobs"]["gate"]
    assert set(gate["needs"]) == {"admit", "frontend"}
    assert gate["steps"][0]["with"]["path"] == "authority"
    assert gate["steps"][0]["with"]["persist-credentials"] is False
