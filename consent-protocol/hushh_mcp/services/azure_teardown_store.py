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
        candidate = {"plan": plan, "approvals": [], "resources": {}}
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
        return {
            "operationId": observed["attemptId"],
            "planDigest": observed["digest"],
            "termsVersion": state.get("plan", {}).get("termsVersion"),
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
