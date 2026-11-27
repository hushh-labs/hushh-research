# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Resource-bounded ChatGPT and Claude export archive ingestion into Personal Wiki (#9429).

Composes encrypted Files (`source_library` / `file_object`) with `WikiLibrary` (`one_wiki`):
- Enforces strict compressed/uncompressed byte ceilings, entry count limits, compression
  ratio caps, symlink refusal, and path-traversal refusal before JSON parsing so pod and
  browser workers never exhaust RAM on zip bombs or malformed exports.
- Parses ChatGPT (`conversations.json`, `memories.json`) and Claude (`conversations.json`,
  `memories.json`, `projects.json`) exports using only owner-originated (`user` / `human`
  and explicit saved-memory) records as claim-eligible evidence; assistant turns are never
  self-cited as personal facts.
- Scrubs secrets/credentials prior to hashing or persistence, checks tombstone fingerprints
  so forgotten statements are never resurrected on re-import, and compiles cited wiki pages
  strictly as untrusted external source material (`untrusted_data: True`,
  `instruction_authority: "none"`).
- Routes candidate PKM projections exclusively through `derive_projection` with
  `require_owner_confirmation=True` (`state="private_candidate"`, `exposure_eligibility=False`).
"""

from __future__ import annotations

import hashlib
import io
import json
import posixpath
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.wiki_memory.contracts import (
    MAX_BATCH_PAGES,
    MAX_CLAIM_CHARS,
    MAX_CLAIMS_PER_PAGE,
    MAX_PAGE_BODY_CHARS,
    MAX_SOURCES_PER_PAGE,
    MAX_TLDR_CHARS,
    WikiRefused,
    WikiSourceRef,
    validate_idempotency_key,
    validate_projection_domain,
    validate_projection_json_path,
)
from hushh_mcp.services.wiki_memory.library import WikiLibrary
from hushh_mcp.services.wiki_memory.migration_and_maintenance import (
    normalize_statement_fingerprint,
)
from hushh_mcp.services.wiki_memory.projections import WikiProjectionEngine
from hushh_mcp.services.wiki_memory.writer import (
    WikiKnowledgeWriter,
    strip_secret_spans,
)

ARCHIVE_IMPORT_SCHEMA = "hussh.wiki.archive_import.v1"
ARCHIVE_IMPORTS_CHECKPOINT = "archive_imports"
TOMBSTONE_FINGERPRINTS_CHECKPOINT = "tombstone_fingerprints"

MAX_ARCHIVE_COMPRESSED_BYTES = 16 * 1024 * 1024  # 16 MiB
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 24 * 1024 * 1024  # 24 MiB
MAX_ARCHIVE_SINGLE_ENTRY_BYTES = 16 * 1024 * 1024  # 16 MiB
MAX_ARCHIVE_ENTRIES = 64
MAX_COMPRESSION_RATIO = 40
RATIO_CHECK_MIN_BYTES = 64 * 1024
STREAM_READ_CHUNK_BYTES = 64 * 1024
MAX_CONVERSATIONS_PER_IMPORT = 24
MAX_CLAIMS_PER_CONVERSATION = 32

SUPPORTED_ARCHIVE_PROVIDERS = frozenset({"auto", "chatgpt", "claude"})
_DISALLOWED_NESTED_SUFFIXES = (".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar")
_CREDENTIAL_RESIDUAL_WORDS = frozenset(
    {
        "api_key",
        "apikey",
        "api-key",
        "password",
        "passwd",
        "secret",
        "token",
        "bearer",
        "pin",
        "cvv",
        "cvc",
    }
)
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class NormalizedArchiveRecord:
    provider: str  # "chatgpt" | "claude"
    record_kind: str  # "conversation" | "saved_memory"
    external_id: str
    title: str
    observed_at: str
    statements: tuple[str, ...]
    candidate_projections: tuple[tuple[str, str], ...] = ()


def _clean_text(raw: Any, *, limit: int = MAX_CLAIM_CHARS) -> str:
    if not isinstance(raw, str):
        return ""
    scrubbed, _ = strip_secret_spans(raw)
    collapsed = _WHITESPACE_RE.sub(" ", scrubbed).strip()
    if not collapsed:
        return ""
    residual = collapsed.replace("[credential omitted]", "").strip(" \t\r\n.,:;=-")
    if not residual or residual.lower() in _CREDENTIAL_RESIDUAL_WORDS:
        return ""
    if len(collapsed) > limit:
        return collapsed[: limit - 1].rstrip() + "…"
    return collapsed


def _iso_date(raw: Any) -> str:
    if isinstance(raw, (int, float)) and raw > 0:
        try:
            return datetime.fromtimestamp(float(raw), tz=timezone.utc).strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            pass
    if isinstance(raw, str):
        trimmed = raw.strip()
        if len(trimmed) >= 10 and re.match(r"^\d{4}-\d{2}-\d{2}", trimmed):
            return trimmed[:10]
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _validate_archive_entry_path(raw_name: str) -> str:
    if not raw_name or "\x00" in raw_name or "\\" in raw_name:
        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
    if raw_name.startswith("/") or re.match(r"^[A-Za-z]:", raw_name):
        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
    parts = [seg for seg in raw_name.split("/") if seg]
    if not parts or any(seg in {".", ".."} for seg in parts):
        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
    normalized = posixpath.normpath("/".join(parts))
    if normalized.startswith("..") or normalized.startswith("/"):
        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
    lower = normalized.lower()
    if lower.endswith(_DISALLOWED_NESTED_SUFFIXES):
        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
    return normalized


def extract_archive_json_documents(
    raw_bytes: bytes,
    *,
    file_name: str = "export.zip",
) -> dict[str, Any]:
    """Safely unpack `.zip` or `.json` bytes into bounded parsed JSON documents."""
    if not isinstance(raw_bytes, (bytes, bytearray)) or len(raw_bytes) == 0:
        raise WikiRefused("WIKI_ARCHIVE_EMPTY", 400)
    if len(raw_bytes) > MAX_ARCHIVE_COMPRESSED_BYTES:
        raise WikiRefused("WIKI_ARCHIVE_TOO_LARGE", 413)

    payload = bytes(raw_bytes)
    is_zip = payload[:4] in {b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"}
    documents: dict[str, Any] = {}

    if not is_zip:
        if len(payload) > MAX_ARCHIVE_SINGLE_ENTRY_BYTES:
            raise WikiRefused("WIKI_ARCHIVE_TOO_LARGE", 413)
        try:
            text = payload.decode("utf-8-sig")
            parsed = json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400) from exc
        safe_key = posixpath.basename(file_name.strip() or "export.json") or "export.json"
        if not safe_key.lower().endswith(".json"):
            safe_key = f"{safe_key}.json"
        documents[safe_key] = parsed
        return documents

    try:
        zf = zipfile.ZipFile(io.BytesIO(payload), mode="r")
    except zipfile.BadZipFile as exc:
        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400) from exc

    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ARCHIVE_ENTRIES:
            raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
        total_uncompressed = 0
        for info in infos:
            if info.flag_bits & 0x1:
                raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
            unix_mode = (info.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)
            if info.is_dir():
                if info.filename.strip("/"):
                    _validate_archive_entry_path(info.filename.rstrip("/"))
                continue
            clean_path = _validate_archive_entry_path(info.filename)
            if info.file_size > MAX_ARCHIVE_SINGLE_ENTRY_BYTES:
                raise WikiRefused("WIKI_ARCHIVE_TOO_LARGE", 413)
            compressed_size = max(1, int(info.compress_size))
            if (
                info.file_size > RATIO_CHECK_MIN_BYTES
                and info.file_size > compressed_size * MAX_COMPRESSION_RATIO
            ):
                raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)

            buf = bytearray()
            with zf.open(info, mode="r") as entry_stream:
                while True:
                    chunk = entry_stream.read(STREAM_READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    total_uncompressed += len(chunk)
                    if (
                        len(buf) > MAX_ARCHIVE_SINGLE_ENTRY_BYTES
                        or total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES
                    ):
                        raise WikiRefused("WIKI_ARCHIVE_TOO_LARGE", 413)
                    if (
                        len(buf) > RATIO_CHECK_MIN_BYTES
                        and len(buf) > compressed_size * MAX_COMPRESSION_RATIO
                    ):
                        raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400)

            if not clean_path.lower().endswith(".json"):
                continue
            try:
                documents[clean_path] = json.loads(buf.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise WikiRefused("WIKI_ARCHIVE_UNSAFE", 400) from exc

    if not documents:
        raise WikiRefused("WIKI_ARCHIVE_EMPTY", 400)
    return documents


def _extract_chatgpt_message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return _clean_text(content)
    if not isinstance(content, dict):
        return ""
    content_type = str(content.get("content_type") or "text")
    if content_type not in {"text", "multimodal_text", "user_editable_context"}:
        return ""
    parts = content.get("parts")
    collected: list[str] = []
    if isinstance(parts, list):
        for part in parts:
            if isinstance(part, str):
                cleaned = _clean_text(part)
                if cleaned:
                    collected.append(cleaned)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                cleaned = _clean_text(part["text"])
                if cleaned:
                    collected.append(cleaned)
    elif isinstance(content.get("user_profile"), str) or isinstance(
        content.get("user_instructions"), str
    ):
        for field in ("user_profile", "user_instructions"):
            cleaned = _clean_text(content.get(field))
            if cleaned:
                collected.append(cleaned)
    elif isinstance(content.get("text"), str):
        cleaned = _clean_text(content["text"])
        if cleaned:
            collected.append(cleaned)
    return _clean_text(" ".join(collected))


def _extract_claude_message_text(msg: dict[str, Any]) -> str:
    pieces: list[str] = []
    if isinstance(msg.get("text"), str):
        cleaned = _clean_text(msg["text"])
        if cleaned:
            pieces.append(cleaned)
    if not pieces and isinstance(msg.get("content"), list):
        for block in msg["content"]:
            if isinstance(block, dict) and str(block.get("type") or "text") == "text":
                cleaned = _clean_text(block.get("text"))
                if cleaned:
                    pieces.append(cleaned)
    return _clean_text(" ".join(pieces))


def _detect_provider(documents: dict[str, Any], requested: str) -> str:
    if requested in {"chatgpt", "claude"}:
        return requested
    for doc in documents.values():
        items = doc if isinstance(doc, list) else [doc]
        for item in items:
            if not isinstance(item, dict):
                continue
            if "mapping" in item or "conversation_id" in item:
                return "chatgpt"
            if "chat_messages" in item or "conversations_memory" in item:
                return "claude"
    return "chatgpt"


def parse_ai_export_documents(
    documents: dict[str, Any],
    *,
    source_provider: str = "auto",
) -> tuple[str, list[NormalizedArchiveRecord]]:
    """Normalize ChatGPT or Claude export JSON payloads into owner-authored records."""
    provider_req = source_provider.strip().lower()
    if provider_req not in SUPPORTED_ARCHIVE_PROVIDERS:
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
    provider = _detect_provider(documents, provider_req)
    provider_label = "ChatGPT" if provider == "chatgpt" else "Claude"

    records: list[NormalizedArchiveRecord] = []
    saved_memory_statements: list[str] = []
    saved_memory_observed = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    for path in sorted(documents.keys()):
        basename = posixpath.basename(path).lower()
        doc = documents[path]

        # 1. Explicit saved memories (memories.json / memory.json)
        if basename in {"memories.json", "memory.json"} or (
            isinstance(doc, dict)
            and any(k in doc for k in ("memories", "conversations_memory", "project_memories"))
        ):
            raw_items: list[Any] = []
            if isinstance(doc, list):
                raw_items = doc
            elif isinstance(doc, dict):
                if isinstance(doc.get("memories"), list):
                    raw_items.extend(doc["memories"])
                if isinstance(doc.get("conversations_memory"), str):
                    raw_items.extend(
                        line.strip(" -*\t")
                        for line in doc["conversations_memory"].splitlines()
                        if line.strip(" -*\t")
                    )
                if isinstance(doc.get("project_memories"), dict):
                    for val in doc["project_memories"].values():
                        if isinstance(val, str):
                            raw_items.extend(
                                line.strip(" -*\t")
                                for line in val.splitlines()
                                if line.strip(" -*\t")
                            )
            for entry in raw_items:
                if isinstance(entry, str):
                    stmt = _clean_text(entry)
                elif isinstance(entry, dict):
                    stmt = _clean_text(
                        entry.get("content")
                        or entry.get("statement")
                        or entry.get("memory")
                        or entry.get("text")
                    )
                    if entry.get("updated_at") or entry.get("created_at"):
                        saved_memory_observed = _iso_date(
                            entry.get("updated_at") or entry.get("created_at")
                        )
                else:
                    stmt = ""
                if stmt and stmt not in saved_memory_statements:
                    saved_memory_statements.append(stmt)
            continue

        # 2. Claude projects.json owner-authored docs
        if basename == "projects.json" and isinstance(doc, list):
            for proj in doc[:MAX_CONVERSATIONS_PER_IMPORT]:
                if not isinstance(proj, dict):
                    continue
                proj_uuid = str(proj.get("uuid") or proj.get("id") or "").strip()
                proj_title = _clean_text(proj.get("name") or "Imported Project", limit=120)
                stmts: list[str] = []
                if isinstance(proj.get("prompt_template"), str):
                    cleaned = _clean_text(proj["prompt_template"])
                    if cleaned:
                        stmts.append(cleaned)
                if isinstance(proj.get("docs"), list):
                    for pdoc in proj["docs"]:
                        if isinstance(pdoc, dict):
                            cleaned = _clean_text(pdoc.get("content") or pdoc.get("text"))
                            if cleaned and cleaned not in stmts:
                                stmts.append(cleaned)
                if stmts:
                    records.append(
                        NormalizedArchiveRecord(
                            provider=provider,
                            record_kind="conversation",
                            external_id=proj_uuid
                            or hashlib.sha256(proj_title.encode("utf-8")).hexdigest()[:16],
                            title=f"{provider_label} Project: {proj_title}"[:120],
                            observed_at=_iso_date(proj.get("updated_at") or proj.get("created_at")),
                            statements=tuple(stmts[:MAX_CLAIMS_PER_CONVERSATION]),
                        )
                    )
            continue

        # 3. Conversations list or single conversation object
        conv_list: list[Any]
        if isinstance(doc, list):
            conv_list = doc
        elif isinstance(doc, dict) and isinstance(doc.get("conversations"), list):
            conv_list = doc["conversations"]
        elif isinstance(doc, dict) and (
            "mapping" in doc or "chat_messages" in doc or "messages" in doc
        ):
            conv_list = [doc]
        else:
            continue

        for conv in conv_list:
            if len(records) >= MAX_CONVERSATIONS_PER_IMPORT:
                break
            if not isinstance(conv, dict):
                continue

            if "mapping" in conv and isinstance(conv["mapping"], dict):
                # ChatGPT DAG conversation
                conv_id = str(conv.get("conversation_id") or conv.get("id") or "").strip()
                raw_title = _clean_text(conv.get("title") or "Imported Conversation", limit=120)
                observed_at = _iso_date(conv.get("update_time") or conv.get("create_time"))
                ordered_nodes: list[tuple[float, str, dict[str, Any]]] = []
                for idx, (node_id, node) in enumerate(conv["mapping"].items()):
                    if not isinstance(node, dict):
                        continue
                    msg = node.get("message")
                    if not isinstance(msg, dict):
                        continue
                    author = msg.get("author")
                    role = str(author.get("role") if isinstance(author, dict) else "").lower()
                    if role != "user":
                        # Never treat assistant/system/tool messages as personal facts.
                        continue
                    ts = msg.get("create_time")
                    sort_ts = float(ts) if isinstance(ts, (int, float)) else float(idx)
                    ordered_nodes.append((sort_ts, str(node_id), msg))
                ordered_nodes.sort(key=lambda item: (item[0], item[1]))
                user_stmts: list[str] = []
                for _, _, msg in ordered_nodes:
                    cleaned = _extract_chatgpt_message_text(msg)
                    if cleaned and cleaned not in user_stmts:
                        user_stmts.append(cleaned)
                        if len(user_stmts) >= MAX_CLAIMS_PER_CONVERSATION:
                            break
                if user_stmts:
                    records.append(
                        NormalizedArchiveRecord(
                            provider="chatgpt",
                            record_kind="conversation",
                            external_id=conv_id
                            or hashlib.sha256(raw_title.encode("utf-8")).hexdigest()[:16],
                            title=f"ChatGPT: {raw_title or 'Conversation'}"[:120],
                            observed_at=observed_at,
                            statements=tuple(user_stmts),
                        )
                    )
                continue

            if "chat_messages" in conv and isinstance(conv["chat_messages"], list):
                # Claude conversation
                conv_id = str(conv.get("uuid") or conv.get("id") or "").strip()
                raw_title = _clean_text(
                    conv.get("name") or conv.get("title") or "Imported Conversation", limit=120
                )
                observed_at = _iso_date(conv.get("updated_at") or conv.get("created_at"))
                human_stmts: list[str] = []
                for msg in conv["chat_messages"]:
                    if not isinstance(msg, dict):
                        continue
                    sender = str(msg.get("sender") or msg.get("role") or "").lower()
                    if sender not in {"human", "user"}:
                        continue
                    cleaned = _extract_claude_message_text(msg)
                    if cleaned and cleaned not in human_stmts:
                        human_stmts.append(cleaned)
                        if len(human_stmts) >= MAX_CLAIMS_PER_CONVERSATION:
                            break
                if human_stmts:
                    records.append(
                        NormalizedArchiveRecord(
                            provider="claude",
                            record_kind="conversation",
                            external_id=conv_id
                            or hashlib.sha256(raw_title.encode("utf-8")).hexdigest()[:16],
                            title=f"Claude: {raw_title or 'Conversation'}"[:120],
                            observed_at=observed_at,
                            statements=tuple(human_stmts),
                        )
                    )
                continue

            if "messages" in conv and isinstance(conv["messages"], list):
                # Generic normalized message list fallback
                conv_id = str(conv.get("id") or conv.get("uuid") or "").strip()
                raw_title = _clean_text(
                    conv.get("title") or conv.get("name") or "Conversation", limit=120
                )
                observed_at = _iso_date(conv.get("updated_at") or conv.get("created_at"))
                stmts = []
                for msg in conv["messages"]:
                    if not isinstance(msg, dict):
                        continue
                    role = str(msg.get("role") or msg.get("sender") or "").lower()
                    if role not in {"user", "human"}:
                        continue
                    cleaned = _clean_text(msg.get("content") or msg.get("text"))
                    if cleaned and cleaned not in stmts:
                        stmts.append(cleaned)
                        if len(stmts) >= MAX_CLAIMS_PER_CONVERSATION:
                            break
                if stmts:
                    records.append(
                        NormalizedArchiveRecord(
                            provider=provider,
                            record_kind="conversation",
                            external_id=conv_id
                            or hashlib.sha256(raw_title.encode("utf-8")).hexdigest()[:16],
                            title=f"{provider_label}: {raw_title}"[:120],
                            observed_at=observed_at,
                            statements=tuple(stmts),
                        )
                    )

    if saved_memory_statements:
        capped_memories = tuple(saved_memory_statements[:MAX_CLAIMS_PER_CONVERSATION])
        candidates = tuple(
            (
                "preferences",
                f"imported_notes.item_{hashlib.sha256(stmt.encode('utf-8')).hexdigest()[:12]}",
            )
            for stmt in capped_memories
        )
        records.insert(
            0,
            NormalizedArchiveRecord(
                provider=provider,
                record_kind="saved_memory",
                external_id=f"{provider}_saved_memories",
                title=f"{provider_label} Saved Memories",
                observed_at=saved_memory_observed,
                statements=capped_memories,
                candidate_projections=candidates,
            ),
        )

    return provider, records


class WikiArchiveImporter:
    """Idempotent, tombstone-respecting compiler from encrypted Files archives into `one_wiki`."""

    def __init__(
        self,
        library: WikiLibrary,
        *,
        pod_memory_service: Any = None,
    ) -> None:
        self.library = library
        self.writer = WikiKnowledgeWriter(library, pod_memory_service=pod_memory_service)
        self.projections = WikiProjectionEngine(library)

    def _opaque_hex(self, label: str) -> str:
        return hashlib.sha256(f"{self.library.owner}|{label}".encode("utf-8")).hexdigest()[:16]

    def source_id_for_archive(self, archive_sha256: str, external_id: str) -> str:
        return f"wsr_{self._opaque_hex(f'archive:{archive_sha256}:{external_id}')}"

    def page_id_for_archive_record(self, provider: str, record_kind: str, external_id: str) -> str:
        return f"wpg_{self._opaque_hex(f'import:{provider}:{record_kind}:{external_id}')}"

    async def _load_tombstoned_fingerprints(self) -> tuple[set[str], set[str], set[str]]:
        tombstones = await self.library.list_tombstones()
        dead_claims = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "claim"}
        dead_pages = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "page"}
        fp_doc, _ = await self.library.read_named_checkpoint(TOMBSTONE_FINGERPRINTS_CHECKPOINT)
        dead_fps = set((fp_doc or {}).get("fingerprints") or ())
        return dead_fps, dead_claims, dead_pages

    async def import_archive_bytes(
        self,
        *,
        file_id: str,
        file_name: str,
        raw_bytes: bytes,
        idempotency_key: str,
        source_provider: str = "auto",
        explicit_candidate_mappings: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        validate_idempotency_key(idempotency_key)
        clean_file_id = str(file_id or "").strip()
        if not clean_file_id or len(clean_file_id) > 128 or "/" in clean_file_id:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        archive_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        documents = extract_archive_json_documents(raw_bytes, file_name=file_name)
        provider, records = parse_ai_export_documents(documents, source_provider=source_provider)

        explicit_by_statement: dict[str, tuple[str, str]] = {}
        for mapping in explicit_candidate_mappings or []:
            stmt_fp = normalize_statement_fingerprint(str(mapping.get("statement") or ""))
            dom = validate_projection_domain(mapping.get("domain"))
            jpath = validate_projection_json_path(mapping.get("json_path"))
            if stmt_fp:
                explicit_by_statement[stmt_fp] = (dom, jpath)

        dead_fps, dead_claims, dead_pages = await self._load_tombstoned_fingerprints()

        batch_items: list[dict[str, Any]] = []
        pending_candidates: list[tuple[str, str, str, str]] = []
        registered_sources: list[str] = []
        imported_claim_count = 0
        skipped_tombstoned_count = 0
        deduplicated_claim_count = 0

        for record in records[:MAX_BATCH_PAGES]:
            page_id = self.page_id_for_archive_record(
                record.provider, record.record_kind, record.external_id
            )
            if page_id in dead_pages:
                skipped_tombstoned_count += len(record.statements)
                continue

            source_id = self.source_id_for_archive(archive_sha256, record.external_id)
            locator = f"files:{clean_file_id}#{record.provider}:{record.external_id}"[:256]
            record_digest = hashlib.sha256("\n".join(record.statements).encode("utf-8")).hexdigest()

            source_ref = WikiSourceRef(
                source_id=source_id,
                kind="file_object",
                locator=locator,
                content_sha256=record_digest,
                observed_at=record.observed_at,
                consent_derived=False,
            )
            await self.library.register_source(
                source_ref,
                idempotency_key=f"src:{idempotency_key}:{source_id}",
            )
            registered_sources.append(source_id)

            existing_page: dict[str, Any] | None = None
            try:
                existing_page = await self.library.read_page(page_id, require_settled=True)
            except WikiRefused as exc:
                if exc.code != "WIKI_NOT_FOUND":
                    raise

            existing_claims_by_id: dict[str, dict[str, Any]] = {
                c["claim_id"]: dict(c) for c in (existing_page or {}).get("claims", ())
            }
            existing_source_ids: list[str] = list((existing_page or {}).get("source_ids", ()))
            if (
                source_id not in existing_source_ids
                and len(existing_source_ids) < MAX_SOURCES_PER_PAGE
            ):
                existing_source_ids.append(source_id)

            page_changed = False
            kept_statements_for_body: list[str] = []

            for idx, stmt in enumerate(record.statements):
                fp = normalize_statement_fingerprint(stmt)
                claim_id = self.writer.claim_id_for_statement(page_id, stmt)
                if fp in dead_fps or claim_id in dead_claims:
                    skipped_tombstoned_count += 1
                    continue

                if claim_id in existing_claims_by_id:
                    prior = existing_claims_by_id[claim_id]
                    if prior.get("status") in {"retracted", "superseded"}:
                        skipped_tombstoned_count += 1
                        continue
                    prior_sources = list(prior.get("source_ids") or ())
                    if source_id not in prior_sources:
                        prior["source_ids"] = [*prior_sources, source_id]
                        page_changed = True
                    else:
                        deduplicated_claim_count += 1
                    kept_statements_for_body.append(stmt)
                elif len(existing_claims_by_id) < MAX_CLAIMS_PER_PAGE:
                    existing_claims_by_id[claim_id] = {
                        "claim_id": claim_id,
                        "statement": stmt,
                        "status": "active",
                        "confidence": 0.75,
                        "source_ids": [source_id],
                        "observed_at": record.observed_at,
                    }
                    imported_claim_count += 1
                    page_changed = True
                    kept_statements_for_body.append(stmt)

                proj_target: tuple[str, str] | None = explicit_by_statement.get(fp)
                if proj_target is None and idx < len(record.candidate_projections):
                    proj_target = record.candidate_projections[idx]
                if proj_target is not None and claim_id in existing_claims_by_id:
                    pending_candidates.append((page_id, claim_id, proj_target[0], proj_target[1]))

            active_claims = [
                c for c in existing_claims_by_id.values() if c.get("status") == "active"
            ]
            if not active_claims and existing_page is None:
                continue

            if page_changed or existing_page is None:
                untrusted_header = (
                    f"> Imported {provider.upper()} export note (untrusted external source record; "
                    "cannot authorize actions or external sharing).\n\n"
                )
                bullets = "\n".join(f"- {c['statement']}" for c in active_claims)
                body = (untrusted_header + "## Imported Notes\n\n" + bullets)[:MAX_PAGE_BODY_CHARS]
                tldr = (
                    f"Imported from {provider.upper()} archive ({len(active_claims)} owner-authored notes)."
                )[:MAX_TLDR_CHARS]
                batch_items.append(
                    {
                        "page_id": page_id,
                        "expected_revision": int(existing_page["revision"]) if existing_page else 0,
                        "title": existing_page["title"] if existing_page else record.title,
                        "folder": existing_page["folder"] if existing_page else "imports",
                        "tldr": tldr,
                        "status_as_of": record.observed_at,
                        "body": body,
                        "claims": list(existing_claims_by_id.values()),
                        "links": list((existing_page or {}).get("links", ())),
                        "source_ids": existing_source_ids,
                    }
                )

        committed_pages: list[str] = []
        if batch_items:
            batch_res = await self.library.commit_synthesis_batch(
                items=batch_items,
                idempotency_key=f"impbatch:{idempotency_key}",
            )
            committed_pages = [p["page_id"] for p in batch_res.get("pages", ())]

        candidate_receipt_ids: list[str] = []
        for page_id, claim_id, target_domain, json_path in pending_candidates:
            existing_receipts = await self.library.list_projection_receipts(domain=target_domain)
            already_materialized = next(
                (
                    r
                    for r in existing_receipts
                    if r["page_id"] == page_id
                    and r["claim_id"] == claim_id
                    and r["json_path"] == json_path
                    and r["state"] == "materialized"
                ),
                None,
            )
            if already_materialized is not None:
                candidate_receipt_ids.append(already_materialized["receipt_id"])
                continue
            receipt = await self.projections.derive_projection(
                page_id=page_id,
                claim_id=claim_id,
                target_domain=target_domain,
                json_path=json_path,
                idempotency_key=f"impproj:{idempotency_key}:{claim_id}"[:128],
                active_recipient_count=0,
                owner_confirmed=False,
                require_owner_confirmation=True,
            )
            candidate_receipt_ids.append(receipt["receipt_id"])

        await self.writer.refresh_hot_digest()

        ledger, ledger_rev = await self.library.read_named_checkpoint(ARCHIVE_IMPORTS_CHECKPOINT)
        prior_imports = dict((ledger or {}).get("imports") or {})
        prior_imports[archive_sha256] = {
            "file_id": clean_file_id,
            "provider": provider,
            "archive_sha256": archive_sha256,
            "pages": committed_pages,
            "source_ids": registered_sources,
        }
        await self.library.write_named_checkpoint(
            ARCHIVE_IMPORTS_CHECKPOINT,
            {"imports": prior_imports},
            expected_revision=ledger_rev,
        )

        return {
            "schema": ARCHIVE_IMPORT_SCHEMA,
            "status": "imported",
            "provider": provider,
            "file_id": clean_file_id,
            "archive_sha256": archive_sha256,
            "pages_updated": len(committed_pages),
            "page_ids": committed_pages,
            "claims_imported": imported_claim_count,
            "claims_deduplicated": deduplicated_claim_count,
            "claims_skipped_tombstoned": skipped_tombstoned_count,
            "source_ids": registered_sources,
            "candidate_receipt_ids": candidate_receipt_ids,
            "untrusted_data": True,
            "instruction_authority": "none",
            "shareable": "never",
        }
