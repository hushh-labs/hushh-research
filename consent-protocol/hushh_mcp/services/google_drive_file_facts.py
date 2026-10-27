"""Presentation of validated Drive metadata; this projection grants no access."""

import re
from typing import Any


def facts_projection(file_id: str, result: dict[str, Any]) -> dict[str, Any]:
    size, modified, link = (result.get(key) for key in ("size", "modifiedTime", "webViewLink"))
    capabilities = result.get("capabilities")
    encryption = result.get("clientEncryptionDetails")
    return {
        "id": file_id,
        "title": result["name"][:1024],
        "mimeType": result["mimeType"][:255],
        "modifiedTime": modified if isinstance(modified, str) and len(modified) <= 64 else None,
        **{
            key: result[key]
            for key in (
                "version",
                "createdTime",
                "driveId",
                "resourceKey",
                "md5Checksum",
                "sha256Checksum",
                "headRevisionId",
            )
            if isinstance(result.get(key), str)
        },
        "size": int(size) if isinstance(size, str) and re.fullmatch(r"[0-9]{1,20}", size) else None,
        "viewUrl": link if isinstance(link, str) and link.startswith("https://") else None,
        **(
            {
                "capabilities": {
                    key: capabilities[key]
                    for key in ("canShare", "canDownload", "canAccessViaGenAi")
                    if key in capabilities
                }
            }
            if isinstance(capabilities, dict)
            else {}
        ),
        **(
            {"clientEncryptionDetails": {"encryptionState": encryption["encryptionState"]}}
            if isinstance(encryption, dict)
            else {}
        ),
    }
