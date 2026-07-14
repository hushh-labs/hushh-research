"""Synthetic HumanProfile v0 system.

An 8-billion-profile address space with zero storage: profile(seed) is a pure
deterministic function, stratified against world marginals so the generated
population honestly represents all kinds of humans. Every profile is synthetic;
no real person's data is used or reproduced.

Modules:
- generator: seed -> HumanProfile v0 document (pure, stdlib-only)
- marginals: the editable world-distribution data
- cli: generate / sample / stats / validate / bench / cohort

See README.md for the scale claims (what "8B address space" and "1B baseline"
mean precisely), the demo script, and the properties that survive scrutiny.
"""

from .generator import ADDRESS_SPACE, SCHEMA_VERSION, canonical_json, generate, profile_id_for_seed

__all__ = [
    "ADDRESS_SPACE",
    "SCHEMA_VERSION",
    "canonical_json",
    "generate",
    "profile_id_for_seed",
]
