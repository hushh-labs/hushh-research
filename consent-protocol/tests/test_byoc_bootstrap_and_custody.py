"""BYOC: the bootstrap applier, the impersonation credential, and per-user key custody.

BYO GCP is the only production path, and its whole claim is that hushh operates in a
project it does not own without holding a credential there. These tests are aimed at the
ways that claim could be true on paper and false in code: a silent fallback to hushh's
own identity when the user's grant is gone, a plaintext key ending up in a service
description, or a pod continuing with a substitute key it invented.
"""

from __future__ import annotations

import base64
import json
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
    REQUIRED_SERVICES,
    BootstrapError,
    UserGcpBootstrap,
    authorization_request,
    mint_bootstrap_token,
)

USER_PROJECT = "hushh-byoc-test"
BOOTSTRAP_SA = "one-bootstrap@hushh-byoc-test.iam.gserviceaccount.com"
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


#: Answers for calls a test does not care about, addressed by URL rather than by
#: position. Positional fixtures made every test order-dependent: inserting one step
#: into the bootstrap broke five tests that had nothing to do with it, because each was
#: silently counting responses. Routes are matched in insertion order, so a more
#: specific fragment can be listed before a more general one.
_DEFAULT_ROUTES: dict = {
    # The Cloud Storage service agent lookup. Named here because almost every apply()
    # test now passes through it on the way to the CMEK bucket.
    "storage/v1/projects/": lambda: _Response(
        200, {"email_address": "service-1@gs-project-accounts.iam.gserviceaccount.com"}
    ),
}


class _Session:
    """Records every call so a test can assert what was sent, not only what came back."""

    def __init__(self, responses=(), routes=None) -> None:
        self._responses = list(responses)
        self._routes = {**_DEFAULT_ROUTES, **(routes or {})}
        self.calls: list[dict] = []

    def _next(self, url: str = "") -> _Response:
        for fragment, answer in self._routes.items():
            if fragment not in url:
                continue
            if callable(answer):
                return answer()
            if isinstance(answer, list):
                return answer.pop(0) if answer else _Response(200, {})
            return answer
        return self._responses.pop(0) if self._responses else _Response(200, {})

    def post(self, url, headers=None, json=None, params=None, data=None, timeout=None, **kw):
        self.calls.append({"method": "POST", "url": url, "headers": headers or {},
                           "json": json, "params": params or {}, "data": data})
        return self._next(url)

    def get(self, url, headers=None, params=None, timeout=None, **kw):
        self.calls.append({"method": "GET", "url": url, "headers": headers or {}, "params": params})
        return self._next(url)

    def request(self, method, url, headers=None, params=None, data=None, timeout=None, **kw):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "data": data})
        return self._next(url)


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


def test_exactly_one_grant_is_project_level_and_it_is_vertex() -> None:
    """Least privilege is still the claim; the claim's SHAPE changed, so this did too.

    This test used to assert that NO step grants a project-level role. That was true
    while the pod only needed a key and a bucket, both of which take per-resource
    bindings. Vertex does not: `roles/aiplatform.user` has no per-resource form, so
    model access for the pod has to be granted on the project.

    Asserting "none" would now be asserting something false, and the useful property is
    not "zero project-level grants" but "exactly one, and we know which". A second one
    appearing is the regression worth catching.
    """
    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    calls = boot.plan_calls(plan)

    project_level = [c for c in calls if c.get("project_level")]
    assert len(project_level) == 1
    assert project_level[0]["bindings"][0]["role"] == "roles/aiplatform.user"

    # Every OTHER IAM write still targets a named key or bucket.
    for call in calls:
        if call.get("kind") != "merge_binding" or call.get("project_level"):
            continue
        assert "cloudresourcemanager" not in call["write_url"]


def test_a_failed_step_is_reported_rather_than_raised() -> None:
    """A half-built project is a real state; an exception loses which half."""
    # enable_services, kms_keyring, kms_key, pod_service_account, then the bucket fails.
    session = _Session(
        [_Response(200, {})] * 20,
        routes={"storage/v1/b": [_Response(403, text="denied")]},
    )
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)
    assert result["ok"] is False
    assert "cmek_bucket" in result["failed"]
    assert len(result["steps"]) == len(boot.plan_calls(plan))


def test_already_exists_is_tolerated_so_resource_steps_are_rerunnable() -> None:
    """The four create-a-resource steps tolerate 409; a re-run must not fail on them.

    `enable_services` is excluded deliberately -- batchEnable is idempotent and returns
    200 for an already-enabled API, so a 409 there would be a real fault rather than a
    re-run. The bucket is excluded too: its 409 is verified against ownership, which
    this fixture answers as "not ours".
    """
    session = _Session([_Response(409, text="already exists")] * 24)
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)
    tolerated = {"kms_keyring", "kms_key", "pod_service_account", "mail_topic",
                 "mail_subscription", "watch_renew_job"}
    assert tolerated.isdisjoint(set(result["failed"])), (
        f"a re-runnable resource step failed: {result['failed']}"
    )


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


def test_the_pod_mints_its_own_key_on_first_boot(monkeypatch) -> None:
    """Nobody hands the pod a key, because nobody else can make one.

    hushh's bootstrap account holds cloudkms.admin and neither encrypter nor decrypter,
    which a live run proved by refusing its wrap with
    "Permission 'cloudkms.cryptoKeyVersions.useToEncrypt' denied". So first boot is
    where the DEK is born, and hushh is not present for it.
    """
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "one-pod-x-blobs")
    wrapped = base64.b64encode(b"WRAPPED").decode()
    session = _Session(
        [
            _Response(404, text="no key yet"),          # nothing stored
            _Response(200, {"ciphertext": wrapped}),    # KMS wrap
            _Response(200, {}),                         # stored in the user's bucket
        ]
    )
    key = resolve_pod_log_key(session=session, token=BORROWED)
    assert len(key) == 32
    upload = session.calls[2]
    # "Create only if absent" is what stops two cold starts writing two keys.
    assert upload["params"]["ifGenerationMatch"] == 0
    assert "/upload/storage/v1/b/one-pod-x-blobs/o" in upload["url"]


def test_a_pod_that_loses_the_first_boot_race_adopts_the_winners_key(monkeypatch) -> None:
    """Two cold starts are ordinary at min-instances 0.

    Without the precondition both would write a different DEK and the second would
    orphan everything sealed under the first. The loser must agree, not overwrite.
    """
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "one-pod-x-blobs")
    winner = b"\x09" * 32
    session = _Session(
        [
            _Response(404, text="no key yet"),
            _Response(200, {"ciphertext": base64.b64encode(b"MINE").decode()}),
            _Response(412, text="precondition failed"),          # someone else won
            _Response(200, content=b"THEIRS"),                   # read theirs
            _Response(200, {"plaintext": base64.b64encode(winner).decode()}),
        ]
    )
    assert resolve_pod_log_key(session=session, token=BORROWED) == winner


def test_a_key_that_exists_but_cannot_be_read_is_never_replaced(monkeypatch) -> None:
    """404 means "first boot". Anything else means "do not invent a second history"."""
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "one-pod-x-blobs")
    session = _Session([_Response(403, text="denied")])
    with pytest.raises(ByocKeyCustodyError) as exc:
        resolve_pod_log_key(session=session, token=BORROWED)
    assert "second history" in str(exc.value)
    assert len(session.calls) == 1, "a failed read must not lead to a write"


def test_a_key_that_cannot_be_stored_stops_the_pod(monkeypatch) -> None:
    """Running on an unpersisted key seals records that no later boot can open."""
    monkeypatch.setenv(KMS_KEY_ENV, KMS_KEY)
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "one-pod-x-blobs")
    session = _Session(
        [
            _Response(404, text="no key yet"),
            _Response(200, {"ciphertext": base64.b64encode(b"W").decode()}),
            _Response(500, text="storage unavailable"),
        ]
    )
    with pytest.raises(ByocKeyCustodyError) as exc:
        resolve_pod_log_key(session=session, token=BORROWED)
    assert "nothing persisted" in str(exc.value)


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


# -- an existing project, not a fresh one -------------------------------------------
#
# Everything below exists because BYOC must work against a project the person ALREADY
# owns. A fresh, empty project hides all three of these.


def test_api_enablement_is_the_first_step_not_a_prerequisite() -> None:
    """Seven of eight APIs were off in a real project, which made THIS the blocker.

    Enabling them is idempotent and happens inside the project the person already
    authorized, so it belongs to the bootstrap rather than to a setup checklist.
    """
    from hushh_mcp.services.user_gcp_bootstrap import REQUIRED_SERVICES

    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    calls = boot.plan_calls(plan)
    assert calls[0]["step"] == "enable_services"
    assert set(calls[0]["body"]["serviceIds"]) == set(REQUIRED_SERVICES)
    assert "aiplatform.googleapis.com" in calls[0]["body"]["serviceIds"]


def test_iam_steps_merge_rather_than_overwrite() -> None:
    """safe-changes R3: add a binding, never set a policy.

    The bootstrap is deliberately re-runnable and is meant to run against a project the
    person already owns, so a whole-policy write would drop bindings that were there.
    """
    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    iam = [c for c in boot.plan_calls(plan) if c["step"].startswith("iam_")]
    assert iam, "expected IAM steps"
    for call in iam:
        assert call["kind"] == "merge_binding"
        assert "read_url" in call, "a merge must read the existing policy first"
        assert "fresh_resource" not in call, "the fresh-resource shortcut must be gone"


def test_a_merge_preserves_bindings_that_were_already_there() -> None:
    """The regression this guards: somebody else's grant silently disappearing."""
    existing = {
        "bindings": [
            {"role": "roles/storage.objectViewer", "members": ["user:someone@example.com"]}
        ],
        "etag": "BwXyz",
    }
    session = _Session([_Response(200, existing), _Response(200, {})])
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    call = next(c for c in boot.plan_calls(plan) if c["step"] == "iam_pod_sa_on_bucket")

    result = boot._merge_binding(call, {"Authorization": "Bearer x"})
    assert result["ok"] is True
    written = json.loads(session.calls[1]["data"])
    roles = {b["role"] for b in written["bindings"]}
    assert "roles/storage.objectViewer" in roles, "a pre-existing binding was dropped"
    assert "roles/storage.objectAdmin" in roles, "our binding was not added"
    members = next(b for b in written["bindings"] if b["role"] == "roles/storage.objectViewer")
    assert "user:someone@example.com" in members["members"]


def test_a_merge_that_changes_nothing_is_reported_as_a_no_op() -> None:
    """A re-run should say 'already bound', not rewrite an identical policy."""
    pod_sa = f"one-pod-{HUSHH_ID.lower()}@{USER_PROJECT}.iam.gserviceaccount.com"
    already = {
        "bindings": [
            {"role": "roles/storage.objectAdmin", "members": [f"serviceAccount:{pod_sa}"]}
        ]
    }
    session = _Session([_Response(200, already)])
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    call = next(c for c in boot.plan_calls(plan) if c["step"] == "iam_pod_sa_on_bucket")

    result = boot._merge_binding(call, {"Authorization": "Bearer x"})
    assert result["ok"] is True
    assert result["detail"] == "already bound"
    assert len(session.calls) == 1, "a no-op must not write"


def test_an_unreadable_policy_fails_rather_than_writing_blind() -> None:
    """Merging into a policy you could not read is overwriting with extra steps."""
    session = _Session([_Response(403, text="denied")])
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    call = next(c for c in boot.plan_calls(plan) if c["step"] == "iam_pod_sa_on_key")

    result = boot._merge_binding(call, {"Authorization": "Bearer x"})
    assert result["ok"] is False
    assert "could not read" in result["detail"]


def test_the_vertex_grant_is_the_one_project_level_binding_and_is_marked() -> None:
    """Vertex has no per-resource binding, so this one is project-scoped by necessity.

    Marked rather than buried, so the disclosure can name it instead of a reader
    discovering it in a policy dump later.
    """
    boot = UserGcpBootstrap(project=USER_PROJECT, session=_Session([]))
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    project_level = [c for c in boot.plan_calls(plan) if c.get("project_level")]
    assert len(project_level) == 1
    assert project_level[0]["step"] == "iam_pod_sa_vertex"
    assert project_level[0]["bindings"][0]["role"] == "roles/aiplatform.user"


def test_a_bucket_name_owned_by_someone_else_is_not_treated_as_success() -> None:
    """GCS bucket names are GLOBALLY unique.

    A 409 can mean the name belongs to a stranger's project. Tolerating it would point
    this person's pod at storage it cannot write, and the failure would surface far
    from the cause -- at the pod's first append, not at bootstrap.
    """
    session = _Session(
        [_Response(200, {})] * 20,
        routes={
            "storage/v1/b": [
                _Response(409, text="conflict"),      # the bucket name is taken...
                _Response(200, {"items": []}),        # ...and this project does not own it
            ]
        },
    )
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)
    bucket = next(s for s in result["steps"] if s["step"] == "cmek_bucket")
    assert bucket["ok"] is False
    assert "globally unique" in bucket["detail"]


def test_a_bucket_we_already_own_still_counts_as_success() -> None:
    """Re-running a bootstrap against our own bucket must not be an error."""
    bucket_name = f"one-pod-{HUSHH_ID.lower()}-blobs"
    session = _Session(
        [_Response(200, {})] * 20,
        routes={
            "storage/v1/b": [
                _Response(409, text="conflict"),
                _Response(200, {"items": [{"name": bucket_name}]}),
            ]
        },
    )
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session)
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)
    bucket = next(s for s in result["steps"] if s["step"] == "cmek_bucket")
    assert bucket["ok"] is True


# -- the long-running operation the first live run tripped over -----------------------
#
# Against a real empty project (hushh-byoc-test, 2026-08-08) `services:batchEnable`
# returned 200, the applier moved straight on, and six of the next seven steps failed
# with "API has not been used in project 642919918840". Every one of those APIs was on
# less than a minute later. The enable had worked; the applier had not waited. These
# tests hold that shape: a 200 from an LRO means "started", never "done".


class _Clock:
    """A clock a test controls, so a five-minute deadline costs no seconds to prove."""

    def __init__(self, step: float = 60.0) -> None:
        self._now = 0.0
        self._step = step

    def __call__(self) -> float:
        now = self._now
        self._now += self._step
        return now


def _no_sleep(_seconds: float) -> None:
    return None


def _resource_calls(session: _Session) -> list[str]:
    """The calls that create things, i.e. everything that is not the operation poll."""
    return [c["url"] for c in session.calls if "/v1/operations/" not in c["url"]]


def test_no_resource_is_created_until_the_enablement_operation_reports_done() -> None:
    """The defect verbatim: a 200 on batchEnable is the operation STARTING.

    Ordering is the whole assertion. If a single create lands before the operation
    reports done, this is the live failure again — six steps refused by APIs that were
    moments from being on.
    """
    session = _Session(
        [
            _Response(200, {"name": "operations/acat.p2-1-abc"}),  # batchEnable: started
            _Response(200, {"name": "operations/acat.p2-1-abc"}),  # poll: not done yet
            _Response(200, {"name": "operations/acat.p2-1-abc", "done": True}),  # poll: done
        ]
        + [_Response(200, {})] * 20
    )
    boot = UserGcpBootstrap(
        project=USER_PROJECT, token=BORROWED, session=session, sleep=_no_sleep
    )
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)

    assert result["ok"] is True
    polls = [c for c in session.calls if "/v1/operations/acat.p2-1-abc" in c["url"]]
    assert len(polls) == 2, "the applier must poll until done, not once"
    # The first resource create must come AFTER both polls.
    first_create = next(
        i for i, c in enumerate(session.calls) if "cloudkms.googleapis.com" in c["url"]
    )
    last_poll = max(
        i for i, c in enumerate(session.calls) if "/v1/operations/acat.p2-1-abc" in c["url"]
    )
    assert first_create > last_poll


def test_an_operation_that_finishes_with_an_error_is_not_success() -> None:
    """`done: true` is set on failure too. Reading only that field turns a failed
    enable into a green step, which is worse than the original defect."""
    session = _Session(
        [
            _Response(200, {"name": "operations/acat.p2-1-abc"}),
            _Response(
                200,
                {
                    "name": "operations/acat.p2-1-abc",
                    "done": True,
                    "error": {"code": 7, "message": "permission denied on serviceusage"},
                },
            ),
        ]
        + [_Response(200, {})] * 20
    )
    boot = UserGcpBootstrap(
        project=USER_PROJECT, token=BORROWED, session=session, sleep=_no_sleep
    )
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)

    assert result["ok"] is False
    assert result["failed"] == ["enable_services"]
    enable = next(s for s in result["steps"] if s["step"] == "enable_services")
    assert enable["ok"] is False
    assert "permission denied" in enable["detail"]


def test_a_failed_enablement_skips_the_rest_instead_of_reporting_seven_failures() -> None:
    """One cause must be reported once.

    The live run reported six failures that were all the same fact. Steps that were
    never attempted are `skipped`, and the run is still not ok — skipping is not
    forgiveness.
    """
    session = _Session(
        [
            _Response(200, {"name": "operations/acat.p2-1-abc"}),
            _Response(200, {"name": "operations/acat.p2-1-abc", "done": True, "error": {"code": 7}}),
        ]
        + [_Response(200, {})] * 20
    )
    boot = UserGcpBootstrap(
        project=USER_PROJECT, token=BORROWED, session=session, sleep=_no_sleep
    )
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)

    assert result["failed"] == ["enable_services"]
    assert len(result["skipped"]) == len(boot.plan_calls(plan)) - 1
    assert "kms_keyring" in result["skipped"]
    assert "iam_pod_sa_vertex" in result["skipped"]
    assert result["ok"] is False
    # And nothing was created: the only calls are the enable and its one poll.
    assert _resource_calls(session) == [
        f"https://serviceusage.googleapis.com/v1/projects/{USER_PROJECT}/services:batchEnable"
    ]


def test_an_operation_that_never_finishes_gives_up_rather_than_hanging() -> None:
    """A stuck operation must surface as a failed step, not an applier that never returns."""
    session = _Session(
        [_Response(200, {"name": "operations/acat.p2-1-abc"})]
        + [_Response(200, {"name": "operations/acat.p2-1-abc"})] * 40
    )
    boot = UserGcpBootstrap(
        project=USER_PROJECT,
        token=BORROWED,
        session=session,
        sleep=_no_sleep,
        clock=_Clock(step=60.0),
    )
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)

    enable = next(s for s in result["steps"] if s["step"] == "enable_services")
    assert enable["ok"] is False
    assert "did not finish" in enable["detail"]
    assert _resource_calls(session) == [
        f"https://serviceusage.googleapis.com/v1/projects/{USER_PROJECT}/services:batchEnable"
    ]


def test_an_operation_that_answers_inline_needs_no_poll() -> None:
    """Waiting is for work that is outstanding. An API that answers `done` immediately
    must not cost the bootstrap a poll interval per step."""
    session = _Session(
        [_Response(200, {"name": "operations/acat.p2-1-abc", "done": True})]
        + [_Response(200, {})] * 20
    )
    boot = UserGcpBootstrap(
        project=USER_PROJECT, token=BORROWED, session=session, sleep=_no_sleep
    )
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    result = boot.apply(plan, dry_run=False)

    assert result["ok"] is True
    assert not [c for c in session.calls if "/v1/operations/" in c["url"]]


# -- what the second live run found: three gaps a green gate could not see ------------


def _boot(session, **kw):
    return UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=session,
                            sleep=_no_sleep, **kw)


def _plan():
    return UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())


def test_every_api_the_bootstrap_calls_is_one_the_bootstrap_enables() -> None:
    """The guard that would have caught it by construction.

    `cloudresourcemanager.googleapis.com` was missing from REQUIRED_SERVICES while the
    bootstrap's own last step called it, so the project-level Vertex binding failed with
    "API has not been used in this project". Enumerating the hosts the plan actually
    calls turns that from a thing you have to notice into a thing that cannot pass.
    """
    hosts = set()
    for call in _boot(_Session([]), bootstrap_sa=BOOTSTRAP_SA).plan_calls(_plan()):
        for key in ("url", "read_url", "write_url"):
            if call.get(key):
                hosts.add(call[key].split("/")[2])
        if call.get("member_lookup"):
            hosts.add(call["member_lookup"]["url"].split("/")[2])
        if call.get("operation_url"):
            hosts.add(call["operation_url"].split("/")[2])

    # serviceusage is the one exemption, and it is not an oversight: it is the API the
    # bootstrap uses to enable the others, so it is enabled on every project by default
    # and cannot bootstrap itself. Listing it would suggest a capability that does not
    # exist.
    missing = sorted(
        h for h in hosts if h not in REQUIRED_SERVICES and h != "serviceusage.googleapis.com"
    )
    assert missing == [], f"the bootstrap calls APIs it never enables: {missing}"


def test_the_storage_service_agent_is_authorized_on_the_key_before_the_bucket_exists() -> None:
    """Cloud Storage encrypts as its own service agent, not as the pod.

    Granting the pod encrypt/decrypt is not a substitute, and the live run said so:
    "Permission denied on Cloud KMS key. Please ensure that your Cloud Storage service
    account has been authorized to use this key." Order is load-bearing — the grant is
    worthless after the bucket create has already been refused.
    """
    calls = _boot(_Session([]), bootstrap_sa=BOOTSTRAP_SA).plan_calls(_plan())
    steps = [c["step"] for c in calls]
    assert steps.index("iam_gcs_agent_on_key") < steps.index("cmek_bucket")

    grant = next(c for c in calls if c["step"] == "iam_gcs_agent_on_key")
    # The address embeds the project NUMBER, so it cannot be rendered from the id.
    assert grant["bindings"][0]["members"] == []
    assert grant["member_lookup"]["field"] == "email_address"
    assert grant["bindings"][0]["role"] == "roles/cloudkms.cryptoKeyEncrypterDecrypter"


def test_the_looked_up_agent_is_the_member_actually_written() -> None:
    agent = "service-642919918840@gs-project-accounts.iam.gserviceaccount.com"
    session = _Session(
        [_Response(200, {"name": "operations/x", "done": True})] + [_Response(200, {})] * 24,
        routes={"storage/v1/projects/": _Response(200, {"email_address": agent})},
    )
    result = _boot(session, bootstrap_sa=BOOTSTRAP_SA).apply(_plan(), dry_run=False)
    assert next(s for s in result["steps"] if s["step"] == "iam_gcs_agent_on_key")["ok"]

    written = [json.loads(c["data"]) for c in session.calls if c.get("data")]
    members = [
        m
        for body in written
        for b in (body.get("policy", {}) or {}).get("bindings", [])
        if b.get("role") == "roles/cloudkms.cryptoKeyEncrypterDecrypter"
        for m in b.get("members", [])
    ]
    assert members == [f"serviceAccount:{agent}"]


def test_an_unresolvable_principal_refuses_instead_of_writing_a_binding() -> None:
    """A policy write is an access grant. Guessing the member is worse than failing."""
    session = _Session(
        [_Response(200, {"name": "operations/x", "done": True})] + [_Response(200, {})] * 24,
        routes={"storage/v1/projects/": _Response(500, text="service agent lookup down")},
    )
    result = _boot(session, bootstrap_sa=BOOTSTRAP_SA).apply(_plan(), dry_run=False)
    grant = next(s for s in result["steps"] if s["step"] == "iam_gcs_agent_on_key")
    assert grant["ok"] is False
    assert "guessing" in grant["detail"]
    # And the bucket, which cannot work without it, is not attempted.
    bucket = next(s for s in result["steps"] if s["step"] == "cmek_bucket")
    assert bucket.get("skipped") is True


def test_a_missing_prerequisite_skips_only_what_depends_on_it() -> None:
    """Narrower than stopping the run: mail and scheduling do not need the bucket."""
    session = _Session(
        [_Response(200, {"name": "operations/x", "done": True})] + [_Response(200, {})] * 24,
        routes={"storage/v1/projects/": _Response(500, text="lookup down")},
    )
    result = _boot(session, bootstrap_sa=BOOTSTRAP_SA).apply(_plan(), dry_run=False)
    assert set(result["skipped"]) == {"cmek_bucket", "iam_pod_sa_on_bucket"}
    for still_run in ("mail_topic", "mail_subscription", "watch_renew_job"):
        assert next(s for s in result["steps"] if s["step"] == still_run)["ok"] is True


def test_the_bootstrap_can_act_as_the_pod_account_and_nothing_wider() -> None:
    """Cloud Run refused with "Permission 'iam.serviceaccounts.actAs' denied".

    The cheap fix is roles/iam.serviceAccountUser on the PROJECT, which would let the
    bootstrap act as every service account the person owns — including accounts that
    have nothing to do with hushh. The binding is on the one account this bootstrap
    just created instead, so the user's one-time authorization does not grow.
    """
    grant = next(
        c
        for c in _boot(_Session([]), bootstrap_sa=BOOTSTRAP_SA).plan_calls(_plan())
        if c["step"] == "iam_bootstrap_can_run_as_pod"
    )
    assert grant["bindings"][0]["role"] == "roles/iam.serviceAccountUser"
    assert grant["bindings"][0]["members"] == [f"serviceAccount:{BOOTSTRAP_SA}"]
    # Scoped to the service-account resource, never the project.
    assert "/serviceAccounts/" in grant["write_url"]
    assert "cloudresourcemanager" not in grant["write_url"]
    # And the ask made of the user is unchanged.
    assert all(role != "roles/iam.serviceAccountUser" for role, _why in BOOTSTRAP_ROLES)


def test_an_unknown_bootstrap_identity_omits_the_grant_rather_than_guessing_one() -> None:
    """Binding a grant to a guessed principal is an access grant to the wrong account."""
    steps = [c["step"] for c in _boot(_Session([])).plan_calls(_plan())]
    assert "iam_bootstrap_can_run_as_pod" not in steps


# -- the IAM race the bootstrap opens for itself --------------------------------------


class _HttpError(Exception):
    def __init__(self, status: int, text: str) -> None:
        super().__init__(text)
        self.response = type("R", (), {"status_code": status, "text": text})()


async def test_a_just_written_actas_binding_is_waited_out_not_reported_as_denied() -> None:
    """The bootstrap grants itself actAs moments before using it, and IAM lags.

    Observed live: the create was refused, and the identical call succeeded once the
    binding had propagated. Reporting the first 403 as failure would make BYOC
    intermittently broken for a reason that fixes itself.
    """
    from hushh_mcp.services import user_gcp_backend as mod

    attempts = {"n": 0}

    async def create():
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise _HttpError(403, "Permission 'iam.serviceaccounts.actAs' denied on ...")

    original = mod.UserGcpBackend._ACTAS_BACKOFF_SECONDS
    mod.UserGcpBackend._ACTAS_BACKOFF_SECONDS = (0.0, 0.0, 0.0, 0.0)
    try:
        await mod._create_once_iam_settles(create)
    finally:
        mod.UserGcpBackend._ACTAS_BACKOFF_SECONDS = original
    assert attempts["n"] == 3


async def test_a_403_that_is_not_the_actas_race_is_raised_immediately() -> None:
    """A revoked grant is an answer the operator needs, not a delay before the answer."""
    from hushh_mcp.services import user_gcp_backend as mod

    attempts = {"n": 0}

    async def create():
        attempts["n"] += 1
        raise _HttpError(403, "caller does not have permission run.services.create")

    with pytest.raises(_HttpError):
        await mod._create_once_iam_settles(create)
    assert attempts["n"] == 1, "a real denial must not be retried"


# -- the rendered pod, which is where the promise is actually kept or broken -----------
#
# `byoc_key_env` was correct and had no caller: `render_deploy_config` reused the managed
# renderer wholesale, so a BYOC pod was rendered with hushh's bucket, hushh-derived
# plaintext keys, and no runtime identity of its own. The unit test below it passed the
# whole time. These assert the artifact, not the helper.


def _byoc_pod(monkeypatch):
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "hushh-pda-dev-pod-state")
    monkeypatch.setenv("HUSSH_POD_KEY_MASTER", base64.b64encode(b"M" * 48).decode())
    backend = UserGcpBackend(user_project=USER_PROJECT, image="img", live=False)
    cfg = backend.render_deploy_config(_spec())
    return cfg["spec"]["template"]["spec"]


def test_a_byoc_pod_is_never_handed_a_plaintext_key(monkeypatch) -> None:
    """A Cloud Run env var is readable by anyone with run.services.get.

    In the user's project that turns a key which was supposed to need KMS into one
    that needs only a service description.
    """
    env = {e["name"]: e.get("value", "") for e in _byoc_pod(monkeypatch)["containers"][0]["env"]}
    assert "HUSSH_POD_LOG_KEY" not in env
    assert "HUSSH_POD_MEMORY_KEY" not in env
    # Two addresses instead: where the key is, and what may open it.
    assert env[WRAPPED_KEY_OBJECT_ENV] == "keys/log-key.wrapped"
    assert env[KMS_KEY_ENV].startswith(f"projects/{USER_PROJECT}/")


def test_a_byoc_pod_writes_to_the_users_bucket_not_hushhs(monkeypatch) -> None:
    """The single most consequential line in the render: whose storage this is."""
    env = {e["name"]: e.get("value", "") for e in _byoc_pod(monkeypatch)["containers"][0]["env"]}
    assert env["POD_STORAGE_GCS_BUCKET"] == f"one-pod-{HUSHH_ID.lower()}-blobs"
    assert "hushh-pda-dev" not in env["POD_STORAGE_GCS_BUCKET"]


def test_a_byoc_pod_runs_as_its_own_least_privilege_identity(monkeypatch) -> None:
    """Unset means the DEFAULT COMPUTE account, which is not a smaller mistake.

    Every per-resource binding the bootstrap writes is addressed to the pod account. A
    pod running as anything else inherits none of them and rather a lot else.
    """
    runs_as = _byoc_pod(monkeypatch).get("serviceAccountName", "")
    assert runs_as == f"one-pod-{HUSHH_ID.lower()}@{USER_PROJECT}.iam.gserviceaccount.com"


def test_the_memory_key_is_derived_in_the_pod_and_differs_from_the_log_key() -> None:
    """One wrapped secret, two purposes, and hushh holds neither."""
    from hushh_mcp.services.byoc_key_custody import derive_memory_key

    dek = b"\x11" * 32
    memory = derive_memory_key(dek)
    assert len(memory) == 32
    assert memory != dek, "a memory key usable as a log key is one key wearing two hats"
    assert derive_memory_key(dek) == memory, "derivation must be stable across boots"
