"""One-feed projection of the personal-agent provisioning lifecycle.

Hermetic: no DB, no network. The registry and grant are injected fakes and
``FeedService`` is monkeypatched at its module, so every assertion is about the
rows this service *would* write.

Three properties are load-bearing:

1. one feed row per state transition (reserved / provisioning / ready / failed);
2. FAIL-SAFE -- provisioning runs fire-and-forget off the phone-verify seam, so a
   feed-write failure must be swallowed, never propagated (a raised feed error
   there would be an invisible, unretried break of the user's agent setup);
3. flag-gated -- with ``PERSONAL_AGENT_ENABLED`` off nothing is emitted at all.
"""

from __future__ import annotations

import hashlib

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.personal_agent_provisioning_service import (
    FEED_EVENT_FAILED,
    FEED_EVENT_PROVISIONING,
    FEED_EVENT_READY,
    FEED_EVENT_RESERVED,
    FEED_REASON_INVALID_DETAILS,
    FEED_REASON_TEMPORARY,
    PersonalAgentProvisioningService,
    record_provisioning_feed_event_safe,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from tests import test_personal_agent_upgrade_authority as authority
from tests.personal_agent_registry_fake import ProvisionAdmissionFake

_UID = "firebase_uid_feed_test_123"
_PHONE = "+14255550188"
_FEED_MODULE = "hushh_mcp.services.feed_service.FeedService"


class FakeRegistry(ProvisionAdmissionFake):
    def __init__(self, *, upsert_raises: bool = False):
        self.upserts: list[dict] = []
        self.tombstones: list[dict] = []
        self.rows: dict[str, dict] = {}
        self._upsert_raises = upsert_raises

    async def upsert(self, **kw):
        if self._upsert_raises:
            raise RuntimeError("registry unavailable: dsn=postgres://secret@host/db")
        self.upserts.append(kw)
        self.rows[kw["user_id"]] = {"hushh_id": kw["hushh_id"], "external_agent_id": None}

    async def get(self, user_id):
        return self.rows.get(user_id)

    async def tombstone(self, **kw):
        self.tombstones.append(kw)

    async def delete(self, user_id):
        self.rows.pop(user_id, None)

    async def tombstone_exists(self, hushh_id):
        return False


class FakeGrant:
    def __init__(self, *, issue_raises: bool = False):
        self.calls: list[str] = []
        self._issue_raises = issue_raises

    async def issue_standing_pkm_read(self, user_id, *, ledger=None):
        if self._issue_raises:
            raise RuntimeError("mint failed: token=HCT:supersecret")
        self.calls.append(user_id)
        return {"token": "HCT:fake", "expiresAt": 9_999_999_999_999, "scope": "pkm.read"}

    async def revoke_standing_pkm_read(self, user_id, *, ledger=None):
        return {"revoked": True}


class RecordingFeedService:
    """Stand-in for the real FeedService; captures record_event kwargs."""

    events: list[dict] = []

    def record_event(self, **kw):
        RecordingFeedService.events.append(kw)


class RaisingFeedService:
    """Every feed write blows up -- proves the projection cannot break provisioning."""

    calls: int = 0

    def record_event(self, **kw):
        RaisingFeedService.calls += 1
        raise RuntimeError("feed_events insert failed")


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()
    RecordingFeedService.events = []
    RaisingFeedService.calls = 0
    yield
    get_core_security_settings.cache_clear()


@pytest.fixture
def feed(monkeypatch):
    monkeypatch.setattr(_FEED_MODULE, RecordingFeedService)
    return RecordingFeedService


def _pod_key():
    return generate_pod_keypair().public()


def _svc(registry=None, grant=None):
    return PersonalAgentProvisioningService(
        registry=registry or FakeRegistry(), grant=grant or FakeGrant()
    )


def _types(events: list[dict]) -> list[str]:
    return [event["event_type"] for event in events]


async def _provision(svc):
    pod = _pod_key()
    return await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )


# ---------------------------------------------------------------------------
# One event per state transition
# ---------------------------------------------------------------------------


async def test_register_pending_emits_reserved(feed):
    await _svc().register_pending(user_id=_UID, phone_e164=_PHONE)

    assert _types(feed.events) == [FEED_EVENT_RESERVED]
    event = feed.events[0]
    assert event["user_id"] == _UID
    # Presentation-only projection: feed_events.source_domain is CHECK-constrained
    # to the six allowlisted domains, and the row carries no sensitive holdings.
    assert event["source_domain"] == "consent"
    assert event["metadata"] == {}
    assert _PHONE not in str(event)


async def test_register_pending_on_existing_row_emits_nothing(feed):
    registry = FakeRegistry()
    registry.rows[_UID] = {"hushh_id": "ha1_existing", "status": "provisioned"}

    await _svc(registry=registry).register_pending(user_id=_UID, phone_e164=_PHONE)

    # No state transition -> no row: a re-fired phone-verify never replays the line.
    assert feed.events == []


async def test_provision_emits_provisioning_then_ready(feed):
    result = await _provision(_svc())

    assert result["status"] == "provisioned"
    assert _types(feed.events) == [FEED_EVENT_PROVISIONING, FEED_EVENT_READY]
    assert {event["user_id"] for event in feed.events} == {_UID}


async def test_full_lifecycle_emits_all_three_success_transitions(feed):
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)

    await svc.register_pending(user_id=_UID, phone_e164=_PHONE)
    await _provision(svc)

    assert _types(feed.events) == [
        FEED_EVENT_RESERVED,
        FEED_EVENT_PROVISIONING,
        FEED_EVENT_READY,
    ]


async def test_provision_failure_emits_failed_and_still_raises(feed):
    grant = FakeGrant(issue_raises=True)

    with pytest.raises(RuntimeError):
        await _provision(_svc(grant=grant))

    assert _types(feed.events) == [FEED_EVENT_PROVISIONING, FEED_EVENT_FAILED]
    failure = feed.events[-1]
    assert failure["metadata"] == {"reason": FEED_REASON_TEMPORARY}
    # No ready row was ever written for a provisioning run that never completed.
    assert FEED_EVENT_READY not in _types(feed.events)


async def test_register_pending_failure_emits_failed_and_still_raises(feed):
    with pytest.raises(RuntimeError):
        await _svc(registry=FakeRegistry(upsert_raises=True)).register_pending(
            user_id=_UID, phone_e164=_PHONE
        )

    assert _types(feed.events) == [FEED_EVENT_FAILED]
    assert feed.events[0]["metadata"] == {"reason": FEED_REASON_TEMPORARY}


async def test_bad_pod_key_emits_failed_with_invalid_details(feed):
    with pytest.raises(ValueError):
        await _svc().provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64="not-base64!!",
            pod_key_id="pod-1",
        )

    assert _types(feed.events) == [FEED_EVENT_FAILED]
    assert feed.events[0]["metadata"] == {"reason": FEED_REASON_INVALID_DETAILS}


# ---------------------------------------------------------------------------
# The failure row is user-safe: never a raw exception message or internal detail
# ---------------------------------------------------------------------------


async def test_failure_row_never_leaks_the_exception_message(feed):
    with pytest.raises(RuntimeError):
        await _provision(_svc(grant=FakeGrant(issue_raises=True)))

    failure = feed.events[-1]
    serialized = str(failure)
    for leaked in ("mint failed", "HCT:supersecret", "Traceback", "RuntimeError"):
        assert leaked not in serialized
    assert failure["metadata"]["reason"] in {FEED_REASON_TEMPORARY, FEED_REASON_INVALID_DETAILS}


async def test_registry_failure_row_never_leaks_connection_details(feed):
    with pytest.raises(RuntimeError):
        await _svc(registry=FakeRegistry(upsert_raises=True)).register_pending(
            user_id=_UID, phone_e164=_PHONE
        )

    serialized = str(feed.events[0])
    assert "postgres://" not in serialized
    assert "secret" not in serialized


# ---------------------------------------------------------------------------
# FAIL-SAFE: a feed-write failure never propagates
# ---------------------------------------------------------------------------


async def test_feed_write_failure_does_not_break_provisioning(monkeypatch):
    monkeypatch.setattr(_FEED_MODULE, RaisingFeedService)
    registry, grant = FakeRegistry(), FakeGrant()

    result = await _provision(PersonalAgentProvisioningService(registry=registry, grant=grant))

    # Every feed write raised, and provisioning completed anyway -- full result,
    # full registry ladder, standing read minted.
    assert RaisingFeedService.calls == 2
    assert result["status"] == "provisioned"
    assert registry.upserts[0]["status"] == "provisioning"
    assert registry.upserts[-1]["status"] == "provisioned"
    assert grant.calls == [_UID]


async def test_feed_write_failure_does_not_break_register_pending(monkeypatch):
    monkeypatch.setattr(_FEED_MODULE, RaisingFeedService)
    registry = FakeRegistry()

    result = await _svc(registry=registry).register_pending(user_id=_UID, phone_e164=_PHONE)

    assert RaisingFeedService.calls == 1
    assert result["status"] == "pending"
    assert [u["status"] for u in registry.upserts] == ["pending"]


async def test_feed_write_failure_does_not_mask_the_real_provisioning_error(monkeypatch):
    """A failing feed write on the failure path must not replace the real error."""
    monkeypatch.setattr(_FEED_MODULE, RaisingFeedService)

    with pytest.raises(RuntimeError, match="mint failed"):
        await _provision(_svc(grant=FakeGrant(issue_raises=True)))


async def test_feed_helper_swallows_any_writer_exception(monkeypatch):
    monkeypatch.setattr(_FEED_MODULE, RaisingFeedService)

    # No raise, no return value: the helper is a pure best-effort projection.
    assert (
        await record_provisioning_feed_event_safe(user_id=_UID, event_type=FEED_EVENT_READY)
    ) is None
    assert RaisingFeedService.calls == 1


async def test_feed_helper_ignores_unknown_event_types(feed):
    await record_provisioning_feed_event_safe(user_id=_UID, event_type="totally_made_up")
    assert feed.events == []


# ---------------------------------------------------------------------------
# Flag off: no events, no behaviour change
# ---------------------------------------------------------------------------


async def test_flag_off_emits_nothing_from_register_pending(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    get_core_security_settings.cache_clear()

    with pytest.raises(PersonalAgentDisabledError):
        await _svc().register_pending(user_id=_UID, phone_e164=_PHONE)

    assert feed.events == []


async def test_flag_off_emits_nothing_from_provision(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    get_core_security_settings.cache_clear()

    with pytest.raises(PersonalAgentDisabledError):
        await _provision(_svc())

    assert feed.events == []


async def test_flag_off_makes_the_feed_helper_inert(monkeypatch):
    monkeypatch.setattr(_FEED_MODULE, RaisingFeedService)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    get_core_security_settings.cache_clear()

    # Not even constructed: the writer import is deferred behind the flag check.
    await record_provisioning_feed_event_safe(user_id=_UID, event_type=FEED_EVENT_RESERVED)
    assert RaisingFeedService.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("completion", ["changed", "noop", "explicit_noop", "lost_publication"])
async def test_reconciled_update_projects_only_published_image_changes(monkeypatch, completion):
    from hushh_mcp.services import personal_agent_provisioning_service as pas

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED", "1")
    monkeypatch.setattr(pas, "resolve_user_cloud", lambda *args, **kwargs: authority._no_cloud())
    events = []

    class RecordingFeed:
        def record_event(self, **fields):
            events.append(fields)

    monkeypatch.setattr("hushh_mcp.services.feed_service.FeedService", RecordingFeed)
    lease = "persisted-lease"
    row = authority._row(
        approval=authority._approval(authority._row(), authority.OLD_IMAGE, status="blocked"),
        lease=lease,
    )
    if completion != "noop":
        row["backend_metadata"].update(
            source_image=authority.NEW_IMAGE,
            image=authority.NEW_IMAGE,
            image_digest=authority.NEW_DIGEST,
        )
    # The operation's approval is for the old target; current hub configuration has
    # moved on. Reconciliation must use the receipt's binding, never the new offer.
    row["backend_metadata"]["upgradeAcknowledgement"] = {
        "version": 1,
        "attemptId": hashlib.sha256(lease.encode()).hexdigest(),
        "serviceUid": authority.SERVICE_UID,
        "service": authority.SERVICE,
        "targetImage": authority.OLD_IMAGE,
        "image": authority.OLD_IMAGE,
        "operationId": row["backend_metadata"]["upgradeApproval"]["operationId"],
        "releaseId": row["backend_metadata"]["upgradeApproval"]["releaseId"],
        "podIncarnation": authority.SERVICE_UID,
    }
    registry = authority._RecoveryRegistry(row)
    if completion == "lost_publication":

        async def lost_publication(**fields):
            return False

        monkeypatch.setattr(registry, "record_image_upgrade", lost_publication)
    backend = authority._ObservingBackend(
        authority.BackendHandle(
            external_agent_id=authority.SERVICE,
            a2a_route="https://a2a.invalid/owner",
            status="live",
            backend="fake",
            backend_metadata={
                "image": authority.OLD_IMAGE,
                "image_digest": authority.OLD_DIGEST,
                # Real recovery adapters omit this flag. A same-image capability
                # restart must still be silent; explicit False also stays silent.
                **({"upgraded": False} if completion == "explicit_noop" else {}),
            },
        )
    )
    service = PersonalAgentProvisioningService(registry=registry, backend=backend)
    if completion == "lost_publication":
        with pytest.raises(RuntimeError, match="publication lost authority"):
            await service.upgrade_pod(user_id=authority.OWNER, current_image=authority.NEW_IMAGE)
        assert events == []
        return
    result = await service.upgrade_pod(user_id=authority.OWNER, current_image=authority.NEW_IMAGE)
    assert result["reconciled"] is True
    assert result["upgraded"] is True
    assert backend.observed
    assert registry.row["backend_metadata"]["upgradeApproval"]["status"] == "succeeded"
    assert "upgradeLease" not in registry.row["backend_metadata"]
    if completion == "changed":
        assert len(events) == 1
        assert events[0]["event_type"] == "personal_agent_updated"
        assert events[0]["source_row_id"] == "op-original"
        assert events[0]["metadata"] == {}
    else:
        assert events == []
