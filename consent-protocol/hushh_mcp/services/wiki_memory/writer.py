"""Canonical personal-wiki knowledge writer for opted-in capture and pod review.

Unifies browser consolidation and pod schema-2 fact review into one single-authority
writer over ``WikiLibrary``:
- Explicit opt-in default (``capture_opt_in: False`` until enabled by the owner);
  opt-in authorizes personal-wiki capture ONLY — never connector reads, external
  actions, recipient sharing, or third-party provider processing.
- Immediate withdrawal and epoch/abort fencing on vault lock or owner withdrawal.
- Excludes ``consent_derived``, receipt-private, ``history_*``, and assistant-only
  self-citation turns; strips raw secret/credential spans before hashing or storing.
- Deduplicates across chat switches, restarts, and browser<->pod handoffs via
  ``WikiCaptureCheckpoint``; writes ``wtb_*`` tombstones and notifies any attached
  ``PodMemoryService`` so Vertex ``PodMemoryBank`` suppresses stale recall.
- Maintains bounded ``root/hot.md.enc`` (<= 8,000 chars) from active claims only and
  returns closed ``WikiSaveOutcome`` statuses (``saved | pending | failed | withdrawn | disabled``).
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.consent.secret_patterns import find_secret_spans
from hushh_mcp.services.wiki_memory.contracts import (
    MAX_CLAIM_CHARS,
    WIKI_HOT_MAX_CHARS,
    WIKI_SAVE_OUTCOMES,
    WikiCaptureCheckpoint,
    WikiRefused,
    WikiSourceRef,
    WikiTombstone,
    validate_claim_id,
    validate_page_id,
)
from hushh_mcp.services.wiki_memory.library import WikiLibrary

DEFAULT_WORKING_PAGE_ID = "wpg_0000000000000001"
DEFAULT_WORKING_PAGE_TITLE = "Working Memory"


def strip_secret_spans(text: str) -> tuple[str, int]:
    """Replace all detected credential/secret spans with neutral omission markers."""
    if not text:
        return "", 0
    spans = find_secret_spans(text)
    if not spans:
        return text, 0
    parts: list[str] = []
    cursor = 0
    for span in spans:
        parts.append(text[cursor : span.start])
        parts.append("[credential omitted]")
        cursor = span.end
    parts.append(text[cursor:])
    return "".join(parts), len(spans)


_CREDENTIAL_LABEL_ONLY_RE = (
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
)


def _is_omission_only(text: str) -> bool:
    residual = text.replace("[credential omitted]", "").strip(" \t\r\n.,:;=-")
    if not residual:
        return True
    if residual.lower() in _CREDENTIAL_LABEL_ONLY_RE:
        return True
    return False


def _event_key(conversation_id: str, event_id: str) -> str:
    return json.dumps([conversation_id, event_id], separators=(",", ":"))


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class CaptureEventInput:
    conversation_id: str
    event_id: str
    role: str  # "user" | "assistant"
    content: str
    invocation_id: str = ""
    consent_derived: bool = False
    receipt_private: bool = False
    observed_at: str | None = None


SynthesizerFn = Callable[
    [list[dict[str, Any]], WikiLibrary],
    Awaitable[list[dict[str, Any]]],
]


class WikiKnowledgeWriter:
    """Single canonical writer for personal-wiki capture and pod fact review."""

    def __init__(
        self,
        library: WikiLibrary,
        *,
        pod_memory_service: Any = None,
    ) -> None:
        self.library = library
        self.pod_memory_service = pod_memory_service
        self._abort_epoch = 0
        self._abort_reason: str | None = None

    @staticmethod
    def capture_authority_posture(*, capture_opt_in: bool) -> dict[str, bool]:
        """Prove that capture opt-in grants zero external/connector/provider authority."""
        return {
            "wiki_capture_enabled": bool(capture_opt_in),
            "connector_reads": False,
            "external_actions": False,
            "recipient_sharing": False,
            "provider_processing": False,
        }

    def abort(self, *, reason: str = "vault_locked") -> int:
        """Immediately fence any in-flight consolidation on lock/close or withdrawal."""
        self._abort_epoch += 1
        self._abort_reason = reason
        return self._abort_epoch

    async def set_capture_opt_in(self, enabled: bool) -> dict[str, Any]:
        checkpoint = await self.library.read_capture_checkpoint()
        now_ms = int(time.time() * 1000)
        updated = WikiCaptureCheckpoint(
            capture_opt_in=bool(enabled),
            opt_in_updated_at=now_ms,
            edit_generation=checkpoint.edit_generation + (0 if enabled else 1),
            conversations=dict(checkpoint.conversations),
            withdrawn_conversations=checkpoint.withdrawn_conversations,
            withdrawn_event_keys=checkpoint.withdrawn_event_keys,
            processed_source_ids=checkpoint.processed_source_ids,
            pod_reviewed_through_seq=checkpoint.pod_reviewed_through_seq,
        )
        if not enabled:
            self.abort(reason="withdrawn")
        saved = await self.library.write_capture_checkpoint(updated)
        return {
            "capture_opt_in": saved.capture_opt_in,
            "opt_in_updated_at": saved.opt_in_updated_at,
            "authority": self.capture_authority_posture(capture_opt_in=saved.capture_opt_in),
        }

    def _opaque_hex(self, label: str) -> str:
        digest = hashlib.sha256(f"{self.library.owner}|{label}".encode("utf-8")).hexdigest()
        return digest[:16]

    def source_id_for_event(self, conversation_id: str, event_id: str) -> str:
        return f"wsr_{self._opaque_hex(f'event:{conversation_id}:{event_id}')}"

    def claim_id_for_statement(self, page_id: str, statement: str) -> str:
        return f"wcl_{self._opaque_hex(f'claim:{page_id}:{statement.strip().lower()}')}"

    def tombstone_id_for_target(self, target_kind: str, target_id: str, gen: int) -> str:
        return f"wtb_{self._opaque_hex(f'tb:{target_kind}:{target_id}:{gen}')}"

    async def refresh_hot_digest(self) -> str:
        """Rebuild bounded root/hot.md.enc (<= 8,000 chars) from active, non-tombstoned claims."""
        tombstones = await self.library.list_tombstones()
        dead_claims = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "claim"}
        dead_pages = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "page"}
        dead_sources = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "source"}

        summaries = await self.library.list_pages()
        summaries.sort(key=lambda item: (-int(item["updated_at"]), item["page_id"]))

        header = "# Personal Wiki Hot Digest\n"
        lines: list[str] = [header]
        used = len(header)

        for summary in summaries:
            if summary["page_id"] in dead_pages or summary.get("pending_batch_id"):
                continue
            try:
                page = await self.library.read_page(summary["page_id"], require_settled=True)
            except WikiRefused:
                continue
            active_claims = [
                c
                for c in page["claims"]
                if c["status"] == "active"
                and c["claim_id"] not in dead_claims
                and not any(src in dead_sources for src in c["source_ids"])
            ]
            if (page["claims"] and not active_claims) or (not active_claims and not page["tldr"]):
                continue
            section_lines = [f"\n## {page['title']} ({page['page_id']}@r{page['revision']})"]
            if page["tldr"]:
                section_lines.append(f"- Summary: {page['tldr']}")
            for claim in active_claims[:8]:
                section_lines.append(f"- [{claim['claim_id']}] {claim['statement']}")
            block = "\n".join(section_lines) + "\n"
            if used + len(block) > WIKI_HOT_MAX_CHARS:
                # Fit individual lines if possible without exceeding WIKI_HOT_MAX_CHARS
                for single in section_lines:
                    candidate = single + "\n"
                    if used + len(candidate) <= WIKI_HOT_MAX_CHARS:
                        lines.append(candidate)
                        used += len(candidate)
                    else:
                        break
                break
            lines.append(block)
            used += len(block)

        digest_md = "".join(lines).strip()
        if len(digest_md) > WIKI_HOT_MAX_CHARS:
            digest_md = digest_md[:WIKI_HOT_MAX_CHARS].rstrip()
        await self.library.write_hot_digest(digest_md)
        return digest_md

    async def _emit_tombstone(
        self,
        *,
        target_kind: str,
        target_id: str,
        reason_code: str,
        edit_generation: int,
        page_id: str | None = None,
        superseded_by: str | None = None,
        revoked_text: str = "",
    ) -> str:
        tb_id = self.tombstone_id_for_target(target_kind, target_id, edit_generation)
        now_ms = int(time.time() * 1000)
        tb = WikiTombstone.from_mapping(
            {
                "tombstone_id": tb_id,
                "target_kind": target_kind,
                "target_id": target_id,
                "reason_code": reason_code,
                "created_at": now_ms,
                **({"page_id": page_id} if page_id else {}),
                **({"superseded_by": superseded_by} if superseded_by else {}),
            }
        )
        await self.library.put_tombstone(tb, idempotency_key=f"tb:{tb_id}")
        if self.pod_memory_service is not None and hasattr(
            self.pod_memory_service, "record_wiki_tombstone"
        ):
            await self.pod_memory_service.record_wiki_tombstone(
                tombstone_id=tb_id,
                target_kind=target_kind,
                target_id=target_id,
                reason_code=reason_code,
                revoked_text=revoked_text,
            )
        return tb_id

    async def withdraw_capture(
        self,
        *,
        conversation_id: str | None = None,
        event_keys: tuple[str, ...] | list[str] = (),
        claim_ids: tuple[str, ...] | list[str] = (),
        disable_opt_in: bool = False,
    ) -> dict[str, Any]:
        """Withdraw opted-in capture for a conversation, specific events, or claims."""
        self.abort(reason="withdrawn")
        checkpoint = await self.library.read_capture_checkpoint()
        next_gen = checkpoint.edit_generation + 1
        now_ms = int(time.time() * 1000)

        withdrawn_convs = list(checkpoint.withdrawn_conversations)
        if conversation_id and conversation_id not in withdrawn_convs:
            withdrawn_convs.append(conversation_id)
        withdrawn_keys = list(checkpoint.withdrawn_event_keys)
        for key in event_keys:
            if key and key not in withdrawn_keys:
                withdrawn_keys.append(key)

        target_source_ids: set[str] = set()
        if conversation_id:
            for msg_id in checkpoint.conversations.get(conversation_id, ()):
                target_source_ids.add(self.source_id_for_event(conversation_id, msg_id))
        for raw_key in event_keys:
            try:
                parsed = json.loads(raw_key)
                if isinstance(parsed, list) and len(parsed) == 2:
                    target_source_ids.add(self.source_id_for_event(str(parsed[0]), str(parsed[1])))
            except ValueError:
                continue

        validated_claims = {validate_claim_id(cid) for cid in claim_ids}
        tombstone_ids: list[str] = []

        for src_id in sorted(target_source_ids):
            tb_id = await self._emit_tombstone(
                target_kind="source",
                target_id=src_id,
                reason_code="capture_withdrawn",
                edit_generation=next_gen,
            )
            tombstone_ids.append(tb_id)

        if conversation_id:
            tb_id = await self._emit_tombstone(
                target_kind="capture_conversation",
                target_id=conversation_id,
                reason_code="capture_withdrawn",
                edit_generation=next_gen,
            )
            tombstone_ids.append(tb_id)

        # Retract matching claims on live wiki pages so projections & recall turn stale.
        for summary in await self.library.list_pages():
            page = await self.library.read_page(summary["page_id"], require_settled=True)
            changed = False
            updated_claims: list[dict[str, Any]] = []
            for claim in page["claims"]:
                matches_claim = claim["claim_id"] in validated_claims
                matches_source = bool(target_source_ids.intersection(claim["source_ids"]))
                if (matches_claim or matches_source) and claim["status"] != "retracted":
                    changed = True
                    updated_claims.append({**claim, "status": "retracted"})
                    tb_id = await self._emit_tombstone(
                        target_kind="claim",
                        target_id=claim["claim_id"],
                        reason_code="capture_withdrawn",
                        edit_generation=next_gen,
                        page_id=page["page_id"],
                        revoked_text=claim["statement"],
                    )
                    tombstone_ids.append(tb_id)
                else:
                    updated_claims.append(claim)
            if changed:
                remaining_active = [
                    c["statement"] for c in updated_claims if c["status"] == "active"
                ]
                next_tldr = remaining_active[-1][:280] if remaining_active else ""
                await self.library.edit_page(
                    page["page_id"],
                    expected_revision=page["revision"],
                    idempotency_key=f"withdraw:{page['page_id']}:g{next_gen}",
                    tldr=next_tldr,
                    claims=updated_claims,
                )

        updated_checkpoint = WikiCaptureCheckpoint(
            capture_opt_in=False if disable_opt_in else checkpoint.capture_opt_in,
            opt_in_updated_at=now_ms if disable_opt_in else checkpoint.opt_in_updated_at,
            edit_generation=next_gen,
            conversations=dict(checkpoint.conversations),
            withdrawn_conversations=tuple(withdrawn_convs),
            withdrawn_event_keys=tuple(withdrawn_keys),
            processed_source_ids=checkpoint.processed_source_ids,
            pod_reviewed_through_seq=checkpoint.pod_reviewed_through_seq,
        )
        await self.library.write_capture_checkpoint(updated_checkpoint)
        await self.refresh_hot_digest()
        return {
            "status": "withdrawn",
            "tombstone_ids": tombstone_ids,
            "edit_generation": next_gen,
            "capture_opt_in": updated_checkpoint.capture_opt_in,
        }

    async def capture_events(
        self,
        events: list[CaptureEventInput | dict[str, Any]],
        *,
        tagged_invocations: set[str] | frozenset[str] = frozenset(),
        receipt_private_invocations: set[str] | frozenset[str] = frozenset(),
        target_page_id: str = DEFAULT_WORKING_PAGE_ID,
        target_page_title: str = DEFAULT_WORKING_PAGE_TITLE,
        target_folder: str = "root",
        synthesizer: SynthesizerFn | None = None,
    ) -> dict[str, Any]:
        """Consolidate eligible conversation events into personal-wiki pages and claims."""
        start_epoch = self._abort_epoch
        checkpoint = await self.library.read_capture_checkpoint()
        if not checkpoint.capture_opt_in:
            return {
                "status": "disabled",
                "saved_page_ids": [],
                "saved_claim_ids": [],
                "skipped_reasons": {"opt_in_disabled": len(events)},
            }

        parsed_events: list[CaptureEventInput] = [
            ev
            if isinstance(ev, CaptureEventInput)
            else CaptureEventInput(
                conversation_id=str(ev.get("conversation_id") or ""),
                event_id=str(ev.get("event_id") or ev.get("id") or ""),
                role=str(ev.get("role") or "user"),
                content=str(ev.get("content") or ""),
                invocation_id=str(ev.get("invocation_id") or ""),
                consent_derived=bool(ev.get("consent_derived", False)),
                receipt_private=bool(ev.get("receipt_private", False)),
                observed_at=ev.get("observed_at"),
            )
            for ev in events
        ]

        skipped: dict[str, int] = {}

        def _bump(reason: str) -> None:
            skipped[reason] = skipped.get(reason, 0) + 1

        preliminary: list[tuple[CaptureEventInput, str, str]] = []
        withdrawn_convs = set(checkpoint.withdrawn_conversations)
        withdrawn_keys = set(checkpoint.withdrawn_event_keys)
        processed_sources = set(checkpoint.processed_source_ids)

        for ev in parsed_events:
            if not ev.conversation_id or not ev.event_id:
                _bump("invalid_event")
                continue
            if (
                ev.conversation_id in withdrawn_convs
                or _event_key(ev.conversation_id, ev.event_id) in withdrawn_keys
            ):
                _bump("withdrawn")
                continue
            if ev.consent_derived or (ev.invocation_id and ev.invocation_id in tagged_invocations):
                _bump("consent_derived")
                continue
            if ev.receipt_private or (
                ev.invocation_id and ev.invocation_id in receipt_private_invocations
            ):
                _bump("receipt_private")
                continue
            if ev.invocation_id.startswith("history_"):
                _bump("seeded_history")
                continue
            src_id = self.source_id_for_event(ev.conversation_id, ev.event_id)
            if (
                ev.event_id in checkpoint.conversations.get(ev.conversation_id, ())
                or src_id in processed_sources
            ):
                _bump("duplicate")
                continue
            scrubbed, _ = strip_secret_spans(ev.content)
            if _is_omission_only(scrubbed):
                _bump("credential_only")
                continue
            preliminary.append((ev, src_id, scrubbed.strip()))

        # Anti-self-citation rule: assistant turns cannot become wiki claims unless at least
        # one eligible owner ("user") turn anchors the batch.
        has_owner_source = any(ev.role == "user" for ev, _, _ in preliminary)
        eligible: list[tuple[CaptureEventInput, str, str]] = []
        for ev, src_id, scrubbed in preliminary:
            if ev.role != "user" and not has_owner_source:
                _bump("assistant_self_citation")
                continue
            eligible.append((ev, src_id, scrubbed))

        if not eligible:
            status = "withdrawn" if skipped.get("withdrawn") and len(skipped) == 1 else "saved"
            return {
                "status": status,
                "saved_page_ids": [],
                "saved_claim_ids": [],
                "skipped_reasons": skipped,
            }

        if self._abort_epoch != start_epoch:
            return self._aborted_outcome()

        try:
            today = _today_utc()
            registered_sources: list[dict[str, Any]] = []
            for ev, src_id, scrubbed in eligible:
                if self._abort_epoch != start_epoch:
                    return self._aborted_outcome()
                obs_date = ev.observed_at or today
                digest = hashlib.sha256(scrubbed.encode("utf-8")).hexdigest()
                source = WikiSourceRef(
                    source_id=src_id,
                    kind="chat_turn",
                    locator=f"chat:{ev.conversation_id}/{ev.event_id}",
                    content_sha256=digest,
                    observed_at=obs_date,
                    consent_derived=False,
                )
                stored_src = await self.library.register_source(
                    source, idempotency_key=f"src:{src_id}"
                )
                registered_sources.append(
                    {
                        "event": ev,
                        "source": stored_src,
                        "scrubbed_text": scrubbed,
                    }
                )

            if synthesizer is not None:
                batch_items = await synthesizer(registered_sources, self.library)
            else:
                batch_items = await self._default_batch_items(
                    registered_sources,
                    page_id=validate_page_id(target_page_id),
                    title=target_page_title,
                    folder=target_folder,
                )

            if self._abort_epoch != start_epoch:
                return self._aborted_outcome()

            saved_page_ids: list[str] = []
            saved_claim_ids: list[str] = []
            if batch_items:
                idem_seed = "|".join(item["source"]["source_id"] for item in registered_sources)
                batch_idem = f"cap:{hashlib.sha256(idem_seed.encode('utf-8')).hexdigest()[:24]}"
                receipt = await self.library.commit_synthesis_batch(
                    items=batch_items,
                    idempotency_key=batch_idem,
                )
                if receipt.get("state") != "finalized":
                    return {
                        "status": "pending",
                        "batch_id": receipt.get("batch_id"),
                        "saved_page_ids": [],
                        "saved_claim_ids": [],
                        "skipped_reasons": skipped,
                    }
                for spec in batch_items:
                    pid = spec["page_id"]
                    saved_page_ids.append(pid)
                    for cl in spec.get("claims", ()):
                        if cl.get("status", "active") == "active":
                            saved_claim_ids.append(cl["claim_id"])

            latest_cp = await self.library.read_capture_checkpoint()
            if (
                latest_cp.edit_generation != checkpoint.edit_generation
                or not latest_cp.capture_opt_in
            ):
                return {
                    "status": "withdrawn",
                    "saved_page_ids": [],
                    "saved_claim_ids": [],
                    "skipped_reasons": skipped,
                }

            conv_map = {k: list(v) for k, v in latest_cp.conversations.items()}
            proc_list = list(latest_cp.processed_source_ids)
            for item in registered_sources:
                ev = item["event"]
                src_id = item["source"]["source_id"]
                conv_msgs = conv_map.setdefault(ev.conversation_id, [])
                if ev.event_id not in conv_msgs:
                    conv_msgs.append(ev.event_id)
                if src_id not in proc_list:
                    proc_list.append(src_id)

            await self.library.write_capture_checkpoint(
                WikiCaptureCheckpoint(
                    capture_opt_in=latest_cp.capture_opt_in,
                    opt_in_updated_at=latest_cp.opt_in_updated_at,
                    edit_generation=latest_cp.edit_generation,
                    conversations={k: tuple(v) for k, v in conv_map.items()},
                    withdrawn_conversations=latest_cp.withdrawn_conversations,
                    withdrawn_event_keys=latest_cp.withdrawn_event_keys,
                    processed_source_ids=tuple(proc_list),
                    pod_reviewed_through_seq=latest_cp.pod_reviewed_through_seq,
                )
            )
            await self.refresh_hot_digest()
            return {
                "status": "saved",
                "saved_page_ids": saved_page_ids,
                "saved_claim_ids": saved_claim_ids,
                "skipped_reasons": skipped,
            }
        except WikiRefused as exc:
            if exc.code == "WIKI_BATCH_INCOMPLETE":
                return {
                    "status": "pending",
                    "code": exc.code,
                    "saved_page_ids": [],
                    "saved_claim_ids": [],
                    "skipped_reasons": skipped,
                }
            return {
                "status": "failed",
                "code": exc.code,
                "saved_page_ids": [],
                "saved_claim_ids": [],
                "skipped_reasons": skipped,
            }

    async def capture_pod_review(
        self,
        *,
        operations: list[dict[str, Any]],
        through_seq: int,
        page_id: str = DEFAULT_WORKING_PAGE_ID,
        page_title: str = DEFAULT_WORKING_PAGE_TITLE,
    ) -> dict[str, Any]:
        """Apply pod schema-2 fact review operations (remember/supersede/retract) to the canonical wiki."""
        checkpoint = await self.library.read_capture_checkpoint()
        if not checkpoint.capture_opt_in:
            return {"status": "disabled", "saved_page_ids": [], "saved_claim_ids": []}
        if through_seq <= checkpoint.pod_reviewed_through_seq:
            return {"status": "saved", "saved_page_ids": [], "saved_claim_ids": [], "deduped": True}

        validated_page_id = validate_page_id(page_id)
        try:
            existing_page = await self.library.read_page(validated_page_id, require_settled=True)
            expected_rev = int(existing_page["revision"])
            claims_by_id: dict[str, dict[str, Any]] = {
                c["claim_id"]: dict(c) for c in existing_page["claims"]
            }
            body = existing_page["body"]
            source_ids = list(existing_page["source_ids"])
        except WikiRefused as exc:
            if exc.code != "WIKI_NOT_FOUND":
                return {
                    "status": "failed",
                    "code": exc.code,
                    "saved_page_ids": [],
                    "saved_claim_ids": [],
                }
            expected_rev = 0
            claims_by_id = {}
            body = ""
            source_ids = []

        today = _today_utc()
        src_id = f"wsr_{self._opaque_hex(f'pod_review:{through_seq}')}"
        src_digest = hashlib.sha256(f"pod_review:{through_seq}".encode("utf-8")).hexdigest()
        await self.library.register_source(
            WikiSourceRef(
                source_id=src_id,
                kind="chat_turn",
                locator=f"pod:review_seq/{through_seq}",
                content_sha256=src_digest,
                observed_at=today,
                consent_derived=False,
            ),
            idempotency_key=f"pod_src:{through_seq}",
        )
        if src_id not in source_ids:
            source_ids.append(src_id)

        saved_claim_ids: list[str] = []
        pending_tombstones: list[dict[str, Any]] = []

        for op in operations:
            kind = str(op.get("op") or "").strip().lower()
            raw_statement = str(op.get("statement") or op.get("text") or "").strip()
            scrubbed, _ = strip_secret_spans(raw_statement)
            clean_stmt = scrubbed.strip()[:MAX_CLAIM_CHARS]

            if kind == "remember":
                if not clean_stmt or _is_omission_only(clean_stmt):
                    continue
                cid = (
                    validate_claim_id(op["claim_id"])
                    if op.get("claim_id")
                    else self.claim_id_for_statement(validated_page_id, clean_stmt)
                )
                claims_by_id[cid] = {
                    "claim_id": cid,
                    "statement": clean_stmt,
                    "status": "active",
                    "confidence": float(op.get("confidence", 0.95)),
                    "source_ids": [src_id],
                    "observed_at": today,
                }
                saved_claim_ids.append(cid)
            elif kind == "supersede":
                old_cid = validate_claim_id(op.get("old_claim_id"))
                if not clean_stmt or _is_omission_only(clean_stmt) or old_cid not in claims_by_id:
                    continue
                new_cid = (
                    validate_claim_id(op["new_claim_id"])
                    if op.get("new_claim_id")
                    else self.claim_id_for_statement(validated_page_id, clean_stmt)
                )
                old_entry = claims_by_id[old_cid]
                claims_by_id[old_cid] = {
                    **old_entry,
                    "status": "superseded",
                    "superseded_by": new_cid,
                }
                claims_by_id[new_cid] = {
                    "claim_id": new_cid,
                    "statement": clean_stmt,
                    "status": "active",
                    "confidence": float(op.get("confidence", 0.95)),
                    "source_ids": [src_id],
                    "observed_at": today,
                }
                saved_claim_ids.append(new_cid)
                pending_tombstones.append(
                    {
                        "claim_id": old_cid,
                        "reason_code": "superseded",
                        "superseded_by": new_cid,
                        "revoked_text": old_entry["statement"],
                    }
                )
            elif kind in {"retract", "forget", "revoke"}:
                target_cid = validate_claim_id(op.get("claim_id"))
                if target_cid not in claims_by_id:
                    continue
                old_entry = claims_by_id[target_cid]
                claims_by_id[target_cid] = {**old_entry, "status": "retracted"}
                pending_tombstones.append(
                    {
                        "claim_id": target_cid,
                        "reason_code": "retracted",
                        "superseded_by": None,
                        "revoked_text": old_entry["statement"],
                    }
                )

        active_statements = [
            c["statement"] for c in claims_by_id.values() if c["status"] == "active"
        ]
        tldr = active_statements[0][:280] if active_statements else ""
        receipt = await self.library.commit_synthesis_batch(
            items=[
                {
                    "page_id": validated_page_id,
                    "expected_revision": expected_rev,
                    "title": page_title,
                    "folder": "root",
                    "tldr": tldr,
                    "status_as_of": today,
                    "body": body or "Consolidated owner preferences and durable context.",
                    "claims": list(claims_by_id.values()),
                    "source_ids": source_ids,
                }
            ],
            idempotency_key=f"pod_review_batch:{through_seq}",
        )
        if receipt.get("state") != "finalized":
            return {"status": "pending", "saved_page_ids": [], "saved_claim_ids": []}

        next_gen = checkpoint.edit_generation + (1 if pending_tombstones else 0)
        for tb_spec in pending_tombstones:
            await self._emit_tombstone(
                target_kind="claim",
                target_id=tb_spec["claim_id"],
                reason_code=tb_spec["reason_code"],
                edit_generation=next_gen,
                page_id=validated_page_id,
                superseded_by=tb_spec["superseded_by"],
                revoked_text=tb_spec["revoked_text"],
            )

        proc_sources = list(checkpoint.processed_source_ids)
        if src_id not in proc_sources:
            proc_sources.append(src_id)
        await self.library.write_capture_checkpoint(
            WikiCaptureCheckpoint(
                capture_opt_in=checkpoint.capture_opt_in,
                opt_in_updated_at=checkpoint.opt_in_updated_at,
                edit_generation=next_gen,
                conversations=dict(checkpoint.conversations),
                withdrawn_conversations=checkpoint.withdrawn_conversations,
                withdrawn_event_keys=checkpoint.withdrawn_event_keys,
                processed_source_ids=tuple(proc_sources),
                pod_reviewed_through_seq=max(checkpoint.pod_reviewed_through_seq, through_seq),
            )
        )
        await self.refresh_hot_digest()
        return {
            "status": "saved",
            "saved_page_ids": [validated_page_id],
            "saved_claim_ids": saved_claim_ids,
        }

    async def _default_batch_items(
        self,
        registered_sources: list[dict[str, Any]],
        *,
        page_id: str,
        title: str,
        folder: str,
    ) -> list[dict[str, Any]]:
        today = _today_utc()
        try:
            existing = await self.library.read_page(page_id, require_settled=True)
            expected_rev = int(existing["revision"])
            claims_by_id: dict[str, dict[str, Any]] = {
                c["claim_id"]: dict(c) for c in existing["claims"]
            }
            source_ids = list(existing["source_ids"])
            body = existing["body"]
        except WikiRefused as exc:
            if exc.code != "WIKI_NOT_FOUND":
                raise
            expected_rev = 0
            claims_by_id = {}
            source_ids = []
            body = ""

        for item in registered_sources:
            ev: CaptureEventInput = item["event"]
            if ev.role != "user":
                continue
            stmt = item["scrubbed_text"][:MAX_CLAIM_CHARS].strip()
            if not stmt:
                continue
            src_id = item["source"]["source_id"]
            if src_id not in source_ids:
                source_ids.append(src_id)
            cid = self.claim_id_for_statement(page_id, stmt)
            existing_claim = claims_by_id.get(cid)
            merged_sources = list(
                dict.fromkeys([*(existing_claim["source_ids"] if existing_claim else []), src_id])
            )
            claims_by_id[cid] = {
                "claim_id": cid,
                "statement": stmt,
                "status": "active",
                "confidence": 1.0,
                "source_ids": merged_sources,
                "observed_at": ev.observed_at or today,
            }

        if not claims_by_id:
            return []
        active = [c["statement"] for c in claims_by_id.values() if c["status"] == "active"]
        tldr = active[-1][:280] if active else title
        return [
            {
                "page_id": page_id,
                "expected_revision": expected_rev,
                "title": title,
                "folder": folder,
                "tldr": tldr,
                "status_as_of": today,
                "body": body or "Owner opted-in working notes and cited statements.",
                "claims": list(claims_by_id.values()),
                "source_ids": source_ids,
            }
        ]

    def _aborted_outcome(self) -> dict[str, Any]:
        status = "withdrawn" if self._abort_reason == "withdrawn" else "pending"
        if status not in WIKI_SAVE_OUTCOMES:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        return {
            "status": status,
            "reason": self._abort_reason or "aborted",
            "saved_page_ids": [],
            "saved_claim_ids": [],
            "skipped_reasons": {},
        }
