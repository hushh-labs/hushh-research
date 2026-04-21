#!/usr/bin/env python3
"""Local PKM core-path smoke for normalization, NL routing, and consumer scope parity.

This harness uses the real local Firebase + vault-owner flow, routes natural-language
messages through the PKM preview endpoint, persists save-capable mutations through the
normal PKM store route, verifies manifest/index/discovery parity after each mutation,
and restores any touched domains before exit.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
MONOREPO_ROOT = CONSENT_PROTOCOL_ROOT.parent
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from scripts.uat_kai_regression_smoke import UatKaiSmoke  # noqa: E402

DEFAULT_LOCAL_BACKEND_URL = "http://127.0.0.1:8000"
DEFAULT_PROTOCOL_ENV = CONSENT_PROTOCOL_ROOT / ".env"
DEFAULT_WEB_ENV = MONOREPO_ROOT / "hushh-webapp" / ".env.local"
DEFAULT_REPORT_PATH = MONOREPO_ROOT / "tmp" / "pkm_v4_core_path_smoke_latest.json"

_STRUCTURAL_SCOPE_SUFFIXES = {
    ".domain_intent.*",
    ".schema_version.*",
    ".updated_at.*",
}


@dataclass(frozen=True)
class PromptCase:
    case_id: str
    message: str
    category: str
    expectation: str
    persist_if_can_save: bool = False


@dataclass
class DomainBackup:
    existed: bool
    encrypted_blob: dict[str, Any] | None
    manifest: dict[str, Any] | None
    summary: dict[str, Any] | None


class LocalPkmCorePathSmoke(UatKaiSmoke):
    def __init__(self, *, backend_url: str, protocol_env: str, web_env: str, timeout: int):
        super().__init__(
            backend_url=backend_url,
            protocol_env=protocol_env,
            web_env=web_env,
            timeout=timeout,
        )
        self._domain_backups: dict[str, DomainBackup] = {}

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        json_body: Any | None = None,
        params: dict[str, Any] | None = None,
        expected: int | None = 200,
    ) -> dict[str, Any]:
        response = self._request(
            method,
            path,
            headers=headers,
            json_body=json_body,
            params=params,
            expected=expected,
        )
        return response.json()

    def preview_structure(
        self,
        *,
        message: str,
        current_domains: list[str],
        simulated_state: dict[str, Any] | None,
    ) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "/api/pkm/agent-lab/structure",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body={
                "user_id": self.user_id,
                "message": message,
                "current_domains": current_domains,
                "simulated_state": simulated_state,
            },
        )

    def compact_scope_snapshot(self) -> dict[str, Any]:
        return self._request_json(
            "GET",
            f"/api/v1/user-scopes/{self.user_id}",
            params={"token": self.developer_token},
        )

    def fetch_metadata(self) -> dict[str, Any]:
        return self.fetch_pkm_metadata()

    def fetch_domain_summary(self, domain: str) -> dict[str, Any] | None:
        payload = self.fetch_metadata()
        for item in payload.get("domains", []):
            if str(item.get("key") or "").strip() == domain:
                return item
        return None

    def fetch_domain_blob_optional(self, domain: str) -> dict[str, Any] | None:
        response = self._request(
            "GET",
            f"/api/pkm/domain-data/{self.user_id}/{domain}",
            headers=self._vault_headers(),
            expected=None,
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError(
                f"GET /api/pkm/domain-data/{domain} returned {response.status_code}: {response.text[:1200]}"
            )
        return response.json()

    def fetch_domain_manifest_optional(self, domain: str) -> dict[str, Any] | None:
        response = self._request(
            "GET",
            f"/api/pkm/manifest/{self.user_id}/{domain}",
            headers=self._vault_headers(),
            expected=None,
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError(
                f"GET /api/pkm/manifest/{domain} returned {response.status_code}: {response.text[:1200]}"
            )
        return response.json()

    def delete_domain_optional(self, domain: str) -> None:
        response = self._request(
            "DELETE",
            f"/api/pkm/domain-data/{self.user_id}/{domain}",
            headers=self._vault_headers(),
            expected=None,
        )
        if response.status_code not in {200, 404}:
            raise RuntimeError(
                f"DELETE /api/pkm/domain-data/{domain} returned {response.status_code}: {response.text[:1200]}"
            )

    def backup_domain(self, domain: str) -> None:
        if domain in self._domain_backups:
            return
        blob_payload = self.fetch_domain_blob_optional(domain)
        manifest = self.fetch_domain_manifest_optional(domain)
        summary = self.fetch_domain_summary(domain)
        self._domain_backups[domain] = DomainBackup(
            existed=blob_payload is not None,
            encrypted_blob=copy.deepcopy(blob_payload),
            manifest=copy.deepcopy(manifest),
            summary=copy.deepcopy(summary.get("summary") if isinstance(summary, dict) else None),
        )

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _local_time_metadata() -> tuple[str, str]:
        now = datetime.now().astimezone()
        timezone_name = now.tzname() or "UTC"
        return timezone_name, now.isoformat()

    @classmethod
    def _deep_merge(cls, base: Any, patch: Any) -> Any:
        if isinstance(base, dict) and isinstance(patch, dict):
            merged = {**base}
            for key, value in patch.items():
                if key in merged:
                    merged[key] = cls._deep_merge(merged[key], value)
                else:
                    merged[key] = copy.deepcopy(value)
            return merged
        return copy.deepcopy(patch)

    @staticmethod
    def _normalize_path(path: str | None) -> str:
        return ".".join(
            segment.strip() for segment in str(path or "").split(".") if segment and segment.strip()
        )

    @classmethod
    def _extract_patch_value(cls, payload: dict[str, Any], path: str | None) -> Any:
        normalized_path = cls._normalize_path(path)
        if not normalized_path:
            return copy.deepcopy(payload)
        cursor: Any = payload
        for segment in normalized_path.split("."):
            if not isinstance(cursor, dict):
                return None
            cursor = cursor.get(segment)
        return copy.deepcopy(cursor)

    @classmethod
    def _ensure_scope_container(
        cls,
        domain_data: dict[str, Any],
        scope_path: str | None,
    ) -> dict[str, Any]:
        normalized_path = cls._normalize_path(scope_path)
        if not normalized_path:
            return domain_data
        cursor = domain_data
        for segment in normalized_path.split("."):
            next_value = cursor.get(segment)
            if not isinstance(next_value, dict):
                next_value = {}
                cursor[segment] = next_value
            cursor = next_value
        return cursor

    @classmethod
    def _count_entities(cls, value: Any) -> int:
        if isinstance(value, dict):
            total = 0
            entities = value.get("entities")
            if isinstance(entities, dict):
                for entity in entities.values():
                    if (
                        isinstance(entity, dict)
                        and str(entity.get("status") or "active") != "deleted"
                    ):
                        total += 1
            for child in value.values():
                total += cls._count_entities(child)
            return total
        if isinstance(value, list):
            return sum(cls._count_entities(item) for item in value)
        return 0

    @classmethod
    def _source_label_for_domain(cls, domain: str, prior_summary: dict[str, Any] | None) -> str:
        if isinstance(prior_summary, dict):
            existing = str(prior_summary.get("readable_source_label") or "").strip()
            if existing:
                return existing
        if domain == "ria":
            return "Advisor package"
        if domain == "shopping":
            return "Saved memory"
        return "Saved memory"

    def _build_summary(
        self,
        *,
        domain: str,
        message: str,
        domain_data: dict[str, Any],
        prior_summary: dict[str, Any] | None,
    ) -> dict[str, Any]:
        timezone_name, local_time = self._local_time_metadata()
        item_count = self._count_entities(domain_data)
        if item_count <= 0:
            item_count = 1 if domain_data else 0
        summary = copy.deepcopy(prior_summary or {})
        summary.update(
            {
                "item_count": item_count,
                "attribute_count": item_count,
                "readable_summary": message[:220],
                "readable_highlights": [message[:120]],
                "readable_updated_at": self._now_iso(),
                "readable_source_label": self._source_label_for_domain(domain, prior_summary),
                "source_timezone": timezone_name,
                "source_local_time": local_time,
            }
        )
        return summary

    def _apply_preview_to_domain_data(
        self,
        *,
        current_domain_data: dict[str, Any],
        preview: dict[str, Any],
    ) -> dict[str, Any]:
        next_domain_data = copy.deepcopy(current_domain_data)
        candidate_payload = (
            preview.get("candidate_payload")
            if isinstance(preview.get("candidate_payload"), dict)
            else {}
        )
        merge_decision = (
            preview.get("merge_decision") if isinstance(preview.get("merge_decision"), dict) else {}
        )
        merge_mode = str(merge_decision.get("merge_mode") or "").strip()
        target_entity_scope = self._normalize_path(preview.get("target_entity_scope"))
        target_entity_id = str(merge_decision.get("target_entity_id") or "").strip()

        if merge_mode in {"create_entity", "extend_entity"}:
            return self._deep_merge(next_domain_data, candidate_payload)

        if merge_mode == "correct_entity":
            scope_patch = self._extract_patch_value(candidate_payload, target_entity_scope)
            if (
                target_entity_scope
                and target_entity_id
                and isinstance(scope_patch, dict)
                and isinstance(scope_patch.get("entities"), dict)
                and target_entity_id in scope_patch["entities"]
            ):
                scope_container = self._ensure_scope_container(
                    next_domain_data, target_entity_scope
                )
                entities = scope_container.setdefault("entities", {})
                if not isinstance(entities, dict):
                    entities = {}
                    scope_container["entities"] = entities
                entities[target_entity_id] = copy.deepcopy(
                    scope_patch["entities"][target_entity_id]
                )
                return next_domain_data
            return self._deep_merge(next_domain_data, candidate_payload)

        if merge_mode == "delete_entity":
            if target_entity_scope and target_entity_id:
                scope_container = self._ensure_scope_container(
                    next_domain_data, target_entity_scope
                )
                entities = scope_container.get("entities")
                if isinstance(entities, dict) and isinstance(entities.get(target_entity_id), dict):
                    entity = copy.deepcopy(entities[target_entity_id])
                    entity["status"] = "deleted"
                    entity["deleted_at"] = self._now_iso()
                    entities[target_entity_id] = entity
                    return next_domain_data
            return self._deep_merge(next_domain_data, candidate_payload)

        return copy.deepcopy(next_domain_data)

    def store_preview_result(
        self,
        *,
        domain: str,
        message: str,
        preview: dict[str, Any],
    ) -> dict[str, Any]:
        self.backup_domain(domain)
        prior_summary = self._domain_backups[domain].summary or {}
        existing_blob = self.fetch_domain_blob_optional(domain)
        current_domain_data = (
            self._decrypt_domain_blob(existing_blob) if isinstance(existing_blob, dict) else {}
        )
        next_domain_data = self._apply_preview_to_domain_data(
            current_domain_data=current_domain_data,
            preview=preview,
        )
        encrypted_blob = self._encrypt_domain_blob(next_domain_data)
        manifest = (
            preview.get("manifest_draft") if isinstance(preview.get("manifest_draft"), dict) else {}
        )
        summary = self._build_summary(
            domain=domain,
            message=message,
            domain_data=next_domain_data,
            prior_summary=prior_summary,
        )
        store_payload = {
            "user_id": self.user_id,
            "domain": domain,
            "encrypted_blob": encrypted_blob,
            "summary": summary,
            "structure_decision": preview.get("structure_decision") or {},
            "manifest": manifest,
            "source_agent": "pkm_core_path_smoke",
        }
        return self._request_json(
            "POST",
            "/api/pkm/store-domain",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body=store_payload,
        )

    def build_simulated_state(self) -> dict[str, Any]:
        metadata = self.fetch_metadata()
        domains = [
            str(domain.get("key") or "").strip()
            for domain in metadata.get("domains", [])
            if str(domain.get("key") or "").strip()
        ]
        memories: list[dict[str, Any]] = []
        for domain in domains:
            blob_payload = self.fetch_domain_blob_optional(domain)
            if not isinstance(blob_payload, dict):
                continue
            domain_data = self._decrypt_domain_blob(blob_payload)

            def _walk(value: Any, path: list[str], *, domain_key: str = domain) -> None:
                if not isinstance(value, dict):
                    return
                entities = value.get("entities")
                if isinstance(entities, dict):
                    scope = ".".join(path)
                    for entity_id, entity in entities.items():
                        if not isinstance(entity, dict):
                            continue
                        message = str(entity.get("summary") or "").strip()
                        observations = entity.get("observations")
                        if not message and isinstance(observations, list) and observations:
                            message = str(observations[0] or "").strip()
                        memories.append(
                            {
                                "domain": domain_key,
                                "entity_scope": scope,
                                "entity_id": str(entity.get("entity_id") or entity_id),
                                "message": message,
                                "active": str(entity.get("status") or "active") != "deleted",
                            }
                        )
                for key, child in value.items():
                    if isinstance(child, dict):
                        _walk(child, [*path, str(key)], domain_key=domain_key)

            _walk(domain_data, [])

        return {"memories": memories}

    def verify_post_write_contract(self, *, domain: str) -> dict[str, Any]:
        metadata = self.fetch_metadata()
        manifest = self.fetch_domain_manifest_optional(domain)
        scope_snapshot = self.compact_scope_snapshot()

        domain_summary = next(
            (
                item
                for item in metadata.get("domains", [])
                if str(item.get("key") or "").strip() == domain
            ),
            None,
        )
        if domain_summary is None:
            raise RuntimeError(f"PKM metadata lost domain after write: {domain}")
        if not isinstance(manifest, dict):
            raise RuntimeError(f"PKM manifest missing after write: {domain}")

        scope_registry = manifest.get("scope_registry") or []
        seen_top_levels: set[str] = set()
        for entry in scope_registry:
            if not isinstance(entry, dict):
                continue
            projection = (
                entry.get("summary_projection")
                if isinstance(entry.get("summary_projection"), dict)
                else {}
            )
            top_level = str(projection.get("top_level_scope_path") or "").strip()
            if not top_level:
                continue
            if top_level in seen_top_levels:
                raise RuntimeError(
                    f"Duplicate top-level scope row remains for {domain}: {top_level}"
                )
            seen_top_levels.add(top_level)
            if top_level in {"domain_intent", "schema_version", "updated_at"} and (
                projection.get("consumer_visible") is not False
                or projection.get("internal_only") is not True
            ):
                raise RuntimeError(
                    f"Structural scope remained consumer-visible for {domain}: {top_level}"
                )

        available_domains = {
            str(item).strip()
            for item in scope_snapshot.get("available_domains", [])
            if str(item).strip()
        }
        if domain not in available_domains:
            raise RuntimeError(f"Compact developer discovery lost domain after write: {domain}")

        leaked_scopes = [
            scope
            for scope in (scope_snapshot.get("scopes") or [])
            if any(str(scope).endswith(suffix) for suffix in _STRUCTURAL_SCOPE_SUFFIXES)
        ]
        if leaked_scopes:
            raise RuntimeError(
                f"Compact developer discovery leaked structural scopes: {leaked_scopes}"
            )

        return {
            "domain": domain,
            "metadata_item_count": (
                domain_summary.get("summary", {}).get("item_count")
                if isinstance(domain_summary.get("summary"), dict)
                else None
            ),
            "manifest_version": manifest.get("manifest_version"),
            "scope_registry_count": len(scope_registry),
            "compact_scope_count": len(scope_snapshot.get("scopes") or []),
        }

    def restore_domains(self) -> None:
        for domain, backup in self._domain_backups.items():
            if not backup.existed:
                self.delete_domain_optional(domain)
                continue
            if not isinstance(backup.encrypted_blob, dict) or not isinstance(backup.manifest, dict):
                continue
            encrypted_blob = backup.encrypted_blob.get("encrypted_blob") or {}
            if not isinstance(encrypted_blob, dict):
                continue
            self._request_json(
                "POST",
                "/api/pkm/store-domain",
                headers={**self._vault_headers(), "Content-Type": "application/json"},
                json_body={
                    "user_id": self.user_id,
                    "domain": domain,
                    "encrypted_blob": encrypted_blob,
                    "summary": backup.summary or {},
                    "manifest": backup.manifest,
                    "source_agent": "pkm_core_path_smoke_restore",
                },
            )


def prompt_cases() -> list[PromptCase]:
    return [
        PromptCase("p01", "I live in San Francisco.", "create", "save_capable", True),
        PromptCase("p02", "Actually I live in New York City now.", "correct", "save_capable", True),
        PromptCase("p03", "I prefer aisle seats on long flights.", "create", "save_capable", True),
        PromptCase(
            "p04", "I still prefer aisle seats for work trips.", "extend", "save_capable", True
        ),
        PromptCase(
            "p05", "Actually window seats work better now.", "correct", "save_capable", True
        ),
        PromptCase("p06", "Forget the old seat preference.", "delete", "save_capable", True),
        PromptCase("p07", "I love Cantonese food.", "create", "save_capable", True),
        PromptCase(
            "p08", "Actually Thai food fits me better these days.", "correct", "save_capable", True
        ),
        PromptCase("p09", "Forget that old food note.", "delete", "save_capable", True),
        PromptCase(
            "p10", "I prefer Patagonia over Nike for jackets.", "preference", "save_capable", True
        ),
        PromptCase(
            "p11",
            "What do you already know about my location preferences?",
            "query",
            "must_not_save",
        ),
        PromptCase(
            "p12", "What have you saved about my shopping habits?", "query", "must_not_save"
        ),
        PromptCase(
            "p13",
            "Remind me tomorrow to review my brokerage statement.",
            "reminder",
            "must_not_save",
        ),
        PromptCase("p14", "Buy groceries tonight.", "task", "must_not_save"),
        PromptCase("p15", "7b9a662f0c63a4d8f65f5b9d4cb4e2aa", "malformed", "must_not_save"),
        PromptCase("p16", "asdf qwer zxcv", "malformed", "must_not_save"),
        PromptCase("p17", "Maybe this matters.", "ambiguous", "must_not_save"),
        PromptCase(
            "p18", "Sell half my AAPL position tomorrow.", "financial_core", "must_not_save"
        ),
        PromptCase(
            "p19",
            "Rebalance my portfolio toward dividend stocks.",
            "financial_core",
            "must_not_save",
        ),
        PromptCase("p20", "Move 20% into bonds next week.", "financial_core", "must_not_save"),
        PromptCase(
            "p21", "I want lower portfolio volatility.", "financial_memory", "observed_only"
        ),
        PromptCase(
            "p22", "I care most about long-term growth.", "financial_memory", "observed_only"
        ),
        PromptCase(
            "p23", "I might want to remember boutique hotels.", "preview_only", "observed_only"
        ),
        PromptCase(
            "p24",
            "I want the system to keep finance separate from non-financial memory.",
            "policy",
            "observed_only",
        ),
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run PKM v4 local core-path smoke.")
    parser.add_argument("--backend-url", default=DEFAULT_LOCAL_BACKEND_URL)
    parser.add_argument("--protocol-env", default=str(DEFAULT_PROTOCOL_ENV))
    parser.add_argument("--web-env", default=str(DEFAULT_WEB_ENV))
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--json-out", default=str(DEFAULT_REPORT_PATH))
    parser.add_argument(
        "--limit",
        type=int,
        default=24,
        help="Limit prompt cases for quicker iteration.",
    )
    return parser.parse_args()


def write_report(report_path: Path, payload: dict[str, Any]) -> None:
    report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def summarize_release_issues(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for result in results:
        case_id = str(result.get("case_id") or "").strip()
        category = str(result.get("category") or "").strip()
        write_mode = str(result.get("write_mode") or "").strip()
        target_domain = str(result.get("target_domain") or "").strip() or None
        persisted = bool(result.get("persisted"))
        verification = result.get("verification")

        if persisted and not isinstance(verification, dict):
            issues.append(
                {
                    "case_id": case_id,
                    "issue": "persisted_case_missing_verification",
                    "write_mode": write_mode,
                    "target_domain": target_domain,
                }
            )

        if category == "financial_core":
            if write_mode != "do_not_save":
                issues.append(
                    {
                        "case_id": case_id,
                        "issue": "financial_core_should_not_be_save_capable",
                        "write_mode": write_mode,
                        "target_domain": target_domain,
                    }
                )
            if target_domain not in {None, "financial"}:
                issues.append(
                    {
                        "case_id": case_id,
                        "issue": "financial_core_target_domain_mismatch",
                        "write_mode": write_mode,
                        "target_domain": target_domain,
                    }
                )

        if category == "preview_only" and write_mode == "can_save":
            issues.append(
                {
                    "case_id": case_id,
                    "issue": "preview_only_prompt_became_save_capable",
                    "write_mode": write_mode,
                    "target_domain": target_domain,
                }
            )

    return issues


def main() -> int:
    args = parse_args()
    load_dotenv(args.protocol_env, override=True)
    load_dotenv(args.web_env, override=False)

    smoke = LocalPkmCorePathSmoke(
        backend_url=args.backend_url,
        protocol_env=args.protocol_env,
        web_env=args.web_env,
        timeout=args.timeout,
    )
    report_path = Path(args.json_out)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    started_at = time.time()
    failure: str | None = None

    try:
        smoke.authenticate()
        smoke.derive_vault_key()
        initial_metadata = smoke.fetch_metadata()
        write_report(
            report_path,
            {
                "status": "running",
                "backend_url": args.backend_url,
                "user_id": smoke.user_id,
                "initial_domain_count": len(initial_metadata.get("domains", [])),
                "results": results,
                "started_at": started_at,
            },
        )

        for case in prompt_cases()[: max(1, args.limit)]:
            write_report(
                report_path,
                {
                    "status": "running",
                    "backend_url": args.backend_url,
                    "user_id": smoke.user_id,
                    "initial_domain_count": len(initial_metadata.get("domains", [])),
                    "current_case": asdict(case),
                    "completed_count": len(results),
                    "results": results,
                    "started_at": started_at,
                },
            )
            current_metadata = smoke.fetch_metadata()
            current_domains = [
                str(item.get("key") or "").strip()
                for item in current_metadata.get("domains", [])
                if str(item.get("key") or "").strip()
            ]
            simulated_state = smoke.build_simulated_state()
            preview = smoke.preview_structure(
                message=case.message,
                current_domains=current_domains,
                simulated_state=simulated_state,
            )
            write_mode = str(preview.get("write_mode") or "").strip()
            routing_decision = str(preview.get("routing_decision") or "").strip()
            target_domain = str(
                (preview.get("manifest_draft") or {}).get("domain")
                or (preview.get("structure_decision") or {}).get("target_domain")
                or ""
            ).strip()

            if case.expectation == "must_not_save" and write_mode != "do_not_save":
                raise RuntimeError(
                    f"{case.case_id} expected do_not_save, got {write_mode} ({case.message})"
                )
            if case.expectation == "save_capable" and write_mode == "do_not_save":
                raise RuntimeError(
                    f"{case.case_id} expected a save-capable route, got do_not_save ({case.message})"
                )

            persisted = False
            verification: dict[str, Any] | None = None
            if case.persist_if_can_save and write_mode == "can_save" and target_domain:
                store_result = smoke.store_preview_result(
                    domain=target_domain,
                    message=case.message,
                    preview=preview,
                )
                persisted = True
                verification = smoke.verify_post_write_contract(domain=target_domain)
            else:
                store_result = None

            results.append(
                {
                    "case_id": case.case_id,
                    "message": case.message,
                    "category": case.category,
                    "expectation": case.expectation,
                    "routing_decision": routing_decision,
                    "write_mode": write_mode,
                    "target_domain": target_domain or None,
                    "validation_hints": preview.get("validation_hints") or [],
                    "persisted": persisted,
                    "store_result": store_result,
                    "verification": verification,
                }
            )
            write_report(
                report_path,
                {
                    "status": "running",
                    "backend_url": args.backend_url,
                    "user_id": smoke.user_id,
                    "initial_domain_count": len(initial_metadata.get("domains", [])),
                    "completed_count": len(results),
                    "last_completed_case_id": case.case_id,
                    "results": results,
                    "started_at": started_at,
                },
            )

        compact_scope_snapshot = smoke.compact_scope_snapshot()
        final_metadata = smoke.fetch_metadata()
        leaked_scopes = [
            scope
            for scope in (compact_scope_snapshot.get("scopes") or [])
            if any(str(scope).endswith(suffix) for suffix in _STRUCTURAL_SCOPE_SUFFIXES)
        ]
        if leaked_scopes:
            raise RuntimeError(f"Final compact discovery leaked structural scopes: {leaked_scopes}")

        release_issues = summarize_release_issues(results)
        status = "ok" if not release_issues else "issues_detected"
        if release_issues and failure is None:
            failure = f"{len(release_issues)} release issue(s) detected"
        report = {
            "status": status,
            "backend_url": args.backend_url,
            "user_id": smoke.user_id,
            "initial_domain_count": len(initial_metadata.get("domains", [])),
            "final_domain_count": len(final_metadata.get("domains", [])),
            "compact_scope_count": len(compact_scope_snapshot.get("scopes", [])),
            "prompt_count": len(results),
            "persisted_count": sum(1 for result in results if result.get("persisted")),
            "release_issues": release_issues,
            "results": results,
            "duration_seconds": round(time.time() - started_at, 2),
        }
    except Exception as exc:
        failure = str(exc)
        report = {
            "status": "failed",
            "backend_url": args.backend_url,
            "user_id": getattr(smoke, "user_id", None),
            "results": results,
            "error": failure,
            "duration_seconds": round(time.time() - started_at, 2),
        }
    finally:
        try:
            smoke.restore_domains()
        except Exception as restore_exc:
            report["restore_error"] = str(restore_exc)

    write_report(report_path, report)
    print(json.dumps(report, indent=2))
    return 0 if failure is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
