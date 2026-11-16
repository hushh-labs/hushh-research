"""Revision-bound PKM projections, specialist disagreement checks, and consent anti-broadening.

Phase 3 invariants:
1. Only settled, active, non-``consent_derived``, non-tombstoned ``WikiClaim``s with at least
   one verified ``WikiSourceRef`` can seed a PKM projection receipt (``wpr_<16hex>``).
2. Arbitrary wiki folders are NEVER implicitly converted to ``attr.<folder>.*`` scopes, and
   ``NON_EXTERNALIZABLE_WIKI_DOMAINS`` (``one_memory``, ``secrets``, ``financial``,
   ``identity``, ``consent``, ``kyc_*``, etc.) are refused with ``WIKI_PROJECTION_DOMAIN_FORBIDDEN``.
3. Authoritative typed specialists (Finance / Plaid, KYC / ``identity``, active ``consent``)
   remain the system of record: conflicting wiki claims transition the projection receipt to
   ``state="conflicted"`` (``exposure_eligibility=False``) with value-free
   ``specialist_disagreement`` metadata instead of overwriting specialist branches.
4. Anti-broadening fence: whenever ``active_recipient_count > 0`` covers the target scope or
   domain wildcard, newly derived or expanded wiki leaves stay in ``state="private_candidate"``
   (``exposure_eligibility=False``) until explicit owner confirmation.
5. Claim deletion, retraction, supersession, page move/trash, or ``wtb_*`` tombstones
   immediately transition receipts to ``state="stale"`` (``exposure_eligibility=False``) at
   monotonic ``(page_revision, source_revision)`` so out-of-order stale retries fail closed.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from hushh_mcp.services.wiki_memory.contracts import (
    NON_REQUESTABLE_PROJECTION_STATES,
    WIKI_PROJECTION_STATES,
    WikiProjectionReceipt,
    WikiRefused,
    validate_claim_id,
    validate_idempotency_key,
    validate_page_id,
    validate_projection_domain,
    validate_projection_json_path,
    validate_projection_receipt_id,
)
from hushh_mcp.services.wiki_memory.library import WikiLibrary

WIKI_CLAIM_PROJECTION_PROFILE = "wiki_claim_projection_v1"
WIKI_CLAIM_PROJECTION_MAX_ITEMS = 64
WIKI_CLAIM_PROJECTION_MAX_ITEM_CHARS = 1_000
WIKI_CLAIM_PROJECTION_MAX_TOTAL_CHARS = 24_000

_SPECIALIST_AUTHORITIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("financial", ("financial", "finance", "plaid", "portfolio", "bank_accounts")),
    ("identity", ("identity", "kyc", "kyc_identity", "verified_identity")),
    ("consent", ("consent", "active_grants", "scopes")),
)


_SKIPPED_BOOKKEEPING_KEYS: frozenset[str] = frozenset(
    {
        "_wiki_projections",
        "superseded",
        "source_receipts",
        "created_at",
        "updated_at",
        "observed_at",
        "last_updated_at",
    }
)


def _normalize_scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list, tuple, set)):
        return ""
    return str(value).strip().lower()


def _flatten_scalar_leaves(
    node: Any,
    prefix: str = "",
    *,
    max_depth: int = 8,
) -> list[tuple[str, str]]:
    if max_depth < 0 or not isinstance(node, dict):
        return []
    leaves: list[tuple[str, str]] = []
    for raw_key, child in node.items():
        key = str(raw_key).strip().lower()
        if not key or key.startswith("_") or key in _SKIPPED_BOOKKEEPING_KEYS:
            continue
        full_path = f"{prefix}.{key}" if prefix else key
        if isinstance(child, dict):
            leaves.extend(_flatten_scalar_leaves(child, full_path, max_depth=max_depth - 1))
        elif isinstance(child, list):
            if child and all(not isinstance(item, (dict, list)) for item in child):
                joined = ", ".join(norm for item in child if (norm := _normalize_scalar(item)))
                if joined:
                    leaves.append((full_path, joined))
        else:
            norm = _normalize_scalar(child)
            if norm:
                leaves.append((full_path, norm))
    return leaves


def _get_nested_leaf(domain_data: dict[str, Any], json_path: str) -> Any:
    current: Any = domain_data
    for segment in json_path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return None
        current = current[segment]
    return current


def detect_existing_domain_conflict(
    *,
    claim_statement: str,
    target_domain: str,
    json_path: str,
    claim_id: str | None = None,
    proposed_value: Any = None,
    existing_domain_data: dict[str, Any] | None = None,
) -> dict[str, str] | None:
    """Protect pre-existing non-wiki PKM domain leaves from silent overwrite."""
    if not isinstance(existing_domain_data, dict) or not existing_domain_data:
        return None
    existing_val = _get_nested_leaf(existing_domain_data, json_path)
    if existing_val is None:
        return None

    provenance_map = existing_domain_data.get("_wiki_projections")
    provenance = provenance_map.get(json_path) if isinstance(provenance_map, dict) else None
    if isinstance(provenance, dict) and provenance.get("receipt_id"):
        # Owned by an earlier Personal Wiki projection (not a pre-existing structured PKM field).
        return None

    norm_existing = _normalize_scalar(existing_val)
    if isinstance(existing_val, (dict, list)) and existing_val:
        return {
            "authority": target_domain,
            "reason": "existing_pkm_structure_conflict",
            "path": f"{target_domain}.{json_path}"[:128],
        }
    if not norm_existing:
        return None
    norm_proposed = _normalize_scalar(proposed_value)
    stmt_lower = claim_statement.strip().lower()
    if norm_proposed:
        if norm_proposed != norm_existing:
            return {
                "authority": target_domain,
                "reason": "existing_pkm_value_conflict",
                "path": f"{target_domain}.{json_path}"[:128],
            }
        return None
    if norm_existing != stmt_lower and norm_existing not in stmt_lower:
        return {
            "authority": target_domain,
            "reason": "existing_pkm_value_conflict",
            "path": f"{target_domain}.{json_path}"[:128],
        }
    return None


def detect_specialist_disagreement(
    *,
    claim_statement: str,
    target_domain: str,
    json_path: str,
    proposed_value: Any = None,
    specialist_snapshot: dict[str, Any] | None = None,
) -> dict[str, str] | None:
    """Detect conflicts against authoritative Finance, KYC/identity, or Consent records.

    Returns value-free metadata ``{"authority", "reason", "path"}`` without leaking
    authoritative specialist values into receipts or logs.
    """
    if not isinstance(specialist_snapshot, dict) or not specialist_snapshot:
        return None

    norm_target_path = json_path.strip().lower()
    leaf_key = norm_target_path.split(".")[-1].strip().lower()
    stmt_lower = claim_statement.strip().lower()
    norm_proposed = _normalize_scalar(proposed_value)

    for canonical_authority, aliases in _SPECIALIST_AUTHORITIES:
        branch: dict[str, Any] | None = None
        for alias in aliases:
            candidate = specialist_snapshot.get(alias)
            if isinstance(candidate, dict):
                branch = candidate
                break
        if not branch:
            continue

        # Direct path, suffix, or leaf-key overlap against nested authoritative specialist records
        for norm_spec_key, norm_spec_val in _flatten_scalar_leaves(branch):
            key_leaf = norm_spec_key.split(".")[-1]
            same_slot = (
                norm_spec_key == norm_target_path
                or norm_spec_key.endswith(f".{norm_target_path}")
                or (key_leaf and key_leaf == leaf_key)
            )
            if same_slot:
                if norm_proposed and norm_proposed != norm_spec_val:
                    return {
                        "authority": canonical_authority,
                        "reason": "authoritative_value_mismatch",
                        "path": f"{canonical_authority}.{norm_spec_key}"[:128],
                    }
                if not norm_proposed and norm_spec_val not in stmt_lower:
                    return {
                        "authority": canonical_authority,
                        "reason": "claim_contradicts_specialist",
                        "path": f"{canonical_authority}.{norm_spec_key}"[:128],
                    }
    return None


def resolve_top_level_projection_state(leaf_states: list[str]) -> tuple[str, int]:
    """Summarize leaf projection states for a top-level scope without coercing to ``unknown``."""
    if not leaf_states:
        return "empty", 0
    materialized_count = sum(1 for st in leaf_states if st == "materialized")
    if materialized_count > 0:
        return "materialized", materialized_count
    for priority in (
        "conflicted",
        "private_candidate",
        "stale",
        "pending",
        "failed",
        "empty",
        "unknown",
    ):
        if priority in leaf_states:
            return priority, 0
    return "empty", 0


class WikiProjectionEngine:
    """Deterministic revision-bound PKM projection coordinator over ``WikiLibrary``."""

    def __init__(self, library: WikiLibrary) -> None:
        self.library = library

    def receipt_id_for_slot(self, domain: str, json_path: str, claim_id: str) -> str:
        clean_domain = validate_projection_domain(domain)
        clean_path = validate_projection_json_path(json_path)
        clean_claim = validate_claim_id(claim_id)
        digest = hashlib.sha256(
            f"{self.library.owner}|proj|{clean_domain}|{clean_path}|{clean_claim}".encode("utf-8")
        ).hexdigest()
        return f"wpr_{digest[:16]}"

    async def derive_projection(
        self,
        *,
        page_id: str,
        claim_id: str,
        target_domain: str | None,
        json_path: str | None,
        idempotency_key: str,
        active_recipient_count: int = 0,
        owner_confirmed: bool = False,
        require_owner_confirmation: bool = False,
        proposed_value: Any = None,
        specialist_snapshot: dict[str, Any] | None = None,
        existing_domain_data: dict[str, Any] | None = None,
        source_revision: int = 1,
    ) -> dict[str, Any]:
        """Derive or update a revision-bound PKM projection receipt for one wiki claim."""
        validate_idempotency_key(idempotency_key)
        if not target_domain or not json_path:
            # Never synthesize attr.<folder>.* implicitly from wiki folder hierarchy.
            raise WikiRefused("WIKI_PROJECTION_MAPPING_REQUIRED", 400)
        domain = validate_projection_domain(target_domain)
        path = validate_projection_json_path(json_path)
        validated_page_id = validate_page_id(page_id)
        validated_claim_id = validate_claim_id(claim_id)
        if type(active_recipient_count) is not int or active_recipient_count < 0:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        if type(source_revision) is not int or source_revision < 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        receipt_id = self.receipt_id_for_slot(domain, path, validated_claim_id)
        now_ms = int(time.time() * 1000)
        tombstones = await self.library.list_tombstones()

        try:
            page = await self.library.read_page(validated_page_id, require_settled=True)
        except WikiRefused as exc:
            if exc.code == "WIKI_BATCH_INCOMPLETE":
                pending_receipt = WikiProjectionReceipt(
                    receipt_id=receipt_id,
                    domain=domain,
                    json_path=path,
                    page_id=validated_page_id,
                    page_revision=1,
                    claim_id=validated_claim_id,
                    source_ids=(),
                    source_revision=source_revision,
                    state="pending",
                    exposure_eligibility=False,
                    updated_at=now_ms,
                )
                return dict(
                    await self.library.put_projection_receipt(
                        pending_receipt, idempotency_key=idempotency_key
                    )
                )
            raise

        page_rev = int(page["revision"])
        claim = next(
            (c for c in page["claims"] if c["claim_id"] == validated_claim_id),
            None,
        )
        if claim is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)

        claim_tb = next(
            (
                tb
                for tb in reversed(tombstones)
                if tb["target_kind"] == "claim" and tb["target_id"] == validated_claim_id
            ),
            None,
        )
        page_tb = next(
            (
                tb
                for tb in reversed(tombstones)
                if tb["target_kind"] == "page" and tb["target_id"] == validated_page_id
            ),
            None,
        )
        raw_source_ids = list(claim.get("source_ids") or ())
        if not raw_source_ids:
            raise WikiRefused("WIKI_PROJECTION_UNVERIFIED_SOURCE", 400)

        source_tb = next(
            (
                tb
                for tb in reversed(tombstones)
                if tb["target_kind"] == "source" and tb["target_id"] in raw_source_ids
            ),
            None,
        )
        verified_sources: list[str] = []
        for src_id in raw_source_ids:
            src = await self.library.get_source(src_id)
            if src.get("consent_derived") is True:
                raise WikiRefused("WIKI_SOURCE_INELIGIBLE", 403)
            verified_sources.append(src["source_id"])

        effective_tb = claim_tb or page_tb or source_tb
        disagreement: dict[str, Any] | None = None

        if effective_tb is not None or claim["status"] in {"retracted", "superseded"}:
            state = "stale"
        elif claim["status"] == "uncertain" or any(
            edge.get("relation") == "contradicts"
            and edge.get("anchor_claim_id") == validated_claim_id
            for edge in page.get("links", ())
        ):
            state = "conflicted"
        else:
            disagreement = detect_specialist_disagreement(
                claim_statement=claim["statement"],
                target_domain=domain,
                json_path=path,
                proposed_value=proposed_value,
                specialist_snapshot=specialist_snapshot,
            ) or detect_existing_domain_conflict(
                claim_statement=claim["statement"],
                target_domain=domain,
                json_path=path,
                claim_id=validated_claim_id,
                proposed_value=proposed_value,
                existing_domain_data=existing_domain_data,
            )
            if disagreement is not None:
                state = "conflicted"
            elif (active_recipient_count > 0 or require_owner_confirmation) and not owner_confirmed:
                state = "private_candidate"
            else:
                state = "materialized"

        if state not in WIKI_PROJECTION_STATES:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        receipt = WikiProjectionReceipt(
            receipt_id=receipt_id,
            domain=domain,
            json_path=path,
            page_id=validated_page_id,
            page_revision=page_rev,
            claim_id=validated_claim_id,
            source_ids=tuple(verified_sources),
            source_revision=source_revision,
            state=state,
            exposure_eligibility=(state == "materialized"),
            updated_at=now_ms,
            tombstone_id=effective_tb["tombstone_id"] if effective_tb else None,
            specialist_disagreement=disagreement,
        )
        return dict(
            await self.library.put_projection_receipt(receipt, idempotency_key=idempotency_key)
        )

    async def confirm_candidate_projection(
        self,
        receipt_id: str,
        *,
        idempotency_key: str,
        proposed_value: Any = None,
        specialist_snapshot: dict[str, Any] | None = None,
        existing_domain_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Explicit owner confirmation promoting ``private_candidate`` -> ``materialized``."""
        validate_idempotency_key(idempotency_key)
        validated_id = validate_projection_receipt_id(receipt_id)
        existing = await self.library.get_projection_receipt(validated_id)
        if existing.get("tombstone_id") or existing["state"] in {"stale", "conflicted", "failed"}:
            raise WikiRefused("WIKI_PROJECTION_NOT_CONFIRMABLE", 409)
        return await self.derive_projection(
            page_id=existing["page_id"],
            claim_id=existing["claim_id"],
            target_domain=existing["domain"],
            json_path=existing["json_path"],
            idempotency_key=idempotency_key,
            active_recipient_count=1,
            owner_confirmed=True,
            proposed_value=proposed_value,
            specialist_snapshot=specialist_snapshot,
            existing_domain_data=existing_domain_data,
            source_revision=int(existing["source_revision"]) + 1,
        )

    async def sync_page_lifecycle(
        self,
        page_id: str,
        *,
        page_moved: bool = False,
    ) -> list[dict[str, Any]]:
        """Transition affected projection receipts to ``stale`` on retraction/delete/move/tombstone."""
        validated_page_id = validate_page_id(page_id)
        receipts = [
            r
            for r in await self.library.list_projection_receipts()
            if r["page_id"] == validated_page_id
        ]
        if not receipts:
            return []

        tombstones = await self.library.list_tombstones()
        page_tb = next(
            (
                tb
                for tb in reversed(tombstones)
                if tb["target_kind"] == "page" and tb["target_id"] == validated_page_id
            ),
            None,
        )
        live_page: dict[str, Any] | None = None
        try:
            live_page = await self.library.read_page(validated_page_id, require_settled=True)
        except WikiRefused as exc:
            if exc.code not in {"WIKI_NOT_FOUND", "WIKI_BATCH_INCOMPLETE"}:
                raise

        now_ms = int(time.time() * 1000)
        updated_receipts: list[dict[str, Any]] = []
        for rec in receipts:
            claim_id = rec["claim_id"]
            claim_tb = next(
                (
                    tb
                    for tb in reversed(tombstones)
                    if tb["target_kind"] == "claim" and tb["target_id"] == claim_id
                ),
                None,
            )
            source_tb = next(
                (
                    tb
                    for tb in reversed(tombstones)
                    if tb["target_kind"] == "source" and tb["target_id"] in rec["source_ids"]
                ),
                None,
            )
            live_claim = (
                next((c for c in live_page["claims"] if c["claim_id"] == claim_id), None)
                if live_page is not None
                else None
            )
            needs_stale = (
                page_moved
                or live_page is None
                or live_claim is None
                or live_claim["status"] in {"retracted", "superseded"}
                or page_tb is not None
                or claim_tb is not None
                or source_tb is not None
            )
            if not needs_stale:
                continue
            tb_obj = claim_tb or page_tb or source_tb
            next_page_rev = max(
                int(rec["page_revision"]),
                int(live_page["revision"]) if live_page is not None else int(rec["page_revision"]),
            )
            next_source_rev = int(rec["source_revision"]) + 1
            stale_receipt = WikiProjectionReceipt(
                receipt_id=rec["receipt_id"],
                domain=rec["domain"],
                json_path=rec["json_path"],
                page_id=validated_page_id,
                page_revision=next_page_rev,
                claim_id=claim_id,
                source_ids=tuple(rec["source_ids"]),
                source_revision=next_source_rev,
                state="stale",
                exposure_eligibility=False,
                updated_at=now_ms,
                tombstone_id=tb_obj["tombstone_id"] if tb_obj else rec.get("tombstone_id"),
                specialist_disagreement=rec.get("specialist_disagreement"),
            )
            saved = await self.library.put_projection_receipt(
                stale_receipt,
                idempotency_key=f"stale:{rec['receipt_id']}:{next_page_rev}:{next_source_rev}",
            )
            updated_receipts.append(saved)
        return updated_receipts

    async def projection_states_for_domain(self, domain: str) -> dict[str, dict[str, Any]]:
        """Return ``{json_path: receipt_dict}`` for manifest and scope-registry wiring."""
        receipts = await self.library.list_projection_receipts(domain=domain)
        by_path: dict[str, dict[str, Any]] = {}
        for rec in receipts:
            prev = by_path.get(rec["json_path"])
            if prev is None or (rec["page_revision"], rec["source_revision"]) >= (
                prev["page_revision"],
                prev["source_revision"],
            ):
                by_path[rec["json_path"]] = rec
        return by_path

    async def scope_materialization_for_domain(self, domain: str) -> dict[str, dict[str, Any]]:
        """Build 8-state ``scope_materialization`` map for ``DomainManifest.summary_projection``."""
        by_path = await self.projection_states_for_domain(domain)
        grouped: dict[str, list[str]] = {}
        for json_path, rec in by_path.items():
            top = json_path.split(".", 1)[0]
            grouped.setdefault(top, []).append(rec["state"])
        out: dict[str, dict[str, Any]] = {}
        for top, states in sorted(grouped.items()):
            state, leaf_count = resolve_top_level_projection_state(states)
            out[top] = {
                "state": state,
                "materialized_leaf_count": leaf_count,
            }
        return out

    async def build_agent_lab_claim_payload(
        self,
        *,
        domain: str,
        max_items: int = WIKI_CLAIM_PROJECTION_MAX_ITEMS,
    ) -> dict[str, Any]:
        """Build bounded ``wiki_claim_projection_v1`` state summary (<= 64 items, <= 24,000 chars)."""
        clean_domain = validate_projection_domain(domain)
        cap = max(1, min(int(max_items), WIKI_CLAIM_PROJECTION_MAX_ITEMS))
        tombstones = await self.library.list_tombstones()
        dead_claims = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "claim"}
        dead_pages = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "page"}
        dead_sources = {tb["target_id"] for tb in tombstones if tb["target_kind"] == "source"}

        memories: list[dict[str, Any]] = []
        total_chars = 0
        for summary in await self.library.list_pages():
            if summary["page_id"] in dead_pages or summary.get("pending_batch_id"):
                continue
            try:
                page = await self.library.read_page(summary["page_id"], require_settled=True)
            except WikiRefused:
                continue
            for claim in page["claims"]:
                if len(memories) >= cap:
                    break
                if (
                    claim["status"] != "active"
                    or claim["claim_id"] in dead_claims
                    or not claim["source_ids"]
                    or any(src in dead_sources for src in claim["source_ids"])
                ):
                    continue
                excerpt = claim["statement"][:WIKI_CLAIM_PROJECTION_MAX_ITEM_CHARS]
                if total_chars + len(excerpt) > WIKI_CLAIM_PROJECTION_MAX_TOTAL_CHARS:
                    break
                memories.append(
                    {
                        "domain": clean_domain,
                        "entity_id": claim["claim_id"],
                        "entity_scope": f"{page['page_id']}_r{page['revision']}",
                        "intent_class": "wiki_claim_projection",
                        "message": excerpt,
                        "active": True,
                    }
                )
                total_chars += len(excerpt)
        return {
            "memory_profile": WIKI_CLAIM_PROJECTION_PROFILE,
            "target_domain": clean_domain,
            "simulated_state": {
                "domains": [clean_domain],
                "memories": memories,
            },
            "non_requestable_states": sorted(NON_REQUESTABLE_PROJECTION_STATES),
        }
