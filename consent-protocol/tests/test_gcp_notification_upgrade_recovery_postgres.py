"""Owner-scoped notification recovery keeps its evidence under real registry CAS."""

from __future__ import annotations

import copy
from datetime import datetime, timezone

import pytest

from hushh_mcp.services.gcp_notification_upgrade_recovery import (
    FAILED_EXECUTOR_SOURCE_SHA,
    REVIEW_EVIDENCE_SHA256,
    REVIEWED_EXECUTOR_REVISION,
    REVIEWED_TARGET_IMAGE,
    NotificationUpgradeRecoveryRefused,
    qualify_candidate,
    recover_blocked_upgrade,
    verify_failed_event,
    verify_native_predecessor,
    verify_released_handoff,
)
from hushh_mcp.services.personal_agent_provisioning_service import upgrade_release_id
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from tests import standby_postgres_support as support
from tests.pkm_conformance.postgres_harness import find_pg_bin

_OWNER = support.OWNER
_HUSHH_ID = support.HUSHH_ID
_SERVICE_UID = "synthetic-native-incarnation"
_SERVICE = f"svc-{_OWNER}"
_OLD_DIGEST = "sha256:" + "a" * 64
_OLD_NATIVE_IMAGE = "us-central1-docker.pkg.dev/owner-project/pod@" + _OLD_DIGEST
_OLD_TARGET_IMAGE = "gcr.io/hushh-pda-dev/pod@" + _OLD_DIGEST
_OPERATION = "synthetic-current-operation"
_LEASE = f"2026-11-01T13:12:51+00:00|{'1' * 32}|{REVIEWED_TARGET_IMAGE}"
_ATTEMPTED_AT = "2026-11-01T13:12:52.098232+00:00"
_NOW = datetime(2026, 11, 1, 13, 30, tzinfo=timezone.utc)
_IDLE = {"seq": 68, "sha": "c" * 64}
_RELEASE = {"seq": 69, "sha": "d" * 64}


@pytest.fixture(scope="module")
def server():
    yield from support.start_server()


@pytest.fixture
def pg(server):
    return support.reset(server)


@pytest.fixture
def engine(pg):
    from sqlalchemy import create_engine

    engine = create_engine(
        f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}", future=True
    )
    try:
        yield engine
    finally:
        engine.dispose()


def _owner_row() -> tuple[dict, dict, dict]:
    from hushh_mcp.services.personal_agent_feed import FEED_REASON_TEMPORARY
    from hushh_mcp.services.pod_release import image_digest

    metadata = {
        "serviceUid": _SERVICE_UID,
        "service": _SERVICE,
        "url": f"https://{_SERVICE}.run.app",
        "source_image": _OLD_TARGET_IMAGE,
        "image": _OLD_NATIVE_IMAGE,
        "image_digest": _OLD_DIGEST,
        "upgradeLease": _LEASE,
        "upgrade": {
            "outcome": "unresolved",
            "attempts": 1,
            "failedImage": REVIEWED_TARGET_IMAGE,
            "lastAttemptAt": _ATTEMPTED_AT,
            "lastError": FEED_REASON_TEMPORARY,
        },
        "upgradeAcknowledgement": {
            "version": 1,
            "service": _SERVICE,
            "serviceUid": _SERVICE_UID,
            "generation": 22,
            "attemptId": "e" * 64,
            "image": _OLD_NATIVE_IMAGE,
            "targetImage": _OLD_TARGET_IMAGE,
            "targetDigest": _OLD_DIGEST,
            "hubRevision": "consent-protocol-00061-9p2",
            "operationId": "synthetic-previous-operation",
            "releaseId": "synthetic-previous-release",
            "podIncarnation": _SERVICE_UID,
            "outcome": "ready",
        },
        "notificationCheckpoint": {
            "version": 1,
            "phase": "observed",
            "attemptId": "f" * 64,
            "operationId": "synthetic-previous-operation",
        },
        "substrateReceipt": {"owner": _OWNER, "receipt": "preserved"},
    }
    row = {
        "user_id": _OWNER,
        "hushh_id": _HUSHH_ID,
        "external_agent_id": _SERVICE,
        "status": "provisioned",
        "deployment_target": "user_gcp",
        "backend_metadata": metadata,
    }
    metadata["upgradeAcknowledgement"]["releaseId"] = upgrade_release_id(row, _OLD_TARGET_IMAGE)
    approval = {
        "version": 1,
        "status": "blocked",
        "operationState": "blocked",
        "presentationPhase": "blocked",
        "releaseId": upgrade_release_id(row, REVIEWED_TARGET_IMAGE),
        "operationId": _OPERATION,
        "idempotencyKey": "synthetic-current-idempotency",
        "ownerId": _OWNER,
        "hushhId": _HUSHH_ID,
        "podIncarnation": _SERVICE_UID,
        "targetImage": REVIEWED_TARGET_IMAGE,
        "handoffIdleRecord": copy.deepcopy(_IDLE),
    }
    metadata["upgradeApproval"] = approval
    assert image_digest(_OLD_TARGET_IMAGE) == image_digest(_OLD_NATIVE_IMAGE)
    assert image_digest(REVIEWED_TARGET_IMAGE) != image_digest(_OLD_NATIVE_IMAGE)
    return row, metadata, approval


def _native_service() -> dict:
    revision = f"{_SERVICE}-00022-nzx"
    return {
        "metadata": {
            "name": _SERVICE,
            "uid": _SERVICE_UID,
            "generation": 22,
            "resourceVersion": "rv-22",
        },
        "spec": {
            "template": {
                "metadata": {"annotations": {"hussh/restart-nonce": "e" * 64}},
                "spec": {"containers": [{"image": _OLD_NATIVE_IMAGE}]},
            }
        },
        "status": {
            "url": f"https://{_SERVICE}.run.app",
            "observedGeneration": 22,
            "latestReadyRevisionName": revision,
            "latestCreatedRevisionName": revision,
            "conditions": [{"type": "Ready", "status": "True"}],
            "traffic": [{"revisionName": revision, "percent": 100}],
        },
    }


def _handoff_snapshot() -> dict:
    revision = f"{_SERVICE}-00022-nzx"
    return {
        "info": {"hushhId": _HUSHH_ID, "revision": revision},
        "status": {
            "incarnation": revision,
            "state": "accepting",
            "operationId": None,
            "activeWork": 0,
            "runtimeEpoch": "runtime-after-restart",
            "releaseReceipt": {
                "operationId": _OPERATION,
                "incarnation": revision,
                "runtimeEpoch": "sealed-release-epoch",
                "expectedIdleRecord": None,
                "retainedIdleRecord": copy.deepcopy(_IDLE),
                "releaseRecord": copy.deepcopy(_RELEASE),
            },
        },
    }


async def _rearm(pg, engine, repo, *, observed: dict, execute=True, race_writer=False) -> dict:
    from sqlalchemy import text

    failure_at = datetime.fromisoformat(_ATTEMPTED_AT)

    async def event_reader(candidate):
        with engine.begin() as connection:
            result = connection.execute(
                text(
                    "SELECT user_id,hushh_id,seq,attempt,event,stage,registry_status,"
                    "occurred_at,reason FROM pod_lifecycle_events WHERE user_id=:user_id "
                    "AND hushh_id=:hushh_id AND occurred_at>=:attempted_at "
                    "ORDER BY occurred_at DESC,seq DESC LIMIT 64"
                ),
                {
                    "user_id": candidate.user_id,
                    "hushh_id": candidate.hushh_id,
                    "attempted_at": failure_at,
                },
            )
            return [dict(row._mapping) for row in result]

    async def native_reader(_candidate):
        return _native_service()

    async def handoff_reader(_candidate, _native):
        return _handoff_snapshot()

    async def notification_validator():
        return None

    async def writer(**fields):
        if race_writer:
            pg.execute(
                "UPDATE personal_agent_registry SET backend_metadata = "
                'backend_metadata || \'{"raceWitness":"concurrent"}\'::jsonb '
                "WHERE user_id=%s",
                (_OWNER,),
            )
        return await repo.record_image_upgrade(**fields)

    result = await recover_blocked_upgrade(
        user_id=_OWNER,
        row=observed,
        target_image=REVIEWED_TARGET_IMAGE,
        running_hub_source="9" * 40,
        reviewed_operation_id=_OPERATION,
        reviewed_executor_revision=REVIEWED_EXECUTOR_REVISION,
        review_evidence_sha256=REVIEW_EVIDENCE_SHA256,
        event_reader=event_reader,
        native_reader=native_reader,
        handoff_reader=handoff_reader,
        notification_validator=notification_validator,
        writer=writer,
        execute=execute,
        now=_NOW,
    )
    return result


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
@pytest.mark.asyncio
async def test_recovery_rearms_same_approval_with_real_guarded_registry_cas(pg, engine):
    from db.db_client import DatabaseClient

    _row, metadata, approval = _owner_row()
    metadata["upgradeAcknowledgement"]["hubRevision"] = ""
    support.seed_primary(pg, metadata=metadata)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_OWNER)
    assert observed is not None
    before = copy.deepcopy(observed["backend_metadata"])
    pg.execute(
        "INSERT INTO pod_lifecycle_events(user_id,seq,hushh_id,attempt,event,stage,"
        "registry_status,reason,occurred_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            _OWNER,
            71,
            _HUSHH_ID,
            1,
            "upgrade_failed",
            "authority_live",
            "provisioned",
            metadata["upgrade"]["lastError"],
            datetime.fromisoformat("2026-11-01T13:12:52.141889+00:00"),
        ),
    )
    dry_run = await _rearm(pg, engine, repo, observed=observed, execute=False)
    assert dry_run == {"status": "dry_run", "operationId": _OPERATION}
    assert (await repo.get(_OWNER))["backend_metadata"] == before

    # A concurrent metadata update must make the exact recovery snapshot lose CAS.
    with pytest.raises(NotificationUpgradeRecoveryRefused, match="compare-and-swap"):
        await _rearm(pg, engine, repo, observed=observed, race_writer=True)
    raced = await repo.get(_OWNER)
    assert raced is not None
    assert raced["backend_metadata"]["upgradeLease"] == _LEASE
    assert raced["backend_metadata"]["upgradeApproval"] == approval
    assert raced["backend_metadata"]["raceWitness"] == "concurrent"

    # A fresh owner row can publish the same approved operation, preserving the old proof.
    result = await _rearm(pg, engine, repo, observed=raced)
    assert result == {"status": "scheduled", "operationId": _OPERATION}
    recovered = await repo.get(_OWNER)
    assert recovered is not None
    actual = recovered["backend_metadata"]
    assert "upgradeLease" not in actual
    assert actual["upgradeApproval"] == {
        **approval,
        "status": "scheduled",
        "operationState": "scheduled",
        "presentationPhase": "scheduled",
    }
    assert actual["upgrade"] == before["upgrade"]
    assert actual["upgradeAcknowledgement"] == before["upgradeAcknowledgement"]
    assert actual["notificationCheckpoint"] == before["notificationCheckpoint"]
    assert actual["substrateReceipt"] == before["substrateReceipt"]
    assert actual["raceWitness"] == "concurrent"
    recovery = actual["upgradeRecovery"]
    assert recovery["failedExecutorSource"] == "351d975545b490769fa28bc2ebff6cc61f9ddd37"
    assert recovery["operationId"] == _OPERATION
    assert recovery["previousAckHubRevision"] is None
    assert recovery["operator_verified_source_provenance"]["provenance"] == (
        "operator_declared_preserved_public_evidence"
    )


def _candidate():
    row, _, _ = _owner_row()
    return qualify_candidate(
        row,
        user_id=_OWNER,
        target_image=REVIEWED_TARGET_IMAGE,
        running_hub_source="9" * 40,
        reviewed_operation_id=_OPERATION,
        reviewed_executor_revision=REVIEWED_EXECUTOR_REVISION,
        review_evidence_sha256=REVIEW_EVIDENCE_SHA256,
        now=_NOW,
    )


@pytest.mark.parametrize("legacy_revision", [None, ""])
def test_legacy_ack_without_hub_revision_still_requires_native_predecessor(legacy_revision):
    row, metadata, _ = _owner_row()
    acknowledgement = metadata["upgradeAcknowledgement"]
    if legacy_revision is None:
        acknowledgement.pop("hubRevision")
    else:
        acknowledgement["hubRevision"] = legacy_revision

    candidate = qualify_candidate(
        row,
        user_id=_OWNER,
        target_image=REVIEWED_TARGET_IMAGE,
        running_hub_source="9" * 40,
        reviewed_operation_id=_OPERATION,
        reviewed_executor_revision=REVIEWED_EXECUTOR_REVISION,
        review_evidence_sha256=REVIEW_EVIDENCE_SHA256,
        now=_NOW,
    )
    receipt = verify_native_predecessor(_native_service(), candidate)
    assert receipt["serviceUid"] == _SERVICE_UID
    assert receipt["generation"] == 22
    assert receipt["attemptId"] == acknowledgement["attemptId"]


def _failure_event(candidate):
    from hushh_mcp.services.personal_agent_feed import FEED_REASON_TEMPORARY

    return {
        "user_id": candidate.user_id,
        "hushh_id": candidate.hushh_id,
        "seq": 71,
        "attempt": 1,
        "event": "upgrade_failed",
        "stage": "authority_live",
        "registry_status": "provisioned",
        "occurred_at": "2026-11-01T13:12:52.141889+00:00",
        "reason": FEED_REASON_TEMPORARY,
    }


def test_current_notification_intent_or_wrong_review_pin_refuses_candidate():
    row, metadata, _ = _owner_row()
    metadata["notificationCheckpoint"]["phase"] = "intent"
    with pytest.raises(NotificationUpgradeRecoveryRefused, match="checkpoint"):
        qualify_candidate(
            row,
            user_id=_OWNER,
            target_image=REVIEWED_TARGET_IMAGE,
            running_hub_source="9" * 40,
            reviewed_operation_id=_OPERATION,
            reviewed_executor_revision=REVIEWED_EXECUTOR_REVISION,
            review_evidence_sha256=REVIEW_EVIDENCE_SHA256,
            now=_NOW,
        )

    with pytest.raises(NotificationUpgradeRecoveryRefused, match="source"):
        row, _, _ = _owner_row()
        qualify_candidate(
            row,
            user_id=_OWNER,
            target_image=REVIEWED_TARGET_IMAGE,
            running_hub_source=FAILED_EXECUTOR_SOURCE_SHA,
            reviewed_operation_id=_OPERATION,
            reviewed_executor_revision=REVIEWED_EXECUTOR_REVISION,
            review_evidence_sha256=REVIEW_EVIDENCE_SHA256,
            now=_NOW,
        )


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("notificationCheckpoint", [], "notification checkpoint receipt is malformed"),
        ("filesUpgradeCheckpoint", [], "provider receipt is malformed"),
        ("browserUpgradeCheckpoint", [], "provider receipt is malformed"),
        ("browserUpdateCheckpoint", [], "provider receipt is malformed"),
    ],
)
def test_malformed_non_null_attempt_receipts_refuse_candidate(key, value, message):
    row, metadata, _ = _owner_row()
    metadata[key] = value

    with pytest.raises(NotificationUpgradeRecoveryRefused, match=message):
        qualify_candidate(
            row,
            user_id=_OWNER,
            target_image=REVIEWED_TARGET_IMAGE,
            running_hub_source="9" * 40,
            reviewed_operation_id=_OPERATION,
            reviewed_executor_revision=REVIEWED_EXECUTOR_REVISION,
            review_evidence_sha256=REVIEW_EVIDENCE_SHA256,
            now=_NOW,
        )


@pytest.mark.parametrize("changed", ["generation", "restart_nonce"])
def test_native_predecessor_refuses_a_newer_generation_or_nonce(changed):
    candidate = _candidate()
    service = _native_service()
    if changed == "generation":
        service["metadata"]["generation"] = 23
        service["status"]["observedGeneration"] = 23
    else:
        service["spec"]["template"]["metadata"]["annotations"]["hussh/restart-nonce"] = "0" * 64
    with pytest.raises(NotificationUpgradeRecoveryRefused):
        verify_native_predecessor(service, candidate)


@pytest.mark.parametrize("changed", ["wrong_operation", "missing_idle_cursor"])
def test_handoff_requires_the_current_release_and_prior_idle_cursor(changed):
    candidate = _candidate()
    native = verify_native_predecessor(_native_service(), candidate)
    snapshot = _handoff_snapshot()
    if changed == "wrong_operation":
        snapshot["status"]["releaseReceipt"]["operationId"] = "another-operation"
    else:
        snapshot["status"]["releaseReceipt"]["retainedIdleRecord"] = None
    with pytest.raises(NotificationUpgradeRecoveryRefused):
        verify_released_handoff(snapshot, candidate, native)


@pytest.mark.parametrize("events", [[], [{"user_id": "another-owner"}]])
def test_failure_event_must_bind_the_same_owner_and_failed_attempt(events):
    candidate = _candidate()
    if events:
        events[0] = {**_failure_event(candidate), **events[0]}
    with pytest.raises(NotificationUpgradeRecoveryRefused):
        verify_failed_event(events, candidate)
