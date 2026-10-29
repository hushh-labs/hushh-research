# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Synthetic archive and live-observation fixtures for the WorkOS history owner."""

import copy
import hashlib
import importlib
import io
import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from zipfile import ZipFile

from .phone_rollback_release import PRIMARY


def restoration_observation(module):
    import restoration_workos_observation as historical

    source = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
    observation = {
        "row": {
            "revision": historical.REVISION,
            "source": source,
            "created_at": historical.CREATED,
            "capable": True,
            "direct_sso_false": True,
        },
        "history_start": module.HISTORY_START,
        "history_until": "2026-10-27T08:54:23.191934+00:00",
        "source_anchor": module.SOURCE_ANCHOR,
        "provenance": {"run_id": historical.RUN, "run_attempt": historical.ATTEMPT},
    }
    template = {
        "metadata": {"name": historical.REVISION, "labels": {"deploy-sha": source}},
        "spec": {"containers": [{"env": []}]},
    }
    event = {
        "resource": {"labels": {"service_name": module.SERVICE}},
        "timestamp": "2026-10-27T01:32:22.325803Z",
        "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity",
        "protoPayload": {
            "serviceName": "run.googleapis.com",
            "methodName": "/Services.ReplaceService",
            "request": {"service": {"spec": {"template": template}}},
        },
    }
    return historical, observation, event, template


def cold_anchor(module, source, report):
    anchor = {
        "origin": {
            "run_id": "42",
            "run_attempt": 2,
            "workflow_sha": PRIMARY,
            "artifact_id": 100,
            "artifact_digest": "sha256:" + "a" * 64,
        },
        "sealed_boundary": {
            "installed_schema": {
                "workos": report,
                "snapshot": {
                    "revisions": {
                        module.REVISION: {
                            "revision": module.REVISION,
                            "source": source,
                            "uid": "original-revision-uid",
                        }
                    },
                    "services": {"consent-protocol": {"uid": "original-service-uid"}},
                },
            }
        },
    }
    return anchor


def sealed_cold_case(monkeypatch):
    module = importlib.import_module("operational_workos_observation")
    producers = importlib.import_module("schema_producers")
    closed = producers.closed
    source = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
    row = {
        "revision": module.REVISION,
        "source": source,
        "created_at": module.CREATED,
        "capable": True,
        "direct_sso_false": True,
    }
    receipt = {
        "schema_version": 1,
        "qualification": "passed",
        "project": "hushh-pda",
        "region": "us-central1",
        "service": "consent-protocol",
        "scope": "workos427_closed_initial_rollout",
        "restoration_source": source,
        "history_start": closed.HISTORY_START,
        "source_anchor": closed.SOURCE_ANCHOR,
        "history_until": "2026-10-29T06:00:10Z",
        "captured_at": "2026-10-29T06:00:15.5Z",
        "audit_event_count": 13,
        "audit_truncated": False,
        "sso_activation_qualified": False,
        "revisions": [row],
        "database": {
            "memberships_empty": True,
            "sso_receipts_empty": True,
            "owned_proxy_exited": True,
        },
        "historical_observation": {"reused_revision_count": 1},
    }
    monkeypatch.setattr(closed, "qualify", lambda project: copy.deepcopy(receipt))
    # Execute the actual snapshot producer; a digest alone cannot preserve a row.
    report = producers.Runtime({}, "").workos()
    anchor = cold_anchor(module, source, report)
    job = {
        "steps": [
            {
                "name": "Qualify final cold installed-schema proof",
                "status": "completed",
                "conclusion": "success",
                "started_at": "2026-10-29T06:00:00Z",
                "completed_at": "2026-10-29T06:00:15Z",
            }
        ]
    }
    artifact = {"created_at": "2026-10-29T06:00:30Z"}
    return SimpleNamespace(
        module=module,
        closed=closed,
        anchor=anchor,
        source=source,
        report=report,
        job=job,
        artifact=artifact,
    )


def original_receipt_case(closed):
    module = closed
    historical, observation, _, _ = restoration_observation(module)
    source = observation["row"]["source"]
    run = {
        "id": historical.RUN,
        "run_attempt": historical.ATTEMPT,
        "head_sha": historical.WORKFLOW_SHA,
        "status": "completed",
        "conclusion": "success",
    }
    artifact = {
        "id": historical.ARTIFACT,
        "digest": historical.DIGEST,
        "created_at": "2026-10-27T08:57:05Z",
    }
    receipt = {
        "schema_version": 1,
        "qualification": "passed",
        "project": "hushh-pda",
        "region": module.REGION,
        "service": module.SERVICE,
        "captured_at": "2026-10-27T08:54:29.183142+00:00",
        "scope": "workos427_closed_initial_rollout",
        "history_start": module.HISTORY_START,
        "history_until": observation["history_until"],
        "source_anchor": module.SOURCE_ANCHOR,
        "restoration_source": source,
        "audit_event_count": 12,
        "audit_truncated": False,
        "revisions": [copy.deepcopy(observation["row"])],
        "database": {},
        "sso_activation_qualified": False,
    }
    step = {
        "name": "Verify restoration WorkOS remains closed",
        "status": "completed",
        "conclusion": "success",
        "started_at": "2026-10-27T08:54:22Z",
        "completed_at": "2026-10-27T08:54:29Z",
    }
    return SimpleNamespace(
        historical=historical,
        observation=observation,
        source=source,
        run=run,
        artifact=artifact,
        receipt=receipt,
        step=step,
    )


def original_ports(case, monkeypatch, defect):
    historical, source = case.historical, case.source
    run, artifact, receipt, step = case.run, case.artifact, case.receipt, case.step
    member = json.dumps(receipt).encode()
    monkeypatch.setattr(historical, "MEMBER_DIGEST", hashlib.sha256(member).hexdigest())
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as bundle:
        bundle.writestr(historical.MEMBER, member + (b" " if defect == "member" else b""))
        bundle.writestr("prod-release-status.json", json.dumps({"sha": source}))
    content = buffer.getvalue()

    def read(archive, name):
        with ZipFile(io.BytesIO(archive)) as bundle:
            return json.loads(bundle.read(name))

    owner = SimpleNamespace(phone=SimpleNamespace(_document=read), serving_reference=MagicMock())
    if defect == "authority":
        owner.serving_reference.side_effect = ValueError("unqualified_original_operation")
    continuation = SimpleNamespace(
        owner=owner,
        ports=lambda: {},
        manual=MagicMock(),
        archive=lambda *_: (artifact, {"steps": [step]}, content, {}),
        fresh_run=MagicMock(
            side_effect=[
                copy.deepcopy(run),
                {**run, "run_attempt": 3} if defect == "refresh" else copy.deepcopy(run),
            ]
        ),
    )
    monkeypatch.setattr(historical, "_authorities", lambda: None)
    monkeypatch.setattr(
        historical, "importlib", SimpleNamespace(import_module=lambda _: continuation)
    )
    return owner, continuation


def discovery_state(state, defect):
    module, anchor = state.module, state.anchor
    original_proof = importlib.import_module("production_backend_successor_proof")
    tag = {"commit": "c" * 40, "message": "healthy", "tag_oid": "d" * 40}
    cold_run = {"id": 42, "run_attempt": 3 if defect == "attempt" else 2, "head_sha": PRIMARY}
    healthy_run = {"id": 100, "run_attempt": 1, "head_sha": "c" * 40}
    release = {
        "status": "healthy",
        "sha": tag["commit"],
        "phone_rollback": {"revision": "cold"},
        "final": {"backend_revision": "current-backend", "frontend_revision": "current-frontend"},
    }
    artifact = {
        **state.artifact,
        "id": 100,
        "digest": anchor["origin"]["artifact_digest"],
        "expired": False,
    }
    job = {**state.job, "name": "Deploy Production Scope"}

    def api(repository, endpoint):
        assert repository == "hushh-labs/hushh-research"
        return {
            "runs/42": cold_run,
            "runs/100": healthy_run,
            "runs/42/attempts/2/jobs?per_page=100": {"total_count": 1, "jobs": [job]},
            "artifacts/100": artifact,
        }[endpoint]

    def find_release(*args, **kwargs):
        callback = kwargs.get("on_phone_rollback")
        if callback is not None:
            callback(
                {
                    "release_run_id": 100,
                    "run_attempt": 2 if defect == "discovery_attempt" else 1,
                    "artifact_id": 100,
                    "artifact_digest": artifact["digest"],
                }
            )
        return 100, release

    return SimpleNamespace(
        module=module,
        anchor=anchor,
        original_proof=original_proof,
        tag=tag,
        api=api,
        find_release=find_release,
        release=release,
        artifact=artifact,
        job=job,
    )


def discovery_ports(state, kind, defect, monkeypatch):
    case = discovery_state(state, defect)
    module, anchor, original_proof = case.module, case.anchor, case.original_proof
    tag, api, find_release = case.tag, case.api, case.find_release
    release, artifact, job = case.release, case.artifact, case.job
    owner = SimpleNamespace(
        uncached_api=api,
        governed_dispatch=lambda *_: True,
        _github_timestamp=lambda *_: None,
        retention=SimpleNamespace(run_command=MagicMock()),
        LANES={"production": {}},
        find_release=MagicMock(side_effect=find_release),
    )
    reference = SimpleNamespace(
        split=lambda *_: ("healthy", None),
        healthy_fields=lambda *_: {
            "run": "https://github.com/hushh-labs/hushh-research/actions/runs/100",
            **release["final"],
        },
    )
    proof = SimpleNamespace(
        read_original=MagicMock(
            side_effect=[tag, {**tag, "tag_oid": "e" * 40} if defect == "tag" else tag]
        ),
        reference=reference,
        load=MagicMock(return_value=anchor),
        digest=original_proof.digest,
    )
    control = SimpleNamespace(
        record_anchor=MagicMock(return_value=anchor if kind == "operational" else None)
    )
    if defect == "authority":
        (control.record_anchor if kind == "operational" else proof.load).side_effect = ValueError(
            "unqualified_archive"
        )
    documents = {
        "prod-release-status.json": release,
        "prod-activation-origin.json": {"cold_rollback": {"origin": anchor["origin"]}},
        "phone-rollback/workos-after.json": {
            "qualification": "passed",
            "operational_observation": {"origin": anchor["origin"]},
        },
    }
    continuation = SimpleNamespace(
        ORIGIN="prod-activation-origin.json",
        manual=MagicMock(),
        phone=SimpleNamespace(_document=lambda content, name: documents[name]),
        receipts=SimpleNamespace(
            current_attempt_artifact=MagicMock(return_value=(artifact, job)),
            immutable_archive=MagicMock(return_value=b"authenticated-archive-port"),
        ),
        archive_context=MagicMock(
            return_value={"status": "activated"} if kind == "activation" else None
        ),
    )
    modules = {
        "production_backend_successor_proof": proof,
        "production_backend_successor_control": control,
        "production_activation_continuation": continuation,
        "production_restoration_continuation": continuation,
    }
    monkeypatch.setattr(module, "_authorities", lambda: owner)
    monkeypatch.setattr(
        module, "importlib", SimpleNamespace(import_module=lambda name: modules[name])
    )
    return proof, owner, continuation
