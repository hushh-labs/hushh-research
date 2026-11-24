"""Phase 0 baseline vs bounded-wiki recall benchmark & consent/injection evaluators.

Separates cold/warm storage + selection timings from prompt payload size/token cost,
and exercises real PKM consent scope guards without network calls.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass
from statistics import median

from hushh_eval.wiki_memory.corpus import (
    SyntheticClaim,
    SyntheticPhase0Corpus,
    SyntheticQueryCase,
    build_phase0_synthetic_corpus,
)

V1_MAX_MARKDOWN_CHARS = 96_000
WIKI_HOT_MAX_CHARS = 8_000
WIKI_RETRIEVED_MAX_CHARS = 6_000

_INJECTION_DIRECTIVE_PATTERN = re.compile(
    r"\b(ignore\s+(?:all\s+)?consent|system\s+override|skip\s+owner\s+confirmation|"
    r"treat\s+attr\.[a-z0-9_.*]+\s+as\s+pre-approved)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class StrategyQueryResult:
    case_id: str
    answered_correctly: bool
    abstained: bool
    citation_verified: bool
    leaked_forbidden: bool
    prompt_chars: int
    estimated_prompt_tokens: int
    cold_store_ms: float
    warm_store_ms: float
    selection_ms: float


@dataclass(frozen=True)
class StrategySummary:
    strategy: str
    total_queries: int
    correct_count: int
    accuracy: float
    citation_validity_rate: float
    forbidden_leak_count: int
    prompt_chars_p50: int
    prompt_chars_max: int
    estimated_prompt_tokens_p50: int
    estimated_prompt_tokens_max: int
    cold_store_median_ms: float
    warm_store_median_ms: float
    selection_median_ms: float
    corpus_truncated: bool


def _estimate_tokens(char_count: int) -> int:
    # Conservative 4 chars/token deterministic estimate for English/Markdown fixtures.
    return (max(0, char_count) + 3) // 4


def _compile_v1_flat_markdown(
    corpus: SyntheticPhase0Corpus,
    *,
    apply_v1_cap: bool = True,
) -> tuple[str, bool]:
    lines = ["# memory.md", ""]
    for page in corpus.pages:
        lines.append(f"## {page.topic}")
        for claim in page.claims:
            if claim.status == "tombstoned":
                continue
            # V1 flat markdown stores plain bullets without structured status/claim_id/source_id metadata.
            lines.append(f"- {claim.statement}")
        for extra_line in page.markdown_body.splitlines():
            if extra_line.startswith("- Synthetic research note"):
                lines.append(extra_line)
        lines.append("")
    full_doc = "\n".join(lines)
    if apply_v1_cap and len(full_doc) > V1_MAX_MARKDOWN_CHARS:
        return full_doc[:V1_MAX_MARKDOWN_CHARS], True
    return full_doc, False


def _evaluate_v1_query(
    flat_payload_bytes: bytes,
    warm_doc: str,
    query: SyntheticQueryCase,
) -> StrategyQueryResult:
    t0 = time.perf_counter()
    cold_decoded = json.loads(flat_payload_bytes.decode("utf-8"))["markdown"]
    cold_ms = (time.perf_counter() - t0) * 1000.0

    t1 = time.perf_counter()
    _ = warm_doc
    warm_ms = (time.perf_counter() - t1) * 1000.0

    t2 = time.perf_counter()
    # V1 sends the entire flat document on every turn; matching bullets have no status disambiguation.
    tokens = [
        word
        for word in re.findall(r"[a-z0-9_-]{4,}", f"{query.topic_hint} {query.question}".lower())
        if word not in {"what", "which", "where", "when", "does", "currently", "before"}
    ]
    matched_lines = [
        line
        for line in cold_decoded.splitlines()
        if line.startswith("- ") and any(tok in line.lower() for tok in tokens)
    ]
    selection_ms = (time.perf_counter() - t2) * 1000.0

    joined_matches = "\n".join(matched_lines)
    leaked_forbidden = any(f in joined_matches for f in query.forbidden_substrings)
    if query.expected_answer_substring is None:
        abstained = len(matched_lines) == 0
        correct = abstained and not leaked_forbidden
    else:
        abstained = len(matched_lines) == 0
        correct = (query.expected_answer_substring in joined_matches) and not leaked_forbidden

    prompt_chars = len(cold_decoded)
    return StrategyQueryResult(
        case_id=query.case_id,
        answered_correctly=correct,
        abstained=abstained,
        # V1 flat bullets strip source_id / claim_id out of Soul.md by contract.
        citation_verified=False,
        leaked_forbidden=leaked_forbidden,
        prompt_chars=prompt_chars,
        estimated_prompt_tokens=_estimate_tokens(prompt_chars),
        cold_store_ms=round(cold_ms, 4),
        warm_store_ms=round(warm_ms, 4),
        selection_ms=round(selection_ms, 4),
    )


def verify_claim_citation(
    claim: SyntheticClaim,
    known_source_ids: frozenset[str],
) -> bool:
    return (
        bool(claim.claim_id.startswith("wcl_"))
        and bool(claim.source_id in known_source_ids)
        and claim.status != "tombstoned"
    )


def _evaluate_wiki_query(
    serialized_store: dict[str, bytes],
    warm_pages: dict[str, dict],
    known_source_ids: frozenset[str],
    corpus: SyntheticPhase0Corpus,
    query: SyntheticQueryCase,
) -> StrategyQueryResult:
    # Cold read: decode only index + matching topic page + claims object (bounded read, never whole 160k store).
    t0 = time.perf_counter()
    index_map: dict[str, str] = json.loads(serialized_store["indexes/lexical.json"].decode("utf-8"))
    target_page_id = index_map.get(query.topic_hint)
    cold_page = (
        json.loads(serialized_store[f"pages/{target_page_id}.json"].decode("utf-8"))
        if target_page_id and f"pages/{target_page_id}.json" in serialized_store
        else None
    )
    cold_ms = (time.perf_counter() - t0) * 1000.0

    # Warm read: direct dictionary lookup in decrypted owner session cache.
    t1 = time.perf_counter()
    warm_page = warm_pages.get(target_page_id) if target_page_id else None
    warm_ms = (time.perf_counter() - t1) * 1000.0
    _ = warm_page

    t2 = time.perf_counter()
    include_superseded = query.kind == "superseded_history"
    query_tokens = [
        word
        for word in re.findall(r"[a-z0-9]{4,}", query.question.lower())
        if word not in {"what", "which", "where", "when", "does", "currently", "before", "have"}
    ]
    scored_claims: list[tuple[int, SyntheticClaim]] = []
    if cold_page is not None:
        page_claims = [SyntheticClaim(**raw_claim) for raw_claim in cold_page["claims"]]
        claims_by_id = {c.claim_id: c for c in page_claims}
        for claim in page_claims:
            if claim.status == "tombstoned":
                continue
            if claim.status == "superseded" and not include_superseded:
                continue
            if include_superseded and claim.status != "superseded":
                continue
            linked_successor = (
                claims_by_id[claim.superseded_by].statement
                if include_superseded
                and claim.superseded_by
                and claim.superseded_by in claims_by_id
                else ""
            )
            searchable = f"{claim.statement} {linked_successor}".lower()
            score = sum(
                1
                for tok in query_tokens
                if tok in searchable or (len(tok) >= 6 and tok[:5] in searchable)
            )
            if score > 0:
                scored_claims.append((score, claim))
    scored_claims.sort(key=lambda item: item[0], reverse=True)
    selected_claims = [claim for _, claim in scored_claims[:3]]
    selection_ms = (time.perf_counter() - t2) * 1000.0

    rendered_claims = "\n".join(
        f"- {c.statement} [{c.claim_id} -> {c.source_id}]" for c in selected_claims
    )[:WIKI_RETRIEVED_MAX_CHARS]
    hot_prompt = (
        corpus.identity_markdown[:4_000]
        + "\n\n"
        + corpus.hot_orientation_markdown[:WIKI_HOT_MAX_CHARS]
    )
    prompt_chars = len(hot_prompt) + (len(rendered_claims) + 2 if rendered_claims else 0)
    leaked_forbidden = any(f in rendered_claims for f in query.forbidden_substrings)

    if query.expected_answer_substring is None:
        abstained = len(selected_claims) == 0
        correct = abstained and not leaked_forbidden
        citation_ok = abstained
    else:
        abstained = len(selected_claims) == 0
        matched = [c for c in selected_claims if query.expected_answer_substring in c.statement]
        citation_ok = bool(matched) and all(
            c.claim_id == query.expected_claim_id
            and c.source_id == query.expected_source_id
            and verify_claim_citation(c, known_source_ids)
            for c in matched
        )
        correct = bool(matched) and citation_ok and not leaked_forbidden

    return StrategyQueryResult(
        case_id=query.case_id,
        answered_correctly=correct,
        abstained=abstained,
        citation_verified=citation_ok,
        leaked_forbidden=leaked_forbidden,
        prompt_chars=prompt_chars,
        estimated_prompt_tokens=_estimate_tokens(prompt_chars),
        cold_store_ms=round(cold_ms, 4),
        warm_store_ms=round(warm_ms, 4),
        selection_ms=round(selection_ms, 4),
    )


def _summarize(
    strategy: str,
    results: list[StrategyQueryResult],
    *,
    corpus_truncated: bool,
) -> StrategySummary:
    total = len(results)
    correct = sum(1 for r in results if r.answered_correctly)
    cited = sum(1 for r in results if r.citation_verified)
    leaks = sum(1 for r in results if r.leaked_forbidden)
    chars = sorted(r.prompt_chars for r in results)
    tokens = sorted(r.estimated_prompt_tokens for r in results)
    return StrategySummary(
        strategy=strategy,
        total_queries=total,
        correct_count=correct,
        accuracy=round(correct / total, 4) if total else 0.0,
        citation_validity_rate=round(cited / total, 4) if total else 0.0,
        forbidden_leak_count=leaks,
        prompt_chars_p50=int(median(chars)) if chars else 0,
        prompt_chars_max=max(chars) if chars else 0,
        estimated_prompt_tokens_p50=int(median(tokens)) if tokens else 0,
        estimated_prompt_tokens_max=max(tokens) if tokens else 0,
        cold_store_median_ms=round(float(median(r.cold_store_ms for r in results)), 4)
        if results
        else 0.0,
        warm_store_median_ms=round(float(median(r.warm_store_ms for r in results)), 4)
        if results
        else 0.0,
        selection_median_ms=round(float(median(r.selection_ms for r in results)), 4)
        if results
        else 0.0,
        corpus_truncated=corpus_truncated,
    )


def evaluate_consent_and_injection_guards(
    corpus: SyntheticPhase0Corpus | None = None,
) -> dict[str, object]:
    """Verify prompt-injection framing and real PKM consent scope refusal."""
    from hushh_mcp.consent.pkm_scope_policy import (
        is_external_requestable_pkm_scope,
        is_private_pkm_export_scope,
    )

    active_corpus = corpus or build_phase0_synthetic_corpus()
    outcomes: list[dict[str, object]] = []
    passed = 0

    for case in active_corpus.adversarial_cases:
        injection_detected = bool(_INJECTION_DIRECTIVE_PATTERN.search(case.memory_payload))
        scope_private = is_private_pkm_export_scope(case.attempted_scope)
        scope_requestable = is_external_requestable_pkm_scope(case.attempted_scope)
        # Memory prose never grants authority: even if an ordinary scope is requestable,
        # an unapproved injection directive inside memory.md/soul.md cannot self-approve it.
        refused = scope_private or (not scope_requestable) or injection_detected
        case_ok = refused == case.expect_refusal
        if case_ok:
            passed += 1
        outcomes.append(
            {
                "case_id": case.case_id,
                "category": case.category,
                "attempted_scope": case.attempted_scope,
                "injection_detected": injection_detected,
                "refused": refused,
                "expect_refusal": case.expect_refusal,
                "passed": case_ok,
            }
        )

    total = len(outcomes)
    return {
        "total_cases": total,
        "passed_cases": passed,
        "pass_rate": round(passed / total, 4) if total else 0.0,
        "cases": outcomes,
    }


def evaluate_phase0_baseline(
    corpus: SyntheticPhase0Corpus | None = None,
) -> dict[str, object]:
    active_corpus = corpus or build_phase0_synthetic_corpus()
    flat_doc, truncated = _compile_v1_flat_markdown(active_corpus)
    flat_bytes = json.dumps({"markdown": flat_doc}).encode("utf-8")

    known_sources = frozenset(s.source_id for s in active_corpus.sources)
    serialized_store: dict[str, bytes] = {}
    warm_pages: dict[str, dict] = {}
    lexical_index: dict[str, str] = {}
    for page in active_corpus.pages:
        lexical_index[page.topic] = page.page_id
        payload = {
            "page_id": page.page_id,
            "topic": page.topic,
            "summary": page.summary,
            "markdown_body": page.markdown_body,
            "claims": [asdict(c) for c in page.claims],
        }
        serialized_store[f"pages/{page.page_id}.json"] = json.dumps(payload).encode("utf-8")
        warm_pages[page.page_id] = payload
    serialized_store["indexes/lexical.json"] = json.dumps(lexical_index).encode("utf-8")

    v1_results = [
        _evaluate_v1_query(flat_bytes, flat_doc, query) for query in active_corpus.queries
    ]
    wiki_results = [
        _evaluate_wiki_query(serialized_store, warm_pages, known_sources, active_corpus, query)
        for query in active_corpus.queries
    ]

    v1_summary = _summarize("v1_whole_markdown_baseline", v1_results, corpus_truncated=truncated)
    wiki_summary = _summarize(
        "phase0_target_wiki_claim_recall", wiki_results, corpus_truncated=False
    )

    full_flat_doc, _ = _compile_v1_flat_markdown(active_corpus, apply_v1_cap=False)
    tier_measurements: dict[str, dict[str, int | bool]] = {}
    for tier_name, budget in active_corpus.tier_target_chars.items():
        simulated_corpus = full_flat_doc[:budget]
        tier_truncated = len(simulated_corpus) > V1_MAX_MARKDOWN_CHARS
        v1_sent = simulated_corpus[:V1_MAX_MARKDOWN_CHARS]
        tier_measurements[tier_name] = {
            "target_chars": len(simulated_corpus),
            "v1_prompt_chars": len(v1_sent),
            "v1_estimated_tokens": _estimate_tokens(len(v1_sent)),
            "v1_truncated": tier_truncated,
            "wiki_default_hot_chars": len(active_corpus.identity_markdown)
            + len(active_corpus.hot_orientation_markdown)
            + 2,
            "wiki_default_hot_tokens": _estimate_tokens(
                len(active_corpus.identity_markdown)
                + len(active_corpus.hot_orientation_markdown)
                + 2
            ),
        }

    guards = evaluate_consent_and_injection_guards(active_corpus)

    return {
        "schema": "hushh.wiki_memory.phase0_eval.v1",
        "owner_id": active_corpus.owner_id,
        "corpus_stats": {
            "page_count": len(active_corpus.pages),
            "source_count": len(active_corpus.sources),
            "claim_count": sum(len(p.claims) for p in active_corpus.pages),
            "untruncated_flat_markdown_chars": sum(
                len(p.markdown_body) for p in active_corpus.pages
            ),
            "v1_ceiling_chars": V1_MAX_MARKDOWN_CHARS,
        },
        "v1_whole_markdown_baseline": asdict(v1_summary),
        "phase0_target_wiki_claim_recall": asdict(wiki_summary),
        "growth_tiers": tier_measurements,
        "adversarial_and_consent_guards": guards,
        "per_query": {
            "v1": [asdict(r) for r in v1_results],
            "wiki": [asdict(r) for r in wiki_results],
        },
    }
