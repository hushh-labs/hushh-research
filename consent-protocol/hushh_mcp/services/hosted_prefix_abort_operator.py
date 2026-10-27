"""Operator-only cleanup of a retained, never-hosted managed core prefix.

The caller supplies verified short-lived authority and complete native inventory.
Retirement is a separate operation; no partial result claims account erasure.
"""

from __future__ import annotations

import asyncio
import threading
from copy import deepcopy
from typing import Any, Callable
from urllib.parse import unquote

from hushh_mcp.services.byoc_substrate_teardown import revoke_runtime_writer
from hushh_mcp.services.hosted_gcp_admission import _worker_guard
from hushh_mcp.services.hosted_model_grant_cleanup import _reservation
from hushh_mcp.services.hosted_prefix_abort_journal import PrefixAbortJournal, retained_entry
from hushh_mcp.services.hosted_prefix_iam import remove_prefix_binding
from hushh_mcp.services.hosted_prefix_native_resources import (
    BoundedPrefixSession,
    PrefixNativeResources,
)
from hushh_mcp.services.hosted_project_gcp_operator import GuardedOperatorSession
from hushh_mcp.services.hosted_project_retirement import _retire
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

InventoryObserver = Callable[[dict, str, Any], dict]


class HostedPrefixAbortOperator:
    def __init__(
        self,
        registry: Any,
        *,
        actor: str,
        token: str,
        session: Any,
        observe_inventory: InventoryObserver | None = None,
    ) -> None:
        self.registry, self.actor, self.token, self.session = registry, actor, token, session
        if observe_inventory is None:
            from hushh_mcp.services.hosted_prefix_native_inventory import NativePrefixInventory

            observe_inventory = NativePrefixInventory(registry, token=token)
        self.observe_inventory: InventoryObserver = observe_inventory

    async def prefix_abort(self, *, user_id: str, reservation: dict) -> None:
        journal, assignment = await self._journal(user_id, reservation)
        inventory = await self._inventory(journal, assignment)
        for binding in inventory["bindings"]:
            await self._binding(journal, assignment, inventory, binding)
        for item in sorted(inventory["resources"], key=lambda r: r["type"] == "kms_key"):
            await self._resource(journal, assignment, item)
        await self._bootstrap(journal, assignment)
        # The orchestrator's SQL completion check still refuses until separate retirement.

    async def retirement(self, *, user_id: str, reservation: dict) -> None:
        journal, assignment = await self._journal(user_id, reservation)
        original = reservation["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        creation = original["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
            "resourceObservation"
        ]["identity"]
        admitted = {
            **await journal.base(),
            "project": creation["projectId"],
            "projectNumber": creation["projectNumber"],
            "operatorPrincipal": self.actor,
            "status": "admitted",
        }
        saved = await journal.retain("retirement", "project", "admission", admitted)
        if retained_entry(saved, "retirement", "project").get("deletion") is not None:
            return
        native = self._native(journal, assignment, "retirement", "project", admitted)
        identity, billing, _ = await asyncio.to_thread(
            _retire,
            native.session,
            self.token,
            creation,
            assignment["preparationContract"]["billingAccount"],
        )
        await journal.retain(
            "retirement",
            "project",
            "deletion",
            {
                **admitted,
                "status": "retirement_pending_provider_purge",
                "projectIdentity": identity,
                "billingObservation": billing,
            },
        )

    async def _journal(self, owner: str, reservation: dict) -> tuple[PrefixAbortJournal, dict]:
        saved = await _reservation(self.registry, owner)
        if (
            saved["attemptId"] != reservation["attemptId"]
            or saved["registrySnapshot"] != reservation["registrySnapshot"]
        ):
            raise ProvisionReconciliationRequired("Managed prefix request changed")
        attempt = saved["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        assignment = attempt["hostedAdmission"]["assignment"]
        if self.actor != assignment["preparationContract"]["operatorPrincipal"] or not self.token:
            raise ProvisionReconciliationRequired(
                "Managed prefix operator differs from retained authority"
            )
        journal = PrefixAbortJournal(self.registry, owner, saved)
        current = await journal.current()
        observed = await journal.query(
            "SELECT public.managed_prefix_abort_context(CAST(:r AS jsonb)) AS coordinates", current
        )
        coordinates = observed.get("coordinates")
        if not isinstance(coordinates, dict) or not isinstance(
            coordinates.get("projectNumber"), str
        ):
            raise ProvisionReconciliationRequired(
                "Managed prefix numeric project authority unavailable"
            )
        return journal, {**assignment, "projectNumber": coordinates["projectNumber"]}

    def _native(
        self, journal: PrefixAbortJournal, assignment: dict, kind: str, key: str, admitted: dict
    ) -> PrefixNativeResources:
        async def current() -> None:
            saved = await journal.check(kind, key, "admission", admitted)
            entry = retained_entry(saved, kind, key)
            if (
                entry.get("admission") != admitted
                or entry.get("deletion") is not None
                or (kind == "inventory" and entry.get("inventory") is not None)
            ):
                raise ProvisionReconciliationRequired(
                    "Managed prefix mutation lacks active retained admission"
                )

        guard = _worker_guard(current, asyncio.get_running_loop(), threading.get_ident())
        return PrefixNativeResources(
            project=assignment["project"],
            number=assignment["projectNumber"],
            region=assignment["region"],
            token=self.token,
            session=GuardedOperatorSession(self.session, guard),
            deadline=journal.deadline,
        )

    async def _inventory(self, journal: PrefixAbortJournal, assignment: dict) -> dict:
        saved = await journal.current()
        retained = retained_entry(saved, "inventory", "")
        if retained.get("inventory") is not None:
            await journal.check("inventory", "", "inventory", retained["inventory"])
            return deepcopy(retained["inventory"])
        observer_session = _InventorySession(BoundedPrefixSession(self.session, journal.deadline))
        admitted = retained.get("admission")
        if admitted is None:
            admitted = await asyncio.to_thread(
                self.observe_inventory, saved, "admission", observer_session
            )
            if not isinstance(admitted, dict):
                raise ProvisionReconciliationRequired(
                    "Managed prefix inventory response is malformed"
                )
            await journal.retain("inventory", "", "admission", admitted)
        if not isinstance(admitted, dict):
            raise ProvisionReconciliationRequired("Managed prefix inventory admission is malformed")
        if admitted["writerFence"]["status"] == "admitted":
            native = self._native(journal, assignment, "inventory", "", admitted)
            bootstrap = assignment["bootstrapContract"]["plan"]["federation"]["impersonation"][
                "bootstrap_service_account"
            ]
            await asyncio.to_thread(
                revoke_runtime_writer,
                token=self.token,
                project=assignment["project"],
                bootstrap_ref=bootstrap,
                identity=admitted["writerFence"]["identity"],
                before_disable=lambda _: True,
                session=native.session,
            )
        current = await journal.current()
        observed = await asyncio.to_thread(
            self.observe_inventory, current, "inventory", observer_session
        )
        await journal.retain("inventory", "", "inventory", observed)
        return observed

    async def _binding(
        self, journal: PrefixAbortJournal, assignment: dict, inventory: dict, binding: dict
    ) -> None:
        key = await journal.binding_key(binding)
        admitted = {**await journal.base(), "binding": binding, "status": "admitted"}
        saved = await journal.retain("bindings", key, "admission", admitted)
        if retained_entry(saved, "bindings", key).get("deletion") is not None:
            return
        native = self._native(journal, assignment, "bindings", key, admitted)
        runtime = next(item for item in inventory["resources"] if item["type"] == "service_account")

        def remove() -> None:
            for resource in inventory["resources"]:
                policy_target = (
                    binding["policyResource"].removesuffix(":getIamPolicy")
                    if binding["policyResource"].endswith(":getIamPolicy")
                    else binding["policyResource"].removesuffix("/iam")
                )
                if unquote(policy_target) == unquote(native.url(resource)):
                    if native.observe(resource) is None:
                        return  # Exact native target absence also removes its attached policy.
            remove_prefix_binding(native, binding, identity=runtime.get("identity"))

        await asyncio.to_thread(remove)
        status = "observed_absent" if binding["disposition"] == "added" else "preserved_preexisting"
        await journal.retain("bindings", key, "deletion", {**admitted, "status": status})

    async def _resource(self, journal: PrefixAbortJournal, assignment: dict, item: dict) -> None:
        key = item["type"] + ":" + item["id"]
        saved = await journal.current()
        entry = retained_entry(saved, "resources", key)
        if entry.get("deletion") is not None:
            await journal.check("resources", key, "deletion", entry["deletion"])
            return
        admitted = entry.get("admission") or {
            **await journal.base(),
            "resource": item,
            "status": "admitted",
        }
        if (
            item["type"] == "kms_key"
            and item["disposition"] == "created"
            and "versionNames" not in admitted
        ):
            native = PrefixNativeResources(
                project=assignment["project"],
                number=assignment["projectNumber"],
                region=assignment["region"],
                token=self.token,
                session=_InventorySession(BoundedPrefixSession(self.session, journal.deadline)),
                deadline=journal.deadline,
            )
            versions = await asyncio.to_thread(native.versions, item)
            admitted.update(
                versionNames=[value["name"] for value in versions], paginationComplete=True
            )
        await journal.retain("resources", key, "admission", admitted)
        native = self._native(journal, assignment, "resources", key, admitted)
        receipt = await asyncio.to_thread(native.erase, item, admitted)
        await journal.retain("resources", key, "deletion", receipt)

    async def _bootstrap(self, journal: PrefixAbortJournal, assignment: dict) -> None:
        saved = await journal.current()
        authorization = saved["registrySnapshot"]["backend_metadata"]["provisionAttempt"][
            "evidence"
        ]["reserved"]["projectAuthorization"]["receipt"]
        admitted = {**await journal.base(), "authorization": authorization, "status": "admitted"}
        saved = await journal.retain("bootstrap", "bootstrap", "admission", admitted)
        if retained_entry(saved, "bootstrap", "bootstrap").get("deletion") is not None:
            return
        native = self._native(journal, assignment, "bootstrap", "bootstrap", admitted)

        def remove() -> None:
            identity = authorization["bootstrapIdentity"]
            item = {
                "type": "service_account",
                "id": identity["email"],
                "identity": identity,
                "disposition": "created",
            }
            if native.observe(item) is None:
                raise ProvisionReconciliationRequired("Bootstrap recovery identity unavailable")
            remove_prefix_binding(native, authorization["bindingObservation"], identity=identity)

        await asyncio.to_thread(remove)
        status = (
            "observed_absent"
            if authorization["bindingObservation"]["disposition"] == "added"
            else "preserved_preexisting"
        )
        await journal.retain("bootstrap", "bootstrap", "deletion", {**admitted, "status": status})


class _InventorySession:
    """An inventory callback cannot acquire mutation authority before its receipt."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def request(self, method: str, url: str, **options: Any) -> Any:
        if method.upper() != "GET" and not (
            method.upper() == "POST" and url.endswith(":getIamPolicy")
        ):
            raise ProvisionReconciliationRequired("Prefix inventory is read-only")
        options.setdefault("allow_redirects", False)
        return self._session.request(method, url, **options)

    def get(self, url: str, **options: Any) -> Any:
        return self.request("GET", url, **options)

    def post(self, url: str, **options: Any) -> Any:
        return self.request("POST", url, **options)
