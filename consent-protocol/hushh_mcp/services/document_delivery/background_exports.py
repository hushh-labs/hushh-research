"""Labelled Workspace exports. They are not byte-identical Google originals."""

import hashlib
import json
from datetime import UTC, datetime

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.google_drive_adapter import FILE_ID

FORMATS = {
    "application/vnd.google-apps.document": ("PDF", "application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet": (
        "XLSX",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xlsx",
    ),
    "application/vnd.google-apps.presentation": (
        "PPTX",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".pptx",
    ),
}
EXPORT_LIMIT = 10 * 1024 * 1024


def identity(item):
    if (
        item.get("mimeType") not in FORMATS
        or not isinstance(item.get("version"), str)
        or not isinstance(item.get("modifiedTime"), str)
    ):
        return None
    return {
        "native": True,
        "mimeType": item["mimeType"],
        "version": item["version"],
        "modifiedTime": item["modifiedTime"],
    }


def require_export(source, facts):
    if facts.get("capabilities", {}).get("canDownload") is not True:
        raise DeliveryError("download_restricted")
    encryption = facts.get("clientEncryptionDetails")
    if encryption and encryption.get("encryptionState") != "unencrypted":
        raise DeliveryError("download_restricted")
    frozen = source.get("sourceContentIdentity")
    if not frozen or frozen.get("native") is not True:
        raise DeliveryError("source_identity_unavailable")
    if (
        facts.get("id") != source["id"]
        or facts.get("title") != source["name"]
        or facts.get("mimeType") != source["mimeType"]
        or identity(facts) is None
    ):
        raise DeliveryError("source_changed")
    return identity(facts)


async def download(source, credential):
    if source["mimeType"] not in FORMATS or not FILE_ID.fullmatch(source["id"]):
        raise DeliveryError("native_export_unavailable")
    _, mime, _ = FORMATS[source["mimeType"]]
    headers = {
        "Authorization": f"Bearer {credential['accessToken']}",
        "Accept-Encoding": "identity",
    }
    if source.get("resourceKey"):
        headers["X-Goog-Drive-Resource-Keys"] = f"{source['id']}/{source['resourceKey']}"
    with suppress_instrumentation():
        async with httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False) as client:
            async with client.stream(
                "GET",
                f"https://www.googleapis.com/drive/v3/files/{source['id']}/export",
                params={"mimeType": mime},
                headers=headers,
            ) as response:
                if response.status_code == 403:
                    raise DeliveryError("export_limit_or_download_restricted")
                if response.status_code != 200:
                    raise DeliveryError("native_export_unavailable")
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise DeliveryError("native_export_unavailable")
                body = bytearray()
                async for chunk in response.aiter_raw():
                    if len(body) + len(chunk) > EXPORT_LIMIT:
                        raise DeliveryError("export_size_limit")
                    body.extend(chunk)
                return body


async def snapshot(service, row, source, credential, facts):
    before = require_export(source, facts)
    await service.store.current(row)
    data = await service.reader.export(source, credential)
    try:
        await service.store.current(row)
        if require_export(source, await service.reader.facts(source, credential)) != before:
            raise DeliveryError("source_changed")
        fmt, mime, suffix = FORMATS[source["mimeType"]]
        result = {
            "rendition": "google_export",
            "exportFormat": fmt,
            "mimeType": mime,
            "sourceName": source["name"],
            "name": source["name"] + suffix,
            "exportedAt": datetime.now(UTC).isoformat(),
            "sourceRevision": facts["version"],
            "sourceModifiedTime": facts["modifiedTime"],
            "sha256Checksum": hashlib.sha256(data).hexdigest(),
            "md5Checksum": hashlib.md5(data, usedforsecurity=False).hexdigest(),
            "size": len(data),
        }

        def bind(connection):
            service.store.file_authority(connection, row, service.store.owner(row), lease=True)
            prior = service.store._row(
                connection,
                "SELECT export_envelope FROM document_delivery_background_files WHERE file_ref=:ref",
                {"ref": row["file_ref"]},
            )
            if prior["export_envelope"]:
                previous = service.store.sharing_cipher.open(
                    prior["export_envelope"],
                    user_id=service.store.owner(row),
                    resource_id=str(row["file_ref"]),
                    purpose="background-copy-export-v2",
                )
                if previous["sha256Checksum"] != result["sha256Checksum"]:
                    raise DeliveryError("export_representation_changed")
                return previous
            envelope = service.store.sharing_cipher.seal(
                result,
                user_id=service.store.owner(row),
                resource_id=str(row["file_ref"]),
                purpose="background-copy-export-v2",
            )
            connection.execute(
                text(
                    "UPDATE document_delivery_background_files SET export_envelope=CAST(:value AS jsonb) WHERE file_ref=:ref"
                ),
                {"ref": row["file_ref"], "value": json.dumps(envelope)},
            )
            return result

        return await service.store._transaction(bind), data
    except BaseException:
        data[:] = b"\0" * len(data)
        raise
