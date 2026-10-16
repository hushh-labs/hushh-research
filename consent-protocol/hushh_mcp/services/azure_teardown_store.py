"""SQL ports over the existing private-agent erasure reservation.

The account route owns transaction approval. The OAuth callback can read a bound
authorization and retain provider observations; it cannot approve a plan.
"""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from typing import Any, Literal

from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused


class AzureTeardownStore:
    def __init__(self, registry: Any) -> None:
        self.registry = registry

    async def _value(self, sql: str, params: dict) -> Any:
        try:
            response = await asyncio.to_thread(self.registry._db().execute_raw, sql, params)
        except Exception as exc:
            raise AzureTeardownRefused("AZURE_CLEANUP_STORAGE_UNAVAILABLE") from exc
        return response.data[0].get("value") if response.data else None

    async def authorization(self, owner: str, purpose: Literal["inspect", "execute"]) -> dict:
        value = await self._value(
            "SELECT public.azure_erasure_authorization(:owner,:purpose) AS value",
            {"owner": owner, "purpose": purpose},
        )
        if not isinstance(value, dict):
            raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_UNAVAILABLE")
        return value

    async def require_completion_contract(self) -> None:
        exists = await self._value(
            "SELECT to_regprocedure('public.azure_account_cleanup_ready()') IS NOT NULL AS value",
            {},
        )
        ready = exists is True and await self._value(
            "SELECT public.azure_account_cleanup_ready() AS value", {}
        )
        if ready is not True:
            raise AzureTeardownRefused("AZURE_CLEANUP_NOT_AVAILABLE")

    async def candidate_digest(self, owner: str, row: dict) -> str:
        value = await self._value(
            "SELECT public.azure_cleanup_candidate_digest(to_jsonb(p)) AS value "
            "FROM public.personal_agent_registry p WHERE user_id=:owner AND ((status='provisioned' "
            "AND deployment_target='user_azure' AND backend_metadata->>'serviceUid'=:uid "
            "AND coalesce(backend_metadata->>'image_digest','')=:image) "
            "OR public.azure_setup_never_deployed(:owner,to_jsonb(p)) IS TRUE)",
            {
                "owner": owner,
                "uid": (row.get("backend_metadata") or {}).get("serviceUid"),
                "image": str((row.get("backend_metadata") or {}).get("image_digest") or ""),
            },
        )
        if not isinstance(value, str):
            raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_CHANGED")
        return value

    async def can_offer_failed_setup_cleanup(self, owner: str, row: dict) -> bool:
        """Read an optional admission hint; reservation still owns cleanup authority."""
        available = await self._value(
            "SELECT to_regprocedure('public.azure_setup_never_deployed(text,jsonb)') "
            "IS NOT NULL AS value",
            {},
        )
        snapshot = (
            (row.get("backend_metadata") or {}).get("erasure", {}).get("registrySnapshot", row)
        )
        return available is True and await self.never_deployed(owner, snapshot)

    async def never_deployed(self, owner: str, snapshot: dict) -> bool:
        return (
            await self._value(
                "SELECT public.azure_setup_never_deployed(:owner,CAST(:snapshot AS jsonb)) AS value",
                {"owner": owner, "snapshot": json.dumps(snapshot)},
            )
            is True
        )

    async def reserve(self, owner: str, snapshot_digest: str | None) -> dict:
        value = await self._value(
            "SELECT public.reserve_azure_account_cleanup(:owner,:snapshot) AS value",
            {"owner": owner, "snapshot": snapshot_digest},
        )
        if not isinstance(value, dict):
            raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_UNAVAILABLE")
        return value

    async def match_authorization(self, owner: str, *, attempt: str, digest: str) -> dict:
        for purpose in ("inspect", "execute"):
            value = await self._value(
                "SELECT public.azure_erasure_authorization(:owner,:purpose) AS value",
                {"owner": owner, "purpose": purpose},
            )
            if (
                isinstance(value, dict)
                and value.get("digest") == digest
                and value.get("context", {}).get("attemptId") == attempt
                and value.get("purpose") == purpose
            ):
                return value
        raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")

    async def mark_authorization(
        self, owner: str, selection: Any, purpose: str, status: str, code: str
    ) -> None:
        from hashlib import sha256

        retained = await self._value(
            "SELECT public.retain_azure_cleanup_authorization_outcome("
            ":owner,:attempt,:nonce,:purpose,:digest,:outcome,:code) AS value",
            {
                "owner": owner,
                "attempt": selection.erasure_attempt,
                "nonce": sha256(selection.nonce.encode()).hexdigest(),
                "purpose": purpose,
                "digest": selection.erasure_digest,
                "outcome": status,
                "code": code,
            },
        )
        if retained is not True:
            raise AzureTeardownRefused("AZURE_CLEANUP_STATUS_UNCONFIRMED")

    async def reservation(self, owner: str) -> dict:
        row = await self.registry.get(owner)
        value = ((row or {}).get("backend_metadata") or {}).get("erasure")
        if (
            not isinstance(value, dict)
            or (row or {}).get("status") != "suspended"
            or value.get("ownerId") != owner
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_UNAVAILABLE")
        return value

    async def retain_plan(self, owner: str, plan: dict) -> dict:
        reservation = await self.reservation(owner)
        prior = reservation.get("azureTeardown")
        if prior is not None:
            if prior.get("plan") != plan:
                raise AzureTeardownRefused("AZURE_CLEANUP_PLAN_CHANGED")
            return deepcopy(prior)
        history = await self._value(
            "SELECT public.azure_erasure_setup_history(:owner) AS value", {"owner": owner}
        )
        if not isinstance(history, list):
            raise AzureTeardownRefused("AZURE_CLEANUP_HISTORY_UNCONFIRMED")
        candidate = {"plan": plan, "approvals": [], "resources": {}, "setupHistory": history}
        retained = await self._value(
            "SELECT public.retain_azure_erasure_state(:owner,:attempt,CAST(:expected AS jsonb),"
            "CAST(:candidate AS jsonb)) AS value",
            {
                "owner": owner,
                "attempt": reservation["attemptId"],
                "expected": json.dumps(reservation),
                "candidate": json.dumps(candidate),
            },
        )
        observed = (await self.reservation(owner)).get("azureTeardown")
        if retained is not True or observed != candidate:
            raise AzureTeardownRefused("AZURE_CLEANUP_PLAN_UNCONFIRMED")
        return candidate

    async def approve(self, owner: str, plan_digest: str, group_confirmation: str) -> dict:
        reservation = await self.reservation(owner)
        approved = await self._value(
            "SELECT public.approve_azure_erasure_plan(:owner,:attempt,:digest,:group_confirmation) AS value",
            {
                "owner": owner,
                "attempt": reservation["attemptId"],
                "digest": plan_digest,
                "group_confirmation": group_confirmation,
            },
        )
        if not isinstance(approved, dict):
            raise AzureTeardownRefused("AZURE_CLEANUP_APPROVAL_UNCONFIRMED")
        return approved

    async def view(self, owner: str) -> dict:
        """Return metadata only; the resource list is read from the retained plan."""
        observed = await self._value(
            "SELECT jsonb_build_object('attemptId',r->>'attemptId','state',r->'azureTeardown',"
            "'digest',encode(sha256(convert_to((r->'azureTeardown'->'plan')::text,'UTF8')),'hex')) AS value "
            "FROM (SELECT backend_metadata->'erasure' AS r FROM public.personal_agent_registry "
            "WHERE user_id=:owner AND status='suspended') current "
            "WHERE r->>'ownerId'=:owner",
            {"owner": owner},
        )
        if not isinstance(observed, dict) or not observed.get("attemptId"):
            raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_UNAVAILABLE")
        state = observed.get("state") or {}
        resources = state.get("plan", {}).get("resources", {})
        worker = state.get("worker") or {}
        exited = state.get("workerExits", {}).get(worker.get("executionId"), {})
        complete = await self._value(
            "SELECT public.azure_erasure_resources_complete(:owner,backend_metadata->'erasure') AS value "
            "FROM public.personal_agent_registry WHERE user_id=:owner AND status='suspended'",
            {"owner": owner},
        )
        authorized = await self._value(
            "SELECT public.azure_erasure_authorization(:owner,'execute') AS value", {"owner": owner}
        )
        observations = list(state.get("authorizationAttempts", {}).values())
        latest = max(observations, key=lambda value: value.get("startedAt", 0), default=None)
        return {
            "operationId": observed["attemptId"],
            "planDigest": observed["digest"],
            "termsVersion": state.get("plan", {}).get("termsVersion"),
            "canFinalize": complete is True,
            "workerOutcome": exited.get("outcome"),
            "approvalRequired": complete is not True and not isinstance(authorized, dict),
            "authorizationOutcome": latest,
            "retention": [
                value["retention"]
                for value in state.get("resources", {}).values()
                if "retention" in value
            ],
            "resources": [
                {"id": path, "kind": value["kind"], "scope": value["deletionScope"]}
                for path, value in resources.items()
                if not value.get("coveredBy")
            ],
            "removed": sum(
                1 for value in state.get("resources", {}).values() if "absence" in value
            ),
            "total": sum(1 for value in resources.values() if not value.get("coveredBy")),
        }
