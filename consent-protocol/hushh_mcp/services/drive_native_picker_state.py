"""Validate bounded native Picker state; route and lifecycle authority stay with the service."""

from __future__ import annotations

import json
import uuid
from typing import Any

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
)
from hushh_mcp.services.google_drive_adapter import (
    MAX_SELECTION,
    DriveMetadata,
    DriveReadError,
    selected_file_ids,
)

_PICKER_RESULT_VERSION = 1


def _decode_candidates(value: str) -> tuple[str, list[dict[str, Any]]]:
    try:
        decoded = json.loads(value)
        if (
            not isinstance(decoded, dict)
            or decoded.get("version") != _PICKER_RESULT_VERSION
            or set(decoded) != {"version", "subject", "files"}
            or not isinstance(decoded.get("subject"), str)
            or not 1 <= len(decoded["subject"]) <= 255
            or not isinstance(decoded.get("files"), list)
            or not 1 <= len(decoded["files"]) <= MAX_SELECTION
        ):
            raise ValueError("invalid candidate envelope")
        result: list[dict[str, Any]] = []
        ids: set[str] = set()
        handles: set[str] = set()
        for candidate in decoded["files"]:
            if not isinstance(candidate, dict):
                raise ValueError("invalid candidate")
            handle, source = candidate.get("documentId"), candidate.get("file")
            if (
                not isinstance(handle, str)
                or str(uuid.UUID(handle)) != handle
                or not isinstance(source, dict)
            ):
                raise ValueError("invalid candidate")
            file_id = source.get("file_id")
            if not isinstance(file_id, str) or file_id in ids or handle in handles:
                raise ValueError("invalid candidate")
            metadata = DriveMetadata(
                file_id=file_id,
                name=source["name"],
                mime_type=source["mime_type"],
                version=source["version"],
                modified_time=source["modified_time"],
                size=source.get("size"),
                checksum=source.get("checksum"),
            )
            # Reuse the canonical strict identifier parser.  The other fields
            # are display-only until the exact same source is re-read at
            # confirmation.
            selected_file_ids([metadata.file_id])
            if (
                not isinstance(metadata.name, str)
                or not 1 <= len(metadata.name) <= 1024
                or not isinstance(metadata.mime_type, str)
                or not isinstance(metadata.version, str)
                or not isinstance(metadata.modified_time, str)
            ):
                raise ValueError("invalid candidate")
            ids.add(metadata.file_id)
            handles.add(handle)
            result.append({"documentId": handle, "metadata": metadata})
        return decoded["subject"], result
    except (KeyError, TypeError, ValueError):
        raise DriveReadError("selection_expired") from None


def open_proof(service, attempt: dict[str, Any]) -> dict[str, str]:
    from hushh_mcp.services.drive_native_picker_service import _attempt_aad

    try:
        result = json.loads(
            service.oauth.credentials.decrypt_secret(
                ciphertext=attempt["proof_ciphertext"],
                iv=attempt["proof_iv"],
                aad=_attempt_aad(attempt, "proof"),
            )
        )
        if (
            not isinstance(result, dict)
            or not all(isinstance(result.get(key), str) and result[key] for key in result)
            or set(result) != {"verifier", "subject", "clientId", "redirectUri"}
        ):
            raise ValueError("invalid proof")
        return result
    except (ValueError, TypeError, ExternalConnectorCredentialError):
        raise DriveReadError("selection_expired") from None


def same_attempt(
    attempt: dict[str, Any], row: dict[str, Any], credential: dict[str, Any], *, client_id: str
) -> None:
    if (
        int(attempt["connection_generation"]) != int(row["connection_generation"])
        or int(attempt["credential_version"]) != int(row["credential_version"])
        or credential.get("oauthClientId") != client_id
        or not isinstance(credential.get("subject"), str)
    ):
        raise DriveReadError("connection_changed")
