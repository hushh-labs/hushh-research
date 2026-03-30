from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from hushh_mcp.services.domain_contracts import (
    CURRENT_PKM_MODEL_VERSION,
    CURRENT_READABLE_SUMMARY_VERSION,
    current_domain_contract_version,
)
from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelIndex,
    get_pkm_service,
)

logger = logging.getLogger(__name__)

_ACTIVE_RUN_STATUSES = {"planned", "running", "awaiting_local_auth_resume"}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class PkmUpgradeService:
    def __init__(self):
        self._pkm_service = None

    @property
    def pkm_service(self):
        if self._pkm_service is None:
            self._pkm_service = get_pkm_service()
        return self._pkm_service

    @property
    def supabase(self):
        return self.pkm_service.supabase

    @staticmethod
    def _clean_text(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = value.strip()
        return cleaned or None

    @staticmethod
    def _to_int(value: Any, default: int) -> int:
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            try:
                return int(float(value.strip()))
            except Exception:
                return default
        return default

    def _normalize_run(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not isinstance(row, dict):
            return None
        return {
            "run_id": row.get("run_id"),
            "user_id": row.get("user_id"),
            "status": row.get("status") or "planned",
            "from_model_version": self._to_int(row.get("from_model_version"), 1),
            "to_model_version": self._to_int(
                row.get("to_model_version"), CURRENT_PKM_MODEL_VERSION
            ),
            "current_domain": self._clean_text(row.get("current_domain")),
            "initiated_by": self._clean_text(row.get("initiated_by")) or "unlock_warm",
            "resume_count": self._to_int(row.get("resume_count"), 0),
            "started_at": row.get("started_at"),
            "last_checkpoint_at": row.get("last_checkpoint_at"),
            "completed_at": row.get("completed_at"),
            "last_error": self._clean_text(row.get("last_error")),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    def _normalize_step(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not isinstance(row, dict):
            return None
        checkpoint_payload = row.get("checkpoint_payload")
        if not isinstance(checkpoint_payload, dict):
            checkpoint_payload = {}
        return {
            "run_id": row.get("run_id"),
            "domain": self._clean_text(row.get("domain")) or "",
            "status": row.get("status") or "pending",
            "from_domain_contract_version": self._to_int(
                row.get("from_domain_contract_version"), 1
            ),
            "to_domain_contract_version": self._to_int(row.get("to_domain_contract_version"), 1),
            "from_readable_summary_version": self._to_int(
                row.get("from_readable_summary_version"), 0
            ),
            "to_readable_summary_version": self._to_int(row.get("to_readable_summary_version"), 0),
            "attempt_count": self._to_int(row.get("attempt_count"), 0),
            "last_completed_content_revision": row.get("last_completed_content_revision"),
            "last_completed_manifest_version": row.get("last_completed_manifest_version"),
            "checkpoint_payload": checkpoint_payload,
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    def _sort_runs(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(
            [run for run in (self._normalize_run(row) for row in rows) if run],
            key=lambda run: (
                str(run.get("updated_at") or ""),
                str(run.get("created_at") or ""),
            ),
            reverse=True,
        )

    async def _list_runs(self, user_id: str) -> list[dict[str, Any]]:
        try:
            result = (
                self.supabase.table("pkm_upgrade_runs").select("*").eq("user_id", user_id).execute()
            )
            return self._sort_runs(result.data or [])
        except Exception as exc:
            logger.error("Failed to list PKM upgrade runs for %s: %s", user_id, exc)
            return []

    async def _list_steps(self, run_id: str) -> list[dict[str, Any]]:
        try:
            result = (
                self.supabase.table("pkm_upgrade_steps").select("*").eq("run_id", run_id).execute()
            )
            rows = [
                step for step in (self._normalize_step(row) for row in (result.data or [])) if step
            ]
            return sorted(rows, key=lambda step: step["domain"])
        except Exception as exc:
            logger.error("Failed to list PKM upgrade steps for %s: %s", run_id, exc)
            return []

    async def _get_latest_run(self, user_id: str) -> dict[str, Any] | None:
        runs = await self._list_runs(user_id)
        active = next((run for run in runs if run["status"] in _ACTIVE_RUN_STATUSES), None)
        if active:
            active["steps"] = await self._list_steps(active["run_id"])
            return active
        latest = runs[0] if runs else None
        if latest:
            latest["steps"] = await self._list_steps(latest["run_id"])
        return latest

    async def build_status(self, user_id: str) -> dict[str, Any]:
        index = await self.pkm_service.get_index_v2(user_id)
        available_domains = list(index.available_domains) if index else []
        if not available_domains:
            try:
                rows = (
                    self.supabase.table("pkm_manifests")
                    .select("domain")
                    .eq("user_id", user_id)
                    .execute()
                    .data
                    or []
                )
                available_domains = sorted(
                    {
                        self._clean_text(row.get("domain")) or ""
                        for row in rows
                        if self._clean_text(row.get("domain"))
                    }
                )
            except Exception:
                available_domains = []

        current_model_version = self._to_int(getattr(index, "model_version", None), 2)
        domain_states: list[dict[str, Any]] = []
        domain_summaries = index.domain_summaries if index else {}
        for domain in sorted(available_domains):
            summary = (
                domain_summaries.get(domain)
                if isinstance(domain_summaries.get(domain), dict)
                else {}
            )
            manifest = await self.pkm_service.get_domain_manifest(user_id, domain) or {}
            summary_domain_version = summary.get("domain_contract_version")
            manifest_domain_version = manifest.get("domain_contract_version")
            summary_readable_version = summary.get("readable_summary_version")
            manifest_readable_version = manifest.get("readable_summary_version")
            current_domain_version = self._to_int(
                summary_domain_version
                if summary_domain_version is not None
                else manifest_domain_version,
                0,
            )
            current_readable_version = self._to_int(
                summary_readable_version
                if summary_readable_version is not None
                else manifest_readable_version,
                0,
            )
            target_domain_version = current_domain_contract_version(domain)
            target_readable_version = CURRENT_READABLE_SUMMARY_VERSION
            domain_states.append(
                {
                    "domain": domain,
                    "current_domain_contract_version": current_domain_version,
                    "target_domain_contract_version": target_domain_version,
                    "current_readable_summary_version": current_readable_version,
                    "target_readable_summary_version": target_readable_version,
                    "upgraded_at": summary.get("upgraded_at") or manifest.get("upgraded_at"),
                    "needs_upgrade": (
                        current_domain_version < target_domain_version
                        or current_readable_version < target_readable_version
                    ),
                }
            )

        stale_domains = [domain for domain in domain_states if domain["needs_upgrade"]]
        latest_run = await self._get_latest_run(user_id)
        if latest_run and latest_run["status"] in _ACTIVE_RUN_STATUSES:
            upgrade_status = latest_run["status"]
        elif latest_run and latest_run["status"] == "failed" and stale_domains:
            upgrade_status = "failed"
        elif stale_domains:
            upgrade_status = "ready"
        else:
            upgrade_status = "current"

        return {
            "user_id": user_id,
            "model_version": current_model_version,
            "target_model_version": CURRENT_PKM_MODEL_VERSION,
            "upgrade_status": upgrade_status,
            "upgradable_domains": stale_domains,
            "last_upgraded_at": getattr(index, "last_upgraded_at", None) if index else None,
            "run": latest_run,
        }

    async def start_or_resume_run(
        self, user_id: str, *, initiated_by: str = "unlock_warm"
    ) -> dict[str, Any]:
        status_payload = await self.build_status(user_id)
        latest_run = status_payload.get("run")
        if latest_run and latest_run.get("status") in _ACTIVE_RUN_STATUSES:
            if latest_run["status"] == "awaiting_local_auth_resume":
                now_iso = _now_iso()
                (
                    self.supabase.table("pkm_upgrade_runs")
                    .update(
                        {
                            "status": "running",
                            "resume_count": self._to_int(latest_run.get("resume_count"), 0) + 1,
                            "last_checkpoint_at": now_iso,
                        }
                    )
                    .eq("run_id", latest_run["run_id"])
                    .execute()
                )
            return await self.build_status(user_id)

        upgradable_domains = status_payload.get("upgradable_domains") or []
        if not upgradable_domains:
            return status_payload

        run_id = f"pkm_upgrade_{uuid.uuid4().hex}"
        now_iso = _now_iso()
        run_row = {
            "run_id": run_id,
            "user_id": user_id,
            "status": "running",
            "from_model_version": status_payload.get("model_version") or 1,
            "to_model_version": CURRENT_PKM_MODEL_VERSION,
            "current_domain": upgradable_domains[0]["domain"],
            "initiated_by": initiated_by,
            "resume_count": 0,
            "started_at": now_iso,
            "last_checkpoint_at": now_iso,
            "completed_at": None,
            "last_error": None,
        }
        self.supabase.table("pkm_upgrade_runs").insert(run_row).execute()
        step_rows = [
            {
                "run_id": run_id,
                "domain": domain_state["domain"],
                "status": "pending",
                "from_domain_contract_version": domain_state["current_domain_contract_version"],
                "to_domain_contract_version": domain_state["target_domain_contract_version"],
                "from_readable_summary_version": domain_state["current_readable_summary_version"],
                "to_readable_summary_version": domain_state["target_readable_summary_version"],
                "attempt_count": 0,
                "checkpoint_payload": {},
            }
            for domain_state in upgradable_domains
        ]
        if step_rows:
            self.supabase.table("pkm_upgrade_steps").upsert(
                step_rows,
                on_conflict="run_id,domain",
            ).execute()
        return await self.build_status(user_id)

    async def mark_run_status(
        self,
        *,
        run_id: str,
        status: str,
        current_domain: str | None = None,
        last_error: str | None = None,
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        current = runs[0]
        payload: dict[str, Any] = {
            "status": status,
            "current_domain": current_domain
            if current_domain is not None
            else current.get("current_domain"),
            "last_checkpoint_at": _now_iso(),
        }
        if last_error is not None:
            payload["last_error"] = last_error
        if status == "completed":
            payload["completed_at"] = _now_iso()
        (self.supabase.table("pkm_upgrade_runs").update(payload).eq("run_id", run_id).execute())
        updated = await self._list_runs_for_run_id(run_id)
        return updated[0] if updated else None

    async def _list_runs_for_run_id(self, run_id: str) -> list[dict[str, Any]]:
        try:
            result = (
                self.supabase.table("pkm_upgrade_runs").select("*").eq("run_id", run_id).execute()
            )
            return self._sort_runs(result.data or [])
        except Exception as exc:
            logger.error("Failed to fetch PKM upgrade run %s: %s", run_id, exc)
            return []

    async def update_step(
        self,
        *,
        run_id: str,
        domain: str,
        status: str,
        checkpoint_payload: dict[str, Any] | None = None,
        attempt_count: int | None = None,
        last_completed_content_revision: int | None = None,
        last_completed_manifest_version: int | None = None,
    ) -> dict[str, Any] | None:
        rows = await self._list_steps(run_id)
        current = next((row for row in rows if row["domain"] == domain), None)
        if current is None:
            return None
        payload: dict[str, Any] = {
            "status": status,
            "checkpoint_payload": checkpoint_payload
            if isinstance(checkpoint_payload, dict)
            else {},
        }
        if attempt_count is not None:
            payload["attempt_count"] = max(0, attempt_count)
        else:
            payload["attempt_count"] = current["attempt_count"]
        if last_completed_content_revision is not None:
            payload["last_completed_content_revision"] = last_completed_content_revision
        if last_completed_manifest_version is not None:
            payload["last_completed_manifest_version"] = last_completed_manifest_version
        (
            self.supabase.table("pkm_upgrade_steps")
            .update(payload)
            .eq("run_id", run_id)
            .eq("domain", domain)
            .execute()
        )
        if status in {"running", "conflict_retry"}:
            await self.mark_run_status(run_id=run_id, status="running", current_domain=domain)
        return next(
            (step for step in await self._list_steps(run_id) if step["domain"] == domain), None
        )

    async def complete_run(self, run_id: str) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        run = runs[0]
        steps = await self._list_steps(run_id)
        if any(step["status"] != "completed" for step in steps):
            raise ValueError("Cannot complete PKM upgrade run with unfinished steps.")

        now = datetime.now(UTC)
        await self.mark_run_status(run_id=run_id, status="completed", current_domain=None)

        index = await self.pkm_service.get_index_v2(run["user_id"])
        if index is None:
            index = PersonalKnowledgeModelIndex(user_id=run["user_id"])
        index.model_version = CURRENT_PKM_MODEL_VERSION
        index.last_upgraded_at = now
        await self.pkm_service.upsert_index_v2(index)
        return await self.build_status(run["user_id"])

    async def fail_run(
        self, run_id: str, *, last_error: str | None = None
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        await self.mark_run_status(run_id=run_id, status="failed", last_error=last_error)
        return await self.build_status(runs[0]["user_id"])


_pkm_upgrade_service: PkmUpgradeService | None = None


def get_pkm_upgrade_service() -> PkmUpgradeService:
    global _pkm_upgrade_service
    if _pkm_upgrade_service is None:
        _pkm_upgrade_service = PkmUpgradeService()
    return _pkm_upgrade_service
