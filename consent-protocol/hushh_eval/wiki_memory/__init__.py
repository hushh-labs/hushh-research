"""Sanitized, zero-network evaluation harness for Personal Wiki Memory (#9370 Phase 0).

Never imported by runtime packages (``hushh_mcp``, ``api``).
"""

from hushh_eval.wiki_memory.baseline import (
    evaluate_consent_and_injection_guards,
    evaluate_phase0_baseline,
)
from hushh_eval.wiki_memory.conformance import (
    evaluate_four_placement_conformance,
    evaluate_live_agent_turn_e2e,
    evaluate_live_wiki_pipeline,
    evaluate_phase6_cutover_and_retirement,
)
from hushh_eval.wiki_memory.corpus import build_phase0_synthetic_corpus

__all__ = [
    "build_phase0_synthetic_corpus",
    "evaluate_consent_and_injection_guards",
    "evaluate_four_placement_conformance",
    "evaluate_live_agent_turn_e2e",
    "evaluate_live_wiki_pipeline",
    "evaluate_phase0_baseline",
    "evaluate_phase6_cutover_and_retirement",
]
