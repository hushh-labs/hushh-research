"""SQL ports into the existing provisionAttempt; no second operation store."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal


class HostedPodJournal:
    def __init__(self, database: Any) -> None:
        self._database = database

    async def current(
        self,
        *,
        owner_id: str,
        attempt_id: str,
        admission: dict,
        project_observation: dict | None = None,
        purpose: Literal["bootstrap", "provision"] | None = None,
    ) -> bool:
        if purpose not in {None, "bootstrap", "provision"}:
            raise ValueError("Unsupported managed execution purpose")
        query = (
            "SELECT public.hosted_pod_pilot_admission_current(:owner,:attempt,"
            "CAST(:admission AS jsonb),CAST(:project_observation AS jsonb)) AS current"
            if purpose is None
            else "SELECT public.hosted_pod_execution_admitted(:owner,:attempt,"
            "CAST(:admission AS jsonb),CAST(:project_observation AS jsonb),:purpose) AS current"
        )
        result = await asyncio.to_thread(
            self._database.execute_raw,
            query,
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "purpose": purpose,
                "admission": json.dumps(admission),
                "project_observation": json.dumps(project_observation),
            },
        )
        return bool(result.data and result.data[0].get("current") is True)

    async def publish(
        self,
        *,
        kind: Literal["bootstrap", "preparation"],
        owner_id: str,
        attempt_id: str,
        checkpoint: dict[str, Any],
    ) -> bool:
        if kind not in {"bootstrap", "preparation"}:
            raise ValueError("Unsupported managed checkpoint kind")
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.publish_hosted_pod_step_checkpoint(:owner,:attempt,"
            "CAST(:checkpoint AS jsonb),:kind) AS admitted",
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "kind": kind,
                "checkpoint": json.dumps(checkpoint),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def retain_project(self, *, owner_id: str, attempt_id: str, observation: dict) -> bool:
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.retain_hosted_pod_project_observation(:owner,:attempt,"
            "CAST(:observation AS jsonb)) AS admitted",
            {"owner": owner_id, "attempt": attempt_id, "observation": json.dumps(observation)},
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def record_provider_account_transition_intent(
        self, *, owner_id: str, attempt_id: str, intent: dict[str, Any]
    ) -> bool:
        """Persist a verified-actor intent before any provider billing mutation."""
        import os
        import re

        source_revision = str(os.getenv("HUSHH_DEPLOY_SHA") or "").strip().lower()
        if not re.fullmatch(r"[a-f0-9]{40}", source_revision):
            raise ValueError("Provider account transition requires the control-plane source SHA")
        if "minimumSourceRevision" in intent:
            raise ValueError("Minimum source revision is owned by the running control plane")
        bound_intent = {**intent, "minimumSourceRevision": source_revision}
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.record_hosted_provider_account_transition_intent(:owner,:attempt,"
            "CAST(:intent AS jsonb)) AS admitted",
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "intent": json.dumps(bound_intent),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def settle_provider_account_transition(
        self,
        *,
        owner_id: str,
        attempt_id: str,
        expected_generation: int,
        expected_phase: Literal["intent", "unknown"],
        settlement: dict[str, Any],
    ) -> bool:
        """CAS a provider observation into the existing owner operation journal."""
        if type(expected_generation) is not int or expected_generation < 1:
            raise ValueError("Invalid provider account transition generation")
        if expected_phase not in {"intent", "unknown"}:
            raise ValueError("Unsupported provider account transition phase")
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.settle_hosted_provider_account_transition(:owner,:attempt,:generation,"
            ":phase,CAST(:settlement AS jsonb)) AS admitted",
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "generation": expected_generation,
                "phase": expected_phase,
                "settlement": json.dumps(settlement),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def reconcile_bucket_absence(
        self, *, owner_id: str, attempt_id: str, checkpoint: dict, observation: dict
    ) -> bool:
        """CAS one failed create after native absence; retain its full history."""
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.reconcile_hosted_bucket_absence(:owner,:attempt,"
            "CAST(:checkpoint AS jsonb),CAST(:observation AS jsonb)) AS admitted",
            {
                "owner": owner_id,
                "attempt": attempt_id,
                "checkpoint": json.dumps(checkpoint),
                "observation": json.dumps(observation),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def retain_authorization(self, *, owner_id: str, attempt_id: str) -> bool:
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.retain_hosted_pod_project_authorization(:owner,:attempt) AS admitted",
            {"owner": owner_id, "attempt": attempt_id},
        )
        return bool(result.data and result.data[0].get("admitted") is True)

    async def upgrade_current(
        self,
        *,
        owner_id: str,
        lease: str,
        observed: dict,
        work: bool = True,
        join_on_cancel: bool = False,
    ) -> bool:
        from hushh_mcp.services.pod_files.managed_worker import database_thread

        result = await database_thread(
            self._database.execute_raw,
            "SELECT public.hosted_pod_upgrade_admitted(:owner,:lease,CAST(:observed AS jsonb),:work) AS current",
            {
                "owner": owner_id,
                "lease": lease,
                "observed": json.dumps(observed, default=str),
                "work": work,
            },
            join_on_cancel=join_on_cancel,
        )
        return bool(result.data and result.data[0].get("current") is True)

    async def cleanup_current(self, *, owner_id: str, reservation: dict) -> bool:
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.hosted_pod_cleanup_admitted(:owner,:attempt,CAST(:expected AS jsonb)) AS current",
            {
                "owner": owner_id,
                "attempt": reservation["attemptId"],
                "expected": json.dumps(reservation),
            },
        )
        return bool(result.data and result.data[0].get("current") is True)

    async def retained_current(self, *, owner_id: str, observed: dict) -> bool:
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.hosted_pod_retained_admitted(:owner,CAST(:observed AS jsonb)) AS current",
            {"owner": owner_id, "observed": json.dumps(observed, default=str)},
        )
        return bool(result.data and result.data[0].get("current") is True)

    async def effective_provider_billing_account(self, *, registry_row: dict[str, Any]) -> str:
        """Use SQL's single transition-aware account resolver; unresolved blocks work."""
        result = await asyncio.to_thread(
            self._database.execute_raw,
            "SELECT public.hosted_provider_effective_billing_account(CAST(:row AS jsonb)) "
            "AS billing_account",
            {"row": json.dumps(registry_row, default=str)},
        )
        account = result.data[0].get("billing_account") if result.data else None
        if not isinstance(account, str) or not account:
            from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

            raise ProvisionReconciliationRequired(
                "Hosted provider account transition requires reconciliation"
            )
        return account

    async def managed_cleanup_check(
        self, *, owner_id: str, reservation: dict, kind: str, stage: str, receipt: dict
    ) -> bool:
        validators = {
            "vertex": "valid_erasure_managed_model_grant_receipt",
            "quota": "valid_erasure_managed_model_grant_receipt",
            "retirement": "valid_erasure_managed_project_retirement",
            "preparation": "valid_managed_preparation_cleanup",
        }
        if kind not in validators or stage not in {"admission", "acknowledgement", "deletion"}:
            raise ValueError("Unsupported managed cleanup step")
        model = kind in {"vertex", "quota"}
        admission = (
            "hosted_preparation_cleanup_admitted"
            if kind == "preparation"
            else "hosted_pod_cleanup_admitted"
        )
        query = (
            f"SELECT public.{admission}(:owner,:attempt,CAST(:expected AS jsonb)) "
            f"AND public.{validators[kind]}(CAST(:expected AS jsonb),"
            + (":kind," if model else "")
            + ":stage,CAST(:receipt AS jsonb)) AS admitted"
        )
        return await self._cleanup_query(query, owner_id, reservation, kind, stage, receipt)

    async def retain_managed_cleanup(
        self, *, owner_id: str, reservation: dict, kind: str, stage: str, receipt: dict
    ) -> bool:
        ports = {
            "vertex": "retain_erasure_managed_model_grant_receipt",
            "quota": "retain_erasure_managed_model_grant_receipt",
            "retirement": "retain_erasure_managed_project_retirement",
            "preparation": "retain_managed_preparation_cleanup",
        }
        if kind not in ports or stage not in {"admission", "acknowledgement", "deletion"}:
            raise ValueError("Unsupported managed cleanup step")
        query = (
            f"SELECT public.{ports[kind]}(:owner,:attempt,CAST(:expected AS jsonb),"
            + (":kind," if kind in {"vertex", "quota"} else "")
            + ":stage,CAST(:receipt AS jsonb)) AS admitted"
        )
        return await self._cleanup_query(query, owner_id, reservation, kind, stage, receipt)

    async def prefix_abort_current(self, *, owner_id: str, reservation: dict) -> bool:
        return await self._cleanup_query(
            "SELECT public.hosted_prefix_abort_admitted(:owner,:attempt,CAST(:expected AS jsonb)) AS admitted",
            owner_id,
            reservation,
            "",
            "",
            {},
        )

    async def retain_prefix_abort(
        self,
        *,
        owner_id: str,
        reservation: dict,
        kind: str,
        key: str,
        stage: str,
        receipt: dict,
    ) -> bool:
        stages = {
            "inventory": {"admission", "inventory"},
            "resources": {"admission", "deletion"},
            "bindings": {"admission", "deletion"},
            "bootstrap": {"admission", "deletion"},
            "retirement": {"admission", "deletion"},
        }
        if kind not in stages or stage not in stages[kind] or not isinstance(key, str):
            raise ValueError("Unsupported managed prefix-abort receipt")
        return await self._cleanup_query(
            "SELECT public.retain_managed_prefix_abort(:owner,:attempt,CAST(:expected AS jsonb),"
            ":kind,:key,:stage,CAST(:receipt AS jsonb)) AS admitted",
            owner_id,
            reservation,
            kind,
            stage,
            receipt,
            key=key,
        )

    async def _cleanup_query(
        self,
        query: str,
        owner_id: str,
        reservation: dict,
        kind: str,
        stage: str,
        receipt: dict,
        *,
        key: str = "",
    ) -> bool:
        result = await asyncio.to_thread(
            self._database.execute_raw,
            query,
            {
                "owner": owner_id,
                "attempt": reservation["attemptId"],
                "expected": json.dumps(reservation),
                "kind": kind,
                "key": key,
                "stage": stage,
                "receipt": json.dumps(receipt),
            },
        )
        return bool(result.data and result.data[0].get("admitted") is True)
