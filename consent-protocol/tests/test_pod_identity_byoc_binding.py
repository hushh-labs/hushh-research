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

    async def _legacy_row(_hushh_id):
        return {"deployment_target": "gcp", "backend": "gcp", "backend_metadata": {}}

    monkeypatch.setattr(pia, "_identity_placement_row", _legacy_row)


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


@pytest.mark.asyncio
async def test_fleet_identity_cannot_assert_a_dedicated_hosted_owner(monkeypatch):
    from tests.hosted_pod_support import hosted_registry_row

    _arrange(monkeypatch, verified_email=FLEET_SA)
    row = hosted_registry_row()

    async def lookup(_hushh_id):
        return row

    monkeypatch.setattr(pia, "_identity_placement_row", lookup)
    assert await pia.verify_pod_identity(_Req(row["hushh_id"]), "Bearer t") is None


def test_retained_hosted_access_survives_admission_expiry_but_not_owner_or_uid_drift():
    from copy import deepcopy

    from hushh_mcp.services.compute_backend import is_private_pod_row
    from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement
    from tests.hosted_pod_support import hosted_registry_row

    row = hosted_registry_row()
    assert is_private_pod_row(row)
    assert retained_hosted_placement(row).project == "hussh-pilot-owner-a"
    for defect in ("owner", "uid", "principal", "erasure", "model", "mixed"):
        changed = deepcopy(row)
        if defect == "owner":
            changed["user_id"] = "owner-b"
        elif defect == "uid":
            changed["backend_metadata"]["serviceUid"] = "different-incarnation"
        elif defect == "principal":
            changed["backend_metadata"]["runtime_service_account"] = OTHER_SA
        elif defect == "model":
            changed["model_credential_mode"] = "shared"
        elif defect == "mixed":
            changed["deployment_target"] = "user_gcp"
        else:
            changed["backend_metadata"]["erasure"] = {}
        assert retained_hosted_placement(changed) is None
        assert not is_private_pod_row(changed)


async def test_the_audience_is_verified_not_merely_the_signature(monkeypatch):
    """Without an audience, verify_oauth2_token checks only that Google signed it —
    so a token the pod SA minted for ANY other service would be accepted, and the
    whole decision would rest on the email claim alone. A pod mints its hub token
    audience-bound precisely so it cannot be replayed elsewhere."""
    from api.routes.one import pod_identity_auth

    seen: dict = {}

    class _FakeIdToken:
        @staticmethod
        def verify_oauth2_token(token, request, audience=None):
            seen["audience"] = audience
            return {"email": "pod@proj.iam.gserviceaccount.com", "email_verified": True}

    monkeypatch.setattr(pod_identity_auth, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(
        pod_identity_auth,
        "pod_hub_allowed_service_account",
        lambda: "pod@proj.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(
        pod_identity_auth, "pod_hub_expected_audience", lambda: "https://hub.example"
    )
    # `from google.oauth2 import id_token` is an ATTRIBUTE lookup on the package,
    # so patching sys.modules would not intercept it.
    import google.oauth2

    monkeypatch.setattr(google.oauth2, "id_token", _FakeIdToken, raising=False)

    req = _Req("hushh-abc")
    req.headers = {"X-Hushh-Pod-Id": "hushh-abc"}

    async def legacy_row(_hushh_id):
        return {"deployment_target": "gcp", "backend": "gcp", "backend_metadata": {}}

    monkeypatch.setattr(pod_identity_auth, "_identity_placement_row", legacy_row)
    result = await pod_identity_auth.verify_pod_identity(req, "Bearer tok")

    assert result == "hushh-abc"
    assert seen["audience"] == "https://hub.example"
    # Action coordination refuses the fleet identity even when it asserts a
    # real owner. Its existing read-only compatibility path above is preserved.
    assert await pod_identity_auth.verify_pod_identity(req, "Bearer tok", owner_bound=True) is None
