"""Exact binary originals, bounded Range reads, and ACL-independent identity."""

import re

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.document_delivery.background_diagnostics import (
    IDENTITY_FIELDS,
    CopySourceChanged,
)
from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.google_drive_adapter import FILE_ID, GoogleDriveAdapter

CHUNK_BYTES = 1024 * 1024


def content_identity(item):
    """Missing identity is unavailable, never permission to substitute current bytes."""
    size, modified, md5 = item.get("size"), item.get("modifiedTime"), item.get("md5Checksum")
    if isinstance(size, str) and re.fullmatch(r"[0-9]{1,20}", size):
        size = int(size)
    if (
        type(size) is not int
        or size < 0
        or not isinstance(modified, str)
        or not isinstance(md5, str)
    ):
        return None
    if not re.fullmatch(r"[a-fA-F0-9]{32}", md5):
        return None
    result = {"size": size, "modifiedTime": modified, "md5Checksum": md5.lower()}
    for key, pattern in (
        ("sha256Checksum", r"[a-fA-F0-9]{64}"),
        ("headRevisionId", r"[A-Za-z0-9_-]{1,256}"),
    ):
        value = item.get(key)
        if value is not None:
            if not isinstance(value, str) or not re.fullmatch(pattern, value):
                return None
            result[key] = value.lower() if key == "sha256Checksum" else value
    return result


def require_original(source, facts, *, stage="source_before"):
    if facts.get("mimeType", "").startswith("application/vnd.google-apps."):
        raise DeliveryError("native_export_unavailable")
    identity = source.get("sourceContentIdentity")
    if not identity:
        raise DeliveryError("source_identity_unavailable")
    if facts.get("capabilities", {}).get("canDownload") is not True:
        raise DeliveryError("download_restricted")
    encryption = facts.get("clientEncryptionDetails")
    if encryption and encryption.get("encryptionState") != "unencrypted":
        raise DeliveryError("download_restricted")
    observed = content_identity(facts)
    # Drive permission writes can advance modifiedTime without changing the
    # binary. Retain the frozen shape for old jobs; only a matching SHA-256 or
    # provider content revision may establish a metadata-only time change.
    stable_content = bool(
        observed
        and (identity.get("sha256Checksum") or identity.get("headRevisionId"))
        and {key: value for key, value in identity.items() if key != "modifiedTime"}
        == {key: value for key, value in observed.items() if key != "modifiedTime"}
    )
    mismatches = [
        field
        for field, before, after in (
            ("id", source.get("id"), facts.get("id")),
            ("name", source.get("name"), facts.get("title")),
            ("mime", source.get("mimeType"), facts.get("mimeType")),
        )
        if before != after
    ]
    if observed != identity and not stable_content:
        mismatches.extend(
            (
                [
                    IDENTITY_FIELDS[key]
                    for key in IDENTITY_FIELDS
                    if identity.get(key) != observed.get(key)
                ]
                or ["identity"]
            )
            if observed
            else ["identity"]
        )
    if mismatches:
        raise CopySourceChanged(stage, mismatches)
    return identity


class BackgroundOriginalReader:
    def __init__(self, adapter=None):
        self.adapter = adapter or GoogleDriveAdapter()

    async def export(self, source, credential):
        from .background_exports import download

        return await download(source, credential)

    async def facts(self, source, credential):
        return await self.adapter.get_file_facts(
            file_id=source["id"],
            access_token=credential["accessToken"],
            resource_key=source.get("resourceKey"),
        )

    async def chunk(self, source, credential, offset, size):
        if (
            not FILE_ID.fullmatch(source["id"])
            or type(offset) is not int
            or offset < 0
            or size <= offset
        ):
            raise CopySourceChanged("read", ["range"])
        end = min(size, offset + CHUNK_BYTES) - 1
        headers = {
            "Authorization": f"Bearer {credential['accessToken']}",
            "Accept-Encoding": "identity",
            "Range": f"bytes={offset}-{end}",
        }
        if source.get("resourceKey"):
            headers["X-Goog-Drive-Resource-Keys"] = f"{source['id']}/{source['resourceKey']}"
        # Fixed provider origin and no instrumentation: source URLs and bearer stay private.
        with suppress_instrumentation():
            async with httpx.AsyncClient(
                timeout=15, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "GET",
                    f"https://www.googleapis.com/drive/v3/files/{source['id']}",
                    params={"alt": "media", "supportsAllDrives": "true"},
                    headers=headers,
                ) as response:
                    if response.status_code in {401, 403, 404, 410}:
                        raise DeliveryError("download_restricted")
                    if response.status_code == 429 or response.status_code >= 500:
                        raise DeliveryError("provider_unavailable", 503)
                    complete = offset == 0 and size <= CHUNK_BYTES and response.status_code == 200
                    if not complete and (
                        response.status_code != 206
                        or response.headers.get("Content-Range") != f"bytes {offset}-{end}/{size}"
                    ):
                        raise DeliveryError("original_range_unavailable")
                    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                        raise CopySourceChanged("read", ["content_encoding"])
                    body = bytearray()
                    async for chunk in response.aiter_raw():
                        if len(body) + len(chunk) > end - offset + 1:
                            raise CopySourceChanged("read", ["body_length"])
                        body.extend(chunk)
                    if len(body) != end - offset + 1:
                        raise CopySourceChanged("read", ["body_length"])
                    return body


def content_evidence(item):
    from .background_exports import identity as native_identity

    identity = content_identity(item) or native_identity(item)
    return {"sourceContentIdentity": identity} if identity else {}
