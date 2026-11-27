"""Managed creation is disabled until sharded capacity and per-pod custody qualify.

Configuration cannot bypass that gate; planning and existing resource inspection
remain available. Reviewer phone-verification and BYOC are separate authorities.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.hosted_tier_guard import (
    HostedTierNotPermittedError,
    hosted_pod_creates_permitted,
)

_SPEC = PodSpec(hushh_id="ha1x", phone_e164_hash="h" * 64, pod_pubkey="p" * 43)

_ALL_VARS = (
    "HUSSH_HOSTED_POD_TIER_ENABLED",
    "HUSHH_DEV_SIMULATION_ENABLED",
    "HUSHH_DEPLOY_ENV",
    "DEPLOY_ENV",
    "_DEPLOY_ENV",
    "HUSSH_POD_PROJECT",
    "ENVIRONMENT",
    "APP_ENV",
)


@pytest.fixture
def clean_env(monkeypatch):
    for name in _ALL_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


class _CountingClient:
    """Records creates so a test can assert that none happened."""

    def __init__(self) -> None:
        self.created: list[dict] = []

    def create_service(self, config):  # pragma: no cover - must never be reached
        self.created.append(config)

    def set_invoker_binding(self, name, member):  # pragma: no cover
        pass

    def wait_ready(self, name):  # pragma: no cover
        return True, {}


# --------------------------------------------------------------------------- #
# 1. The matrix: every leg is required, absence denies.
# --------------------------------------------------------------------------- #


def test_nothing_set_denies(clean_env):
    """The failure mode this guards is a container that lost its environment.

    For a reviewer alias code, reading that as "development" is a defensible
    trade. For "create billable per-person compute" it is not.
    """
    assert hosted_pod_creates_permitted() is False


def test_the_flag_alone_denies(clean_env):
    """Being opted in is not the same as being deployed somewhere known."""
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    assert hosted_pod_creates_permitted() is False


def test_flag_and_lane_without_a_project_denies(clean_env):
    """A hosted fleet must be AIMED.

    Without `HUSSH_POD_PROJECT` the project resolver falls through to ambient
    credentials or `GOOGLE_CLOUD_PROJECT`, and pods materialise in whatever
    project the hub happens to hold. That inheritance is the exact bug the
    resolver's precedence order exists to prevent, so the guard refuses rather
    than letting the fleet land somewhere nobody named.
    """
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    assert hosted_pod_creates_permitted() is False


def test_lane_and_project_without_the_flag_denies(clean_env):
    """Deployment is not consent. The opt-in is a separate, deliberate act."""
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")
    assert hosted_pod_creates_permitted() is False


def test_configuration_cannot_bypass_capacity_and_custody_qualification(clean_env):
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")
    assert hosted_pod_creates_permitted() is False


def test_production_configuration_is_not_qualification(clean_env):
    """Neither a dev nor production flag proves isolated custody or capacity."""
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "production")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-prod")
    assert hosted_pod_creates_permitted() is False


def test_garbage_flag_values_deny(clean_env):
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "maybe")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")
    assert hosted_pod_creates_permitted() is False


def test_whitespace_only_project_denies(clean_env):
    """An empty-string project is how a substitution that resolved to nothing
    arrives. It must read as unset, not as a project named "  "."""
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "   ")
    assert hosted_pod_creates_permitted() is False


# --------------------------------------------------------------------------- #
# 2. The refusal is loud, and names what was refused.
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_live_provisioning_refuses_and_names_the_missing_pieces(clean_env):
    """A bypass that silently does nothing is indistinguishable from one that works.

    So the boundary raises rather than returning falsy, and the message carries
    the three observed signals — which are exactly what someone debugging a
    refused provision needs.
    """
    clean_env.setenv("HUSHH_DEPLOY_ENV", "uat")

    backend = GcpBackend(project="p", region="us-central1", live=True, client=object())

    with pytest.raises(HostedTierNotPermittedError) as excinfo:
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})

    message = str(excinfo.value)
    assert "hussh-managed pod provisioning" in message
    assert "uat" in message
    assert "HUSSH_POD_PROJECT" in message


def test_plan_mode_still_renders_everywhere(clean_env):
    """The refusal is at the live-execution boundary, never at render time.

    Rendering costs nothing and bills nothing, and being able to inspect the
    artifact a lane WOULD produce is how several defects in this workstream were
    found. Moving the guard to render time would close that off for no gain.
    """
    clean_env.setenv("ENVIRONMENT", "production")

    config = GcpBackend(project="p", region="us-central1", live=False).render_deploy_config(_SPEC)

    assert config["metadata"]["name"] == "one-pod-ha1x"


# --------------------------------------------------------------------------- #
# 3. The split held: hosted tier ON does not unlock the phone bypass.
# --------------------------------------------------------------------------- #


def test_opening_the_hosted_tier_does_not_open_the_reviewer_bypass(clean_env):
    """The defect this whole module exists to fix.

    One flag used to gate two unrelated things: hussh-managed provisioning and
    the reviewer alias-code / phone-test-code bypass. They were coupled only
    because both happened to be dev-only. Shipping the hosted tier to a lane
    would therefore have silently disabled phone verification on that lane.

    Asserted from both directions so neither flag can be quietly re-merged into
    the other.
    """
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "production")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-prod")

    assert hosted_pod_creates_permitted() is False
    assert simulation_permitted() is False


def test_the_reviewer_bypass_does_not_open_the_hosted_tier(clean_env):
    clean_env.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")

    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    assert simulation_permitted() is True
    assert hosted_pod_creates_permitted() is False


# --------------------------------------------------------------------------- #
# 4. Break the guard on purpose. It must fail CLOSED.
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_a_broken_guard_creates_nothing(clean_env, monkeypatch):
    """If the guard itself raises, no service may be created.

    The property under test is not "the guard denies" — it is "there is no path
    from a broken guard to a billable create". A guard that fails open is absent
    on exactly the day something is wrong with it, which is the day it matters.
    """
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")

    import hushh_mcp.services.hosted_tier_guard as guard

    def _explode(what: str = "") -> None:
        raise ImportError("simulated broken guard")

    monkeypatch.setattr(guard, "require_hosted_pod_creates_permitted", _explode)

    client = _CountingClient()
    backend = GcpBackend(project="p", region="us-central1", live=True, client=client)

    with pytest.raises(ImportError):
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})

    assert client.created == []


def test_configured_existing_maintenance_does_not_enable_new_managed_pods(clean_env):
    from hushh_mcp.services.hosted_tier_guard import require_hosted_pod_maintenance_permitted

    with pytest.raises(HostedTierNotPermittedError):
        require_hosted_pod_maintenance_permitted()
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "synthetic-existing-fleet")
    require_hosted_pod_maintenance_permitted()
    assert hosted_pod_creates_permitted() is False


@pytest.mark.asyncio
async def test_pilot_selection_admits_intent_without_opening_legacy_creation(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection
    from tests.helpers.hosted_pilot_selection import selection_runtime

    db = selection_runtime(monkeypatch)
    selected = await require_hosted_pilot_selection("u1", SimpleNamespace(_db=lambda: db))
    assert selected.owner_id == "u1" and selected.hushh_id == "ha1_test"
    assert selected.registry_present and hosted_pod_creates_permitted() is False
    assert db.calls[0][1]["sha"] == "a" * 40
    assert db.calls[0][1]["digest"] == "sha256:" + "b" * 64


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    ["owner", "lane", "sha", "policy", "hushh", "active", "byoc", "attempt", "missing_schema"],
)
async def test_pilot_selection_refuses_unqualified_owner_and_runtime(monkeypatch, change):
    from types import SimpleNamespace

    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection
    from tests.helpers.hosted_pilot_selection import selection_runtime

    db = selection_runtime(monkeypatch)
    owner = "other" if change == "owner" else "u1"
    if change == "lane":
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    if change == "sha":
        monkeypatch.setenv("HUSHH_DEPLOY_SHA", "c" * 40)
    if change == "policy":
        db.records = False
    if change == "hushh":
        db.row["hushh_id"] = "ha1_wrong"
    if change == "active":
        db.row["status"] = "provisioned"
    if change == "byoc":
        db.row["deployment_target"] = "user_gcp"
    if change == "attempt":
        db.row["backend_metadata"] = {"provisionAttempt": {}}
    if change == "missing_schema":

        def missing(*args):
            raise RuntimeError("missing table")

        db.execute_raw = missing
    with pytest.raises(HostedTierNotPermittedError):
        await require_hosted_pilot_selection(owner, SimpleNamespace(_db=lambda: db))


@pytest.mark.asyncio
async def test_pilot_missing_registry_allows_only_phone_reservation_intent(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection
    from tests.helpers.hosted_pilot_selection import selection_runtime

    db = selection_runtime(monkeypatch)
    db.row = None
    repo = SimpleNamespace(_db=lambda: db)
    assert not (await require_hosted_pilot_selection("u1", repo)).registry_present
    with pytest.raises(HostedTierNotPermittedError):
        await require_hosted_pilot_selection("u1", repo, require_record=True)


def test_pilot_selection_query_with_real_policy_and_expiry(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection
    from tests.helpers.hosted_pilot_selection import selection_runtime
    from tests.pkm_conformance.postgres_harness import find_pg_bin
    from tests.test_byoc_setup_job_azure_admission_postgres import ROOT, _Client, _server
    from tests.test_hosted_pilot_admission_postgres import _policy

    if find_pg_bin() is None:
        pytest.skip("local PostgreSQL unavailable")
    selection_runtime(monkeypatch)
    server = _server(monkeypatch, last=954)
    client = _Client(server)
    repo = SimpleNamespace(_db=lambda: client)
    try:
        server.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
        _policy(server)
        selection = asyncio.run(require_hosted_pilot_selection("owner-a", repo))
        assert selection.hushh_id == "ha1_synthetic_hosted_owner_1"
        assert not selection.registry_present
        server.execute(
            "INSERT INTO public.personal_agent_registry(user_id,hushh_id,status) "
            "VALUES ('owner-a','ha1_synthetic_hosted_owner_1','pending')"
        )
        assert asyncio.run(
            require_hosted_pilot_selection("owner-a", repo, require_record=True)
        ).registry_present
        from hushh_mcp.services import pod_release

        monkeypatch.setattr(
            pod_release, "configured_release", lambda _: {"sourceRevision": "c" * 40}
        )
        monkeypatch.setenv("HUSHH_DEPLOY_SHA", "c" * 40)
        with pytest.raises(HostedTierNotPermittedError):
            asyncio.run(require_hosted_pilot_selection("owner-a", repo))
        selection_runtime(monkeypatch)
        monkeypatch.setenv(
            "HUSSH_ONE_POD_IMAGE", "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "c" * 64
        )
        with pytest.raises(HostedTierNotPermittedError):
            asyncio.run(require_hosted_pilot_selection("owner-a", repo))
        selection_runtime(monkeypatch)
        from hushh_mcp import managed_ai_config

        changed_profile = {**managed_ai_config.load_profile("dev"), "text_model": "gemini-other"}
        with monkeypatch.context() as changed:
            changed.setattr(managed_ai_config, "load_profile", lambda _: changed_profile)
            with pytest.raises(HostedTierNotPermittedError):
                asyncio.run(require_hosted_pilot_selection("owner-a", repo))
        assert asyncio.run(require_hosted_pilot_selection("owner-b", repo)).owner_id == "owner-b"
        from tests.helpers.hosted_pilot_selection import prove_policy_cannot_outlive_cleanup

        prove_policy_cannot_outlive_cleanup(monkeypatch, repo)
        with pytest.raises(HostedTierNotPermittedError):
            asyncio.run(require_hosted_pilot_selection("other", repo))
        monkeypatch.setenv("HUSHH_DEPLOY_SHA", "c" * 40)
        with pytest.raises(HostedTierNotPermittedError):
            asyncio.run(require_hosted_pilot_selection("owner-a", repo))
        monkeypatch.setenv("HUSHH_DEPLOY_SHA", "a" * 40)
        # Recreate the isolated fixture policy, never mutate a live retained policy.
        server.execute("DROP TABLE public.hosted_pod_pilot_policy CASCADE")
        server.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
        _policy(server, expired=True)
        with pytest.raises(HostedTierNotPermittedError):
            asyncio.run(require_hosted_pilot_selection("owner-a", repo))
    finally:
        client._engine.dispose()
        server.stop()


async def test_expired_cleanup_qualification_refuses_before_policy_read(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace

    from hushh_mcp.services import hosted_engine_location_contract as locations
    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection
    from tests.helpers.hosted_pilot_selection import selection_runtime

    real_contract = locations.provider_contract
    db = selection_runtime(monkeypatch)
    monkeypatch.setattr(locations, "provider_contract", real_contract)
    monkeypatch.setattr(locations, "utc_now", lambda: datetime(2026, 11, 1, tzinfo=timezone.utc))
    with pytest.raises(HostedTierNotPermittedError):
        await require_hosted_pilot_selection("u1", SimpleNamespace(_db=lambda: db))
    assert db.calls == []


async def test_dev_extension_slot_admits_detached_owner_on_dev_and_refuses_negative_controls(
    monkeypatch,
):
    import hashlib
    import json
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services import pod_release
    from hushh_mcp.services.hosted_dev_pilot_extension import OVERRIDE_ENV
    from hushh_mcp.services.hosted_project_gcp_operator import _operator_actor_matches
    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection

    owner = "owner-slot-3"
    hushh_id = "ha1_slot3_owner"
    source_rev = "9" * 40
    digest = "sha256:" + "8" * 64
    image = f"gcr.io/hushh-pda-dev/consent-protocol-pod@{digest}"
    profile = load_profile("dev")
    operator = "user:pilot-operator@example.test"
    operator_hash = "sha256:" + hashlib.sha256(operator.encode()).hexdigest()

    ext = {
        "schemaVersion": 1,
        "policyId": "7c3d5e91-4b28-4e62-9f14-8a05d1c32611",
        "environment": "dev",
        "slotNumber": 3,
        "sourceRevision": source_rev,
        "imageDigest": digest,
        "workBudgetCents": 20000,
        "cleanupReserveCents": 5000,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(),
        "modelBinding": {
            "provider": "gemini",
            "model": profile["text_model"],
            "project": profile["project"],
            "profileHash": profile_hash(profile),
        },
        "assignment": {
            "ownerHash": "sha256:" + hashlib.sha256(owner.encode()).hexdigest(),
            "hushhId": hushh_id,
            "project": "hussh-hp-slot3-dev",
            "projectNumber": None,
            "region": "us-central1",
            "bootstrapContract": {
                "plan": {"tenancy": "hussh-hosted"},
                "steps": ["enable_services"],
            },
            "preparationContract": {
                "operatorPrincipalHash": operator_hash,
                "steps": ["create_project"],
            },
        },
    }
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", image)
    monkeypatch.setattr(pod_release, "configured_release", lambda _: {"sourceRevision": source_rev})
    monkeypatch.setenv("HUSHH_DEPLOY_SHA", "f" * 40)  # Application-only deploy moved hub SHA ahead
    monkeypatch.setenv(OVERRIDE_ENV, json.dumps(ext))

    detached_row = {
        "user_id": owner,
        "hushh_id": hushh_id,
        "status": "unprovisioned",
        "deployment_target": None,
        "a2a_route": "/a2a/ha1_slot3_owner",
        "backend_metadata": {
            "detachedPlacements": [
                {
                    "user_id": owner,
                    "hushh_id": hushh_id,
                    "a2a_route": "/a2a/ha1_slot3_owner",
                    "detachedAt": "2026-11-16T00:00:00Z",
                }
            ]
        },
    }

    class _FakeDb:
        def execute_raw(self, query, params):
            if "hosted_pod_pilot_policy" in query:
                return SimpleNamespace(data=[])
            return SimpleNamespace(
                data=[{"registry_row": detached_row, "tombstoned": False, "claimed_other": False}]
            )

    repo = SimpleNamespace(_db=lambda: _FakeDb())
    selected = await require_hosted_pilot_selection(owner, repo)
    assert selected.owner_id == owner
    assert selected.hushh_id == hushh_id
    assert selected.registry_present

    # Hash-bound operator check admits exact operator without storing plaintext email
    assert _operator_actor_matches(operator, ext["assignment"]["preparationContract"]) is True
    assert (
        _operator_actor_matches(
            "user:intruder@example.test", ext["assignment"]["preparationContract"]
        )
        is False
    )

    # Negative controls: foreign owner, UAT lane, and active assigned host must fail closed
    with pytest.raises(HostedTierNotPermittedError):
        await require_hosted_pilot_selection("foreign-owner", repo)

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    with pytest.raises(HostedTierNotPermittedError):
        await require_hosted_pilot_selection(owner, repo)

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    detached_row["external_agent_id"] = "still-assigned"
    with pytest.raises(HostedTierNotPermittedError):
        await require_hosted_pilot_selection(owner, repo)


@pytest.mark.asyncio
async def test_dev_extension_slot_resumes_when_observed_row_contains_datetime_timestamps(
    monkeypatch,
):
    """SQLAlchemy repo.get() returns datetime timestamps; resume & retained checks must normalize."""
    import hashlib
    import json
    from datetime import datetime, timezone
    from pathlib import Path
    from types import SimpleNamespace

    from hushh_mcp.services import hosted_dev_pilot_extension as ext_mod

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("ENVIRONMENT", "dev")
    owner = "owner-slot-3-dt"
    hushh_id = "ha1_slot3_dt_owner"
    attempt_id = "a" * 32
    ext = json.loads(
        (
            Path(__file__).resolve().parents[1] / "config" / "dev-hosted-pilot-extension.json"
        ).read_text(encoding="utf-8")
    )
    ext["expiresAt"] = "2099-01-01T00:00:00Z"
    ext["assignment"]["ownerHash"] = "sha256:" + hashlib.sha256(owner.encode()).hexdigest()
    ext["assignment"]["hushhId"] = hushh_id
    monkeypatch.setenv(ext_mod.OVERRIDE_ENV, json.dumps(ext))

    policy = ext_mod.load_extension_policy()
    assert policy is not None
    admission = ext_mod._build_admission(policy)
    intent = {
        "user_id": owner,
        "hushh_id": hushh_id,
        "phone_e164_hash": "hash123",
        "deployment_target": "gcp",
        "model_credential_mode": "fleet_adc",
    }
    retained_attempt = {
        "ownerId": owner,
        "attemptId": attempt_id,
        "phase": "reserved",
        "intent": intent,
        "hostedAdmission": admission,
    }
    ts = datetime(2026, 11, 16, 11, 4, 50, 123456, tzinfo=timezone.utc)
    observed_with_dt = {
        "user_id": owner,
        "hushh_id": hushh_id,
        "status": "provisioning",
        "deployment_target": "gcp",
        "created_at": ts,
        "updated_at": ts,
        "backend_metadata": {"provisionAttempt": retained_attempt},
    }

    captured_params: dict[str, str] = {}

    class _ResumeDb:
        def execute_raw(self, query, params):
            assert "jsonb_populate_record" in query
            captured_params.update(params)
            # Ensure ISO-8601 'T' separator was emitted, never Python str(datetime) space
            assert "2026-11-16T11:04:50.123456+00:00" in params["expected"]
            return SimpleNamespace(data=[{"unchanged": True}])

    resumed = await ext_mod.claim_extension_provision(
        _ResumeDb(), observed=observed_with_dt, intent=intent, attempt_id=attempt_id
    )
    assert resumed == retained_attempt
    assert "expected" in captured_params
