from __future__ import annotations

import hashlib
import logging
import os
import uuid
from datetime import UTC, datetime
from typing import Any

from db.db_client import JsonParam
from hushh_mcp.services.domain_contracts import (
    CURRENT_PKM_CONTRACT_VERSION,
    CURRENT_PKM_MODEL_VERSION,
    CURRENT_READABLE_PROJECTION_VERSION,
    CURRENT_READABLE_SUMMARY_VERSION,
    current_domain_contract_version,
)
from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelIndex,
    get_pkm_service,
)

logger = logging.getLogger(__name__)

_ACTIVE_RUN_STATUSES = {"planned", "running", "awaiting_local_auth_resume"}
_RUN_TRANSITIONS = {
    "planned": {"planned", "running", "failed", "canceled"},
    "running": {"running", "awaiting_local_auth_resume", "completed", "failed", "canceled"},
    "awaiting_local_auth_resume": {"running", "failed", "canceled"},
    "completed": {"completed"},
    "failed": {"failed"},
    "canceled": {"canceled"},
}
_STEP_TRANSITIONS = {
    "pending": {"pending", "running", "failed"},
    "running": {"running", "conflict_retry", "completed", "failed"},
    "conflict_retry": {"running", "conflict_retry", "completed", "failed"},
    "completed": {"completed"},
    "failed": {"failed"},
}


class PkmUpgradeService:
    def __init__(self):
        self._pkm_service = None

    @property
    def pkm_service(self):
        if self._pkm_service is None:
            self._pkm_service = get_pkm_service()
        return self._pkm_service

    @property
    def db(self):
        return self.pkm_service.db

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

    @staticmethod
    def _semantic_version(value: Any) -> tuple[int, int, int]:
        text = str(value or "0.0.0").strip()
        parts = text.split(".")
        normalized: list[int] = []
        for index in range(3):
            try:
                parsed = int(parts[index]) if index < len(parts) else 0
            except (TypeError, ValueError):
                parsed = 0
            normalized.append(max(0, parsed))
        return normalized[0], normalized[1], normalized[2]

    @staticmethod
    def _env_flag(name: str, default: bool = False) -> bool:
        raw = str(os.getenv(name, "true" if default else "false")).strip().lower()
        return raw in {"1", "true", "yes", "on"}

    @staticmethod
    def _v7_cohort_bucket(user_id: str) -> int:
        digest = hashlib.sha256(f"pkm-v7:{user_id}".encode("utf-8")).digest()
        return int.from_bytes(digest[:4], "big") % 100

    def _upgrade_policy(self, user_id: str) -> dict[str, Any]:
        try:
            cohort_percent = max(0, min(100, int(os.getenv("PKM_V7_COHORT_PERCENT", "0"))))
        except (TypeError, ValueError):
            cohort_percent = 0
        stage = str(os.getenv("PKM_V7_STAGE", "off")).strip().lower()
        if stage not in {"off", "reviewer", "internal", "1", "5", "25", "100"}:
            stage = "off"
        kill_switch_active = self._env_flag("PKM_V7_KILL_SWITCH_ACTIVE", True)
        shadow_enabled = self._env_flag("PKM_V7_SHADOW_ENABLED", False)
        write_promotion_enabled = self._env_flag("PKM_V7_WRITE_PROMOTION_ENABLED", False)
        eligible = (
            stage != "off"
            and not kill_switch_active
            and write_promotion_enabled
            and self._v7_cohort_bucket(user_id) < cohort_percent
        )
        return {
            "schema_version": "pkm_upgrade_policy.v1",
            "stage": stage,
            "shadow_enabled": shadow_enabled,
            "write_promotion_enabled": write_promotion_enabled,
            "kill_switch_active": kill_switch_active,
            "eligible": eligible,
            "cohort_percent": cohort_percent,
            "target_domain": "financial",
            "target_pkm_contract_version": "7.0.0",
        }

    def assert_upgrade_commit_allowed(
        self,
        *,
        user_id: str,
        upgrade_claim: dict[str, Any],
    ) -> None:
        """Re-evaluate rollout authority at commit time.

        Claims are short-lived, but the kill switch must take effect
        immediately even when a client obtained a claim before activation.
        Pre-v7 upgrade claims remain governed by their existing server claim
        and are not blocked by the financial v7 rollout switch.
        """
        target_contract = self._semantic_version(upgrade_claim.get("target_pkm_contract_version"))
        if target_contract[0] < 7:
            return
        if not self._upgrade_policy(user_id)["eligible"]:
            raise ValueError("PKM v7 commits are disabled by server rollout policy.")

    @staticmethod
    def _coerce_datetime(value: Any) -> datetime | None:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=UTC)
            return value.astimezone(UTC)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)
            except Exception:
                return None
        return None

    def _latest_domain_upgrade_at(self, domain_states: list[dict[str, Any]]) -> datetime | None:
        candidates = [
            upgraded_at
            for upgraded_at in (
                self._coerce_datetime(domain_state.get("upgraded_at"))
                for domain_state in domain_states
            )
            if upgraded_at is not None
        ]
        if not candidates:
            return None
        return max(candidates)

    @staticmethod
    def _domain_capabilities(manifest: dict[str, Any]) -> list[str]:
        capabilities: list[str] = ["encrypted_payload_structure"]
        summary = manifest.get("summary_projection") if isinstance(manifest, dict) else {}
        summary = summary if isinstance(summary, dict) else {}
        if manifest.get("paths") or manifest.get("top_level_scope_paths"):
            capabilities.append("manifest_normalization")
        if manifest.get("scope_registry"):
            capabilities.append("scope_registry")
        if manifest.get("externalizable_paths"):
            capabilities.append("externalizable_paths")
        if summary.get("readable_summary") or summary.get("readable_highlights"):
            capabilities.append("readable_summary")
        if summary.get("consumer_visible") is True:
            capabilities.append("consumer_projection")
        if summary.get("consumer_item_count"):
            capabilities.append("semantic_counts")
        return list(dict.fromkeys(capabilities))

    @staticmethod
    def _domain_blockers(manifest: dict[str, Any]) -> list[str]:
        if not manifest:
            return ["missing_manifest"]
        if not manifest.get("paths") and not manifest.get("top_level_scope_paths"):
            return ["manifest_has_no_paths"]
        return []

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
            "mode": self._clean_text(row.get("mode")) or "real",
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

    def _normalize_error_context(self, value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None

        normalized: dict[str, Any] = {}
        text_fields = (
            "stage",
            "domain",
            "detail",
            "correlation_id",
            "request_id",
            "trace_id",
            "client_route",
            "manifest_route",
            "mode",
        )
        for key in text_fields:
            cleaned = self._clean_text(value.get(key))
            if cleaned:
                normalized[key] = cleaned

        http_status = value.get("http_status")
        if http_status is not None:
            normalized["http_status"] = self._to_int(http_status, 0)

        return normalized or None

    def _extract_run_error_context(
        self,
        run: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not isinstance(run, dict):
            return None

        steps = run.get("steps") or []
        current_domain = self._clean_text(run.get("current_domain"))
        candidates: list[dict[str, Any]] = []
        if current_domain:
            current_step = next(
                (
                    step
                    for step in steps
                    if isinstance(step, dict) and step.get("domain") == current_domain
                ),
                None,
            )
            if current_step:
                candidates.append(current_step)
        candidates.extend(
            step
            for step in steps
            if isinstance(step, dict) and step not in candidates and step.get("status") == "failed"
        )

        for step in candidates:
            checkpoint_payload = step.get("checkpoint_payload")
            if not isinstance(checkpoint_payload, dict):
                continue
            error_context = self._normalize_error_context(checkpoint_payload.get("error_context"))
            if error_context:
                if "domain" not in error_context and step.get("domain"):
                    error_context["domain"] = step.get("domain")
                stage = self._clean_text(checkpoint_payload.get("stage"))
                if stage and "stage" not in error_context:
                    error_context["stage"] = stage
                return error_context

        return None

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
            result = self.db.table("pkm_upgrade_runs").select("*").eq("user_id", user_id).execute()
            return self._sort_runs(result.data or [])
        except Exception as exc:
            logger.error("Failed to list PKM upgrade runs for %s: %s", user_id, exc)
            return []

    async def _list_steps(self, run_id: str) -> list[dict[str, Any]]:
        try:
            result = self.db.table("pkm_upgrade_steps").select("*").eq("run_id", run_id).execute()
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
                    self.db.table("pkm_manifests")
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

        # A user with no pkm_index row yet has nothing to be "behind" on: treat
        # them as already current instead of manufacturing a permanent
        # stored-vs-effective version gap that can never be repaired (there is
        # no index row for `_maybe_reconcile_current_index` to write to).
        stored_model_version = self._to_int(
            getattr(index, "model_version", None),
            CURRENT_PKM_MODEL_VERSION,
        )
        domain_states: list[dict[str, Any]] = []
        domain_summaries = index.domain_summaries if index else {}
        for domain in sorted(available_domains):
            summary = (
                domain_summaries.get(domain)
                if isinstance(domain_summaries.get(domain), dict)
                else {}
            )
            manifest = await self.pkm_service.get_domain_manifest(user_id, domain) or {}
            summary_projection = (
                manifest.get("summary_projection") if isinstance(manifest, dict) else {}
            )
            summary_projection = summary_projection if isinstance(summary_projection, dict) else {}
            summary_domain_version = summary.get("domain_contract_version")
            manifest_domain_version = manifest.get("domain_contract_version")
            summary_readable_version = summary.get("readable_summary_version")
            manifest_readable_version = manifest.get("readable_summary_version")
            current_domain_version = self._to_int(
                manifest_domain_version
                if manifest_domain_version is not None
                else summary_domain_version,
                0,
            )
            current_readable_version = self._to_int(
                manifest_readable_version
                if manifest_readable_version is not None
                else summary_readable_version,
                0,
            )
            target_domain_version = current_domain_contract_version(domain)
            target_readable_version = CURRENT_READABLE_SUMMARY_VERSION
            current_pkm_contract_version = (
                manifest.get("pkm_contract_version")
                or summary_projection.get("pkm_contract_version")
                or summary.get("pkm_contract_version")
                or "0.0.0"
            )
            current_readable_projection_version = (
                manifest.get("readable_projection_version")
                or summary_projection.get("readable_projection_version")
                or summary.get("readable_projection_version")
                or "0.0.0"
            )
            future_reasons: list[str] = []
            if current_domain_version > target_domain_version:
                future_reasons.append("future_domain_contract_version")
            if current_readable_version > target_readable_version:
                future_reasons.append("future_readable_summary_version")
            if self._semantic_version(current_pkm_contract_version) > self._semantic_version(
                CURRENT_PKM_CONTRACT_VERSION
            ):
                future_reasons.append("future_pkm_contract_version")
            if self._semantic_version(current_readable_projection_version) > self._semantic_version(
                CURRENT_READABLE_PROJECTION_VERSION
            ):
                future_reasons.append("future_readable_projection_version")
            needs_upgrade = (
                current_domain_version < target_domain_version
                or current_readable_version < target_readable_version
                or self._semantic_version(current_pkm_contract_version)
                < self._semantic_version(CURRENT_PKM_CONTRACT_VERSION)
                or self._semantic_version(current_readable_projection_version)
                < self._semantic_version(CURRENT_READABLE_PROJECTION_VERSION)
            ) and not future_reasons
            blocked_reasons = self._domain_blockers(manifest)
            if needs_upgrade and "missing_manifest" in blocked_reasons:
                # Discovery-only domains: a server-side summary flag (e.g. a
                # claim's has_regulator_profile) can list a domain in the index
                # before any encrypted blob exists. There is nothing to
                # upgrade, and marking it upgradable sends every app entry
                # into a run that fails on the missing blob.
                snapshot = await self.pkm_service.get_domain_snapshot(user_id, domain)
                if snapshot is None:
                    needs_upgrade = False
            if future_reasons:
                blocked_reasons = [*blocked_reasons, "client_update_required", *future_reasons]
            domain_states.append(
                {
                    "domain": domain,
                    "current_domain_contract_version": current_domain_version,
                    "target_domain_contract_version": target_domain_version,
                    "current_readable_summary_version": current_readable_version,
                    "target_readable_summary_version": target_readable_version,
                    "current_pkm_contract_version": str(current_pkm_contract_version),
                    "target_pkm_contract_version": CURRENT_PKM_CONTRACT_VERSION,
                    "current_readable_projection_version": str(current_readable_projection_version),
                    "target_readable_projection_version": CURRENT_READABLE_PROJECTION_VERSION,
                    "capabilities_applied": self._domain_capabilities(manifest),
                    "blocked_reasons": list(dict.fromkeys(blocked_reasons)),
                    "upgraded_at": manifest.get("upgraded_at") or summary.get("upgraded_at"),
                    "needs_upgrade": needs_upgrade,
                    "unsupported_future_version": bool(future_reasons),
                }
            )

        stale_domains = [domain for domain in domain_states if domain["needs_upgrade"]]
        unsupported_domains = [
            domain for domain in domain_states if domain["unsupported_future_version"]
        ]
        future_model_version = stored_model_version > CURRENT_PKM_MODEL_VERSION
        latest_run = await self._get_latest_run(user_id)
        if latest_run:
            latest_run["mode"] = self._clean_text(latest_run.get("mode")) or "real"
            latest_run["error_context"] = self._extract_run_error_context(latest_run)
        if latest_run and latest_run.get("status") == "failed" and not stale_domains:
            latest_run = None
        if future_model_version or unsupported_domains:
            upgrade_status = "client_update_required"
        elif latest_run and latest_run["status"] in _ACTIVE_RUN_STATUSES:
            upgrade_status = latest_run["status"]
        elif latest_run and latest_run["status"] == "failed" and stale_domains:
            upgrade_status = "failed"
        elif stale_domains:
            upgrade_status = "ready"
        else:
            upgrade_status = "current"

        effective_model_version = (
            stored_model_version
            if stale_domains or future_model_version or unsupported_domains
            else CURRENT_PKM_MODEL_VERSION
        )
        last_upgraded_at = self._coerce_datetime(getattr(index, "last_upgraded_at", None))
        if last_upgraded_at is None:
            last_upgraded_at = self._latest_domain_upgrade_at(domain_states)
        reported_pkm_contract_version = (
            unsupported_domains[0]["current_pkm_contract_version"]
            if unsupported_domains
            else CURRENT_PKM_CONTRACT_VERSION
            if not stale_domains
            else f"{stored_model_version}.0.0"
        )
        reported_readable_projection_version = (
            unsupported_domains[0]["current_readable_projection_version"]
            if unsupported_domains
            else CURRENT_READABLE_PROJECTION_VERSION
            if not stale_domains
            else "0.0.0"
        )

        return {
            "user_id": user_id,
            "model_version": effective_model_version,
            "stored_model_version": stored_model_version,
            "effective_model_version": effective_model_version,
            "target_model_version": CURRENT_PKM_MODEL_VERSION,
            "current_pkm_contract_version": reported_pkm_contract_version,
            "target_pkm_contract_version": CURRENT_PKM_CONTRACT_VERSION,
            "current_readable_projection_version": reported_readable_projection_version,
            "target_readable_projection_version": CURRENT_READABLE_PROJECTION_VERSION,
            "upgrade_status": upgrade_status,
            "upgradable_domains": (
                [] if future_model_version or unsupported_domains else stale_domains
            ),
            "unsupported_domains": unsupported_domains,
            "last_upgraded_at": last_upgraded_at,
            "run": latest_run,
            # Financial v7 is reader/shadow-first. Missing policy on older
            # clients must also fail closed, so every status response carries
            # an explicit server-owned kill switch.
            "upgrade_policy": self._upgrade_policy(user_id),
        }

    async def _maybe_reconcile_current_index(
        self,
        user_id: str,
        status_payload: dict[str, Any],
    ) -> dict[str, Any]:
        upgradable_domains = status_payload.get("upgradable_domains") or []
        if upgradable_domains:
            return status_payload
        if status_payload.get("upgrade_status") != "current":
            return status_payload

        index = await self.pkm_service.get_index_v2(user_id)
        if index is None:
            return status_payload

        stored_model_version = self._to_int(
            getattr(index, "model_version", None),
            CURRENT_PKM_MODEL_VERSION,
        )
        stored_last_upgraded_at = self._coerce_datetime(getattr(index, "last_upgraded_at", None))
        effective_last_upgraded_at = self._coerce_datetime(status_payload.get("last_upgraded_at"))
        target_last_upgraded_at = effective_last_upgraded_at or datetime.now(UTC)

        needs_version_repair = stored_model_version < CURRENT_PKM_MODEL_VERSION
        needs_timestamp_repair = (
            stored_last_upgraded_at is None or stored_last_upgraded_at < target_last_upgraded_at
        )
        if not (needs_version_repair or needs_timestamp_repair):
            return status_payload

        index.model_version = CURRENT_PKM_MODEL_VERSION
        index.last_upgraded_at = target_last_upgraded_at
        repaired = await self.pkm_service.upsert_index_v2(index)
        if not repaired:
            logger.warning(
                "Failed silent PKM index reconciliation for %s; serving effective current truth only.",
                user_id,
            )
            return status_payload
        return await self.build_status(user_id)

    async def start_or_resume_run(
        self,
        user_id: str,
        *,
        initiated_by: str = "unlock_warm",
        mode: str = "real",
    ) -> dict[str, Any]:
        status_payload = await self.build_status(user_id)
        if status_payload.get("upgrade_status") == "client_update_required":
            return status_payload
        latest_run = status_payload.get("run")
        if latest_run and latest_run.get("status") in _ACTIVE_RUN_STATUSES:
            if latest_run["status"] == "awaiting_local_auth_resume":
                await self.pkm_service._run_rpc(
                    "start_or_resume_pkm_upgrade_v1",
                    {
                        "p_user_id": user_id,
                        "p_run_id": latest_run["run_id"],
                        "p_from_model_version": status_payload.get("model_version") or 1,
                        "p_to_model_version": CURRENT_PKM_MODEL_VERSION,
                        "p_initiated_by": initiated_by,
                        "p_mode": mode,
                        "p_step_rows": JsonParam([]),
                    },
                )
            return await self.build_status(user_id)

        upgradable_domains = status_payload.get("upgradable_domains") or []
        if not upgradable_domains:
            if mode == "real":
                return await self._maybe_reconcile_current_index(user_id, status_payload)
            return status_payload

        if mode != "real":
            return status_payload

        run_id = f"pkm_upgrade_{uuid.uuid4().hex}"
        step_rows = [
            {
                "domain": domain_state["domain"],
                "from_domain_contract_version": domain_state["current_domain_contract_version"],
                "to_domain_contract_version": domain_state["target_domain_contract_version"],
                "from_readable_summary_version": domain_state["current_readable_summary_version"],
                "to_readable_summary_version": domain_state["target_readable_summary_version"],
            }
            for domain_state in upgradable_domains
        ]
        await self.pkm_service._run_rpc(
            "start_or_resume_pkm_upgrade_v1",
            {
                "p_user_id": user_id,
                "p_run_id": run_id,
                "p_from_model_version": status_payload.get("model_version") or 1,
                "p_to_model_version": CURRENT_PKM_MODEL_VERSION,
                "p_initiated_by": initiated_by,
                "p_mode": mode,
                "p_step_rows": JsonParam(step_rows),
            },
        )
        return await self.build_status(user_id)

    async def mark_run_status(
        self,
        *,
        run_id: str,
        user_id: str,
        status: str,
        current_domain: str | None = None,
        last_error: str | None = None,
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        current = runs[0]
        if current.get("user_id") != user_id:
            raise PermissionError("PKM upgrade run is not owned by authenticated user.")
        allowed = _RUN_TRANSITIONS.get(str(current.get("status") or ""), set())
        if status not in allowed:
            raise ValueError("Invalid PKM upgrade run state transition.")
        result = await self.pkm_service._run_rpc(
            "transition_pkm_upgrade_run_v1",
            {
                "p_user_id": user_id,
                "p_run_id": run_id,
                "p_target_status": status,
                "p_current_domain": current_domain,
                "p_set_current_domain": current_domain is not None,
                "p_last_error": last_error,
                "p_set_last_error": last_error is not None,
            },
        )
        payload = self.pkm_service._unwrap_rpc_payload(result, "transition_pkm_upgrade_run_v1")
        return payload if isinstance(payload, dict) else None

    async def issue_claim(
        self,
        *,
        user_id: str,
        run_id: str,
        domain: str,
        source_content_revision: int,
        source_manifest_revision: int,
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        if runs[0].get("user_id") != user_id:
            raise PermissionError("PKM upgrade run is not owned by authenticated user.")
        status_payload = await self.build_status(user_id)
        domain_state = next(
            (
                entry
                for entry in (status_payload.get("upgradable_domains") or [])
                if entry.get("domain") == domain
            ),
            None,
        )
        if not domain_state:
            raise ValueError("PKM domain is not eligible for an upgrade claim.")
        self.assert_upgrade_commit_allowed(
            user_id=user_id,
            upgrade_claim={
                "target_pkm_contract_version": domain_state.get("target_pkm_contract_version")
            },
        )
        rpc_result = await self.pkm_service._run_rpc(
            "issue_pkm_upgrade_claim_v1",
            {
                "p_user_id": user_id,
                "p_run_id": run_id,
                "p_domain": domain,
                "p_source_content_revision": max(0, source_content_revision),
                "p_source_manifest_revision": max(0, source_manifest_revision),
                "p_target_domain_contract_version": domain_state["target_domain_contract_version"],
                "p_target_readable_summary_version": domain_state[
                    "target_readable_summary_version"
                ],
                "p_target_pkm_contract_version": domain_state["target_pkm_contract_version"],
                "p_target_readable_projection_version": domain_state[
                    "target_readable_projection_version"
                ],
                "p_lease_seconds": 300,
            },
        )
        payload = self.pkm_service._unwrap_rpc_payload(rpc_result, "issue_pkm_upgrade_claim_v1")
        return payload if isinstance(payload, dict) else None

    async def rollback_revision(
        self,
        *,
        user_id: str,
        run_id: str,
        domain: str,
        revision_id: str,
        expected_content_revision: int,
        expected_manifest_revision: int,
        rollback_commit_id: str,
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        if runs[0].get("user_id") != user_id:
            raise PermissionError("PKM upgrade run is not owned by authenticated user.")
        rpc_result = await self.pkm_service._run_rpc(
            "rollback_pkm_domain_revision_v1",
            {
                "p_user_id": user_id,
                "p_run_id": run_id,
                "p_domain": domain,
                "p_revision_id": revision_id,
                "p_expected_content_revision": max(0, expected_content_revision),
                "p_expected_manifest_revision": max(0, expected_manifest_revision),
                "p_rollback_commit_id": rollback_commit_id,
            },
        )
        payload = self.pkm_service._unwrap_rpc_payload(
            rpc_result, "rollback_pkm_domain_revision_v1"
        )
        return payload if isinstance(payload, dict) else None

    async def _list_runs_for_run_id(self, run_id: str) -> list[dict[str, Any]]:
        try:
            result = self.db.table("pkm_upgrade_runs").select("*").eq("run_id", run_id).execute()
            return self._sort_runs(result.data or [])
        except Exception as exc:
            logger.error("Failed to fetch PKM upgrade run %s: %s", run_id, exc)
            return []

    async def update_step(
        self,
        *,
        run_id: str,
        user_id: str,
        domain: str,
        status: str,
        checkpoint_payload: dict[str, Any] | None = None,
        attempt_count: int | None = None,
        last_completed_content_revision: int | None = None,
        last_completed_manifest_version: int | None = None,
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        if runs[0].get("user_id") != user_id:
            raise PermissionError("PKM upgrade run is not owned by authenticated user.")
        rows = await self._list_steps(run_id)
        current = next((row for row in rows if row["domain"] == domain), None)
        if current is None:
            return None
        allowed = _STEP_TRANSITIONS.get(str(current.get("status") or ""), set())
        if status not in allowed:
            raise ValueError("Invalid PKM upgrade step state transition.")
        result = await self.pkm_service._run_rpc(
            "transition_pkm_upgrade_step_v1",
            {
                "p_user_id": user_id,
                "p_run_id": run_id,
                "p_domain": domain,
                "p_target_status": status,
                "p_checkpoint_payload": JsonParam(
                    checkpoint_payload if isinstance(checkpoint_payload, dict) else {}
                ),
                "p_attempt_count": max(0, attempt_count) if attempt_count is not None else None,
                "p_last_completed_content_revision": last_completed_content_revision,
                "p_last_completed_manifest_version": last_completed_manifest_version,
            },
        )
        payload = self.pkm_service._unwrap_rpc_payload(result, "transition_pkm_upgrade_step_v1")
        updated_step = payload if isinstance(payload, dict) else None
        return updated_step

    async def complete_run(self, run_id: str, *, user_id: str) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        run = runs[0]
        if run.get("user_id") != user_id:
            raise PermissionError("PKM upgrade run is not owned by authenticated user.")
        steps = await self._list_steps(run_id)
        if any(step["status"] != "completed" for step in steps):
            raise ValueError("Cannot complete PKM upgrade run with unfinished steps.")

        now = datetime.now(UTC)
        await self.mark_run_status(
            run_id=run_id,
            user_id=user_id,
            status="completed",
            current_domain=None,
        )

        index = await self.pkm_service.get_index_v2(run["user_id"])
        if index is None:
            index = PersonalKnowledgeModelIndex(user_id=run["user_id"])
        index.model_version = CURRENT_PKM_MODEL_VERSION
        index.last_upgraded_at = now
        await self.pkm_service.upsert_index_v2(index)
        return await self.build_status(run["user_id"])

    async def fail_run(
        self,
        run_id: str,
        *,
        user_id: str,
        last_error: str | None = None,
        error_context: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        runs = await self._list_runs_for_run_id(run_id)
        if not runs:
            return None
        run = runs[0]
        if run.get("user_id") != user_id:
            raise PermissionError("PKM upgrade run is not owned by authenticated user.")
        normalized_error_context = self._normalize_error_context(error_context)
        if normalized_error_context:
            step_domain = self._clean_text(
                normalized_error_context.get("domain")
            ) or self._clean_text(run.get("current_domain"))
            if step_domain:
                steps = await self._list_steps(run_id)
                current_step = next((step for step in steps if step["domain"] == step_domain), None)
                if current_step:
                    checkpoint_payload = dict(current_step.get("checkpoint_payload") or {})
                    checkpoint_payload["error_context"] = normalized_error_context
                    stage = self._clean_text(normalized_error_context.get("stage"))
                    if stage:
                        checkpoint_payload["stage"] = stage
                    await self.update_step(
                        run_id=run_id,
                        user_id=user_id,
                        domain=step_domain,
                        status="failed",
                        checkpoint_payload=checkpoint_payload,
                        attempt_count=current_step.get("attempt_count"),
                        last_completed_content_revision=current_step.get(
                            "last_completed_content_revision"
                        ),
                        last_completed_manifest_version=current_step.get(
                            "last_completed_manifest_version"
                        ),
                    )

        await self.mark_run_status(
            run_id=run_id,
            user_id=user_id,
            status="failed",
            last_error=last_error,
        )
        return await self.build_status(runs[0]["user_id"])


_pkm_upgrade_service: PkmUpgradeService | None = None


def get_pkm_upgrade_service() -> PkmUpgradeService:
    global _pkm_upgrade_service
    if _pkm_upgrade_service is None:
        _pkm_upgrade_service = PkmUpgradeService()
    return _pkm_upgrade_service
