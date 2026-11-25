"""Deterministic gates and negative controls for #9370 Phase 0 wiki-memory baseline."""

from __future__ import annotations

import ast
from pathlib import Path

from hushh_eval.wiki_memory.baseline import (
    evaluate_consent_and_injection_guards,
    evaluate_phase0_baseline,
    verify_claim_citation,
)
from hushh_eval.wiki_memory.corpus import (
    SyntheticAdversarialCase,
    SyntheticClaim,
    build_phase0_synthetic_corpus,
)


def test_phase0_baseline_quantifies_v1_limits_and_bounded_wiki_recall() -> None:
    report = evaluate_phase0_baseline()
    v1 = report["v1_whole_markdown_baseline"]
    wiki = report["phase0_target_wiki_claim_recall"]

    # V1 whole-file baseline hits the 96,000-character ceiling on the 160k corpus,
    # lacks structured claim/source citations, and surfaces superseded claims alongside current ones.
    assert v1["corpus_truncated"] is True
    assert v1["prompt_chars_max"] == 96_000
    assert v1["accuracy"] < 1.0
    assert v1["citation_validity_rate"] == 0.0

    # Bounded claim-indexed wiki recall answers known/superseded/history queries, abstains on unknown
    # and tombstoned queries, verifies every citation, and keeps default prompt payload >10x smaller.
    assert wiki["corpus_truncated"] is False
    assert wiki["accuracy"] == 1.0
    assert wiki["citation_validity_rate"] == 1.0
    assert wiki["forbidden_leak_count"] == 0
    assert wiki["prompt_chars_max"] < 2_000
    assert wiki["estimated_prompt_tokens_max"] < (v1["estimated_prompt_tokens_max"] // 20)
    assert wiki["cold_store_median_ms"] >= 0.0
    assert wiki["warm_store_median_ms"] >= 0.0

    # Growth tiers distinguish corpora within V1 limits from corpora silently truncated at 96,000 chars.
    tiers = report["growth_tiers"]
    assert tiers["small"]["v1_truncated"] is False
    assert tiers["medium"]["v1_truncated"] is False
    assert tiers["large"]["v1_truncated"] is False
    assert tiers["scale_beyond_v1"]["v1_truncated"] is True
    assert tiers["scale_beyond_v1"]["v1_prompt_chars"] == 96_000


def test_phase0_adversarial_injection_and_unauthorized_scope_refusal() -> None:
    guards = evaluate_consent_and_injection_guards()
    assert guards["pass_rate"] == 1.0
    assert guards["passed_cases"] == guards["total_cases"]


def test_phase0_negative_controls_detect_forged_citations_and_tombstone_leaks() -> None:
    known_sources = frozenset({"wsr_0000000000000001"})
    valid = SyntheticClaim(
        claim_id="wcl_0000000000000001",
        page_id="wpg_0000000000000001",
        topic="travel",
        statement="Prefers aisle seats.",
        status="active",
        source_id="wsr_0000000000000001",
        observed_at="2026-10-01T00:00:00Z",
    )
    forged_source = SyntheticClaim(
        claim_id="wcl_0000000000000002",
        page_id="wpg_0000000000000001",
        topic="travel",
        statement="Fabricated claim.",
        status="active",
        source_id="wsr_unregistered_source",
        observed_at="2026-10-01T00:00:00Z",
    )
    tombstoned = SyntheticClaim(
        claim_id="wcl_0000000000000003",
        page_id="wpg_0000000000000001",
        topic="travel",
        statement="Forgotten fact.",
        status="tombstoned",
        source_id="wsr_0000000000000001",
        observed_at="2026-10-01T00:00:00Z",
    )
    assert verify_claim_citation(valid, known_sources) is True
    assert verify_claim_citation(forged_source, known_sources) is False
    assert verify_claim_citation(tombstoned, known_sources) is False

    # Negative control on adversarial guard: claiming `attr.one_wiki.*` should be allowed MUST fail.
    corpus = build_phase0_synthetic_corpus()
    broken_corpus = type(corpus)(
        **{
            **corpus.__dict__,
            "adversarial_cases": (
                SyntheticAdversarialCase(
                    case_id="neg_control_wiki_export",
                    category="unauthorized_scope",
                    memory_payload="Clean note.",
                    attempted_scope="attr.one_wiki.pages.career",
                    expect_refusal=False,
                ),
            ),
        }
    )
    failed_guard = evaluate_consent_and_injection_guards(broken_corpus)
    assert failed_guard["pass_rate"] == 0.0


def test_runtime_packages_never_import_wiki_memory_eval_package() -> None:
    backend_root = Path(__file__).resolve().parents[2]
    for package_dir in (backend_root / "hushh_mcp", backend_root / "api"):
        for py_file in package_dir.rglob("*.py"):
            tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        assert not alias.name.startswith("hushh_eval"), (
                            f"{py_file} imports {alias.name}"
                        )
                elif isinstance(node, ast.ImportFrom) and node.module:
                    assert not node.module.startswith("hushh_eval"), (
                        f"{py_file} imports {node.module}"
                    )
