"""Retained F capacity identity is synthetic here, never release acceptance."""

import base64
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "deploy/plg"), str(ROOT / "consent-protocol/tests")]
import frontend_fixture_retained as retained  # noqa: E402
import frontend_fixture_runtime as runtime  # noqa: E402
import frontend_hosted_caller as caller  # noqa: E402
import test_plg_frontend_build_evidence as builds  # noqa: E402
import test_plg_frontend_fixture as fixtures  # noqa: E402
import test_plg_frontend_fixture_github as github_fixtures  # noqa: E402


def _source_fixture(monkeypatch):
    args = builds.bind_fixture(builds.fixture(monkeypatch))
    attempt, prepared, recipe = args[:3]
    originals = {
        path: (ROOT / path).read_bytes().replace(b"\r\n", b"\n")
        for path in (*retained.release.AUTHORITY_PATHS, retained.release.WORKFLOWS["uat"])
    }
    prepared["authorityFiles"] = {
        path: hashlib.sha256(raw).hexdigest() for path, raw in originals.items()
    }
    prepared["authorityFiles"].pop("deploy/plg/frontend_fixture_retained.py")
    pair = prepared["backendPair"]
    pair.update(
        serviceUid="backend-uid",
        revisionUid="backend-revision-uid",
        revision="consent-protocol-plg-qual-q" + "a" * 12,
        serviceUrl="https://s-fixed-uc.a.run.app",
    )
    dockerfile = retained.release.source.backend._git(
        "show", retained.release.SOURCE + ":hushh-webapp/Dockerfile"
    )
    recipe, prepared["fixtureRuntime"] = runtime.bundle(
        attempt,
        pair,
        recipe,
        {path: originals[path] for path in runtime.SCRIPTS},
        prepared["authorityFiles"],
        dockerfile,
    )
    inventory = builds.fixtures.inventory("uat", fixture_backend=True)
    snapshot = {
        "environment": "uat",
        "project": attempt.project,
        "fixtureBackend": True,
        "inventory": inventory,
        "optionalLatestUnresolved": sorted(
            name for name, value in inventory.items() if value is None
        ),
        "snapshotAtomic": False,
        "buildConsumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
    return args, recipe, snapshot, originals, dockerfile


def _published_document(monkeypatch):
    args, recipe, snapshot, originals, dockerfile = _source_fixture(monkeypatch)
    attempt, prepared = args[:2]

    def git(*words):
        if words[0] == "merge-base":
            return b""
        ref, path = words[1].split(":", 1)
        if path == "hushh-webapp/Dockerfile":
            return dockerfile
        if ref == "origin/main" and path in retained.CAPACITY_ONLY_PATHS:
            return b"changed capacity-only current bytes"
        return originals[path]

    monkeypatch.setattr(retained.release.source.backend, "_git", git)
    recorded = frozenset(prepared["authorityFiles"])
    intent = caller.proposed_build_intent(
        attempt, prepared, snapshot, recipe, args[-2], args[-1], authority_paths=recorded
    )
    image = f"gcr.io/{attempt.project}/hushh-webapp@sha256:" + "b" * 64
    desired = runtime.service_document(
        attempt, image, snapshot["inventory"], prepared["fixtureRuntime"]
    )
    return {
        "kind": "plg-private-fixture-stage-intent-v1",
        "environment": "uat",
        "producer": {"runId": 123, "attempt": 2, "workflowSha": attempt.workflow_sha},
        "sourceSha": retained.release.SOURCE,
        "productionTrafficAuthorized": False,
        "prepared": prepared,
        "snapshot": snapshot,
        "recipeBase64": base64.b64encode(recipe).decode(),
        "buildIntent": intent,
        "buildEvidence": {"imageReference": image},
        "serviceDocument": desired,
        "previous": None,
    }, git


def _hosted(monkeypatch, tmp_path, document):
    client, payload = github_fixtures.fixture(monkeypatch, tmp_path)
    run = payload["runs/123/attempts/2"]
    actor = json.loads((ROOT / "config/ci-governance.json").read_bytes())["uat"][
        "manual_dispatch_users"
    ][0]
    run["actor"]["login"] = run["triggering_actor"]["login"] = actor
    job = payload["runs/123/attempts/2/jobs?per_page=100"]["jobs"][0]
    item = payload["runs/123/artifacts?per_page=100"]["artifacts"][0]
    step = job["steps"][0]
    step["name"] = retained.accepted.STAGE_UPLOAD
    item["name"] = "plg-fixture-stage-intent-uat-123-2"
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("stage-intent.json", json.dumps(document))
    raw = stream.getvalue()
    item.update(size_in_bytes=len(raw), digest="sha256:" + hashlib.sha256(raw).hexdigest())
    payload["artifacts/22/zip"] = raw
    return client, payload, run, job, item


def _read_fixture(monkeypatch, tmp_path):
    document, git = _published_document(monkeypatch)
    client, payload, run, job, item = _hosted(monkeypatch, tmp_path, document)
    # The hosted helper patches _git; restore the exact recorded-blob adapter.
    monkeypatch.setattr(retained.release.source.backend, "_git", git)
    native = fixtures.Native()
    native.project, native.gcloud = "hushh-pda-uat", object()
    fixtures.candidate.stage(
        native, document["serviceDocument"], checkpoint=lambda _: None, previous=None
    )
    import qualification_acceptance

    monkeypatch.setattr(
        qualification_acceptance,
        "verify",
        lambda *_a, **_k: pytest.fail("Retained F must not query old S acceptance"),
    )
    build_calls = []

    def verify_build(value, environment, *, cloud, recorded_authority):
        assert value == document and environment == "uat" and cloud is native.gcloud
        assert recorded_authority == frozenset(document["prepared"]["authorityFiles"])
        build_calls.append(True)

    monkeypatch.setattr(retained.accepted, "verify_build", verify_build)
    monkeypatch.setattr(
        retained.release.frontend_validation,
        "verify",
        lambda *_a, **_k: document["prepared"]["sourceValidation"],
    )
    return document, client, payload, native, build_calls, (run, job, item)


def test_capacity_only_history_uses_real_hosted_artifact_and_current_native_runtime(
    monkeypatch, tmp_path
):
    document, client, _payload, native, calls, _rows = _read_fixture(monkeypatch, tmp_path)
    result = retained.read("uat", 123, 2, github=client, cloud=native)
    assert calls == [True]
    assert result.image == document["buildEvidence"]["imageReference"]
    assert result.pin()["directCloudSqlConnections"] == 0
    assert result.pin()["releaseAccepted"] is False
    assert result.pin()["productionTrafficAuthorized"] is False
    result.service_document["spec"].clear()
    assert result.service_document == document["serviceDocument"]
    # Historical closure exception must never leak into ordinary producer admission.
    with pytest.raises(retained.release.Refused, match="prepared inputs"):
        retained.accepted.validate_intent(document, _rows[0], "uat")


def test_retained_reader_integrates_with_capacity_collector(monkeypatch, tmp_path):
    _document, client, _payload, native, _calls, _rows = _read_fixture(monkeypatch, tmp_path)
    sys.path.insert(0, str(ROOT / "scripts/ci"))
    import runtime_capacity_frontend as capacity

    history = SimpleNamespace(
        RetainedFrontendBinding=retained.RetainedFrontendBinding,
        candidate=retained.candidate,
        read=lambda env, run, attempt: retained.read(
            env, run, attempt, github=client, cloud=native
        ),
    )
    proof = capacity.verify(
        native.service(), list(native.revisions.values()), "uat", history, RuntimeError
    )
    assert proof["connections"] == 0
    assert proof["checked_revisions"] == list(native.revisions)
    assert proof["fixture_bindings"][0]["releaseAccepted"] is False


@pytest.mark.parametrize(
    "case",
    [
        "critical",
        "recorded_hash",
        "actor",
        "attempt",
        "job",
        "digest",
        "image",
        "env",
        "volume",
        "sql",
        "replacement",
    ],
)
def test_retained_reader_refuses_changed_source_hosted_identity_or_native_runtime(
    monkeypatch, tmp_path, case
):
    document, client, payload, native, _calls, (run, job, item) = _read_fixture(
        monkeypatch, tmp_path
    )
    if case in {"critical", "recorded_hash"}:
        old = retained.release.source.backend._git

        def changed(*words):
            if words == ("show", "origin/main:deploy/plg/frontend_release.py"):
                return b"changed critical producer"
            if case == "recorded_hash" and words == (
                "show",
                run["head_sha"] + ":deploy/plg/frontend_release.py",
            ):
                return b"wrong historical blob"
            return old(*words)

        monkeypatch.setattr(retained.release.source.backend, "_git", changed)
    elif case == "actor":
        run["triggering_actor"]["login"] = "outsider"
    elif case == "attempt":
        run["run_attempt"] = 3
    elif case == "job":
        job["run_id"] = 124
    elif case == "digest":
        item["digest"] = "sha256:" + "0" * 64
    else:
        revision = next(iter(native.revisions.values()))
        if case == "image":
            revision["spec"]["containers"][0]["image"] += "wrong"
        elif case == "env":
            revision["spec"]["containers"][0]["env"][0]["value"] = "wrong"
        elif case == "volume":
            revision["spec"]["volumes"] = [{"name": "sql"}]
        elif case == "sql":
            revision["metadata"]["annotations"]["run.googleapis.com/cloudsql-instances"] = (
                "unexpected"
            )
        elif case == "replacement":
            old_read = native.service
            reads = []

            def service(**kwargs):
                value = old_read(**kwargs)
                reads.append(True)
                if len(reads) > 1:
                    value["metadata"]["uid"] = "replacement"
                return value

            native.service = service
    with pytest.raises(retained.release.Refused):
        retained.read("uat", 123, 2, github=client, cloud=native)
