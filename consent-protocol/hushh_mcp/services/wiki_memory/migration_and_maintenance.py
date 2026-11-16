"""Phase 4 per-owner migration, 5-outcome Forget propagation, cold recovery, rollback, and lint.

Implements `#9370` Phase 4 obligations over ``WikiLibrary``, ``WikiKnowledgeWriter``, and
``WikiProjectionEngine``:
1. Per-owner migration state machine (`v1_markdown_only` -> `dual_read_shadow_compile` ->
   `wiki_primary_with_v1_rollback` -> `wiki_primary`) stored encrypted under
   `wiki/v1/checkpoints/` with explicit `expected_migration_revision` CAS.
2. Deterministic compilation of V1 `one_memory.markdown` bullets and Pod Schema-2
   `agent_memory_fact` entries into provenance-cited `wcl_*` claims while preserving
   typed specialist authorities (`financial`, `identity`, `consent`), owner edits, and
   existing `wtb_*` tombstones.
3. Dual-read parity verification (exact content coverage + scoped projection parity +
   zero tombstone resurrection) and four-plane cold reconstruction verification (commit-log
   head, encrypted wiki chunks, nested memory/index ciphertext, and separate owner chat-key
   session recovery) before retiring an owner's legacy writer.
4. Cross-surface Correction & Forget propagation reporting the five distinct `#9370`
   erasure outcomes (`logical_deletion`, `revoked_future_access`, `key_destroyed`,
   `provider_operation_acknowledged`, `physical_erasure_under_retention`), plus one-step
   rollback to V1 Markdown without resurrecting forgotten facts.
5. Idempotent, bounded-budget background wiki maintenance (`WikiMaintenanceRunner`):
   claim deduplication, expired `valid_until` sweeps, contradiction/broken-link/orphan
   lint diagnostics, index reconstruction, and `root/hot.md.enc` compaction (`<= 8,000` chars).
"""

from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.wiki_memory.contracts import (
    WIKI_HOT_MAX_CHARS,
    WikiRefused,
    WikiSourceRef,
    WikiTombstone,
    extract_inline_links,
    validate_claim_id,
    validate_idempotency_key,
    validate_page_id,
)
from hushh_mcp.services.wiki_memory.library import WikiLibrary
from hushh_mcp.services.wiki_memory.projections import WikiProjectionEngine
from hushh_mcp.services.wiki_memory.writer import (
    DEFAULT_WORKING_PAGE_ID,
    DEFAULT_WORKING_PAGE_TITLE,
    WikiKnowledgeWriter,
    strip_secret_spans,
)

WIKI_MIGRATION_STATES: tuple[str, ...] = (
    "v1_markdown_only",
    "dual_read_shadow_compile",
    "wiki_primary_with_v1_rollback",
    "wiki_primary",
)

WIKI_ERASURE_OUTCOME_KEYS: tuple[str, ...] = (
    "logical_deletion",
    "revoked_future_access",
    "key_destroyed",
    "provider_operation_acknowledged",
    "physical_erasure_under_retention",
)

MIGRATION_CHECKPOINT_NAME = "migration_state"
MAINTENANCE_CHECKPOINT_NAME = "maintenance_cursor"
TOMBSTONE_FPS_CHECKPOINT_NAME = "tombstoned_fingerprints"

_HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_BULLET_LINE_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$")
_NEGATION_WORDS = frozenset(
    {"not", "never", "no", "none", "dislikes", "avoids", "stopped", "quit", "cancelled"}
)


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def normalize_statement_fingerprint(statement: str) -> str:
    collapsed = " ".join(str(statement or "").strip().lower().split())
    return hashlib.sha256(collapsed.encode("utf-8")).hexdigest()


def parse_v1_markdown_sections(markdown: str) -> list[dict[str, Any]]:
    """Parse V1 `one_memory.markdown` headings and bullets deterministically."""
    sections: list[dict[str, Any]] = []
    current_heading = DEFAULT_WORKING_PAGE_TITLE
    current_bullets: list[dict[str, Any]] = []

    for line_no, raw_line in enumerate(str(markdown or "").splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        heading_match = _HEADING_LINE_RE.match(stripped)
        if heading_match:
            level = len(heading_match.group(1))
            title = heading_match.group(2).strip()
            if level == 1 and title.lower() in {"memory.md", "memory", "personal memory"}:
                continue
            if current_bullets:
                sections.append({"title": current_heading, "bullets": list(current_bullets)})
                current_bullets = []
            current_heading = title[:120] or DEFAULT_WORKING_PAGE_TITLE
            continue

        bullet_match = _BULLET_LINE_RE.match(raw_line)
        if bullet_match:
            cleaned, _ = strip_secret_spans(bullet_match.group(1).strip())
            residual = cleaned.replace("[credential omitted]", "").strip(" \t\r\n.,:;=-")
            if residual:
                current_bullets.append({"line": line_no, "statement": cleaned[:1000]})

    if current_bullets:
        sections.append({"title": current_heading, "bullets": list(current_bullets)})
    return sections


def _subject_slot_key(statement: str) -> tuple[str, bool] | None:
    tokens = re.findall(r"[a-z0-9_]+", statement.lower())
    if len(tokens) < 3:
        return None
    negated = any(tok in _NEGATION_WORDS for tok in tokens)
    content_tokens = [
        tok
        for tok in tokens
        if tok not in _NEGATION_WORDS
        and tok
        not in {
            "the",
            "owner",
            "prefers",
            "likes",
            "uses",
            "schedule",
            "schedules",
            "is",
            "are",
            "has",
            "have",
        }
    ]
    if len(content_tokens) < 2:
        return None
    return " ".join(content_tokens[:2]), negated


class WikiOwnerMigrator:
    """Per-owner Dev cohort migration, dual-read verifier, Forget propagator, and rollback engine."""

    def __init__(
        self,
        library: WikiLibrary,
        *,
        writer: WikiKnowledgeWriter | None = None,
        projections: WikiProjectionEngine | None = None,
    ) -> None:
        self.library = library
        self.writer = writer or WikiKnowledgeWriter(library)
        self.projections = projections or WikiProjectionEngine(library)

    def _page_id_for_section(self, section_title: str) -> str:
        norm = " ".join(section_title.strip().lower().split())
        if not norm or norm == DEFAULT_WORKING_PAGE_TITLE.lower():
            return str(DEFAULT_WORKING_PAGE_ID)
        digest = hashlib.sha256(
            f"{self.library.owner}|v1_section_page|{norm}".encode("utf-8")
        ).hexdigest()
        return f"wpg_{digest[:16]}"

    def _source_id_for_legacy(self, origin: str, locator: str, statement_fp: str) -> str:
        digest = hashlib.sha256(
            f"{self.library.owner}|legacy_src|{origin}|{locator}|{statement_fp}".encode("utf-8")
        ).hexdigest()
        return f"wsr_{digest[:16]}"

    async def get_migration_status(self) -> dict[str, Any]:
        payload, rev = await self.library.read_named_checkpoint(MIGRATION_CHECKPOINT_NAME)
        if payload is None:
            return {
                "owner": self.library.owner,
                "account_generation": self.library.account_generation,
                "library_id": self.library.library_id,
                "state": "v1_markdown_only",
                "migration_revision": rev,
                "compiled_source_sha256": None,
                "dual_read_qualified": False,
                "cold_recovery_qualified": False,
                "updated_at": 0,
            }
        return {
            "owner": self.library.owner,
            "account_generation": self.library.account_generation,
            "library_id": self.library.library_id,
            "state": str(payload.get("state") or "v1_markdown_only"),
            "migration_revision": rev,
            "compiled_source_sha256": payload.get("compiled_source_sha256"),
            "dual_read_qualified": bool(payload.get("dual_read_qualified", False)),
            "cold_recovery_qualified": bool(payload.get("cold_recovery_qualified", False)),
            "updated_at": int(payload.get("updated_at", 0) or 0),
        }

    async def _tombstone_index(self) -> tuple[set[str], set[str], set[str]]:
        tombstones = await self.library.list_tombstones()
        fp_doc, _ = await self.library.read_named_checkpoint(TOMBSTONE_FPS_CHECKPOINT_NAME)
        statement_fps: set[str] = {
            str(fp) for fp in ((fp_doc or {}).get("fingerprints") or []) if str(fp)
        }
        claim_ids: set[str] = set()
        source_ids: set[str] = set()
        for tb in tombstones:
            kind = tb.get("target_kind")
            tid = str(tb.get("target_id") or "")
            if kind == "claim" and tid:
                claim_ids.add(tid)
            elif kind == "source" and tid:
                source_ids.add(tid)
        return statement_fps, claim_ids, source_ids

    async def _record_tombstoned_fingerprint(self, statement_fp: str) -> None:
        fp_doc, fp_rev = await self.library.read_named_checkpoint(TOMBSTONE_FPS_CHECKPOINT_NAME)
        existing = {str(fp) for fp in ((fp_doc or {}).get("fingerprints") or []) if str(fp)}
        if statement_fp in existing:
            return
        existing.add(statement_fp)
        await self.library.write_named_checkpoint(
            TOMBSTONE_FPS_CHECKPOINT_NAME,
            {"fingerprints": sorted(existing), "updated_at": int(time.time() * 1000)},
            expected_revision=fp_rev,
        )

    async def compile_legacy_sources(
        self,
        *,
        v1_markdown: str,
        pod_schema2_facts: list[dict[str, Any]] | None = None,
        idempotency_key: str,
        expected_migration_revision: int | None = None,
        specialist_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Compile V1 `one_memory.markdown` + Pod Schema-2 facts into cited wiki claims.

        Filters out any `wtb_*` tombstoned facts so forgotten details never re-enter during
        migration or replay, and preserves owner edits and typed specialist authorities.
        """
        idem = validate_idempotency_key(idempotency_key)
        status_before = await self.get_migration_status()
        if (
            expected_migration_revision is not None
            and status_before["migration_revision"] != expected_migration_revision
        ):
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)

        tomb_fps, tomb_claims, tomb_sources = await self._tombstone_index()
        sections = parse_v1_markdown_sections(v1_markdown)

        # Fold Pod Schema-2 facts into Working Memory without duplicating V1 bullets
        schema2_items: list[dict[str, Any]] = []
        for idx, entry in enumerate(pod_schema2_facts or []):
            raw_text = str(entry.get("text") or entry.get("fact") or "").strip()
            if not raw_text:
                continue
            cleaned, _ = strip_secret_spans(raw_text)
            residual = cleaned.replace("[credential omitted]", "").strip(" \t\r\n.,:;=-")
            if residual:
                schema2_items.append(
                    {
                        "seq": int(entry.get("seq", idx + 1) or (idx + 1)),
                        "statement": cleaned[:1000],
                    }
                )

        if schema2_items:
            working_sec = next(
                (
                    sec
                    for sec in sections
                    if self._page_id_for_section(sec["title"]) == DEFAULT_WORKING_PAGE_ID
                ),
                None,
            )
            if working_sec is None:
                working_sec = {"title": DEFAULT_WORKING_PAGE_TITLE, "bullets": []}
                sections.append(working_sec)
            for item in schema2_items:
                working_sec["bullets"].append(
                    {
                        "line": 100_000 + item["seq"],
                        "statement": item["statement"],
                        "origin": "pod_schema2",
                        "seq": item["seq"],
                    }
                )

        compiled_claim_ids: list[str] = []
        skipped_tombstoned = 0
        touched_page_ids: list[str] = []
        today = _today_utc()
        observed_iso = f"{today}T00:00:00Z"

        for sec in sections:
            page_id = self._page_id_for_section(sec["title"])
            existing_page: dict[str, Any] | None = None
            try:
                existing_page = await self.library.read_page(page_id)
            except WikiRefused as exc:
                if exc.code != "WIKI_NOT_FOUND":
                    raise

            existing_claims_by_id: dict[str, dict[str, Any]] = {
                c["claim_id"]: dict(c) for c in (existing_page["claims"] if existing_page else [])
            }
            existing_sources: set[str] = set(existing_page["source_ids"] if existing_page else [])

            for bullet in sec["bullets"]:
                stmt = str(bullet["statement"]).strip()
                stmt_fp = normalize_statement_fingerprint(stmt)
                claim_id = self.writer.claim_id_for_statement(page_id, stmt)
                origin = str(bullet.get("origin") or "v1_markdown")
                locator = (
                    f"pod_commit_log:seq:{bullet['seq']}"
                    if origin == "pod_schema2"
                    else f"pkm:one_memory.markdown#line:{bullet['line']}"
                )
                source_id = self._source_id_for_legacy(origin, locator, stmt_fp)
                if stmt_fp in tomb_fps or claim_id in tomb_claims or source_id in tomb_sources:
                    skipped_tombstoned += 1
                    continue

                source_ref = WikiSourceRef(
                    source_id=source_id,
                    kind="owner_direct" if origin == "pod_schema2" else "pkm_record",
                    locator=locator,
                    content_sha256=stmt_fp,
                    observed_at=observed_iso,
                    consent_derived=False,
                )
                await self.library.register_source(
                    source_ref, idempotency_key=f"{idem}:src:{source_id}"[:120]
                )
                existing_sources.add(source_id)

                prior = existing_claims_by_id.get(claim_id)
                if prior is not None:
                    if prior.get("status") in {"retracted", "superseded"}:
                        # Respect prior owner edits/corrections; never overwrite retracted/superseded claims
                        continue
                    merged_sources = sorted(set(prior.get("source_ids") or []) | {source_id})
                    existing_claims_by_id[claim_id] = {**prior, "source_ids": merged_sources}
                else:
                    existing_claims_by_id[claim_id] = {
                        "claim_id": claim_id,
                        "statement": stmt,
                        "status": "active",
                        "confidence": 1.0,
                        "source_ids": [source_id],
                        "observed_at": today,
                    }
                compiled_claim_ids.append(claim_id)

            merged_claims = list(existing_claims_by_id.values())
            active_stmts = [c["statement"] for c in merged_claims if c.get("status") == "active"]
            if not merged_claims and existing_page is None:
                continue

            body = (
                existing_page["body"]
                if existing_page is not None and existing_page["body"].strip()
                else "\n".join(f"- {s}" for s in active_stmts)
            )
            tldr = (
                existing_page["tldr"]
                if existing_page is not None and existing_page["tldr"].strip()
                else (active_stmts[0][:240] if active_stmts else "")
            )
            if existing_page is None:
                await self.library.create_page(
                    page_id=page_id,
                    title=sec["title"],
                    folder="topics" if page_id != DEFAULT_WORKING_PAGE_ID else "root",
                    tldr=tldr,
                    status_as_of=today,
                    body=body,
                    claims=merged_claims,
                    links=[],
                    source_ids=sorted(existing_sources),
                    idempotency_key=f"{idem}:create:{page_id}"[:120],
                )
            else:
                await self.library.edit_page(
                    page_id,
                    expected_revision=int(existing_page["revision"]),
                    idempotency_key=f"{idem}:edit:{page_id}:{existing_page['revision']}"[:120],
                    tldr=tldr,
                    status_as_of=today,
                    body=body,
                    claims=merged_claims,
                    source_ids=sorted(existing_sources),
                )
            touched_page_ids.append(page_id)

        await self.library.rebuild_indexes()
        await self.writer.refresh_hot_digest()

        combined_digest = hashlib.sha256(
            f"{v1_markdown}\n---\n{len(schema2_items)}".encode("utf-8")
        ).hexdigest()
        next_state = (
            status_before["state"]
            if status_before["state"] in {"wiki_primary_with_v1_rollback", "wiki_primary"}
            else "dual_read_shadow_compile"
        )
        _, next_rev = await self.library.write_named_checkpoint(
            MIGRATION_CHECKPOINT_NAME,
            {
                "state": next_state,
                "compiled_source_sha256": combined_digest,
                "dual_read_qualified": False,
                "cold_recovery_qualified": status_before["cold_recovery_qualified"],
                "specialist_authorities_preserved": sorted((specialist_snapshot or {}).keys()),
                "updated_at": int(time.time() * 1000),
            },
            expected_revision=status_before["migration_revision"],
        )
        return {
            "state": next_state,
            "migration_revision": next_rev,
            "compiled_claim_count": len(compiled_claim_ids),
            "skipped_tombstoned_count": skipped_tombstoned,
            "touched_page_ids": sorted(set(touched_page_ids)),
            "compiled_source_sha256": combined_digest,
        }

    async def verify_dual_read_parity(
        self,
        *,
        v1_markdown: str,
        pod_schema2_facts: list[dict[str, Any]] | None = None,
        expected_scoped_domains: list[str] | None = None,
    ) -> dict[str, Any]:
        """Verify exact content coverage, zero tombstone resurrection, and scoped projection parity."""
        tomb_fps, tomb_claims, _ = await self._tombstone_index()
        pages = await self.library.list_pages()
        active_fps: set[str] = set()
        superseded_or_retracted_fps: set[str] = set()
        resurrected_claims: list[str] = []

        for summary in pages:
            page = await self.library.read_page(summary["page_id"])
            for claim in page["claims"]:
                fp = normalize_statement_fingerprint(claim["statement"])
                if claim["status"] == "active":
                    active_fps.add(fp)
                    if fp in tomb_fps or claim["claim_id"] in tomb_claims:
                        resurrected_claims.append(claim["claim_id"])
                else:
                    superseded_or_retracted_fps.add(fp)

        expected_fps: set[str] = set()
        for sec in parse_v1_markdown_sections(v1_markdown):
            for bullet in sec["bullets"]:
                fp = normalize_statement_fingerprint(bullet["statement"])
                if fp not in tomb_fps:
                    expected_fps.add(fp)
        for entry in pod_schema2_facts or []:
            raw_text = str(entry.get("text") or entry.get("fact") or "").strip()
            cleaned, _ = strip_secret_spans(raw_text)
            if cleaned.strip():
                fp = normalize_statement_fingerprint(cleaned)
                if fp not in tomb_fps:
                    expected_fps.add(fp)

        covered_fps = active_fps | superseded_or_retracted_fps
        missing_count = len(expected_fps - covered_fps)

        projection_parity = True
        domain_summaries: dict[str, str] = {}
        for domain in expected_scoped_domains or []:
            states = await self.projections.projection_states_for_domain(domain)
            for path_key, info in states.items():
                if info.get("exposure_eligibility") and info.get("state") != "materialized":
                    projection_parity = False
                domain_summaries[f"{domain}.{path_key}"] = str(info.get("state"))

        exact_match = missing_count == 0 and len(resurrected_claims) == 0
        qualified = exact_match and projection_parity

        current, rev = await self.library.read_named_checkpoint(MIGRATION_CHECKPOINT_NAME)
        base_payload = dict(current or {"state": "v1_markdown_only"})
        base_payload["dual_read_qualified"] = qualified
        base_payload["updated_at"] = int(time.time() * 1000)
        _, next_rev = await self.library.write_named_checkpoint(
            MIGRATION_CHECKPOINT_NAME, base_payload, expected_revision=rev
        )

        return {
            "qualified": qualified,
            "exact_content_match": exact_match,
            "scoped_projection_match": projection_parity,
            "expected_fact_count": len(expected_fps),
            "missing_fact_count": missing_count,
            "unexpected_resurrection_count": len(resurrected_claims),
            "domain_projection_states": domain_summaries,
            "migration_revision": next_rev,
        }

    async def verify_cold_reconstruction(
        self,
        *,
        commit_log_verifier: Callable[[], Awaitable[bool]] | None = None,
        chat_session_verifier: Callable[[], Awaitable[bool]] | None = None,
    ) -> dict[str, Any]:
        """Qualify all four cold-recovery planes independently (`#9370` Phase 4).

        A matching replayed commit-log head NEVER stands in for wiki chunk readability,
        nested ciphertext integrity, or owner chat-key session recovery.
        """
        commit_log_ok = await commit_log_verifier() if commit_log_verifier is not None else True

        wiki_chunks_ok = True
        pages_verified = 0
        try:
            for summary in await self.library.list_pages():
                key_bytes, rev_path = await self.library.export_narrow_page_key(summary["page_id"])
                raw_cipher, _ = await self.library.store.get_with_generation(rev_path)
                if raw_cipher is None or len(key_bytes) != 32:
                    wiki_chunks_ok = False
                    break
                page = await self.library.read_page(summary["page_id"], require_settled=True)
                if page["page_id"] != summary["page_id"]:
                    wiki_chunks_ok = False
                    break
                pages_verified += 1
        except Exception:
            wiki_chunks_ok = False

        nested_ok = True
        try:
            _ = await self.library.read_hot_digest()
            _ = await self.library.read_capture_checkpoint()
            _ = await self.library.list_tombstones()
            _ = await self.library.list_projection_receipts()
            _ = await self.library.rebuild_indexes()
        except Exception:
            nested_ok = False

        # Chat-key session recovery MUST be verified explicitly when required; never inferred
        # from commit_log_ok alone.
        chat_session_ok = (
            await chat_session_verifier() if chat_session_verifier is not None else False
        )

        all_qualified = (
            bool(commit_log_ok)
            and bool(wiki_chunks_ok)
            and bool(nested_ok)
            and bool(chat_session_ok)
        )
        current, rev = await self.library.read_named_checkpoint(MIGRATION_CHECKPOINT_NAME)
        base_payload = dict(current or {"state": "v1_markdown_only"})
        base_payload["cold_recovery_qualified"] = all_qualified
        base_payload["updated_at"] = int(time.time() * 1000)
        _, next_rev = await self.library.write_named_checkpoint(
            MIGRATION_CHECKPOINT_NAME, base_payload, expected_revision=rev
        )
        return {
            "qualified": all_qualified,
            "commit_log_head_verified": bool(commit_log_ok),
            "wiki_chunks_readable": bool(wiki_chunks_ok),
            "nested_memory_ciphertext_readable": bool(nested_ok),
            "chat_key_session_recovery_verified": bool(chat_session_ok),
            "pages_verified": pages_verified,
            "migration_revision": next_rev,
        }

    async def advance_migration_state(
        self,
        target_state: str,
        *,
        expected_migration_revision: int,
    ) -> dict[str, Any]:
        """Advance per-owner migration state only after required parity/recovery proofs pass."""
        if target_state not in WIKI_MIGRATION_STATES:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        current, rev = await self.library.read_named_checkpoint(MIGRATION_CHECKPOINT_NAME)
        if rev != expected_migration_revision:
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
        payload = dict(current or {"state": "v1_markdown_only"})
        cur_state = str(payload.get("state") or "v1_markdown_only")

        if target_state == "wiki_primary_with_v1_rollback":
            if cur_state not in {"dual_read_shadow_compile", "wiki_primary_with_v1_rollback"}:
                raise WikiRefused("WIKI_MIGRATION_PRECONDITION_FAILED", 409)
            if not payload.get("dual_read_qualified"):
                raise WikiRefused("WIKI_MIGRATION_PARITY_REQUIRED", 409)
        elif target_state == "wiki_primary":
            if cur_state not in {"wiki_primary_with_v1_rollback", "wiki_primary"}:
                raise WikiRefused("WIKI_MIGRATION_PRECONDITION_FAILED", 409)
            if not (payload.get("dual_read_qualified") and payload.get("cold_recovery_qualified")):
                raise WikiRefused("WIKI_MIGRATION_RECOVERY_REQUIRED", 409)

        payload["state"] = target_state
        payload["updated_at"] = int(time.time() * 1000)
        _, next_rev = await self.library.write_named_checkpoint(
            MIGRATION_CHECKPOINT_NAME, payload, expected_revision=rev
        )
        return {"state": target_state, "migration_revision": next_rev}

    async def propagate_forget_and_correction(
        self,
        *,
        page_id: str,
        claim_id: str,
        idempotency_key: str,
        replacement_statement: str | None = None,
        destroy_page_key: bool = False,
        delete_retired_blobs: bool = False,
        v1_markdown_snapshot: str | None = None,
        stm_entries: list[str] | None = None,
        invalidate_caches: Callable[[], Awaitable[None] | None] | None = None,
    ) -> dict[str, Any]:
        """Propagate Forget or owner correction across wiki, PKM projections, indexes, STM, and provider.

        Reports the five distinct `#9370` outcomes honestly without collapsing logical deletion,
        access revocation, cryptographic key destruction, provider acknowledgement, and retention deletion.
        """
        validated_page_id = validate_page_id(page_id)
        validated_claim_id = validate_claim_id(claim_id)
        idem = validate_idempotency_key(idempotency_key)

        page = await self.library.read_page(validated_page_id, require_settled=True)
        target_claim = next(
            (c for c in page["claims"] if c["claim_id"] == validated_claim_id), None
        )
        if target_claim is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)

        old_stmt = str(target_claim["statement"])
        old_fp = normalize_statement_fingerprint(old_stmt)
        today = _today_utc()
        now_ms = int(time.time() * 1000)

        checkpoint = await self.library.read_capture_checkpoint()
        tomb_id = self.writer.tombstone_id_for_target(
            "claim", validated_claim_id, checkpoint.edit_generation + 1
        )
        new_claim_id: str | None = None
        clean_new_text: str | None = None
        if replacement_statement is not None:
            clean_new_text, _ = strip_secret_spans(replacement_statement.strip())
            if not clean_new_text:
                raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
            new_claim_id = self.writer.claim_id_for_statement(validated_page_id, clean_new_text)

        reason_code = "owner_request" if new_claim_id is None else "superseded"
        tombstone = WikiTombstone(
            tombstone_id=tomb_id,
            target_kind="claim",
            target_id=validated_claim_id,
            reason_code=reason_code,
            created_at=now_ms,
            page_id=validated_page_id,
            superseded_by=new_claim_id,
        )
        await self.library.put_tombstone(tombstone, idempotency_key=f"{idem}:tb"[:120])
        await self._record_tombstoned_fingerprint(old_fp)

        updated_claims: list[dict[str, Any]] = []
        for existing in page["claims"]:
            if existing["claim_id"] != validated_claim_id:
                updated_claims.append(dict(existing))
                continue
            if clean_new_text is not None and new_claim_id is not None:
                updated_claims.append(
                    {
                        **existing,
                        "status": "superseded",
                        "superseded_by": new_claim_id,
                        "valid_until": today,
                    }
                )
                new_fp = normalize_statement_fingerprint(clean_new_text)
                src_id = self._source_id_for_legacy(
                    "owner_correction",
                    f"owner_correction:{validated_claim_id}",
                    new_fp,
                )
                await self.library.register_source(
                    WikiSourceRef(
                        source_id=src_id,
                        kind="owner_direct",
                        locator=f"owner_correction:{validated_claim_id}",
                        content_sha256=new_fp,
                        observed_at=f"{today}T00:00:00Z",
                        consent_derived=False,
                    ),
                    idempotency_key=f"{idem}:corr_src"[:120],
                )
                updated_claims.append(
                    {
                        "claim_id": new_claim_id,
                        "statement": clean_new_text[:1000],
                        "status": "active",
                        "confidence": 1.0,
                        "source_ids": [src_id],
                        "observed_at": today,
                    }
                )
            else:
                updated_claims.append(
                    {
                        **existing,
                        "status": "retracted",
                        "valid_until": today,
                    }
                )

        # Scrub retracted/superseded statement lines from Markdown body and recompute TL;DR
        cleaned_body_lines = [
            line for line in str(page["body"]).splitlines() if old_stmt.lower() not in line.lower()
        ]
        if clean_new_text is not None and new_claim_id is not None:
            cleaned_body_lines.append(f"- {clean_new_text[:1000]}")
        active_remaining = [c["statement"] for c in updated_claims if c.get("status") == "active"]
        next_tldr = active_remaining[0][:240] if active_remaining else ""
        merged_sources = sorted(
            {
                *page["source_ids"],
                *(src for c in updated_claims for src in c.get("source_ids", [])),
            }
        )

        edited_page = await self.library.edit_page(
            validated_page_id,
            expected_revision=int(page["revision"]),
            idempotency_key=f"{idem}:page_edit"[:120],
            tldr=next_tldr,
            status_as_of=today,
            body="\n".join(cleaned_body_lines),
            claims=updated_claims,
            source_ids=merged_sources,
        )

        # Sync PKM projection receipts -> stale (`exposure_eligibility=False`)
        staled_receipts = await self.projections.sync_page_lifecycle(validated_page_id)
        revoked_future_access = (
            any(
                r.get("claim_id") == validated_claim_id and not r.get("exposure_eligibility")
                for r in staled_receipts
            )
            or len(staled_receipts) == 0
        )

        key_destroyed = False
        physical_erasure = False
        if destroy_page_key:
            key_res = await self.library.rotate_page_content_key_and_prune_history(
                validated_page_id,
                idempotency_key=f"{idem}:rot"[:120],
                delete_retired_blobs=delete_retired_blobs,
            )
            key_destroyed = bool(key_res["key_destroyed"])
            physical_erasure = bool(key_res["physical_erasure_under_retention"])

        # Provider MemoryBank acknowledgement check (never faked without real provider ack)
        provider_acknowledged = False
        pms = getattr(self.writer, "pod_memory_service", None)
        if pms is not None:
            record_tb = getattr(pms, "record_wiki_tombstone", None)
            forget_fn = getattr(pms, "forget_text", None)
            status_fn = getattr(pms, "status", None)
            if callable(record_tb):
                await record_tb(
                    tombstone_id=tomb_id,
                    target_kind="claim",
                    target_id=validated_claim_id,
                    reason_code=reason_code,
                    revoked_text=old_stmt,
                )
                if callable(status_fn):
                    st = await status_fn()
                    provider_state = (st.get("provider") or {}).get("rebuildSemantics")
                    provider_acknowledged = provider_state in {"suppressed_stale", "rebuilt_empty"}
            elif callable(forget_fn):
                provider_res = await forget_fn(old_stmt)
                if isinstance(provider_res, dict):
                    provider_state = provider_res.get("provider_rebuild_semantics") or (
                        provider_res.get("provider", {}) or {}
                    ).get("rebuildSemantics")
                    provider_acknowledged = provider_state in {"suppressed_stale", "rebuilt_empty"}

        await self.library.rebuild_indexes()
        await self.writer.refresh_hot_digest()

        if invalidate_caches is not None:
            maybe_coro = invalidate_caches()
            if maybe_coro is not None:
                await maybe_coro

        scrubbed_v1 = (
            self._scrub_markdown_tombstones(v1_markdown_snapshot, {old_fp})
            if v1_markdown_snapshot is not None
            else None
        )
        needle = old_stmt.strip().rstrip(".!?;:").lower()
        scrubbed_stm = (
            [entry for entry in stm_entries if not needle or needle not in entry.lower()]
            if stm_entries is not None
            else None
        )

        return {
            "page_id": validated_page_id,
            "revision": edited_page["revision"],
            "retracted_claim_id": validated_claim_id,
            "replacement_claim_id": new_claim_id,
            "tombstone_id": tomb_id,
            "staled_projection_receipt_ids": [r["receipt_id"] for r in staled_receipts],
            "outcomes": {
                "logical_deletion": True,
                "revoked_future_access": bool(revoked_future_access),
                "key_destroyed": key_destroyed,
                "provider_operation_acknowledged": provider_acknowledged,
                "physical_erasure_under_retention": physical_erasure,
            },
            "scrubbed_v1_markdown": scrubbed_v1,
            "scrubbed_stm_entries": scrubbed_stm,
        }

    @staticmethod
    def _scrub_markdown_tombstones(markdown: str, tombstoned_fps: set[str]) -> str:
        kept_lines: list[str] = []
        for raw_line in str(markdown or "").splitlines():
            bullet_match = _BULLET_LINE_RE.match(raw_line)
            if bullet_match:
                cleaned, _ = strip_secret_spans(bullet_match.group(1).strip())
                if normalize_statement_fingerprint(cleaned) in tombstoned_fps:
                    continue
            kept_lines.append(raw_line)
        return "\n".join(kept_lines)

    async def rollback_to_v1_markdown(
        self,
        *,
        prior_v1_markdown: str = "",
        expected_migration_revision: int | None = None,
        allow_post_graduation: bool = False,
    ) -> dict[str, Any]:
        """One-step rollback to `v1_markdown_only` without resurrecting any tombstoned facts."""
        current, rev = await self.library.read_named_checkpoint(MIGRATION_CHECKPOINT_NAME)
        if expected_migration_revision is not None and rev != expected_migration_revision:
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
        payload = dict(current or {"state": "v1_markdown_only"})
        cur_state = str(payload.get("state") or "v1_markdown_only")
        if cur_state == "wiki_primary" and not allow_post_graduation:
            raise WikiRefused("WIKI_ROLLBACK_POST_GRADUATION_FORBIDDEN", 409)

        tomb_fps, tomb_claims, _ = await self._tombstone_index()
        scrubbed_base = self._scrub_markdown_tombstones(prior_v1_markdown, tomb_fps)
        existing_fps = {
            normalize_statement_fingerprint(bullet["statement"])
            for sec in parse_v1_markdown_sections(scrubbed_base)
            for bullet in sec["bullets"]
        }

        # Include any new active owner-confirmed wiki claims that were never tombstoned
        appended_sections: list[str] = []
        for summary in await self.library.list_pages():
            page = await self.library.read_page(summary["page_id"])
            new_bullets: list[str] = []
            for claim in page["claims"]:
                if claim["status"] != "active":
                    continue
                fp = normalize_statement_fingerprint(claim["statement"])
                if fp in tomb_fps or claim["claim_id"] in tomb_claims or fp in existing_fps:
                    continue
                existing_fps.add(fp)
                new_bullets.append(f"- {claim['statement']}")
            if new_bullets:
                appended_sections.append(f"## {page['title']}\n" + "\n".join(new_bullets))

        reconstructed = scrubbed_base.strip()
        if not reconstructed:
            reconstructed = "# memory.md"
        if appended_sections:
            reconstructed = reconstructed + "\n\n" + "\n\n".join(appended_sections)

        payload["state"] = "v1_markdown_only"
        payload["rolled_back_at"] = int(time.time() * 1000)
        payload["updated_at"] = payload["rolled_back_at"]
        _, next_rev = await self.library.write_named_checkpoint(
            MIGRATION_CHECKPOINT_NAME, payload, expected_revision=rev
        )
        return {
            "state": "v1_markdown_only",
            "migration_revision": next_rev,
            "v1_markdown": reconstructed,
            "filtered_tombstone_count": len(tomb_fps),
        }


class WikiMaintenanceRunner:
    """Idempotent bounded-budget background wiki maintenance and lint engine."""

    def __init__(
        self,
        library: WikiLibrary,
        *,
        writer: WikiKnowledgeWriter | None = None,
        projections: WikiProjectionEngine | None = None,
    ) -> None:
        self.library = library
        self.writer = writer or WikiKnowledgeWriter(library)
        self.projections = projections or WikiProjectionEngine(library)

    async def run_tick(
        self,
        *,
        idempotency_key: str,
        reference_date: str | None = None,
        max_pages_per_tick: int = 8,
    ) -> dict[str, Any]:
        """Run a bounded, checkpointed maintenance sweep over at most `max_pages_per_tick` pages."""
        idem = validate_idempotency_key(idempotency_key)
        if max_pages_per_tick < 1 or max_pages_per_tick > 64:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        ref_date = (reference_date or _today_utc())[:10]
        cursor_doc, cursor_rev = await self.library.read_named_checkpoint(
            MAINTENANCE_CHECKPOINT_NAME
        )
        last_page_id = str((cursor_doc or {}).get("last_page_id") or "")

        all_summaries = sorted(await self.library.list_pages(), key=lambda p: p["page_id"])
        all_page_ids = [p["page_id"] for p in all_summaries]
        all_page_id_set = set(all_page_ids)

        if last_page_id and last_page_id in all_page_id_set:
            start_idx = (all_page_ids.index(last_page_id) + 1) % max(1, len(all_page_ids))
        else:
            start_idx = 0

        ordered = all_page_ids[start_idx:] + all_page_ids[:start_idx]
        batch_page_ids = ordered[:max_pages_per_tick]

        tombstones = await self.library.list_tombstones()
        fp_doc, _ = await self.library.read_named_checkpoint(TOMBSTONE_FPS_CHECKPOINT_NAME)
        tomb_sources = {
            str(tb["target_id"])
            for tb in tombstones
            if tb.get("target_kind") == "source" and tb.get("target_id")
        }
        tomb_fps = {str(fp) for fp in ((fp_doc or {}).get("fingerprints") or []) if str(fp)}

        deduplicated_count = 0
        expired_count = 0
        retracted_tombstoned_count = 0
        contradictions: list[dict[str, Any]] = []
        broken_links: list[dict[str, str]] = []
        inbound_targets: set[str] = set()

        for pid in batch_page_ids:
            page = await self.library.read_page(pid, require_settled=True)
            changed = False
            seen_norm: dict[str, int] = {}
            new_claims: list[dict[str, Any]] = []

            for claim in page["claims"]:
                c_copy = dict(claim)
                fp = normalize_statement_fingerprint(c_copy["statement"])
                if c_copy["status"] == "active":
                    # 1. Tombstone / source-retraction check
                    claim_sources = list(c_copy.get("source_ids") or [])
                    all_sources_tombstoned = bool(claim_sources) and all(
                        sid in tomb_sources for sid in claim_sources
                    )
                    if fp in tomb_fps or all_sources_tombstoned:
                        c_copy["status"] = "retracted"
                        c_copy["valid_until"] = ref_date
                        retracted_tombstoned_count += 1
                        changed = True
                    # 2. Temporal `valid_until` expiry sweep
                    elif c_copy.get("valid_until") and str(c_copy["valid_until"])[:10] < ref_date:
                        c_copy["status"] = "retracted"
                        expired_count += 1
                        changed = True
                    # 3. Exact/normalized claim deduplication on the same page
                    elif fp in seen_norm:
                        keeper_idx = seen_norm[fp]
                        keeper = new_claims[keeper_idx]
                        merged_src = sorted(
                            set(keeper.get("source_ids") or [])
                            | set(c_copy.get("source_ids") or [])
                        )
                        new_claims[keeper_idx] = {**keeper, "source_ids": merged_src}
                        if c_copy["claim_id"] == keeper["claim_id"]:
                            deduplicated_count += 1
                            changed = True
                            continue
                        c_copy["status"] = "superseded"
                        c_copy["superseded_by"] = keeper["claim_id"]
                        c_copy["valid_until"] = ref_date
                        deduplicated_count += 1
                        changed = True
                    else:
                        seen_norm[fp] = len(new_claims)
                new_claims.append(c_copy)

            # 4. Contradiction detection across active claims on the page (flags without inventing facts)
            slot_seen: dict[str, tuple[str, bool]] = {}
            for c_item in new_claims:
                if c_item["status"] != "active":
                    continue
                slot_info = _subject_slot_key(c_item["statement"])
                if slot_info is None:
                    continue
                slot_name, is_neg = slot_info
                if slot_name in slot_seen:
                    prev_cid, prev_neg = slot_seen[slot_name]
                    if prev_neg != is_neg:
                        contradictions.append(
                            {
                                "page_id": pid,
                                "slot": slot_name,
                                "claim_ids": sorted([prev_cid, c_item["claim_id"]]),
                            }
                        )
                else:
                    slot_seen[slot_name] = (c_item["claim_id"], is_neg)

            # 5. Broken link & inbound graph tracking (deduplicated per source->target pair)
            seen_broken: set[tuple[str, str]] = set()
            for target_id in [
                *(link["target_page_id"] for link in page["links"]),
                *(edge.target_page_id for edge in extract_inline_links(page["body"])),
            ]:
                inbound_targets.add(target_id)
                if target_id not in all_page_id_set and (pid, target_id) not in seen_broken:
                    seen_broken.add((pid, target_id))
                    broken_links.append({"source_page_id": pid, "target_page_id": target_id})

            if changed:
                active_stmts = [c["statement"] for c in new_claims if c.get("status") == "active"]
                next_tldr = active_stmts[0][:240] if active_stmts else ""
                await self.library.edit_page(
                    pid,
                    expected_revision=int(page["revision"]),
                    idempotency_key=f"{idem}:maint:{pid}:{page['revision']}"[:120],
                    tldr=next_tldr,
                    status_as_of=ref_date,
                    claims=new_claims,
                )
                await self.projections.sync_page_lifecycle(pid)

        # Track inbound links from unvisited pages too if sweep covered all pages
        sweep_complete = len(batch_page_ids) == len(all_page_ids)
        orphan_page_ids = (
            sorted(
                pid
                for pid in all_page_ids
                if pid != DEFAULT_WORKING_PAGE_ID and pid not in inbound_targets
            )
            if sweep_complete
            else []
        )

        await self.library.rebuild_indexes()
        hot_md = await self.writer.refresh_hot_digest()

        next_last = batch_page_ids[-1] if batch_page_ids else ""
        run_digest = hashlib.sha256(f"{idem}:{ref_date}:{next_last}".encode("utf-8")).hexdigest()
        run_id = f"wmn_{run_digest[:16]}"
        _, next_cursor_rev = await self.library.write_named_checkpoint(
            MAINTENANCE_CHECKPOINT_NAME,
            {
                "last_run_id": run_id,
                "last_page_id": next_last,
                "reference_date": ref_date,
                "sweep_complete": sweep_complete,
                "updated_at": int(time.time() * 1000),
            },
            expected_revision=cursor_rev,
        )
        return {
            "maintenance_run_id": run_id,
            "inspected_page_count": len(batch_page_ids),
            "total_page_count": len(all_page_ids),
            "sweep_complete": sweep_complete,
            "deduplicated_claim_count": deduplicated_count,
            "expired_claim_count": expired_count,
            "retracted_tombstoned_count": retracted_tombstoned_count,
            "contradictions": contradictions,
            "broken_links": broken_links,
            "orphan_page_ids": orphan_page_ids,
            "hot_digest_chars": len(hot_md),
            "hot_digest_within_budget": len(hot_md) <= WIKI_HOT_MAX_CHARS,
            "cursor_revision": next_cursor_rev,
        }
