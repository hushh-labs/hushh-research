"""Files tools for One's ADK specialist; no destructive or shell capability."""

from __future__ import annotations

import hashlib
import inspect
import io
import re
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Literal, Protocol

from hushh_mcp.services.pod_files import analysis_policy
from hushh_mcp.services.pod_files.contracts import CHUNK_BYTES, display_name
from hushh_mcp.services.pod_files.library import FilesRefused
from hushh_mcp.services.pod_files.runtime import operation, require_files_access
from hushh_mcp.services.pod_s3_object_store import PodMultiCloudStorageError

_HEX_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SEP_RE = re.compile(r"[\s_\-./\\]+")
_ALNUM_RE = re.compile(r"[^a-z0-9]+")

_MAX_SCAN_ENTRIES = 500
_MAX_READ_CHUNKS = 2
_MAX_READ_BYTES = _MAX_READ_CHUNKS * CHUNK_BYTES
_MAX_WRITE_BYTES = 256 * 1024
_MAX_EXTRACTED_CHARS = 32_000
_MAX_PDF_PAGES = 20
_MAX_XLSX_SHEETS = 10
_MAX_XLSX_ROWS = 200
_WRITABLE_TEXT_EXTS = frozenset({"", ".txt", ".md", ".markdown", ".json", ".csv"})
_TEXT_EXTS = frozenset(
    {
        "",
        ".txt",
        ".md",
        ".markdown",
        ".json",
        ".csv",
        ".tsv",
        ".yaml",
        ".yml",
        ".xml",
        ".log",
        ".ini",
        ".cfg",
        ".conf",
        ".env",
        ".pem",
        ".key",
        ".pub",
    }
)
_TRANSIENT_STORAGE_ERRORS = (PodMultiCloudStorageError, TimeoutError, OSError)


def _storage_unavailable_response() -> dict[str, Any]:
    return {
        "status": "unavailable",
        "code": "FILES_STORAGE_UNAVAILABLE",
        "message": "Private Files storage is temporarily unavailable. Please try again.",
    }


async def _check_files_access(*, manage: bool = False) -> None:
    if manage and "manage" in inspect.signature(require_files_access).parameters:
        await require_files_access(manage=True)
    else:
        await require_files_access()


def _normalize_text(value: str) -> str:
    return _SEP_RE.sub(" ", str(value or "").strip().lower()).strip()


def _normalize_stem(value: str) -> str:
    stem = Path(str(value or "").strip()).stem or str(value or "").strip()
    return _normalize_text(stem)


def _compact_alnum(value: str) -> str:
    return _ALNUM_RE.sub("", str(value or "").lower())


def _match_score(query: str, entry: dict[str, Any], rel_path: str) -> int:
    q_raw = str(query or "").strip()
    if not q_raw:
        return 0
    if q_raw == entry.get("id"):
        return 120
    q_norm = _normalize_text(q_raw)
    q_stem = _normalize_stem(q_raw)
    q_compact = _compact_alnum(q_raw)
    if not q_norm:
        return 0

    name = str(entry.get("name") or "")
    orig = str(entry.get("originalName") or "")
    candidates = [name]
    if orig and orig != name:
        candidates.append(orig)

    best = 0
    path_norm = _normalize_text(rel_path)
    path_stem_norm = _normalize_text(str(Path(rel_path).with_suffix("")))
    if q_norm == path_norm or (q_stem and q_stem == path_stem_norm):
        best = max(best, 115)

    for candidate in candidates:
        c_norm = _normalize_text(candidate)
        c_stem = _normalize_stem(candidate)
        c_compact = _compact_alnum(candidate)
        c_stem_compact = _compact_alnum(Path(candidate).stem or candidate)
        if q_norm == c_norm:
            best = max(best, 110)
        elif q_norm == c_stem or (q_stem and q_stem == c_stem):
            best = max(best, 100)
        elif q_compact and (q_compact == c_compact or q_compact == c_stem_compact):
            best = max(best, 95)
        elif q_norm in c_norm or q_norm in path_norm:
            best = max(best, 80)
        else:
            q_tokens = [tok for tok in q_norm.split() if tok]
            if q_tokens and all(tok in c_norm or tok in path_norm for tok in q_tokens):
                best = max(best, 70)
            elif q_compact and len(q_compact) >= 4 and q_compact in c_compact:
                best = max(best, 60)
    return best


async def _collect_entries(
    library: Any,
    *,
    parent: str = "root",
    recursive: bool = True,
    settings: dict[str, Any],
    max_entries: int = _MAX_SCAN_ENTRIES,
) -> list[tuple[dict[str, Any], str]]:
    excluded = set(settings.get("excluded") or ())
    if parent != "root" and parent in excluded:
        return []
    queue: deque[tuple[str, str]] = deque([(parent, "")])
    visited_folders: set[str] = set()
    collected: list[tuple[dict[str, Any], str]] = []

    while queue and len(collected) < max_entries:
        folder_id, prefix = queue.popleft()
        if folder_id in visited_folders or folder_id in excluded:
            continue
        visited_folders.add(folder_id)
        cursor = ""
        while len(collected) < max_entries:
            page = await library.list_folder(folder_id, cursor)
            for entry in page.get("entries") or ():
                eid = entry.get("id")
                if not eid or eid in excluded:
                    continue
                rel_path = f"{prefix}/{entry['name']}" if prefix else str(entry["name"])
                collected.append((entry, rel_path))
                if recursive and entry.get("kind") == "folder" and eid not in visited_folders:
                    queue.append((eid, rel_path))
                if len(collected) >= max_entries:
                    break
            next_cursor = str(page.get("cursor") or "")
            if not next_cursor:
                break
            cursor = next_cursor
    return collected


async def _resolve_folder_id(library: Any, parent: str, settings: dict[str, Any]) -> str:
    clean = str(parent or "").strip() or "root"
    if clean == "root" or _HEX_ID_RE.fullmatch(clean):
        return clean
    clean_stripped = clean.strip("/")
    if not clean_stripped or clean_stripped.lower() == "root":
        return "root"
    entries = await _collect_entries(library, parent="root", recursive=True, settings=settings)
    scored = []
    for entry, rel_path in entries:
        if entry.get("kind") != "folder":
            continue
        score = _match_score(clean_stripped, entry, rel_path)
        if score > 0:
            scored.append((score, entry["id"]))
    if not scored:
        raise FilesRefused("FILES_NOT_FOUND", 404)
    scored.sort(key=lambda item: item[0], reverse=True)
    return str(scored[0][1])


def _detect_format(name: str, raw: bytes) -> str:
    ext = Path(name).suffix.lower()
    if raw.startswith(b"%PDF-") or ext == ".pdf":
        return "pdf"
    if ext in {".xlsx", ".xlsm"}:
        return "xlsx"
    if ext in {".html", ".htm"}:
        return "html"
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"}:
        return ext.lstrip(".") or "image"
    if ext in {".docx", ".doc", ".pptx", ".zip", ".tar", ".gz", ".7z"}:
        return ext.lstrip(".")
    if ext in _TEXT_EXTS:
        return "text"
    return ext.lstrip(".") or "binary"


def _decode_bytes_text(raw: bytes) -> str | None:
    text: str | None
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        try:
            from charset_normalizer import from_bytes

            best = from_bytes(raw).best()
            text = str(best) if best is not None else None
        except Exception:  # noqa: BLE001
            text = None
    if text is None or "\x00" in text:
        return None
    return text


def _extract_file_content(name: str, raw: bytes) -> dict[str, Any]:
    detected = _detect_format(name, raw)
    if detected == "pdf":
        try:
            import pdfplumber

            parts: list[str] = []
            total_pages = 0
            pages_read = 0
            chars = 0
            truncated = False
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                total_pages = len(pdf.pages)
                for page in pdf.pages[:_MAX_PDF_PAGES]:
                    pages_read += 1
                    page_text = (page.extract_text() or "").strip()
                    if not page_text:
                        continue
                    remaining = _MAX_EXTRACTED_CHARS - chars
                    if remaining <= 0:
                        truncated = True
                        break
                    if len(page_text) > remaining:
                        parts.append(page_text[:remaining])
                        chars += remaining
                        truncated = True
                        break
                    parts.append(page_text)
                    chars += len(page_text) + 2
                if total_pages > _MAX_PDF_PAGES:
                    truncated = True
            combined = "\n\n".join(parts).strip()
            if combined:
                return {
                    "extracted": True,
                    "detected_format": "pdf",
                    "page_count": total_pages,
                    "pages_extracted": pages_read,
                    "truncated": truncated,
                    "untrusted_content": combined,
                }
            return {
                "extracted": False,
                "detected_format": "pdf",
                "page_count": total_pages,
                "untrusted_content": "",
                "note": "PDF has no extractable text (possibly scanned images or password-protected).",
            }
        except Exception:  # noqa: BLE001 - unreadable/encrypted PDF falls back to metadata
            return {
                "extracted": False,
                "detected_format": "pdf",
                "untrusted_content": "",
                "note": "Could not extract text from PDF (possibly encrypted or malformed).",
            }

    if detected == "xlsx":
        wb = None
        try:
            import openpyxl

            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            lines: list[str] = []
            chars = 0
            truncated = False
            for sheet_name in wb.sheetnames[:_MAX_XLSX_SHEETS]:
                ws = wb[sheet_name]
                header = f"## Sheet: {sheet_name}"
                lines.append(header)
                chars += len(header) + 1
                row_count = 0
                for row in ws.iter_rows(values_only=True):
                    if row_count >= _MAX_XLSX_ROWS:
                        truncated = True
                        break
                    row_count += 1
                    cells = [
                        str(cell).strip() for cell in row if cell is not None and str(cell).strip()
                    ]
                    if not cells:
                        continue
                    line = " | ".join(cells)
                    if chars + len(line) + 1 > _MAX_EXTRACTED_CHARS:
                        truncated = True
                        break
                    lines.append(line)
                    chars += len(line) + 1
                if truncated:
                    break
            if len(wb.sheetnames) > _MAX_XLSX_SHEETS:
                truncated = True
            combined = "\n".join(lines).strip()
            return {
                "extracted": bool(combined),
                "detected_format": "xlsx",
                "sheet_count": len(wb.sheetnames),
                "truncated": truncated,
                "untrusted_content": combined,
            }
        except Exception:  # noqa: BLE001
            return {
                "extracted": False,
                "detected_format": "xlsx",
                "untrusted_content": "",
                "note": "Could not extract spreadsheet rows from workbook.",
            }
        finally:
            if wb is not None:
                try:
                    wb.close()
                except Exception:  # noqa: BLE001
                    pass

    if detected == "html":
        decoded = _decode_bytes_text(raw)
        if decoded is not None:
            try:
                from bs4 import BeautifulSoup

                soup = BeautifulSoup(decoded, "html.parser")
                for tag in soup(["script", "style", "noscript"]):
                    tag.decompose()
                text = soup.get_text("\n", strip=True)
                truncated = len(text) > _MAX_EXTRACTED_CHARS
                return {
                    "extracted": True,
                    "detected_format": "html",
                    "truncated": truncated,
                    "untrusted_content": text[:_MAX_EXTRACTED_CHARS],
                }
            except Exception:  # noqa: BLE001
                pass

    decoded_text = _decode_bytes_text(raw)
    if decoded_text is not None:
        truncated = len(decoded_text) > _MAX_EXTRACTED_CHARS
        return {
            "extracted": True,
            "detected_format": "text" if detected == "binary" else detected,
            "truncated": truncated,
            "untrusted_content": decoded_text[:_MAX_EXTRACTED_CHARS],
        }

    return {
        "extracted": False,
        "detected_format": detected,
        "untrusted_content": "",
        "note": f"Binary {detected} file ({len(raw)} bytes); metadata returned without binary decoding.",
    }


class ForegroundFilesPort(Protocol):
    """Only the selected request projection, never a complete Shared library."""

    async def list_files(self, parent: str, cursor: str) -> dict[str, Any]: ...
    async def create_folder(self, name: str, parent: str, request_id: str) -> dict[str, Any]: ...
    async def read_file(self, file_id: str) -> dict[str, Any]: ...
    async def organize_file(
        self, file_id: str, revision: int, operation_name: str, name: str, parent: str
    ) -> dict[str, Any]: ...


_foreground: ContextVar[ForegroundFilesPort | None] = ContextVar(
    "files_foreground_port", default=None
)


@contextmanager
def foreground_tools(port: ForegroundFilesPort):
    """Request-scoped, owner-checked projection; never a standing Shared library."""
    token = _foreground.set(port)
    try:
        yield
    finally:
        _foreground.reset(token)


_job_target: ContextVar[str | None] = ContextVar("files_job_target", default=None)


@contextmanager
def job_target(file_id: str):
    token = _job_target.set(file_id)
    try:
        yield
    finally:
        _job_target.reset(token)


async def list_files(
    parent: str = "root", cursor: str = "", recursive: bool = False
) -> dict[str, Any]:
    """List bounded metadata from the private library, respecting excluded folders."""
    if (port := _foreground.get()) is not None:
        return await port.list_files(parent, cursor)
    require_bg = _job_target.get() is not None
    try:
        await require_files_access()
        async with operation() as library:
            settings = await library.settings()
            if require_bg and not settings["analysis"]:
                raise FilesRefused("FILES_ANALYSIS_CONSENT_REQUIRED", 403)
            resolved_parent = await _resolve_folder_id(library, parent, settings)
            if resolved_parent != "root":
                await analysis_policy.analysis_allowed(
                    library,
                    resolved_parent,
                    require_background_analysis=require_bg,
                )
            if recursive:
                collected = await _collect_entries(
                    library, parent=resolved_parent, recursive=True, settings=settings
                )
                result: dict[str, Any] = {
                    "entries": [{**entry, "path": rel_path} for entry, rel_path in collected],
                    "cursor": "",
                    "chunkBytes": CHUNK_BYTES,
                }
            else:
                result = await library.list_folder(resolved_parent, cursor)
                result["entries"] = [
                    entry for entry in result["entries"] if entry["id"] not in settings["excluded"]
                ]
            if (await library.settings())["revision"] != settings["revision"]:
                raise FilesRefused("FILES_CONSENT_CHANGED", 403)
            if resolved_parent != "root":
                await analysis_policy.analysis_allowed(
                    library,
                    resolved_parent,
                    require_background_analysis=require_bg,
                )
            await require_files_access()
            return {"status": "ok", **result}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
    except _TRANSIENT_STORAGE_ERRORS:
        return _storage_unavailable_response()


async def search_files(query: str, limit: int = 20) -> dict[str, Any]:
    """Search private library files and folders recursively by normalized name or path."""
    if _foreground.get() is not None:
        return {"status": "blocked", "code": "FILES_PROJECTION_UNAVAILABLE"}
    require_bg = _job_target.get() is not None
    bounded_limit = max(1, min(int(limit or 20), 50))
    try:
        await require_files_access()
        async with operation() as library:
            settings = await library.settings()
            if require_bg and not settings["analysis"]:
                raise FilesRefused("FILES_ANALYSIS_CONSENT_REQUIRED", 403)
            collected = await _collect_entries(
                library, parent="root", recursive=True, settings=settings
            )
            scored: list[tuple[int, dict[str, Any]]] = []
            for entry, rel_path in collected:
                score = _match_score(query, entry, rel_path)
                if score > 0:
                    scored.append((score, {**entry, "path": rel_path}))
            scored.sort(
                key=lambda item: (item[0], int(item[1].get("updatedAt") or 0)), reverse=True
            )
            if (await library.settings())["revision"] != settings["revision"]:
                raise FilesRefused("FILES_CONSENT_CHANGED", 403)
            await require_files_access()
            return {
                "status": "ok",
                "query": query,
                "matches": [item[1] for item in scored[:bounded_limit]],
                "scanned": len(collected),
            }
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
    except _TRANSIENT_STORAGE_ERRORS:
        return _storage_unavailable_response()


async def create_folder(name: str, parent: str, request_id: str) -> dict[str, Any]:
    """Create an empty organization folder; retain request_id when retrying."""
    if (port := _foreground.get()) is not None:
        return await port.create_folder(name, parent, request_id)
    require_bg = _job_target.get() is not None
    try:
        await _check_files_access(manage=True)
        async with operation(mutation=True) as library:
            settings = await library.settings()
            if require_bg and not settings["analysis"]:
                raise FilesRefused("FILES_ANALYSIS_CONSENT_REQUIRED", 403)
            resolved_parent = await _resolve_folder_id(library, parent, settings)
            if resolved_parent != "root":
                await analysis_policy.analysis_allowed(
                    library,
                    resolved_parent,
                    require_background_analysis=require_bg,
                )
            # Background folder creation is consented only for this job's upload.
            if (target_id := _job_target.get()) is not None:
                await library.analysis_allowed(target_id)
            return {
                "status": "ok",
                "folder": await library.create(
                    name=name, parent=resolved_parent, size=0, request_id=request_id, folder=True
                ),
            }
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
    except _TRANSIENT_STORAGE_ERRORS:
        return _storage_unavailable_response()


async def read_file(file_id: str) -> dict[str, Any]:
    """Read a file from the private library by file ID or normalized filename/path.

    Supports multi-chunk UTF-8/charset-normalized text, PDF, XLSX, HTML, and structured
    metadata fallback for large or binary files. Never executes files or expands archives.
    """
    if (port := _foreground.get()) is not None:
        return await port.read_file(file_id)
    require_bg = _job_target.get() is not None
    raw_ref = str(file_id or "").strip()
    if not raw_ref:
        return {"status": "not_found", "code": "FILES_NOT_FOUND"}
    try:
        await require_files_access()
        async with operation() as library:
            settings = await library.settings()
            resolved_id = raw_ref
            if not _HEX_ID_RE.fullmatch(raw_ref):
                collected = await _collect_entries(
                    library, parent="root", recursive=True, settings=settings
                )
                scored = []
                for entry, rel_path in collected:
                    if entry.get("kind") == "folder":
                        continue
                    score = _match_score(raw_ref, entry, rel_path)
                    if score > 0:
                        scored.append((score, {**entry, "path": rel_path}))
                if not scored:
                    return {
                        "status": "not_found",
                        "code": "FILES_NOT_FOUND",
                        "message": f"No file matching '{raw_ref}' was found in private Files.",
                    }
                scored.sort(
                    key=lambda item: (item[0], int(item[1].get("updatedAt") or 0)), reverse=True
                )
                top_score = scored[0][0]
                top_matches = [item[1] for item in scored if item[0] == top_score]
                if len(top_matches) > 1 and top_score < 110:
                    return {
                        "status": "ambiguous",
                        "code": "FILES_MULTIPLE_MATCHES",
                        "matches": top_matches[:10],
                        "message": "Multiple matching files found; pass the exact file id to read_file.",
                    }
                resolved_id = str(top_matches[0]["id"])

            consent = (
                await library.analysis_allowed(resolved_id)
                if require_bg
                else await analysis_policy.analysis_allowed(
                    library, resolved_id, require_background_analysis=False
                )
            )
            entry = await library.stat(resolved_id)
            if entry["kind"] == "folder":
                return {
                    "status": "ok",
                    "extracted": False,
                    "detected_format": "folder",
                    "file": entry,
                    "untrusted_content": "",
                    "note": "This entry is a folder; call list_files with this parent id to view its contents.",
                }
            if entry["size"] > _MAX_READ_BYTES:
                if (
                    await analysis_policy.analysis_allowed(
                        library, resolved_id, require_background_analysis=require_bg
                    )
                )["revision"] != consent["revision"]:
                    raise FilesRefused("FILES_CONSENT_CHANGED", 403)
                await require_files_access()
                return {
                    "status": "ok",
                    "extracted": False,
                    "code": "FILES_SIZE_PREVIEW_ONLY",
                    "detected_format": _detect_format(entry["name"], b""),
                    "file": entry,
                    "untrusted_content": "",
                    "note": (
                        f"File size ({entry['size']} bytes) exceeds the {_MAX_READ_BYTES // (1024 * 1024)} MiB "
                        "in-chat extraction bound; metadata returned."
                    ),
                }

            total_chunks = (
                (entry["size"] + CHUNK_BYTES - 1) // CHUNK_BYTES if entry["size"] > 0 else 0
            )
            raw_parts = [await library.read_chunk(resolved_id, idx) for idx in range(total_chunks)]
            raw_bytes = b"".join(raw_parts)
            extracted = _extract_file_content(entry["name"], raw_bytes)
            check_after = (
                await library.analysis_allowed(resolved_id)
                if require_bg
                else await analysis_policy.analysis_allowed(
                    library, resolved_id, require_background_analysis=False
                )
            )
            if check_after["revision"] != consent["revision"]:
                raise FilesRefused("FILES_CONSENT_CHANGED", 403)
            await require_files_access()
            return {"status": "ok", "file": entry, **extracted}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
    except _TRANSIENT_STORAGE_ERRORS:
        return _storage_unavailable_response()


async def write_file(
    name: str,
    content: str,
    parent: str = "root",
    request_id: str = "",
) -> dict[str, Any]:
    """Create a bounded UTF-8 text/markdown/json/csv file in private Files."""
    if _foreground.get() is not None:
        return {"status": "blocked", "code": "FILES_PROJECTION_UNAVAILABLE"}
    if _job_target.get() is not None:
        return {"status": "blocked", "code": "FILES_JOB_TARGET_MISMATCH"}
    try:
        await _check_files_access(manage=True)
        clean_name = display_name(str(name or "").strip())
        ext = Path(clean_name).suffix.lower()
        if ext not in _WRITABLE_TEXT_EXTS or "\x00" in str(content):
            return {"status": "unsupported", "code": "FILES_FORMAT_UNSUPPORTED"}
        raw = str(content).encode("utf-8")
        if len(raw) > _MAX_WRITE_BYTES:
            return {"status": "unsupported", "code": "FILES_WRITE_SIZE_LIMIT"}
        async with operation(mutation=True) as library:
            settings = await library.settings()
            resolved_parent = await _resolve_folder_id(library, parent, settings)
            if resolved_parent != "root":
                await analysis_policy.analysis_allowed(
                    library, resolved_parent, require_background_analysis=False
                )
            req_id = str(request_id or "").strip()
            if not req_id:
                req_id = hashlib.sha256(
                    f"write:{resolved_parent}:{clean_name}:{content}".encode("utf-8")
                ).hexdigest()[:32]
            created = await library.create(
                name=clean_name,
                parent=resolved_parent,
                size=len(raw),
                request_id=req_id,
                folder=False,
            )
            if created["id"] in settings.get("excluded", ()):
                raise FilesRefused("FILES_EXCLUDED", 403)
            if created["state"] == "ready":
                return {"status": "ok", "file": created}
            if raw:
                await library.put_chunk(created["id"], 0, raw)
            completed = await library.complete(created["id"])
            await _check_files_access(manage=True)
            return {"status": "ok", "file": completed}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
    except _TRANSIENT_STORAGE_ERRORS:
        return _storage_unavailable_response()


async def organize_file(
    file_id: str,
    revision: int,
    operation_name: Literal["rename", "move"],
    name: str = "",
    parent: str = "",
) -> dict[str, Any]:
    """Apply one reversible change. Use rename with name, or move with parent.

    parent is a folder identifier from list_files or create_folder, never a path.
    Use the returned file revision for a subsequent change to the same file.
    """
    if (port := _foreground.get()) is not None:
        return await port.organize_file(file_id, revision, operation_name, name, parent)
    require_bg = _job_target.get() is not None
    try:
        await _check_files_access(manage=True)
        if _job_target.get() is not None and _job_target.get() != file_id:
            raise FilesRefused("FILES_JOB_TARGET_MISMATCH", 403)
        if operation_name not in {"rename", "move"}:
            raise FilesRefused("FILES_OPERATION_UNSUPPORTED", 400)
        async with operation(mutation=True) as library:
            if require_bg:
                await library.analysis_allowed(file_id)
            else:
                await analysis_policy.analysis_allowed(
                    library, file_id, require_background_analysis=False
                )
            if operation_name == "move" and parent != "root":
                if require_bg:
                    await library.analysis_allowed(parent)
                else:
                    await analysis_policy.analysis_allowed(
                        library, parent, require_background_analysis=False
                    )
            await _check_files_access(manage=True)
            return {
                "status": "ok",
                "file": await library.mutate(
                    file_id, revision=revision, operation=operation_name, name=name, parent=parent
                ),
            }
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
    except _TRANSIENT_STORAGE_ERRORS:
        return _storage_unavailable_response()
