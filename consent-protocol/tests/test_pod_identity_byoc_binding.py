"""A BYOC pod runs as the owner's account, and the hub has to be able to trust it.

`verify_pod_identity` compared the verified email against ONE value from
`POD_HUB_ALLOWED_SERVICE_ACCOUNT`. On the managed tier that is correct and cheap:
every pod shares one account, which is exactly what lets that account hold no project
roles. Under BYOC it is fatal — the pod runs as an account in the OWNER's project, so
the hub rejects it and every hub-mediated path (prompt, consent verify, heartbeat,
the specialist relay) fails closed. BYOC is the production path, so this was a
production-path outage waiting behind a working simulator.

The binding is also a security IMPROVEMENT, not just an unblock. The asserted
`X-Hushh-Pod-Id` header has always been returned verbatim, compared against nothing —
documented in-repo as a consistency check rather than a control, because on a
fleet-shared account both halves come from the same caller. A per-user account makes
the header checkable for the first time.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.routes.one import pod_identity_auth as pia  # noqa: E402
from hushh_mcp.services.compute_backend import PodSpec  # noqa: E402

FLEET_SA = "hussh-one-pod@hushh-pda-dev.iam.gserviceaccount.com"
OWNER_SA = "one-pod-ha1owner@owner-project.iam.gserviceaccount.com"
OTHER_SA = "one-pod-ha1other@other-project.iam.gserviceaccount.com"


class _Req:
    def __init__(self, asserted: str) -> None:
        self.headers = {pia.POD_IDENTITY_HEADER: asserted}


def _arrange(monkeypatch, *, verified_email: str, bound: dict[str, str] | None = None):
    """Make the token verify to a chosen email, and stub the registry binding."""
    monkeypatch.setattr(pia, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(pia, "pod_hub_allowed_service_account", lambda: FLEET_SA)
    monkeypatch.setattr(pia, "pod_hub_expected_audience", lambda: "https://hub.example")

    async def _fake_verify(*_a, **_k):
        return {"email": verified_email, "email_verified": True}

    monkeypatch.setattr(pia, "run_in_threadpool", _fake_verify)

    async def _fake_bound(hushh_id: str):
        return (bound or {}).get(hushh_id)

    monkeypatch.setattr(pia, "_bound_service_account", _fake_bound)


@pytest.mark.asyncio
async def test_the_managed_fleet_account_is_still_accepted(monkeypatch) -> None:
    """The simulation tier must not regress. It is where the lifecycle is proven."""
    _arrange(monkeypatch, verified_email=FLEET_SA)
    assert await pia.verify_pod_identity(_Req("HA1OWNER"), "Bearer t") == "HA1OWNER"


@pytest.mark.asyncio
async def test_a_byoc_pod_is_accepted_when_its_account_is_bound(monkeypatch) -> None:
    """The unblock. Without this every BYOC pod is rejected by its own hub."""
    _arrange(monkeypatch, verified_email=OWNER_SA, bound={"HA1OWNER": OWNER_SA})
    assert await pia.verify_pod_identity(_Req("HA1OWNER"), "Bearer t") == "HA1OWNER"


@pytest.mark.asyncio
async def test_one_persons_pod_cannot_assert_another_persons_id(monkeypatch) -> None:
    """The security half, and the reason the binding is per-HusshID rather than a
    widened allowlist.

    A second accepted account added globally would let any BYOC pod claim any owner.
    Bound to the row, presenting B's token while asserting A fails — because A's row
    records a different account.
    """
    _arrange(
        monkeypatch,
        verified_email=OTHER_SA,
        bound={"HA1OWNER": OWNER_SA, "HA1OTHER": OTHER_SA},
    )
    assert await pia.verify_pod_identity(_Req("HA1OWNER"), "Bearer t") is None


@pytest.mark.asyncio
async def test_an_unbound_account_is_refused(monkeypatch) -> None:
    """Neither the fleet account nor anything the registry knows about."""
    _arrange(monkeypatch, verified_email="attacker@evil.example", bound={})
    assert await pia.verify_pod_identity(_Req("HA1OWNER"), "Bearer t") is None


@pytest.mark.asyncio
async def test_an_unverified_email_is_refused_before_any_binding_lookup(
    monkeypatch,
) -> None:
    """`email_verified` gates both tiers. Checking the address of an unverified
    claim would be checking a string the issuer never stood behind."""
    monkeypatch.setattr(pia, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(pia, "pod_hub_allowed_service_account", lambda: FLEET_SA)
    monkeypatch.setattr(pia, "pod_hub_expected_audience", lambda: "https://hub.example")

    async def _fake_verify(*_a, **_k):
        return {"email": FLEET_SA, "email_verified": False}

    monkeypatch.setattr(pia, "run_in_threadpool", _fake_verify)
    assert await pia.verify_pod_identity(_Req("HA1OWNER"), "Bearer t") is None


@pytest.mark.asyncio
async def test_a_registry_failure_denies_rather_than_bypasses(monkeypatch) -> None:
    """An unreadable registry must not become an authentication bypass — and must
    not become an outage for the managed tier either, which never reaches it."""
    _arrange(monkeypatch, verified_email=OWNER_SA)

    async def _boom(_hushh_id: str):
        raise RuntimeError("db down")

    monkeypatch.setattr(pia, "_bound_service_account", _boom)
    with pytest.raises(RuntimeError):
        # The stub raises directly; the REAL helper swallows and returns None. That
        # behaviour is pinned separately below so this test cannot pass by accident.
        await pia.verify_pod_identity(_Req("HA1OWNER"), "Bearer t")


@pytest.mark.asyncio
async def test_the_real_binding_lookup_never_raises() -> None:
    """`_bound_service_account` is on an auth path: a raise there would turn a
    registry hiccup into a 500 on every pod call. It returns None instead, which is
    the same fail-closed answer it gives for an unknown pod."""
    assert await pia._bound_service_account("") is None


def test_the_backend_records_the_account_the_hub_will_trust() -> None:
    """The producing half. Recording it without a consumer, or consuming a field
    nothing writes, would each be another component that passes its tests and never
    runs — the exact pattern this codebase keeps finding."""
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    backend = UserGcpBackend(user_project="owner-project")
    spec = PodSpec(hushh_id="HA1OWNER", phone_e164_hash="h", pod_pubkey="")
    account = backend._pod_service_account(spec)

    assert account.endswith("@owner-project.iam.gserviceaccount.com")
    assert "one-pod-" in account
    # Must match what render_bootstrap_plan creates, or the hub would trust an
    # account the bootstrap never made.
    plan = backend.render_bootstrap_plan(spec)
    assert account in str(plan), (
        "the account the hub will trust is not the one the bootstrap creates"
    )
