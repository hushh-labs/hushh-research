"""BYOC: the bootstrap applier, the impersonation credential, and per-user key custody.

BYO GCP is the only production path, and its whole claim is that hushh operates in a
project it does not own without holding a credential there. These tests are aimed at the
ways that claim could be true on paper and false in code: a silent fallback to hushh's
own identity when the user's grant is gone, a plaintext key ending up in a service
description, or a pod continuing with a substitute key it invented.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.byoc_key_custody import (  # noqa: E402
    KMS_KEY_ENV,
    WRAPPED_KEY_OBJECT_ENV,
    ByocKeyCustodyError,
    byoc_custody_configured,
    byoc_key_env,
    generate_dek,
    resolve_pod_log_key,
    unwrap_dek,
    wrap_dek,
)
from hushh_mcp.services.compute_backend import PodSpec  # noqa: E402
from hushh_mcp.services.user_gcp_backend import UserGcpBackend  # noqa: E402
from hushh_mcp.services.user_gcp_bootstrap import (  # noqa: E402
    BOOTSTRAP_ROLES,
    BootstrapError,
    UserGcpBootstrap,
    authorization_request,
    mint_bootstrap_token,
)

USER_PROJECT = "hushh-byoc-test"
HUSHH_ID = "HA1BYOC0000001"
KMS_KEY = f"projects/{USER_PROJECT}/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-k"

# Bearer strings for the fakes. Named constants rather than inline literals so the
# lint that flags hardcoded credentials stays useful instead of being suppressed --
# a per-line noqa here would train the eye to skip exactly the rule worth reading.
BORROWED = "fake-bearer-for-tests"  # noqa: S105 - not a credential; there is no service
HUSHH_OWN = "fake-hushh-identity-bearer"  # noqa: S105 - same


def _spec() -> PodSpec:
    return PodSpec(
        hushh_id=HUSHH_ID,
        phone_e164_hash="0" * 64,
        pod_pubkey=base64.b64encode(b"\x00" * 32).decode(),
        region="us-central1",
    )


class _Response:
    def __init__(self, status_code: int, payload=None, content: bytes = b"", text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.content = content
        self.text = text

    def json(self):
        return self._payload


class _Session:
    """Records every call so a test can assert what was sent, not only what came back."""

    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []

    def _next(self) -> _Response:
        return self._responses.pop(0) if self._responses else _Response(200, {})

    def post(self, url, headers=None, json=None, timeout=None, **kw):
        self.calls.append({"method": "POST", "url": url, "headers": headers or {}, "json": json})
        return self._next()

    def get(self, url, headers=None, params=None, timeout=None, **kw):
        self.calls.append({"method": "GET", "url": url, "headers": headers or {}, "params": params})
        return self._next()

    def request(self, method, url, headers=None, params=None, data=None, timeout=None, **kw):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "data": data})
        return self._next()


# -- the credential model -----------------------------------------------------------


def test_a_revoked_grant_fails_loudly_instead_of_falling_back() -> None:
    """The control being tested IS revocability.

    If impersonation quietly fell back to hushh's own identity, removing the binding
    would change nothing observable and the user's revocation would be theatre.
    """
    session = _Session([_Response(403, text="caller does not have permission")])
    with pytest.raises(BootstrapError) as exc:
        mint_bootstrap_token(
            bootstrap_sa=f"one-bootstrap@{USER_PROJECT}.iam.gserviceaccount.com",
            session=session,
            source_token=HUSHH_OWN,
        )
    assert "revoked" in str(exc.value) or "missing" in str(exc.value)


def test_the_minted_token_is_short_lived() -> None:
    """A token that outlives the bootstrap is a standing credential wearing a disguise."""
    session = _Session([_Response(200, {"accessToken": "short-lived"})])
    token = mint_bootstrap_token(
        bootstrap_sa=f"one-bootstrap@{USER_PROJECT}.iam.gserviceaccount.com",
        session=session,
        source_token=HUSHH_OWN,
    )
    assert token == "short-lived"
    assert session.calls[0]["json"]["lifetime"] == "900s"


def test_the_authorization_request_is_auditable_and_names_what_hushh_never_gets() -> None:
    """A person handing over a cloud project deserves the full list, not a summary."""
    ask = authorization_request(
        project=USER_PROJECT,
        bootstrap_sa=f"one-bootstrap@{USER_PROJECT}.iam.gserviceaccount.com",
        consent_plane_sa="consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com",
    )
    assert len(ask["grants_to_bootstrap_sa"]) == len(BOOTSTRAP_ROLES)
    assert all(g["why"] for g in ask["grants_to_bootstrap_sa"])
    # The single grant to hushh is scoped to one SA, never the project.
    assert len(ask["grants_to_hushh"]) == 1
    assert ask["grants_to_hushh"][0]["role"] == "roles/iam.serviceAccountTokenCreator"
    assert "project" not in ask["grants_to_hushh"][0]["on"]
    assert any("key file" in item for item in ask["hushh_never_receives"])
    assert "Remove" in ask["revocation"]


# -- the applier --------------------------------------------------------------------


def test_apply_is_dry_by_default_and_writes_nothing() -> None:
    session = _Session([])
    boot = UserGcpBootstrap(project=USER_PROJECT, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan)
    assert result["dryRun"] is True
    assert session.calls == []


def test_apply_refuses_to_write_without_an_impersonated_token() -> None:
    """No token means no borrowed authority — and explicitly not hushh's own."""
    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    with pytest.raises(BootstrapError) as exc:
        boot.apply(plan, dry_run=False)
    assert "fall back" in str(exc.value)


def test_the_bucket_is_created_after_the_key_and_names_it() -> None:
    """Order is load-bearing: default encryption does not re-encrypt existing objects.

    A bucket created before its key would hold the pod's first records under Google's
    default encryption rather than the user's own, and nothing later would fix it.
    """
    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    steps = [c["step"] for c in boot.plan_calls(plan)]
    assert steps.index("kms_key") < steps.index("cmek_bucket")
    bucket_call = next(c for c in boot.plan_calls(plan) if c["step"] == "cmek_bucket")
    assert bucket_call["body"]["encryption"]["defaultKmsKeyName"].endswith("one-pod-ha1byoc0000001-key")
    assert bucket_call["body"]["iamConfiguration"]["uniformBucketLevelAccess"]["enabled"] is True


def test_no_step_grants_a_project_level_role() -> None:
    """Least privilege is the claim; this is the assertion that keeps it true."""
    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    for call in boot.plan_calls(plan):
        if "setIamPolicy" in call["url"] or call["url"].endswith("/iam"):
            # Every IAM write targets a named key or bucket, never the project resource.
            assert "cloudresourcemanager" not in call["url"]
            assert f"/projects/{USER_PROJECT}:setIamPolicy" not in call["url"]


def test_a_failed_step_is_reported_rather_than_raised() -> None:
    """A half-built project is a real state; an exception loses which half."""
    session = _Session(
        [_Response(200, {})] * 3 + [_Response(403, text="denied")] + [_Response(200, {})] * 10
    )
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)
    assert result["ok"] is False
    assert result["failed"] == ["cmek_bucket"]
    assert len(result["steps"]) == len(boot.plan_calls(plan))


def test_already_exists_is_tolerated_so_bootstrap_is_rerunnable() -> None:
    session = _Session([_Response(409, text="already exists")] * 20)
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)
    # The resource steps tolerate 409; the two IAM writes do not, and are the only failures.
    assert set(result["failed"]) == {"iam_pod_sa_on_key", "iam_pod_sa_on_bucket"}


# -- key custody --------------------------------------------------------------------


def test_the_byoc_pod_env_carries_addresses_and_never_the_key() -> None:
    """The managed tier ships HUSSH_POD_LOG_KEY; BYOC must not, and this proves it."""
    env = byoc_key_env(kms_key=KMS_KEY)
    names = {e["name"] for e in env}
    assert names == {KMS_KEY_ENV, WRAPPED_KEY_OBJECT_ENV}
    assert "HUSSH_POD_LOG_KEY" not in names
    blob = str(env)
    assert "keyRings" in blob  # an address
    assert len(blob) < 500  # nothing key-shaped smuggled in


def test_wrap_and_unwrap_round_trip_through_kms() -> None:
    dek = generate_dek()
    assert len(dek) == 32
    wrapped_b64 = base64.b64encode(b"CIPHERTEXT").decode()
    session = _Session([_Response(200, {"ciphertext": wrapped_b64})])
    wrapped = wrap_dek(dek, kms_key=KMS_KEY, session=session, token=BORROWED)
    assert wrapped == b"CIPHERTEXT"
    assert session.calls[0]["url"].endswith(":encrypt")

    session = _Session([_Response(200, {"plaintext": base64.b64encode(dek).decode()})])
    assert unwrap_dek(wrapped, kms_key=KMS_KEY, session=session, token=BORROWED) == dek


def test_a_pod_that_cannot_unwrap_refuses_rather_than_inventing_a_key() -> None:
    """Continuing with a fresh key starts a second history and calls it the same agent."""
    session = _Session([_Response(403, text="permission denied on key")])
    with pytest.raises(ByocKeyCustodyError) as exc:
        unwrap_dek(b"x", kms_key=KMS_KEY, session=session, token=BORROWED)
    assert "substitute" in str(exc.value)


def test_a_short_dek_is_refused_at_wrap_time() -> None:
    with pytest.raises(ByocKeyCustodyError):
        wrap_dek(b"too-short", kms_key=KMS_KEY, session=_Session([]), token=BORROWED)


def test_custody_mode_is_chosen_by_env_not_by_guessing(monkeypatch) -> None:
    monkeypatch.delenv(KMS_KEY_ENV, raising=False)
    assert byoc_custody_configured() is False
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    assert byoc_custody_configured() is True


def test_managed_pods_still_read_their_key_from_env(monkeypatch) -> None:
    """Parity: one call site serves both tiers, so the rest of the pod is identical."""
    monkeypatch.delenv(KMS_KEY_ENV, raising=False)
    monkeypatch.setenv("HUSSH_POD_LOG_KEY", base64.b64encode(b"\x07" * 32).decode())
    assert resolve_pod_log_key() == b"\x07" * 32


def test_byoc_resolution_needs_a_bucket_to_find_the_wrapped_key(monkeypatch) -> None:
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    monkeypatch.delenv("POD_STORAGE_GCS_BUCKET", raising=False)
    with pytest.raises(ByocKeyCustodyError) as exc:
        resolve_pod_log_key(session=_Session([]), token=BORROWED)
    assert "POD_STORAGE_GCS_BUCKET" in str(exc.value)


def test_a_missing_wrapped_key_says_bootstrap_did_not_complete(monkeypatch) -> None:
    """The error names the cause, because 'key missing' alone sends people to the wrong place."""
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "one-pod-x-blobs")
    session = _Session([_Response(404, text="not found")])
    with pytest.raises(ByocKeyCustodyError) as exc:
        resolve_pod_log_key(session=session, token=BORROWED)
    assert "bootstrap did not complete" in str(exc.value)


# -- the backend ---------------------------------------------------------------------


def test_live_provisioning_requires_the_authorized_bootstrap_account(monkeypatch) -> None:
    """An inferred identity that happens to exist would be used silently."""
    monkeypatch.delenv("HUSSH_USER_GCP_BOOTSTRAP_SA", raising=False)
    backend = UserGcpBackend(user_project=USER_PROJECT, image="img", live=True)
    with pytest.raises(RuntimeError) as exc:
        backend._client()
    assert "never inferred" in str(exc.value)


def test_the_rendered_pod_is_marked_user_owned() -> None:
    backend = UserGcpBackend(user_project=USER_PROJECT, image="img", live=False)
    cfg = backend.render_deploy_config(_spec())
    assert cfg["metadata"]["labels"]["hussh-tenancy"] == "user-owned"


def test_the_plan_states_impersonation_for_a_google_hosted_hub() -> None:
    """WIF is the wrong primitive when the caller is already a Google identity."""
    backend = UserGcpBackend(
        user_project=USER_PROJECT,
        hushh_invoker_sa="consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com",
        live=False,
    )
    fed = backend.render_bootstrap_plan(_spec())["federation"]
    assert fed["type"] == "impersonation"
    assert fed["impersonation"]["role"] == "roles/iam.serviceAccountTokenCreator"
    assert fed["impersonation"]["token_lifetime"] == "900s"
    # WIF is retained, and labelled for the deployment it actually serves.
    assert "CloudHub" in fed["workload_identity_federation"]["applies_to"]
