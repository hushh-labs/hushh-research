"""A BYOC pod's registry row must record the liveness rule the pod actually runs under.

THE BUG THESE TESTS LOCK OUT. ``UserGcpBackend`` emitted no ``livenessMode`` in any of
its three ``BackendHandle`` metadata blocks (plan, live, discover). The provisioning
service records ``liveness_mode`` from exactly that field
(``personal_agent_provisioning_service.py``), the registry upsert drops ``None``
fields, so migration 905's column default ``'warm'`` stuck to every user-owned row --
and the hub's liveness sweep then judged every scaled-to-zero BYOC pod under warm
rules: degraded, then probed on a schedule, each probe waking and billing a healthy
sleeping economy pod. Exactly the failure the economy tier exists to prevent.

Three seams, one contract:

* plan mode computes the mode from the same tier resolution the renderer will apply;
* ``_execute_live`` reads it back from the config it actually deployed;
* ``discover`` reads it from the adopted service's own live annotation
  (``minScale`` absent means 0 on Cloud Run).

Plus the end-to-end assertion that would have caught the original bug: a provision
through ``PersonalAgentProvisioningService`` lands ``liveness_mode='economy'`` on the
row itself, for BYOC and for a default-spec managed pod alike.
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

MIN_SCALE = "autoscaling.knative.dev/minScale"

_UID = "firebase_uid_liveness_test"
_PHONE = "+14255550188"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    # The deployment default must come from the code's own default (0, economy),
    # never from whatever the developer's shell happens to export.
    monkeypatch.delenv("HUSSH_POD_MIN_INSTANCES", raising=False)
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


def _spec(hushh_id: str = "HA1ABC", **kw) -> PodSpec:
    return PodSpec(hushh_id=hushh_id, phone_e164_hash="h", pod_pubkey="pub", **kw)


# -- plan mode: the exact shape of the original bug --------------------------------


async def test_plan_mode_default_spec_records_economy_with_env_unset():
    """No resource_tier, no env override: the handle must still SAY economy.

    Silence is the bug. An absent field is not read as economy anywhere downstream --
    it is read as the registry column's 'warm' default, which is the opposite.
    """
    backend = UserGcpBackend(user_project="acme-user-proj", image="i", live=False)
    handle = await backend.provision(_spec())
    assert handle.backend_metadata["livenessMode"] == "economy"


# -- the live path: read back from the config actually deployed --------------------


class _CapturingRunClient:
    """A fake ``GcpRunClient`` for the first-provision (create) path.

    ``get_service`` answers None so ``_execute_live`` takes the create branch, and
    ``create_service`` captures the rendered config -- the artifact the handle's
    ``livenessMode`` must be read back from, not re-derived beside.
    """

    def __init__(self):
        self.created: list[dict] = []
        self.invoker_bindings: list[tuple[str, str]] = []

    def get_service(self, name):  # noqa: ARG002 - nothing exists before first provision
        return None

    def create_service(self, config):
        self.created.append(config)

    def wait_ready(self, name):  # noqa: ARG002
        return True, {"status": {"url": "https://one-pod-ha1abc.run.app"}}

    def set_invoker_binding(self, name, member):
        self.invoker_bindings.append((name, member))

    @staticmethod
    def service_url(svc):
        return ((svc or {}).get("status") or {}).get("url")


@pytest.mark.parametrize("min_instances,expected", [(0, "economy"), (1, "warm")])
async def test_execute_live_handle_reads_the_mode_from_the_deployed_config(
    monkeypatch, min_instances, expected
):
    live = UserGcpBackend(
        user_project="acme-user-proj",
        image="gcr.io/hushh-pda-dev/one-pod:slim-x",
        live=True,
        min_instances=min_instances,
        hushh_invoker_sa="consent-plane@hushh.iam.gserviceaccount.com",
    )
    client = _CapturingRunClient()
    monkeypatch.setattr(live, "_client", lambda: client)
    # The image copy is a network operation; the digest it returns is all that matters.
    monkeypatch.setattr(live, "_ensure_pod_image", lambda spec, digest=None: "sha256:" + "a" * 64)

    handle = await live.provision(_spec())

    assert len(client.created) == 1
    deployed = client.created[0]
    # The handle's mode and the deployed artifact's minScale are the SAME fact.
    assert deployed["spec"]["template"]["metadata"]["annotations"][MIN_SCALE] == str(min_instances)
    assert handle.backend_metadata["livenessMode"] == expected


# -- discover/adopt: the tier the pod ACTUALLY runs at, from its own service -------


class _ServiceClient:
    def __init__(self, svc):
        self._svc = svc

    def get_service(self, name):  # noqa: ARG002
        return self._svc

    @staticmethod
    def service_url(svc):
        return ((svc or {}).get("status") or {}).get("url")


def _adoptable_service(min_scale=None):
    annotations = {} if min_scale is None else {MIN_SCALE: min_scale}
    return {
        "metadata": {"name": "one-pod-ha1abc", "labels": {"hussh-tenancy": "user-owned"}},
        "spec": {"template": {"metadata": {"annotations": annotations}}},
        "status": {
            "url": "https://one-pod-ha1abc.run.app",
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }


@pytest.mark.parametrize(
    "min_scale,expected",
    [("0", "economy"), ("1", "warm"), (None, "economy")],
    ids=["minScale-0", "minScale-1", "no-annotation"],
)
async def test_discover_records_the_tier_the_adopted_pod_actually_runs_at(
    monkeypatch, min_scale, expected
):
    """An adopted pod's mode is read from its live service, never guessed.

    A service with NO minScale annotation runs at 0 on Cloud Run -- absent means
    scale-to-zero -- so adoption must record economy, not fall to the warm default.
    """
    live = UserGcpBackend(user_project="acme", live=True)
    monkeypatch.setattr(live, "_client", lambda: _ServiceClient(_adoptable_service(min_scale)))
    handle = await live.discover("ha1abc")
    assert handle is not None
    assert handle.backend_metadata["livenessMode"] == expected


# -- end to end: the ROW records economy (the assertion that would have caught it) --


class _FakeRegistry:
    def __init__(self):
        self.upserts: list[dict] = []
        self.rows: dict[str, dict] = {}

    async def upsert(self, **kw):
        self.upserts.append(kw)
        self.rows[kw["user_id"]] = {"hushh_id": kw["hushh_id"], "external_agent_id": None}

    async def get(self, user_id):
        return self.rows.get(user_id)

    async def tombstone_exists(self, hushh_id):  # noqa: ARG002
        return False


class _FakeGrant:
    async def issue_standing_pkm_read(self, user_id, *, ledger=None):  # noqa: ARG002
        return {
            "token": "HCT:fake",
            "expiresAt": 9_999_999_999_999,
            "scope": "pkm.read",
            "agentId": "personal_agent",
        }

    async def revoke_standing_pkm_read(self, user_id, *, ledger=None):  # noqa: ARG002
        return {"revoked": True, "scope": "pkm.read", "agentId": "personal_agent"}


async def _provision_row(backend) -> dict:
    registry = _FakeRegistry()
    svc = PersonalAgentProvisioningService(registry=registry, grant=_FakeGrant(), backend=backend)
    pod = generate_pod_keypair().public()
    result = await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )
    assert result["status"] == "provisioned"
    return registry.upserts[-1]


async def test_byoc_provision_records_economy_liveness_mode_on_the_row():
    """The end-to-end gap: handle metadata -> _record -> upsert row.

    Before the fix the BYOC handle carried no livenessMode, `_record` therefore
    passed liveness_mode=None, the repo dropped the None field, and the column
    default 'warm' stuck -- so the sweep woke (billed) sleeping economy pods.
    """
    row = await _provision_row(
        UserGcpBackend(
            user_project="acme-user-proj",
            image="gcr.io/hushh-pda-dev/one-pod:slim-x",
            live=False,
        )
    )
    assert row["status"] == "provisioned"
    assert row["liveness_mode"] == "economy"
    assert row["backend_metadata"]["livenessMode"] == "economy"


async def test_managed_default_provision_records_economy_liveness_mode_on_the_row():
    """The managed twin: economy-by-default holds on the ROW, not just the handle.

    `test_gcp_backend.py` pins the deployment default at minScale 0; this pins that a
    default-spec provision carries that verdict all the way into `liveness_mode`.
    """
    row = await _provision_row(GcpBackend(project="p", image="i", live=False))
    assert row["status"] == "provisioned"
    assert row["liveness_mode"] == "economy"
    assert row["backend_metadata"]["livenessMode"] == "economy"
