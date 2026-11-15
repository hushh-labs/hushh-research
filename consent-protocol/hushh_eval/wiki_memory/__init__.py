"""Sanitized, zero-network evaluation harness for Personal Wiki Memory (#9370 Phase 0).

Never imported by runtime packages (``hushh_mcp``, ``api``).
"""

from hushh_eval.wiki_memory.baseline import (
    evaluate_consent_and_injection_guards,
    evaluate_phase0_baseline,
)
from hushh_eval.wiki_memory.corpus import build_phase0_synthetic_corpus

__all__ = [
    "build_phase0_synthetic_corpus",
    "evaluate_consent_and_injection_guards",
    "evaluate_phase0_baseline",
]
