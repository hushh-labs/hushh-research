"""Per-write SQL CAS and purpose-bound encrypted provider session custody."""

from __future__ import annotations

import json
from typing import Any, Literal

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
)
from hushh_mcp.services.pod_files.contracts import FilesRefused

from . import registry


def _aad(row: dict[str, Any], operation: str, receipt: dict[str, Any]) -> str:
    admission = row["bucket_admission"]
    admission = json.loads(admission) if isinstance(admission, str) else admission
    return json.dumps(
        [
            "shared-files-upload-session-v1",
            row["user_id"],
            str(row["library_id"]),
            operation,
            row["bucket"],
            row["prefix"],
            admission["identity"],
            receipt["path"],
            receipt["digest"],
            receipt["expectedGeneration"],
            receipt["byteCount"],
        ],
        sort_keys=True,
        separators=(",", ":"),
    )


def seal(row: dict[str, Any], operation: str, receipt: dict[str, Any], uri: str) -> dict[str, str]:
    try:
        value = ExternalConnectorCredentialsService().encrypt_secret(
            uri, aad=_aad(row, operation, receipt)
        )
        if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
            raise ValueError
        return dict(value)
    except Exception:
        raise FilesRefused("FILES_UPLOAD_CUSTODY_UNAVAILABLE", 503) from None


def restore(row: dict[str, Any], operation: str, receipt: dict[str, Any]) -> str:
    try:
        sealed = receipt["session"]
        value = ExternalConnectorCredentialsService().decrypt_secret(
            ciphertext=sealed["ciphertext"], iv=sealed["iv"], aad=_aad(row, operation, receipt)
        )
        if not isinstance(value, str):
            raise ValueError
        return value
    except Exception:
        raise FilesRefused("FILES_UPLOAD_CUSTODY_UNVERIFIED", 503) from None


async def current(owner: str, library: str, operation: str) -> dict[str, Any]:
    row = await registry.active(owner, library)
    writes = row["writes"]
    writes = json.loads(writes) if isinstance(writes, str) else writes
    receipt = writes.get(operation)
    if not isinstance(receipt, dict) or receipt.get("protocol") != 2:
        raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
    return receipt


async def transition(
    row: dict[str, Any],
    operation: str,
    previous: dict[str, Any],
    replacement: dict[str, Any] | None,
    *,
    mode: Literal["dispatch", "live", "abandon", "claim", "recovery"],
    lease: str = "",
) -> bool:
    guards = {
        "dispatch": "state='active' AND lease_id=$6::uuid AND lease_until>now()",
        "live": "state='active' AND lease_id=$6::uuid",
        "abandon": "state IN ('active','erasing') AND (state='erasing' OR lease_until<now() OR writes->$3->>'state'='uncertain')",
        "claim": """state IN ('active','erasing') AND
            ((writes->$3->>'state' IN ('session_ready','sending','uncertain') AND
              (state='erasing' OR lease_until<now() OR writes->$3->>'state'='uncertain'))
             OR (writes->$3->>'state'='reconciling' AND
                 (writes->$3->>'claimUntil')::numeric < extract(epoch from now())))""",
        "recovery": "state IN ('active','erasing')",
    }
    if mode not in guards or previous.get("protocol") != 2:
        raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
    pool = await registry.get_pool()
    arguments = [
        row["user_id"],
        registry._epoch(str(row["library_id"])),
        operation,
        json.dumps(previous),
        json.dumps(replacement) if replacement is not None else None,
    ]
    if mode in {"dispatch", "live"}:
        arguments.append(registry._epoch(lease))
    changed = await pool.fetchrow(
        """UPDATE shared_files_storage SET writes=CASE WHEN $5::jsonb IS NULL
             THEN writes-$3::text ELSE jsonb_set(writes,ARRAY[$3::text],$5::jsonb,false) END,
             updated_at=now() WHERE user_id=$1 AND library_id=$2::uuid
             AND writes->$3::text=$4::jsonb
             AND """
        + guards[mode]
        + " RETURNING user_id",
        *arguments,
    )
    return changed is not None
