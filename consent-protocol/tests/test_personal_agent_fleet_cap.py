"""The personal-agent fleet ceiling (DEV-LIVE-EXECUTION-PLAN.md B3).

Every signed-in user gets a pod and a pod is a billable host, so the ONLY thing
standing between a test loop and a runaway bill is this cap. Hermetic: no DB, no
network, no cloud call — the registry, the grant and the compute backend are all
injected fakes, so every assertion is about what provisioning *would* do.

Four properties are load-bearing:

1. at the ceiling the backend is never asked to create a host, the registry row is
   left exactly as phone-verify left it, and a capped feed row is written;
2. capping does NOT raise — provisioning is fire-and-forget off phone-verify,
   where an exception is an invisible, unretried break of someone's sign-in;
3. below the ceiling, behaviour is byte-identical to before the cap existed;
4. an unset, blank, garbage or non-positive ``PERSONAL_AGENT_MAX_PODS`` falls back
   to the safe default rather than to "unlimited".
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import (
    _PERSONAL_AGENT_MAX_PODS_DEFAULT,
    get_core_security_settings,
    personal_agent_max_pods,
)
from hushh_mcp.services.compute_backend import BackendHandle
from hushh_mcp.services.personal_agent_provisioning_service import (
    FEED_EVENT_CAPPED,
    FEED_EVENT_PROVISIONING,
    FEED_EVENT_READY,
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair

_UID = "firebase_uid_cap_test_123"
_PHONE = "+14255550144"
_FEED_MODULE = "hushh_mcp.services.feed_service.FeedService"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class CountingRegistry:
    """Registry fake that CAN count — i.e. one the cap is enforceable against."""

    def __init__(self, *, active: int = 0, count_raises: bool = False):
        self.upserts: list[dict] = []
        self.rows: dict[str, dict] = {}
        self.tombstones: list[dict] = []
        self.count_calls: list[dict] = []
        self._active = active
        self._count_raises = count_raises

    async def upsert(self, **kw):
        self.upserts.append(kw)
        self.rows[kw["user_id"]] = {"hushh_id": kw["hushh_id"], "external_agent_id": None}

    async def get(self, user_id):
        return self.rows.get(user_id)

    async def count_active_pods(self, *, exclude_user_id=None):
        self.count_calls.append({"exclude_user_id": exclude_user_id})
        if self._count_raises:
            raise RuntimeError("registry unavailable: dsn=postgres://secret@host/db")
        return self._active

    async def tombstone(self, **kw):
        self.tombstones.append(kw)

    async def delete(self, user_id):
        self.rows.pop(user_id, None)

    async def tombstone_exists(self, hushh_id):
        return False


class CountlessRegistry:
    """No ``count_active_pods`` at all — like every pre-existing test fake."""

    def __init__(self):
        self.upserts: list[dict] = []
        self.rows: dict[str, dict] = {}

    async def upsert(self, **kw):
        self.upserts.append(kw)
        self.rows[kw["user_id"]] = {"hushh_id": kw["hushh_id"], "external_agent_id": None}

    async def get(self, user_id):
        return self.rows.get(user_id)

    async def tombstone(self, **kw):
        return None

    async def delete(self, user_id):
        self.rows.pop(user_id, None)

    async def tombstone_exists(self, hushh_id):
        return False


class FakeGrant:
    def __init__(self):
        self.calls: list[str] = []

    async def issue_standing_pkm_read(self, user_id, *, ledger=None):
        self.calls.append(user_id)
        return {"token": "HCT:fake", "expiresAt": 9_999_999_999_999, "scope": "pkm.read"}

    async def revoke_standing_pkm_read(self, user_id, *, ledger=None):
        return {"revoked": True}


class CountingBackend:
    """Records every host-creation request. The thing the cap must prevent."""

    backend_id = "gcp"

    def __init__(self):
        self.provisioned: list = []
        self.deprovisioned: list[str] = []

    async def provision(self, spec):
        self.provisioned.append(spec)
        return BackendHandle(
            external_agent_id="one-pod-x",
            a2a_route=f"https://a2a.hushh.ai/u/{spec.hushh_id}",
            status="planned",
            backend="gcp",
        )

    async def deprovision(self, external_agent_id):
        self.deprovisioned.append(external_agent_id)

    async def get(self, external_agent_id):
        return None

    def render_deploy_config(self, spec):
        return {}

    async def health(self):
        return True


class RecordingFeedService:
    events: list[dict] = []

    def record_event(self, **kw):
        RecordingFeedService.events.append(kw)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.delenv("PERSONAL_AGENT_MAX_PODS", raising=False)
    get_core_security_settings.cache_clear()
    RecordingFeedService.events = []
    yield
    get_core_security_settings.cache_clear()


@pytest.fixture
def feed(monkeypatch):
    monkeypatch.setattr(_FEED_MODULE, RecordingFeedService)
    return RecordingFeedService


def _pod_key():
    return generate_pod_keypair().public()


async def _provision(svc, user_id: str = _UID):
    pod = _pod_key()
    return await svc.provision(
        user_id=user_id,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )


def _types(events: list[dict]) -> list[str]:
    return [event["event_type"] for event in events]


# ---------------------------------------------------------------------------
# The setting fails safe
# ---------------------------------------------------------------------------


def test_unset_max_pods_falls_back_to_the_safe_default(monkeypatch):
    monkeypatch.delenv("PERSONAL_AGENT_MAX_PODS", raising=False)
    assert personal_agent_max_pods() == _PERSONAL_AGENT_MAX_PODS_DEFAULT == 50


@pytest.mark.parametrize("raw", ["", "   ", "abc", "50pods", "1e3", "12.5", "0", "-1", "-999"])
def test_unparseable_or_non_positive_max_pods_fails_safe(monkeypatch, raw):
    # Never "unlimited": a typo in the environment must not remove the ceiling.
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", raw)
    assert personal_agent_max_pods() == _PERSONAL_AGENT_MAX_PODS_DEFAULT


@pytest.mark.parametrize(("raw", "expected"), [("1", 1), (" 7 ", 7), ("250", 250)])
def test_valid_max_pods_is_honoured(monkeypatch, raw, expected):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", raw)
    assert personal_agent_max_pods() == expected


# ---------------------------------------------------------------------------
# At the ceiling: no host, no row change, a capped feed row, no exception
# ---------------------------------------------------------------------------


async def test_at_the_cap_the_backend_is_never_asked_to_create_a_host(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "3")
    registry, backend = CountingRegistry(active=3), CountingBackend()
    svc = PersonalAgentProvisioningService(registry=registry, grant=FakeGrant(), backend=backend)

    result = await _provision(svc)

    # The whole point: no billable host was created.
    assert backend.provisioned == []
    # The registry row is left exactly as phone-verify left it — 'pending'.
    assert registry.upserts == []
    assert result["status"] == "pending"
    assert result["capped"] is True
    assert result["externalAgentId"] is None
    assert result["a2aRoute"] is None
    assert result["standingReadExpiresAt"] is None


async def test_at_the_cap_a_capped_feed_row_is_written(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "1")
    svc = PersonalAgentProvisioningService(
        registry=CountingRegistry(active=1), grant=FakeGrant(), backend=CountingBackend()
    )

    await _provision(svc)

    assert _types(feed.events) == [FEED_EVENT_CAPPED]
    capped = feed.events[0]
    assert capped["user_id"] == _UID
    assert capped["source_domain"] == "consent"
    # Capping is not a failure and must not be reported as one.
    assert capped["metadata"] == {}
    assert _PHONE not in str(capped)


async def test_capping_never_raises_into_the_fire_and_forget_path(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "2")
    svc = PersonalAgentProvisioningService(
        registry=CountingRegistry(active=99), grant=FakeGrant(), backend=CountingBackend()
    )

    # No pytest.raises: an exception here would break the caller's sign-in.
    result = await _provision(svc)
    assert result["capped"] is True


async def test_at_the_cap_no_standing_grant_is_minted(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "1")
    grant = FakeGrant()
    svc = PersonalAgentProvisioningService(
        registry=CountingRegistry(active=5), grant=grant, backend=CountingBackend()
    )

    await _provision(svc)

    assert grant.calls == []


async def test_the_cap_excludes_the_callers_own_row(feed, monkeypatch):
    # A user who already has a pod must never be blocked by their own row.
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "5")
    registry = CountingRegistry(active=0)
    svc = PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=CountingBackend()
    )

    await _provision(svc)

    assert registry.count_calls == [{"exclude_user_id": _UID}]


async def test_one_below_the_cap_still_provisions(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "4")
    backend = CountingBackend()
    svc = PersonalAgentProvisioningService(
        registry=CountingRegistry(active=3), grant=FakeGrant(), backend=backend
    )

    result = await _provision(svc)

    assert len(backend.provisioned) == 1
    assert result["status"] == "provisioned"
    assert "capped" not in result


# ---------------------------------------------------------------------------
# Below the ceiling: byte-identical to today
# ---------------------------------------------------------------------------


async def test_below_the_cap_behaviour_is_unchanged(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "50")
    registry, grant, backend = CountingRegistry(active=0), FakeGrant(), CountingBackend()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=backend)

    result = await _provision(svc)

    # The exact registry ladder, grant, handle and feed sequence from before B3.
    assert [u["status"] for u in registry.upserts] == [
        "provisioning",
        "provisioning",
        "provisioned",
    ]
    assert grant.calls == [_UID]
    assert len(backend.provisioned) == 1
    assert result["status"] == "provisioned"
    assert result["externalAgentId"] == "one-pod-x"
    assert _types(feed.events) == [FEED_EVENT_PROVISIONING, FEED_EVENT_READY]
    assert FEED_EVENT_CAPPED not in _types(feed.events)


async def test_a_registry_that_cannot_count_does_not_block_provisioning(feed):
    # Fail-open, by design: the cap is a cost guardrail, and an unevaluable
    # guardrail must not break agent setup for everyone. Every registry fake that
    # predates the cap takes this path, which is why today's suite is unaffected.
    registry, backend = CountlessRegistry(), CountingBackend()
    svc = PersonalAgentProvisioningService(registry=registry, grant=FakeGrant(), backend=backend)

    result = await _provision(svc)

    assert result["status"] == "provisioned"
    assert len(backend.provisioned) == 1


async def test_a_failing_count_query_does_not_block_provisioning(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "1")
    registry, backend = CountingRegistry(count_raises=True), CountingBackend()
    svc = PersonalAgentProvisioningService(registry=registry, grant=FakeGrant(), backend=backend)

    result = await _provision(svc)

    assert result["status"] == "provisioned"
    assert len(backend.provisioned) == 1
    # The DSN in the raised error never reaches the user's feed.
    assert "postgres://" not in str(feed.events)


async def test_the_cap_is_checked_before_the_first_registry_write(feed, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "1")
    registry = CountingRegistry(active=1)
    svc = PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=CountingBackend()
    )

    await _provision(svc)

    # Nothing was written at all — so a row that phone-verify left 'pending' is
    # still 'pending', never advanced to 'provisioning'.
    assert registry.upserts == []
    assert registry.count_calls  # ...and the count really was consulted


async def test_an_invalid_pod_key_still_raises_at_the_cap(feed, monkeypatch):
    # Validation is pure and runs first, so input errors keep their 400 semantics
    # instead of being masked by a capacity answer.
    monkeypatch.setenv("PERSONAL_AGENT_MAX_PODS", "1")
    svc = PersonalAgentProvisioningService(
        registry=CountingRegistry(active=99), grant=FakeGrant(), backend=CountingBackend()
    )

    with pytest.raises(ValueError):
        await svc.provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64="not-base64!!",
            pod_key_id="pod-1",
        )


# ---------------------------------------------------------------------------
# The registry adapter's count query
# ---------------------------------------------------------------------------


class _Query:
    """In-memory stand-in implementing only what count_active_pods uses."""

    def __init__(self, db, table):
        self._db = db
        self._table = table
        self._count = None
        self._in = None
        self._neq = None
        self._limit = None

    def select(self, _cols="*", count=None):
        self._count = count
        return self

    def in_(self, col, values):
        self._in = (col, list(values))
        return self

    def neq(self, col, value):
        self._neq = (col, value)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        from types import SimpleNamespace

        rows = self._db.tables.setdefault(self._table, [])
        if self._in:
            rows = [r for r in rows if r.get(self._in[0]) in self._in[1]]
        if self._neq:
            rows = [r for r in rows if r.get(self._neq[0]) != self._neq[1]]
        total = len(rows) if self._count == "exact" else None
        data = [] if self._limit == 0 else rows
        return SimpleNamespace(data=data, count=total)


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}

    def table(self, name):
        return _Query(self, name)


def _seed(db, rows):
    db.tables["personal_agent_registry"] = list(rows)


async def test_count_active_pods_counts_only_live_rows():
    db = FakeDB()
    _seed(
        db,
        [
            {"user_id": "a", "status": "provisioned"},
            {"user_id": "b", "status": "provisioning"},
            {"user_id": "c", "status": "pending"},
            {"user_id": "d", "status": "provisioning_failed"},
            {"user_id": "e", "status": "unprovisioned"},
        ],
    )
    repo = PersonalAgentRegistryRepo(client=db)

    # pending / failed / unprovisioned rows hold no host and are not counted.
    assert await repo.count_active_pods() == 2


async def test_count_active_pods_can_exclude_one_user():
    db = FakeDB()
    _seed(
        db,
        [
            {"user_id": "a", "status": "provisioned"},
            {"user_id": "b", "status": "provisioned"},
        ],
    )
    repo = PersonalAgentRegistryRepo(client=db)

    assert await repo.count_active_pods(exclude_user_id="a") == 1
    assert await repo.count_active_pods(exclude_user_id="") == 2
    assert await repo.count_active_pods(exclude_user_id=None) == 2


async def test_count_active_pods_on_an_empty_fleet_is_zero():
    repo = PersonalAgentRegistryRepo(client=FakeDB())
    assert await repo.count_active_pods() == 0


# -- the number above our own -------------------------------------------------------
#
# PERSONAL_AGENT_MAX_PODS is a row count in our registry. Underneath it sits a Cloud
# Run services-per-project-per-region quota, read from the Service Usage API on
# 2026-08-06 against hushh-pda-dev:
#
#     Cloud Run "Services", unit 1/{project}/{region}
#     effectiveLimit = 1000, defaultLimit = 1000   (no increase ever granted)
#
# It is a SHARDING TRIGGER, not a wall: the operator identity measures consumption
# and provisions the next GCP project before a region fills. What it constrains is
# THIS setting -- our own cap must stay at or below the per-project number the
# provisioner is currently filling, or a provision passes our check and then fails
# at Cloud Run, after the person has been told their agent is being built.


CLOUD_RUN_SERVICES_PER_PROJECT_PER_REGION = 1000


def test_our_own_cap_stays_within_one_projects_capacity():
    """Our cap governs one project's worth of pods. A default above the per-project
    number would pass our check and then fail at Cloud Run -- the least useful place
    for a limit to surface, because by then the registry row exists and the person
    has already been told their agent is being built. Growing past it is the
    provisioner's job (stand up the next project), not this setting's."""
    from hushh_mcp.runtime_settings import _PERSONAL_AGENT_MAX_PODS_DEFAULT

    assert _PERSONAL_AGENT_MAX_PODS_DEFAULT <= CLOUD_RUN_SERVICES_PER_PROJECT_PER_REGION


def test_the_shard_threshold_is_recorded_where_an_operator_will_look():
    """A number that lives only in a commit message is a number nobody finds. The
    runbook is where someone asks "when does the provisioner need a new project?"."""
    from pathlib import Path

    doc = (
        Path(__file__).resolve().parents[2]
        / "docs"
        / "future"
        / "personal-agent"
        / "POD-AUTOPROVISION.md"
    ).read_text(encoding="utf-8")

    assert str(CLOUD_RUN_SERVICES_PER_PROJECT_PER_REGION) in doc
    assert "consumerQuotaMetrics" in doc, "how to re-read it, not just what it said once"
