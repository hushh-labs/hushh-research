"""Sampling frame: the system's document rows joined with an independent Drive listing.

Each file appears once, keyed by HMAC(salt, file id). Raw ids, names and folder
names stay in the private crosswalk inside the workdir. A file is in the frame if
the system knows it or the independent listing (trashed=false, non-folder) has it,
so discovery coverage and phantom rows are both measurable.
"""

from __future__ import annotations

from hushh_eval.drive_packets.contracts import FrameRow
from hushh_eval.drive_packets.privacy import keyed
from hushh_eval.drive_packets.strata import age_bucket, mime_family, size_bucket, year_of

FOLDER = "application/vnd.google-apps.folder"


def _top_folder(folder_id: str, parents: dict[str, str | None]) -> str:
    seen = set()
    current = folder_id
    while current in parents and parents[current] and parents[current] in parents:
        if current in seen:
            break
        seen.add(current)
        current = parents[current]
    return current


def system_stage(document: dict | None) -> str:
    if document is None:
        return "not_in_system"
    if document["indexed"]:
        return "indexed"
    if document["failed"]:
        return "failed"
    if document["extracted"]:
        return "extracted"
    return "pending"


def build_frame(
    *, salt: bytes, frame_id: str, documents: list[dict], listing: list[dict]
) -> tuple[list[FrameRow], dict[str, dict]]:
    """Return (frame rows, private crosswalk keyed by file_key)."""
    folders = {
        item["id"]: (item.get("parents") or [None])[0]
        for item in listing
        if item.get("mimeType") == FOLDER
    }
    files = {item["id"]: item for item in listing if item.get("mimeType") != FOLDER}
    by_file = {
        document["file_id"]: document
        for document in documents
        if not document.get("source_unavailable")
    }
    rows, crosswalk = [], {}
    for file_id in sorted(set(files) | set(by_file)):
        listed = files.get(file_id)
        document = by_file.get(file_id)
        mime = (listed or {}).get("mimeType") or (document or {}).get("mime_type")
        size = (listed or {}).get("size") or (document or {}).get("size")
        modified = (listed or {}).get("modifiedTime") or (document or {}).get("modified_time")
        created = (listed or {}).get("createdTime") or (document or {}).get("created_time")
        parent = ((listed or {}).get("parents") or [None])[0]
        in_folder = parent in folders
        key = keyed(salt, "file", file_id)
        rows.append(
            FrameRow(
                frame_id=frame_id,
                file_key=key,
                mime_family=mime_family(mime),
                size_bucket=size_bucket(int(size) if size not in (None, "") else None),
                age_bucket=age_bucket(modified),
                modified_year=year_of(modified),
                created_year=year_of(created),
                folder_key=keyed(salt, "folder", parent) if in_folder else None,
                top_folder_key=keyed(salt, "top", _top_folder(parent, folders))
                if in_folder
                else None,
                system_stage=system_stage(document),
                in_system=document is not None,
                in_independent_listing=listed is not None,
            )
        )
        crosswalk[key] = {
            "file_id": file_id,
            "document_id": (document or {}).get("document_id"),
            "mime_type": mime,
            "size": int(size) if size not in (None, "") else None,
            "modified_time": modified,
            "created_time": created,
            "source_version": (document or {}).get("source_version")
            or (listed or {}).get("version"),
            "system": document,
        }
    return rows, crosswalk
