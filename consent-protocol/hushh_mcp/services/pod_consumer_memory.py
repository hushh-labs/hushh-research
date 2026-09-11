"""Consumer MCP memory execution inside one owner's pod.

The gateway owns client/grant fencing; this module owns the pod data plane.  It
uses the existing rebuildable ``PodPkmStore`` and ``PodVaultCustody`` only.  The
vault key is recovered into this process for the bounded decrypt/modify/commit
window and is never returned, logged, or persisted by this adapter.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import uuid
from datetime import UTC, datetime
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.pod_pkm_resolver import resolve_pod_pkm_store

MAX_DOMAIN_RECORDS = 20
MAX_RECORD_CONTENT_CHARS = 4_000
_COMMIT_NAMESPACE = uuid.UUID("7a3b1778-5f9a-44d7-b1a2-2b5304d8a3a0")


class PodConsumerMemoryUnavailable(RuntimeError):
    """The pod lacks an active custody-backed PKM data plane."""


class PodConsumerMemoryConflict(RuntimeError):
    """The canonical PKM revision changed before this mutation committed."""


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _unb64(value: Any) -> bytes:
    return base64.b64decode(str(value or ""), validate=True)


def _encrypt(value: Any, key: bytes) -> dict[str, str]:
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(nonce, json.dumps(value, separators=(",", ":")).encode(), None)
    return {
        "ciphertext": _b64(sealed[:-16]),
        "iv": _b64(nonce),
        "tag": _b64(sealed[-16:]),
        "algorithm": "aes-256-gcm",
    }


def _decrypt(blob: dict[str, Any], key: bytes) -> Any:
    if str(blob.get("algorithm") or "aes-256-gcm").lower() != "aes-256-gcm":
        raise PodConsumerMemoryUnavailable("unsupported PKM encryption")
    sealed = AESGCM(key).decrypt(
        _unb64(blob.get("iv")), _unb64(blob.get("ciphertext")) + _unb64(blob.get("tag")), None
    )
    value = json.loads(sealed)
    if not isinstance(value, dict):
        raise PodConsumerMemoryUnavailable("PKM domain is not an object")
    return value


def _records(value: dict[str, Any]) -> list[dict[str, Any]]:
    raw = value.get("consumer_memory")
    if not isinstance(raw, list):
        return []
    records: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict) and isinstance(item.get("content"), str):
            records.append(
                {
                    "id": str(item.get("id") or "")[:128],
                    "content": str(item.get("content") or "")[:MAX_RECORD_CONTENT_CHARS],
                    "updated_at": str(item.get("updated_at") or ""),
                }
            )
    return records[-MAX_DOMAIN_RECORDS:]


def _manifest(
    snapshot: dict[str, Any], *, domain: str, revision: int
) -> tuple[dict, list[dict], list[dict]]:
    prior = snapshot.get("manifest") if isinstance(snapshot.get("manifest"), dict) else {}
    manifest = dict(prior)
    manifest.update(
        {
            "manifest_version": revision,
            "structure_decision": {
                "action": "match_existing_domain" if prior else "create_domain",
                "source_agent": "consumer_mcp",
                "confidence": 1.0,
                "contract_version": "pkm.v7",
            },
            "summary_projection": {
                "memory_count": 0,
                "storage_mode": "per_domain_blob",
                "source": "consumer_mcp",
            },
            "top_level_scope_paths": ["consumer_memory"],
            "externalizable_paths": ["consumer_memory"],
            "segment_ids": ["root"],
            "path_count": 1,
            "externalizable_path_count": 1,
            "last_structured_at": datetime.now(UTC).isoformat(),
            "last_content_at": datetime.now(UTC).isoformat(),
            "domain_contract_version": 1,
            "readable_summary_version": 1,
            "pkm_contract_version": "7.0.0",
            "readable_projection_version": "1.0.0",
        }
    )
    paths = snapshot.get("paths") if isinstance(snapshot.get("paths"), list) else []
    scopes = snapshot.get("scopes") if isinstance(snapshot.get("scopes"), list) else []
    if not paths:
        paths = [
            {
                "json_path": "consumer_memory",
                "parent_path": None,
                "path_type": "leaf",
                "segment_id": "root",
                "scope_handle": "scope_consumer_memory",
                "exposure_eligibility": True,
                "consent_label": "Personal memory",
                "sensitivity_label": "confidential",
                "source_agent": "consumer_mcp",
            }
        ]
    if not scopes:
        scopes = [
            {
                "scope_handle": "scope_consumer_memory",
                "scope_label": "Personal memory",
                "segment_ids": ["root"],
                "sensitivity_tier": "confidential",
                "scope_kind": "structured",
                "exposure_enabled": True,
                "manifest_version": revision,
                "summary_projection": {},
                "visibility_posture": "private",
                "default_projection_ready": False,
                "owner_consent_override": False,
                "scope_origin": "structured",
                "scope_origin_code": "consumer_mcp",
                "source_kind": "structured",
            }
        ]
    return manifest, paths, scopes


class PodConsumerMemoryExecutor:
    """Decrypt and commit one bounded typed operation inside the owner pod."""

    def __init__(self, *, store: Any, vault_key: bytes):
        if len(vault_key) != 32:
            raise PodConsumerMemoryUnavailable("pod custody key unavailable")
        self._store = store
        self._vault_key = vault_key

    async def execute(self, *, owner_id: str, operation: str, arguments: dict[str, Any]) -> dict:
        domain = str(arguments["domain"])
        snapshot = await self._store.get_domain_snapshot(
            {"p_user_id": owner_id, "p_domain": domain, "p_segment_ids": []}
        )
        current_revision = int(snapshot.get("content_revision") or 0)
        value: dict[str, Any] = {}
        segments = snapshot.get("segments") if isinstance(snapshot, dict) else None
        if isinstance(segments, dict) and segments:
            root = segments.get("root") or next(iter(segments.values()))
            if isinstance(root, dict):
                value = _decrypt(root, self._vault_key)
        records = _records(value)
        query = str(arguments.get("query") or "").strip().casefold()
        if operation in {"read", "query"}:
            matches = [item for item in records if query in item["content"].casefold()]
            return {
                "result": {
                    "records": matches[: int(arguments.get("limit") or 10)],
                    "revision": current_revision,
                }
            }
        if operation == "export":
            return {"result": {"domain": domain, "records": records, "revision": current_revision}}

        expected = arguments.get("expected_revision")
        if expected is not None and int(expected) != current_revision:
            raise PodConsumerMemoryConflict(
                "personal memory changed; retry with the current revision"
            )
        now = datetime.now(UTC).isoformat()
        memory_id = str(arguments.get("memory_id") or "")
        content = str(arguments["content"])
        if operation == "save":
            memory_id = memory_id or "mem_" + uuid.uuid4().hex
            records = [*records, {"id": memory_id, "content": content, "updated_at": now}]
        else:
            found = False
            for record in records:
                if record["id"] == memory_id:
                    record.update(content=content, updated_at=now)
                    found = True
                    break
            if not found:
                raise PodConsumerMemoryUnavailable("memory record not found")
        next_value = {**value, "consumer_memory": records[-MAX_DOMAIN_RECORDS:]}
        next_revision = current_revision + 1
        manifest, paths, scopes = _manifest(snapshot, domain=domain, revision=next_revision)
        manifest["summary_projection"]["memory_count"] = len(records)
        commit_id = str(
            uuid.uuid5(
                _COMMIT_NAMESPACE,
                f"{owner_id}:{domain}:{arguments['idempotency_key']}:{operation}",
            )
        )
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "owner_id": owner_id,
                    "domain": domain,
                    "operation": operation,
                    "value": next_value,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        result = await self._store.commit_domain_mutation(
            {
                "p_user_id": owner_id,
                "p_domain": domain,
                "p_expected_content_revision": current_revision,
                "p_next_content_revision": next_revision,
                "p_segment_rows": [{"segment_id": "root", **_encrypt(next_value, self._vault_key)}],
                "p_manifest_row": manifest,
                "p_path_rows": paths,
                "p_scope_rows": scopes,
                "p_summary_patch": manifest["summary_projection"],
                "p_event_rows": [
                    {
                        "operation_type": "consumer_memory_write",
                        "segment_ids": ["root"],
                        "metadata": {"operation": operation, "record_count": len(records)},
                    }
                ],
                "p_commit_id": commit_id,
                "p_commit_kind": "consumer_memory",
                "p_request_fingerprint": fingerprint,
            }
        )
        if isinstance(result, dict) and result.get("conflict"):
            raise PodConsumerMemoryConflict(
                "personal memory changed; retry with the current revision"
            )
        if not isinstance(result, dict) or not result.get("success"):
            raise PodConsumerMemoryUnavailable("personal memory commit failed")
        return {
            "result": {
                "saved": True,
                "memory_id": memory_id,
                "revision": result.get("data_version", next_revision),
            }
        }


async def execute_pod_consumer_memory(
    *, owner_id: str, operation: str, arguments: dict[str, Any]
) -> dict:
    """Resolve the one pod's custody-backed store and execute one operation."""
    from hushh_mcp.services.pod_session_authority import active_session_authority

    authority = active_session_authority()
    custody = authority.vault_custody if authority is not None else None
    if authority is None or custody is None:
        raise PodConsumerMemoryUnavailable("owner pod custody is not ready")
    await authority.require_held()

    def authority_guard(records: list[dict[str, Any]]) -> None:
        if str(getattr(authority.store, "hushh_id", "")) != str(os.environ.get("HUSSH_ID") or ""):
            raise PodConsumerMemoryUnavailable("owner pod identity changed")
        authority.store.apply_records(records)

    vault_key = await custody.recover(authority_guard=authority_guard)
    store = await resolve_pod_pkm_store(owner_id)
    if store is None:
        raise PodConsumerMemoryUnavailable("owner pod PKM is not ready")
    return await PodConsumerMemoryExecutor(store=store, vault_key=vault_key).execute(
        owner_id=owner_id, operation=operation, arguments=arguments
    )


__all__ = [
    "PodConsumerMemoryConflict",
    "PodConsumerMemoryExecutor",
    "PodConsumerMemoryUnavailable",
    "execute_pod_consumer_memory",
]
