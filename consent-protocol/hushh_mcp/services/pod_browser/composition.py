"""Startup composition of the qualified, public Browser pilot.

The existing release carries reviewed image qualification separately from owner
activation/policy. Startup binds both after authenticated recovery. Login,
retained sessions and PKM remain refused until their own ports are installed.
"""

from __future__ import annotations

import asyncio
import hmac
import os
from pathlib import Path

from hushh_mcp.services.pod_ai_selection import ai_selection_revision
from hushh_mcp.services.pod_session_authority import active_session_authority
from hushh_mcp.services.pod_upgrade_admission import ADMISSION

from .adk_task import NativeAdkBrowserModel
from .contracts import BrowserBinding, BrowserRefused
from .deployment import BrowserDeployment, recovered_browser_deployment
from .dispatch_journal import BrowserDispatchJournal
from .execution_authority import (
    BrowserExecutionAuthority,
    PublicResearchNetworkAuthority,
)
from .inpod_launcher import InPodBrowserLauncher
from .owner_model import resolve_owner_browser_model
from .review_client import PodBrowserReviews
from .task_contracts import BrowserOwnerAccess
from .task_runtime import BrowserTaskRuntime


class _NoInformation:
    async def read(self, binding, field):
        raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE")


class PodBrowserComposition:
    def __init__(self, *, deployment: BrowserDeployment, authority, log, dek: bytes) -> None:
        deployment.require_current(authority)
        if log is None or not isinstance(dek, bytes) or len(dek) != 32:
            raise BrowserRefused("BROWSER_RECOVERY_UNAVAILABLE")
        self._deployment, self._authority, self._log = deployment, authority, log
        self._key = hmac.digest(dek, b"hussh/pod-browser-custody/v1", "sha256")
        self._lock = asyncio.Lock()
        self._owner: str | None = None
        self._runtime: BrowserTaskRuntime | None = None
        self._journal: BrowserDispatchJournal | None = None
        self._closed = False
        self._closing = False
        # Adopt the inherited channel once, only after custody and qualification.
        self._launcher = InPodBrowserLauncher.from_bootstrap(
            readiness=deployment.readiness, network_authority=self._network
        )

    def _network(self, binding, consent, authority):
        if self._journal is None:
            raise BrowserRefused("BROWSER_RECOVERY_UNAVAILABLE")
        return PublicResearchNetworkAuthority(
            binding, consent, self._journal, self._deployment.public_policy
        )

    async def _held(self) -> None:
        if self._closed or self._closing:
            raise BrowserRefused("BROWSER_STOPPED")
        self._deployment.require_current(self._authority)
        await self._authority.require_held()
        await self._log.require_open()

    async def bind(self, access: BrowserOwnerAccess) -> BrowserTaskRuntime:
        await access.check()
        await self._held()
        if (
            access.pod_id != self._deployment.pod_id
            or access.incarnation != self._deployment.incarnation
        ):
            raise BrowserRefused("BROWSER_OWNER_REFUSED")
        async with self._lock:
            # close() may have won this lock while the admitted caller waited.
            # Never publish a runtime backed by an already closed launcher.
            await self._held()
            if self._owner is not None and access.owner_id != self._owner:
                raise BrowserRefused("BROWSER_OWNER_REFUSED")
            if self._runtime is not None:
                return self._runtime
            selected = resolve_owner_browser_model(self._held)
            await selected.require_current()
            model = selected.model
            transport = f"{type(model).__module__}.{type(model).__qualname__}"
            ready = self._deployment.readiness
            if (model.model, transport) != (ready.model_name, ready.model_transport):
                raise BrowserRefused("BROWSER_MODEL_TRANSPORT_UNVERIFIED")
            owner_id = access.owner_id
            revision = ai_selection_revision()

            def available() -> None:
                if self._closed or self._closing:
                    raise BrowserRefused("BROWSER_STOPPED")
                self._deployment.require_current(self._authority)
                if ai_selection_revision() != revision:
                    raise BrowserRefused("BROWSER_MODEL_SELECTION_CHANGED")

            async def bound(binding: BrowserBinding) -> None:
                await selected.require_current()
                if (binding.owner_id, binding.pod_id, binding.incarnation) != (
                    owner_id,
                    self._deployment.pod_id,
                    self._deployment.incarnation,
                ):
                    raise BrowserRefused("BROWSER_BINDING_REFUSED")

            from hushh_mcp.hushh_adk.manifest import ManifestLoader
            from hushh_mcp.services.pod_hub_client import PodHubClient

            journal = BrowserDispatchJournal(
                self._log, key=self._key, owner_id=owner_id, pod_id=access.pod_id
            )
            reviews = PodBrowserReviews(
                key=self._key,
                pod_key_id=self._authority.pod_key_id,
                environment=self._authority.environment,
                epoch=self._authority.epoch,
                check_binding=bound,
                client=PodHubClient(timeout_seconds=10),
            )
            manifest = ManifestLoader.load(
                str(Path(__file__).resolve().parents[2] / "agents/computer_use/agent.yaml")
            )
            await access.check()
            await selected.require_current()
            runtime = BrowserTaskRuntime(
                owner_id=owner_id,
                pod_id=access.pod_id,
                incarnation=access.incarnation,
                launcher=self._launcher,
                model=NativeAdkBrowserModel(manifest, model),
                reviews=reviews,
                source=_NoInformation(),
                authority_factory=lambda binding, consent: BrowserExecutionAuthority(
                    binding, consent, journal, self._deployment.public_policy
                ),
                log=self._log,
                admission=ADMISSION,
                availability_check=available,
                public_research_only=True,
            )
            self._journal, self._owner, self._runtime = journal, owner_id, runtime
            return runtime

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closing = True
            try:
                if self._runtime is not None:
                    await self._runtime.drain()
            finally:
                await self._launcher.close()
                self._closed = True
                self._key = b""


def configure_browser_startup(*, authority, log, dek) -> PodBrowserComposition | None:
    if os.getenv("POD_COMPUTER_USE_ENABLED", "").lower() not in {"1", "true"}:
        return None
    deployment = recovered_browser_deployment(authority)
    return PodBrowserComposition(deployment=deployment, authority=authority, log=log, dek=dek)


async def bind_browser_owner(app, access: BrowserOwnerAccess) -> None:
    composition = getattr(app.state, "browser_composition", None)
    if not isinstance(composition, PodBrowserComposition):
        return
    try:
        app.state.browser_task_runtime = await composition.bind(access)
    except BrowserRefused as exc:
        # Discovery remains useful when a cloud/model gate is not qualified.
        # Never replace a previously bound runtime with a different owner.
        app.state.browser_unavailable_code = exc.code


def install_browser_startup(app, *, log, dek: bytes, logger) -> None:
    """Adopt the restricted launcher only after the pod's authenticated recovery."""
    from .inpod_launcher import discard_bootstrap_channel

    try:
        authority = active_session_authority()
        if authority is None:
            raise BrowserRefused("BROWSER_RECOVERY_UNAVAILABLE")
        app.state.browser_composition = configure_browser_startup(
            authority=authority, log=log, dek=dek
        )
    except BrowserRefused as exc:
        discard_bootstrap_channel()
        app.state.browser_unavailable_code = exc.code
        logger.warning("pod.browser_unavailable code=%s", exc.code)
