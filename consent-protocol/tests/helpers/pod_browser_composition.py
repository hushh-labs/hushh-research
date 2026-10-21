"""Real Browser composition with only cloud/model transports replaced for tests."""

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

from google.adk.models import Gemini

from hushh_mcp.services import pod_hub_client
from hushh_mcp.services.pod_browser import composition
from hushh_mcp.services.pod_browser import deployment as browser_deployment
from hushh_mcp.services.pod_browser.contracts import BrowserAction
from hushh_mcp.services.pod_browser.execution_authority import PublicResearchPolicy
from hushh_mcp.services.pod_browser.owner_model import OwnerBrowserModel
from hushh_mcp.services.pod_browser.task_contracts import BrowserOwnerAccess
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission
from tests.helpers.pod_browser import Executor, readiness


class Model:
    def __init__(self, calls):
        self.calls = calls

    async def run(self, *, control, processing, goal):
        await processing.require()
        await control.require_model_observation()
        self.calls.append(goal)
        await control.execute(
            BrowserAction(
                operation="navigate",
                url="https://example.com/research",
                sequence=control.next_sequence,
                control_epoch=control.control_epoch,
            )
        )
        return {"outcome": "completed", "summary": "Synthetic public research finished."}


def composed_browser_fixture(monkeypatch, tmp_path, post):
    ready = readiness()
    identity = SimpleNamespace(
        hushh_id="ha1_test",
        pod_key_id="podk_test",
        environment="dev",
        epoch=1,
        require_held=AsyncMock(),
    )
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="u")
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    monkeypatch.setattr(composition, "ADMISSION", admission)
    monkeypatch.setattr(composition, "active_session_authority", lambda: identity)
    monkeypatch.setattr(browser_deployment, "active_session_authority", lambda: identity)
    monkeypatch.setattr(browser_deployment, "pod_incarnation", lambda: "revision-a")
    monkeypatch.setattr(browser_deployment, "workload_platform", lambda: "gcp")
    monkeypatch.setattr(
        browser_deployment,
        "installed_browser_host",
        lambda: ("gcp_cloud_run", ready.component_digest),
    )
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    monkeypatch.setenv("HUSSH_POD_IMAGE_TAG", "synthetic-source")
    monkeypatch.setattr(pod_hub_client, "PodHubClient", lambda **_: SimpleNamespace(post=post))
    monkeypatch.setattr(
        composition,
        "resolve_owner_browser_model",
        lambda _: OwnerBrowserModel(Gemini(model=ready.model_name), AsyncMock()),
    )
    executor = Executor()
    launcher = SimpleNamespace(
        readiness=ready, launch=AsyncMock(return_value=executor), close=AsyncMock()
    )
    monkeypatch.setattr(composition.InPodBrowserLauncher, "from_bootstrap", lambda **_: launcher)
    model_calls = []

    monkeypatch.setattr(
        composition,
        "NativeAdkBrowserModel",
        lambda *_: SimpleNamespace(
            model_name=ready.model_name, transport=ready.model_transport, run=Model(model_calls).run
        ),
    )
    deployment = composition.BrowserDeployment(
        version=1,
        environment="development",
        pod_id="ha1_test",
        pod_key_id="podk_test",
        incarnation="revision-a",
        image_tag="synthetic-source",
        host_kind="gcp_cloud_run",
        evidence_sha256="a" * 64,
        readiness=ready,
        public_policy=PublicResearchPolicy(
            page_urls=("https://example.com/research",),
        ),
    )
    composed = composition.PodBrowserComposition(
        deployment=deployment,
        authority=identity,
        log=log,
        dek=b"K" * 32,
    )
    owner = BrowserOwnerAccess("u", "ha1_test", "revision-a", int(time.time()) + 600, AsyncMock())
    return SimpleNamespace(
        composed=composed,
        owner=owner,
        model_calls=model_calls,
        launcher=launcher,
        executor=executor,
        admission=admission,
        log=log,
    )


async def wait_phase(runtime, owner, task_id, expected):
    async with asyncio.timeout(5):
        while True:
            snapshot = await runtime.read(owner, task_id)
            if snapshot.phase == expected:
                return snapshot
            assert snapshot.phase not in {"unavailable", "outcome_uncertain"}
            await asyncio.sleep(0.005)


def qualified_browser_installation_fixture(monkeypatch, tmp_path, host_kind):
    from hushh_mcp.services.pod_browser import deployment as install

    startup = composition
    authority = SimpleNamespace(
        hushh_id="pod",
        pod_key_id="key",
        environment="dev",
        epoch=1,
        require_held=AsyncMock(),
    )
    monkeypatch.setattr(startup, "active_session_authority", lambda: authority)
    monkeypatch.setattr(install, "active_session_authority", lambda: authority)
    monkeypatch.setattr(install, "pod_incarnation", lambda: "epoch")
    cloud = "gcp" if host_kind == "gcp_cloud_run" else "azure"
    monkeypatch.setattr(install, "workload_platform", lambda: cloud)
    monkeypatch.setattr(install, "active_vm_installation", lambda: None)
    monkeypatch.setattr(startup, "ADMISSION", PodUpgradeAdmission(log_resolver=lambda: None))
    monkeypatch.setenv("HUSSH_POD_IMAGE_TAG", "synthetic-source")
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    monkeypatch.delenv("HUSSH_BROWSER_QUALIFICATION_JSON", raising=False)
    monkeypatch.delenv("HUSSH_BROWSER_POLICY_JSON", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("K_REVISION", raising=False)
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner")
    qualified = {
        "version": 1,
        "host_kind": host_kind,
        "source_revision": "a" * 40,
        "image_tag": "synthetic-source",
        "evidence_sha256": "b" * 64,
        "public_policy_sha256": PublicResearchPolicy(
            page_urls=("https://example.com/research",)
        ).digest,
        "readiness": readiness(cloud=cloud).model_dump(),
    }
    policy = {
        "version": 1,
        "pod_id": "pod",
        "pod_key_id": "key",
        "public_policy": {"page_urls": ["https://example.com/research"]},
    }
    return SimpleNamespace(
        authority=authority, log=log, qualified=qualified, policy=policy, cloud=cloud
    )


def install_test_browser_host(monkeypatch, cloud):
    if cloud == "gcp":
        monkeypatch.setenv("K_SERVICE", "owner-service")
        monkeypatch.setenv("K_REVISION", "new-platform-revision")
        monkeypatch.setenv("HUSSH_POD_INSTALLED_IMAGE_DIGEST", "sha256:" + "a" * 64)
    else:
        monkeypatch.setattr(
            browser_deployment,
            "active_vm_installation",
            lambda: SimpleNamespace(image_digest="sha256:" + "a" * 64),
        )


def browser_startup_ports(monkeypatch, deployment):
    launcher = SimpleNamespace(readiness=deployment.readiness, close=AsyncMock())
    monkeypatch.setattr(composition.InPodBrowserLauncher, "from_bootstrap", lambda **_: launcher)
    selected = OwnerBrowserModel(Gemini(model=deployment.readiness.model_name), AsyncMock())
    monkeypatch.setattr(composition, "resolve_owner_browser_model", lambda _: selected)
    owner = BrowserOwnerAccess("owner", "pod", "epoch", 2**31 - 1, AsyncMock())
    return SimpleNamespace(launcher=launcher, owner=owner)
