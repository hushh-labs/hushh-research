"""Safe provider links and per-file download authority for Calendar meeting files."""

from urllib.parse import parse_qsl, urlencode, urlparse

from hushh_mcp.services.google_connection_service import CALENDAR_MEET_DRIVE_READ_SCOPE
from hushh_mcp.services.google_drive_adapter import RESOURCE_KEY


def source_url(value, resource_key=None):
    try:
        parsed = urlparse(value or "")
        if not (
            parsed.scheme == "https"
            and parsed.hostname in {"drive.google.com", "docs.google.com"}
            and not parsed.username
            and not parsed.password
            and parsed.port in (None, 443)
        ):
            return None
        if resource_key and RESOURCE_KEY.fullmatch(resource_key):
            query = parse_qsl(parsed.query, keep_blank_values=True)
            parsed = parsed._replace(
                query=urlencode(
                    [
                        *((key, value) for key, value in query if key.casefold() != "resourcekey"),
                        ("resourcekey", resource_key),
                    ]
                )
            )
        return parsed.geturl()
    except ValueError:
        return None


def browse_file_access(facts, ref, scopes, *, approved, resource_key):
    """A Drive capability and a live content scope must both permit download."""
    mime = facts["mimeType"]
    provider_can_download = (facts.get("capabilities") or {}).get("canDownload") is True
    content_read_allowed = bool(
        scopes
        & {
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/drive",
        }
    ) or (
        CALENDAR_MEET_DRIVE_READ_SCOPE in scopes
        and not approved
        and ref.get("provenance") != "calendar_linked"
    )
    download_url = source_url(facts.get("downloadUrl"), resource_key)
    pdf_export_url = source_url(facts.get("pdfExportUrl"), resource_key)
    has_download_link = bool(
        pdf_export_url if mime == "application/vnd.google-apps.document" else download_url
    )
    can_download = provider_can_download and content_read_allowed and has_download_link
    return {
        "state": "available",
        "title": facts["title"],
        "url": source_url(facts.get("viewUrl"), resource_key),
        "mime_type": mime,
        "can_download": can_download,
        "download_reason": (
            "owner_restricted"
            if not provider_can_download
            else "app_permission"
            if not content_read_allowed
            else "link_unavailable"
            if not has_download_link
            else None
        ),
        "download_url": download_url if can_download else None,
        "pdf_export_url": pdf_export_url if can_download else None,
    }
