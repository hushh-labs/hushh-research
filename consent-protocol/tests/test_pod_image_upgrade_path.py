"""A running pod can be moved to a newer image without losing its memory.

The ledger item this proves: ``pod-image-has-a-supported-upgrade-path``
(config/pod-completion-ledger.yaml). Until 2026-09-02 the only path that touched a
running pod's revision was a heal, and a heal deliberately converges to the digest
ALREADY deployed -- so a fix shipped to the hub never reached a pod that was
already running. The founder's first BYOC pod ran an image five commits behind the
hub that built it and served that older code's 502 on the calendar door while every
hub-side test was green.

Hermetic: no cloud, no database, no registry copy. The Cloud Run client and the
image-copy primitives are doubles that record what they were asked to do, and the
assertions are about the ORDER and CONTENT of those calls, because that is where
"memory and identity survive" is decided:

* the service is replaced in place (PUT), never deleted and re-created, so the URL
  the hub recorded still resolves;
* the replaced revision carries the SAME bucket, prefix and service account the pod
  was born with -- the person's history and identity key live there, not in the
  container being swapped;
* the source tag is resolved AGAIN (a heal would not), and the digest it resolves to
  is what the person's own registry receives and what the revision pins;
* the registry row keeps its status, identity and substrate receipt, and gains only
  the image facts that changed.
"""

from __future__ import annotations

import copy
from typing import Any, Optional

import pytest

from hushh_mcp.runtime_settings import (
    get_core_security_settings,
    personal_agent_upgrade_batch,
    personal_agent_upgrade_sweep_enabled,
)
from hushh_mcp.services import pod_image_copy
from hushh_mcp.services import user_gcp_backend as ugb
from hushh_mcp.services.compute_backend import BackendHandle, PodBootFailedError, PodSpec
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.personal_agent_reconcile_worker import (
    PersonalAgentReconcileWorker,
    StalePod,
)
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

OLD = "sha256:" + "a" * 64
NEW = "sha256:" + "b" * 64
SOURCE_OLD = "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-395b8c959"
SOURCE_NEW = "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-331a11456"
INVOKER = "consent-plane@hushh.iam.gserviceaccount.com"
HUSHH_ID = "ha1_27mqrdirlc56t4p2inqkthnwfrohj62o"


def _spec() -> PodSpec:
    return PodSpec(
        hushh_id=HUSHH_ID, phone_e164_hash="hash", pod_pubkey="", billing_space_id="sp_1"
    )


def _service_json(name: str, digest: Optional[str], *, env: Optional[list] = None) -> dict:
    image = (
        f"us-central1-docker.pkg.dev/acme-user-proj/one-pod/consent-protocol-pod@{digest}"
        if digest
        else "us-central1-docker.pkg.dev/acme-user-proj/one-pod/consent-protocol-pod:dev-x"
    )
    return {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": name,
            "namespace": "acme-user-proj",
            "uid": "uid-from-cloud-run",
            "resourceVersion": "rv-17",
            "labels": {"app": "hussh-one-pod"},
        },
        "spec": {
            "template": {
                "spec": {
                    "serviceAccountName": "one-pod-ha1-27mqrdirl-soqd7cii@acme-user-proj.iam.gserviceaccount.com",
                    "containers": [{"image": image, "env": env or []}],
                }
            }
        },
        "status": {
            "url": "https://one-pod.a.run.app",
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }


class FakeRun:
    """The four Cloud Run calls an upgrade may make, recorded."""

    def __init__(
        self,
        name: str,
        *,
        existing_digest: Optional[str] = OLD,
        ready: bool = True,
        boot_message: Optional[str] = None,
    ) -> None:
        self.services: dict[str, dict] = {}
        if existing_digest is not None:
            self.services[name] = _service_json(name, existing_digest)
        self.ready = ready
        self.boot_message = boot_message
        self.replaced: list[dict] = []
        self.created: list[dict] = []
        self.bindings: list[str] = []

    def get_service(self, name: str) -> Optional[dict]:
        svc = self.services.get(name)
        return copy.deepcopy(svc) if svc else None

    merge_for_replace = staticmethod(GcpRunClient.merge_for_replace)
    service_url = staticmethod(GcpRunClient.service_url)
    ready_failure = staticmethod(GcpRunClient.ready_failure)

    def replace_service(self, name: str, body: dict, *, revision_nonce=None) -> dict:
        assert name in self.services, "replace is not a create"
        self.replaced.append(copy.deepcopy(body))
        self.services[name] = {**self.services[name], "spec": body["spec"]}
        return body

    def create_service(self, config: dict) -> dict:
        self.created.append(config)
        return config

    def wait_ready(self, name: str, **_: Any):
        svc = copy.deepcopy(self.services[name])
        if self.ready:
            svc["status"] = {
                "url": "https://one-pod.a.run.app",
                "conditions": [{"type": "Ready", "status": "True"}],
            }
        else:
            svc["status"] = {
                "conditions": [
                    {"type": "Ready", "status": "False", "message": self.boot_message or "boom"}
                ]
            }
        return self.ready, svc

    def set_invoker_binding(self, name: str, member: str) -> None:
        self.bindings.append(member)


class CopyLog:
    def __init__(self) -> None:
        self.resolved: list[str] = []
        self.copied: list[tuple[str, str]] = []


@pytest.fixture
def copy_log(monkeypatch) -> CopyLog:
    log = CopyLog()

    def _identity(session=None):
        return "tok", INVOKER

    def _resolve(image_ref, token, session=None):
        log.resolved.append(image_ref)
        return NEW

    def _exists(ref, token, session=None):
        return False

    def _copy(source, dest, token, session=None):
        log.copied.append((source, dest))

    monkeypatch.setattr(pod_image_copy, "attached_identity", _identity)
    monkeypatch.setattr(pod_image_copy, "resolve_source_digest", _resolve)
    monkeypatch.setattr(pod_image_copy, "image_exists", _exists)
    monkeypatch.setattr(pod_image_copy, "copy_image", _copy)
    return log


def _backend(run: FakeRun, *, image: str = SOURCE_NEW) -> UserGcpBackend:
    backend = UserGcpBackend(
        user_project="acme-user-proj",
        user_region="us-central1",
        image=image,
        hushh_invoker_sa=INVOKER,
        live=True,
    )
    backend._client = lambda: run  # noqa: E731 - instance attribute shadows the method
    return backend


def _image_of(body: dict) -> str:
    return str(body["spec"]["template"]["spec"]["containers"][0]["image"])


def _env_of(body: dict) -> dict[str, str]:
    return {
        e["name"]: e.get("value", "")
        for e in body["spec"]["template"]["spec"]["containers"][0].get("env", [])
    }


# ---------------------------------------------------------------------------
# The backend: replace in place, resolve the tag fresh, keep the anchors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upgrade_resolves_the_source_tag_fresh_and_replaces_in_place(copy_log):
    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=OLD)

    handle = await _backend(run).upgrade(_spec())

    assert copy_log.resolved == [SOURCE_NEW], "an upgrade resolves the tag again"
    assert copy_log.copied and copy_log.copied[0][1].endswith(f"@{NEW}"), (
        "the NEW digest is what lands in the person's own registry"
    )
    assert run.created == [], "an upgrade never creates"
    assert len(run.replaced) == 1
    body = run.replaced[0]
    assert _image_of(body).endswith(f"@{NEW}")
    # System-managed metadata survives the PUT (this is what keeps the URL).
    assert body["metadata"]["uid"] == "uid-from-cloud-run"
    assert body["metadata"]["resourceVersion"] == "rv-17"
    meta = handle.backend_metadata or {}
    assert handle.status == "live"
    assert meta["image_digest"] == NEW
    assert meta["previous_image_digest"] == OLD
    assert meta["upgraded"] is True
    assert meta["source_image"] == SOURCE_NEW
    assert meta["image"].endswith(f"@{NEW}")


@pytest.mark.asyncio
async def test_a_heal_converges_to_the_deployed_digest_and_only_upgrade_rolls_forward(copy_log):
    """The contrast the ledger item names: provision on an existing service is a heal
    and pins what is already running; upgrade is the one path that moves it."""
    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=OLD)

    await _backend(run).provision(_spec())

    assert copy_log.resolved == [], "a heal never re-resolves the mutable tag"
    assert _image_of(run.replaced[-1]).endswith(f"@{OLD}")

    await _backend(run).upgrade(_spec())

    assert copy_log.resolved == [SOURCE_NEW]
    assert _image_of(run.replaced[-1]).endswith(f"@{NEW}")


@pytest.mark.asyncio
async def test_upgrade_keeps_the_memory_bucket_identity_and_service_account(copy_log):
    """Memory and identity live in the bucket and the pod's own service account, not
    in the container. The upgraded revision must name exactly what the pod was born
    with: same bucket, same prefix, same runtime identity, same service name."""
    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=OLD)
    backend = _backend(run)
    born_with = backend.render_deploy_config(_spec(), image_digest=OLD)

    await backend.upgrade(_spec())

    upgraded = run.replaced[0]
    before, after = _env_of(born_with), _env_of(upgraded)
    for anchor in ("POD_STORAGE_GCS_BUCKET", "POD_STORAGE_GCS_PREFIX", "POD_STORAGE_BACKEND"):
        assert anchor in before, anchor
        assert after[anchor] == before[anchor], anchor
    assert after["POD_STORAGE_GCS_PREFIX"] == f"pods/{HUSHH_ID}"
    assert (
        upgraded["spec"]["template"]["spec"]["serviceAccountName"]
        == born_with["spec"]["template"]["spec"]["serviceAccountName"]
    )
    assert upgraded["metadata"]["name"] == name
    # Everything except the image is byte-identical between the two renders.
    assert {k: v for k, v in after.items()} == {k: v for k, v in before.items()}
    assert _image_of(born_with).endswith(f"@{OLD}") and _image_of(upgraded).endswith(f"@{NEW}")


@pytest.mark.asyncio
async def test_upgrade_is_a_noop_when_the_pod_already_runs_the_current_digest(copy_log):
    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=NEW)

    handle = await _backend(run).upgrade(_spec())

    assert run.replaced == [] and run.created == []
    assert (handle.backend_metadata or {})["upgraded"] is False
    assert (handle.backend_metadata or {})["image_digest"] == NEW


@pytest.mark.asyncio
async def test_upgrade_refuses_when_there_is_no_pod_service(copy_log):
    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=None)
    run.services.clear()

    with pytest.raises(RuntimeError, match="no pod service"):
        await _backend(run).upgrade(_spec())
    assert run.created == [] and run.replaced == []


@pytest.mark.asyncio
async def test_upgrade_raises_when_the_new_revision_fails_to_boot(copy_log):
    """Cloud Run keeps the previous revision serving; the hub must not record a
    digest that is not the one answering."""
    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=OLD, ready=False, boot_message="import error in worker")

    with pytest.raises(PodBootFailedError, match="previous revision keeps serving"):
        await _backend(run).upgrade(_spec())


@pytest.mark.asyncio
async def test_plan_mode_upgrade_touches_nothing():
    backend = UserGcpBackend(
        user_project="acme-user-proj", image=SOURCE_NEW, hushh_invoker_sa=INVOKER, live=False
    )
    handle = await backend.upgrade(_spec())
    assert handle.status == "planned"
    assert (handle.backend_metadata or {})["upgraded"] is False


# ---------------------------------------------------------------------------
# The service: the row keeps who it is and gains only the image facts
# ---------------------------------------------------------------------------


class FakeRegistry:
    def __init__(self, rows: dict[str, dict]) -> None:
        self.rows = rows
        self.upserts: list[dict] = []
        self.upgrade_writes: list[dict] = []

    async def get(self, user_id: str) -> Optional[dict]:
        row = self.rows.get(user_id)
        return copy.deepcopy(row) if row else None

    async def upsert(self, **kw) -> None:
        self.upserts.append(kw)

    async def fetch_upgrade_candidates(self, *, limit: int = 200) -> list[dict]:
        return [copy.deepcopy(r) for r in self.rows.values() if r.get("status") == "provisioned"][
            :limit
        ]

    async def record_image_upgrade(self, *, user_id, backend_metadata, liveness_mode=None):
        self.upgrade_writes.append(
            {
                "user_id": user_id,
                "backend_metadata": backend_metadata,
                "liveness_mode": liveness_mode,
            }
        )
        self.rows[user_id]["backend_metadata"] = backend_metadata


class FakeUpgradingBackend:
    backend_id = "fake"

    def __init__(self, *, fail: Optional[Exception] = None) -> None:
        self.fail = fail
        self.specs: list[PodSpec] = []

    async def provision(self, spec):  # pragma: no cover - never reached
        raise AssertionError("an upgrade must not provision")

    async def deprovision(self, external_agent_id):  # pragma: no cover
        raise AssertionError("an upgrade must not deprovision")

    async def get(self, external_agent_id):  # pragma: no cover
        raise AssertionError

    async def health(self):  # pragma: no cover
        return True

    async def upgrade(self, spec: PodSpec) -> BackendHandle:
        self.specs.append(spec)
        if self.fail is not None:
            raise self.fail
        return BackendHandle(
            external_agent_id="one-pod-x",
            a2a_route=f"https://a2a.hushh.ai/u/{spec.hushh_id}",
            status="live",
            backend=self.backend_id,
            backend_metadata={
                "image": f"reg/copy@{NEW}",
                "source_image": SOURCE_NEW,
                "image_digest": NEW,
                "previous_image_digest": OLD,
                "upgraded": True,
                "livenessMode": "economy",
            },
        )


def _row(*, source_image: str = SOURCE_OLD, status: str = "provisioned", marker=None) -> dict:
    meta = {
        "tenancy": "user-owned",
        "image": f"reg/copy@{OLD}",
        "source_image": source_image,
        "image_digest": OLD,
        "substrateReceipt": {"resource_ids": ["kms", "bucket"]},
    }
    if marker:
        meta["upgrade"] = marker
    return {
        "user_id": "uid-1",
        "hushh_id": HUSHH_ID,
        "phone_e164_hash": "hash",
        "status": status,
        "billing_space_id": "sp_1",
        "pod_pubkey": "pubkey-b64",
        "pod_key_id": "key-1",
        "backend": "fake",
        "backend_metadata": meta,
        "deployment_target": None,
    }


@pytest.fixture
def service_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()
    from hushh_mcp.services import personal_agent_provisioning_service as pas

    async def _no_cloud(user_id, *, repo=None):
        return None

    narrative: list[dict] = []

    async def _append(user_id, **kw):
        narrative.append({"user_id": user_id, **kw})

    monkeypatch.setattr(pas, "resolve_user_cloud", _no_cloud)
    monkeypatch.setattr(pas, "pod_lifecycle_append", _append)
    yield pas, narrative
    get_core_security_settings.cache_clear()


@pytest.mark.asyncio
async def test_upgrade_pod_rewrites_only_the_image_facts(service_env):
    pas, narrative = service_env
    registry = FakeRegistry({"uid-1": _row()})
    backend = FakeUpgradingBackend()
    service = pas.PersonalAgentProvisioningService(registry=registry, backend=backend)

    result = await service.upgrade_pod(user_id="uid-1", current_image=SOURCE_NEW)

    assert result["upgraded"] is True
    assert result["image"] == SOURCE_NEW and result["previousImage"] == SOURCE_OLD
    assert registry.upserts == [], "status, provisioned_at and identity are never rewritten"
    assert len(registry.upgrade_writes) == 1
    meta = registry.upgrade_writes[0]["backend_metadata"]
    assert meta["substrateReceipt"] == {"resource_ids": ["kms", "bucket"]}, (
        "teardown inventory kept"
    )
    assert meta["image_digest"] == NEW and meta["source_image"] == SOURCE_NEW
    assert "upgrade" not in meta
    # The spec handed to the backend was READ from the row, never re-derived.
    spec = backend.specs[0]
    assert spec.hushh_id == HUSHH_ID and spec.billing_space_id == "sp_1"
    assert spec.pod_pubkey == "pubkey-b64"
    assert [n["event"] for n in narrative] == ["upgraded"]
    assert narrative[0]["registry_status"] == "provisioned"


@pytest.mark.asyncio
async def test_upgrade_pod_records_a_bounded_failure_marker_and_reraises(service_env):
    pas, narrative = service_env
    registry = FakeRegistry({"uid-1": _row()})
    service = pas.PersonalAgentProvisioningService(
        registry=registry, backend=FakeUpgradingBackend(fail=PodBootFailedError("boot failed"))
    )

    with pytest.raises(PodBootFailedError):
        await service.upgrade_pod(user_id="uid-1", current_image=SOURCE_NEW)

    marker = registry.rows["uid-1"]["backend_metadata"]["upgrade"]
    assert marker["failedImage"] == SOURCE_NEW and marker["attempts"] == 1
    assert registry.rows["uid-1"]["backend_metadata"]["image_digest"] == OLD, "still the truth"
    assert registry.rows["uid-1"]["status"] == "provisioned"
    assert [n["event"] for n in narrative] == ["upgrade_failed"]

    with pytest.raises(PodBootFailedError):
        await service.upgrade_pod(user_id="uid-1", current_image=SOURCE_NEW)
    assert registry.rows["uid-1"]["backend_metadata"]["upgrade"]["attempts"] == 2


@pytest.mark.asyncio
async def test_upgrade_pod_refuses_a_pod_that_is_not_whole(service_env):
    pas, _ = service_env
    registry = FakeRegistry({"uid-1": _row(status="connecting")})
    service = pas.PersonalAgentProvisioningService(
        registry=registry, backend=FakeUpgradingBackend()
    )
    with pytest.raises(ValueError, match="only a provisioned pod"):
        await service.upgrade_pod(user_id="uid-1", current_image=SOURCE_NEW)
    assert registry.upgrade_writes == []


@pytest.mark.asyncio
async def test_upgrade_pod_refuses_a_backend_without_an_in_place_upgrade(service_env):
    pas, _ = service_env

    class NoUpgrade(FakeUpgradingBackend):
        upgrade = None  # type: ignore[assignment]

    registry = FakeRegistry({"uid-1": _row()})
    service = pas.PersonalAgentProvisioningService(registry=registry, backend=NoUpgrade())
    with pytest.raises(pas.PersonalAgentUpgradeUnsupportedError):
        await service.upgrade_pod(user_id="uid-1", current_image=SOURCE_NEW)


@pytest.mark.asyncio
async def test_candidates_are_the_stale_whole_pods_minus_the_ones_that_keep_failing(service_env):
    pas, _ = service_env
    registry = FakeRegistry(
        {
            "stale": {**_row(), "user_id": "stale"},
            "current": {**_row(source_image=SOURCE_NEW), "user_id": "current"},
            "no-host": {**_row(), "user_id": "no-host", "backend_metadata": {}},
            "connecting": {**_row(status="connecting"), "user_id": "connecting"},
            "gave-up": {
                **_row(
                    marker={"failedImage": SOURCE_NEW, "attempts": pas.UPGRADE_ATTEMPTS_PER_IMAGE}
                ),
                "user_id": "gave-up",
            },
            "failed-on-older": {
                **_row(marker={"failedImage": "gcr.io/x/pod:dev-older", "attempts": 9}),
                "user_id": "failed-on-older",
            },
        }
    )
    service = pas.PersonalAgentProvisioningService(
        registry=registry, backend=FakeUpgradingBackend()
    )

    rows = await service.list_upgrade_candidates(current_image=SOURCE_NEW)

    assert sorted(r["user_id"] for r in rows) == ["failed-on-older", "stale"]
    assert await service.list_upgrade_candidates(current_image="") == []


# ---------------------------------------------------------------------------
# The sweep: inert by default, bounded, one failure never stops the batch
# ---------------------------------------------------------------------------


class SweepSpy:
    def __init__(
        self, stale: list[StalePod], *, fail_for: set[str] | None = None, fetch_raises=False
    ):
        self.stale = stale
        self.fail_for = fail_for or set()
        self.fetch_raises = fetch_raises
        self.fetches = 0
        self.upgraded: list[str] = []

    async def fetch_stalled(self):
        return []

    async def retry(self, user_id):  # pragma: no cover
        raise AssertionError

    async def fetch_idle(self, _since):
        return []

    async def reap(self, _id):  # pragma: no cover
        raise AssertionError

    async def fetch_stale(self):
        self.fetches += 1
        if self.fetch_raises:
            raise RuntimeError("registry unavailable: dsn=postgres://secret@host/db")
        return list(self.stale)

    async def upgrade(self, user_id):
        if user_id in self.fail_for:
            raise RuntimeError("cloud run replace failed: token=HCT:secret")
        self.upgraded.append(user_id)


def _worker(spy: SweepSpy) -> PersonalAgentReconcileWorker:
    return PersonalAgentReconcileWorker(
        fetch_stalled=spy.fetch_stalled,
        retry=spy.retry,
        fetch_idle=spy.fetch_idle,
        reap=spy.reap,
        fetch_stale=spy.fetch_stale,
        upgrade=spy.upgrade,
    )


def _stale(n: int) -> list[StalePod]:
    return [StalePod(user_id=f"u{i}", hushh_id=f"ha1_{i}", image=SOURCE_OLD) for i in range(n)]


@pytest.fixture
def sweep_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "1")
    monkeypatch.delenv("PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED", raising=False)
    monkeypatch.delenv("PERSONAL_AGENT_UPGRADE_BATCH", raising=False)
    get_core_security_settings.cache_clear()
    yield monkeypatch
    get_core_security_settings.cache_clear()


def test_sweep_flag_and_batch_default_dark_and_small(sweep_env):
    assert personal_agent_upgrade_sweep_enabled() is False
    assert personal_agent_upgrade_batch() == 3
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_BATCH", "0")
    assert personal_agent_upgrade_batch() == 1, "a batch of nothing would be a silent off switch"
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_BATCH", "nope")
    assert personal_agent_upgrade_batch() == 3


@pytest.mark.asyncio
async def test_sweep_is_inert_until_switched_on_even_with_stale_pods(sweep_env):
    spy = SweepSpy(_stale(4))
    report = await _worker(spy).scan_and_reconcile()
    assert spy.fetches == 0 and spy.upgraded == []
    assert report.upgraded_count == 0 and report.skipped is False


@pytest.mark.asyncio
async def test_sweep_moves_one_bounded_batch_per_pass(sweep_env):
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED", "1")
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_BATCH", "2")
    spy = SweepSpy(_stale(5))
    report = await _worker(spy).scan_and_reconcile()
    assert spy.upgraded == ["u0", "u1"]
    assert report.upgraded_count == 2 and report.upgrade_failed_count == 0
    assert "2 upgraded" in report.summary()


@pytest.mark.asyncio
async def test_one_failed_upgrade_never_stops_the_batch(sweep_env):
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED", "1")
    spy = SweepSpy(_stale(3), fail_for={"u1"})
    report = await _worker(spy).scan_and_reconcile()
    assert spy.upgraded == ["u0", "u2"]
    assert report.upgraded_count == 2 and report.upgrade_failed_count == 1


@pytest.mark.asyncio
async def test_a_failing_fetch_skips_the_sweep_without_aborting_the_pass(sweep_env):
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED", "1")
    spy = SweepSpy(_stale(2), fetch_raises=True)
    report = await _worker(spy).scan_and_reconcile()
    assert spy.upgraded == []
    assert report.upgraded_count == 0 and report.upgrade_failed_count == 0


@pytest.mark.asyncio
async def test_worker_without_the_callables_never_sweeps(sweep_env):
    sweep_env.setenv("PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED", "1")
    spy = SweepSpy(_stale(2))
    worker = PersonalAgentReconcileWorker(
        fetch_stalled=spy.fetch_stalled, retry=spy.retry, fetch_idle=spy.fetch_idle, reap=spy.reap
    )
    report = await worker.scan_and_reconcile()
    assert spy.fetches == 0 and report.upgraded_count == 0


# ---------------------------------------------------------------------------
# Wiring: the hub schedules the sweep and the deploy lane carries the switch
# ---------------------------------------------------------------------------


def test_hub_startup_wires_the_sweep_and_the_deploy_lane_carries_its_flag():
    from pathlib import Path

    server = Path(__file__).resolve().parents[1] / "server.py"
    text = server.read_text(encoding="utf-8")
    assert "fetch_stale=fetch_stale" in text and "upgrade=upgrade" in text
    assert "HUSSH_ONE_POD_IMAGE" in text, "the hub's own image is the fleet target"
    deploy = Path(__file__).resolve().parents[2] / "scripts" / "deploy" / "backend-deploy.sh"
    lines = deploy.read_text(encoding="utf-8").splitlines()
    assert any('append_optional_env "PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED"' in ln for ln in lines)
    assert any(ln.strip() == 'personal_agent_upgrade_sweep="true"' for ln in lines)
