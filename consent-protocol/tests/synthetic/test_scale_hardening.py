"""Scale + provenance hardening contract tests for HumanProfile v0.

These lock the properties the "planet-scale" claim actually depends on when a
skeptical engineer leans in:

1. profile_id is wide enough that it is unique across the full 8B space (not
   just across a small sample) — the 64-bit id it replaced collided ~1.7x.
2. Every profile is self-describing: it carries its own provenance (synthetic
   flag + marginals_version) so the JSON alone reproduces it.
3. Determinism is frozen against a golden fixture, so a Python/library upgrade
   that silently changes the RNG stream is caught instead of shipping.
4. Cohort addressing returns only matching humans — sub-population slices are
   honest.
"""

from __future__ import annotations

import hashlib

from scripts.synthetic_profiles.cli import cohort_match
from scripts.synthetic_profiles.generator import (
    ADDRESS_SPACE,
    PROFILE_ID_HEX,
    canonical_json,
    generate,
    profile_id_for_seed,
)
from scripts.synthetic_profiles.marginals import MARGINALS_VERSION


def test_profile_id_is_wide_enough_to_be_unique_across_8b() -> None:
    """The id is a truncated sha256. The expected number of birthday collisions
    across the whole address space must be far below 1, or the id cannot double
    as a stable user_id. 96 bits (24 hex) gives ~4e-10; 64 bits gave ~1.7."""
    bits = PROFILE_ID_HEX * 4
    expected_collisions = ADDRESS_SPACE * ADDRESS_SPACE / (2 * (2 ** bits))
    assert expected_collisions < 1e-6, (
        f"{bits}-bit profile_id expects {expected_collisions:.2e} collisions "
        f"across {ADDRESS_SPACE:,} — widen PROFILE_ID_HEX"
    )


def test_profile_id_shape_matches_schema_pattern() -> None:
    pid = profile_id_for_seed(4193772206)
    assert pid.startswith("synth_")
    hexpart = pid[len("synth_"):]
    assert len(hexpart) == PROFILE_ID_HEX
    assert all(c in "0123456789abcdef" for c in hexpart)


def test_every_profile_carries_its_own_provenance() -> None:
    """synthetic=true and the marginals_version are embedded, so no profile can
    be mistaken for real data and (seed + marginals_version) reproduces it."""
    step = ADDRESS_SPACE // 500
    for i in range(500):
        p = generate((i * step) % ADDRESS_SPACE)
        assert p["synthetic"] is True
        assert p["marginals_version"] == MARGINALS_VERSION


# --- Golden determinism fixture -------------------------------------------------
# canonical_json SHA-256 for pinned seeds (the four heroes + both boundary seeds),
# frozen for schema humanprofile/v0, marginals 2026.07-v1, 96-bit id. If a Python
# or stdlib upgrade perturbs the random stream, or a generator edit is unintended,
# these hashes move and the test fails loudly instead of silently invalidating
# every profile anyone reproduced from a seed.
#
# Regenerate ONLY on an intentional version bump:
#   for s in 0 4193772206 480000000 2020202020 1618033988 7999999999; do \
#     python -m scripts.synthetic_profiles.cli generate --seed $s \
#     | python -c "import sys,json,hashlib; from scripts.synthetic_profiles.generator import canonical_json; \
#       print(hashlib.sha256(canonical_json(json.load(sys.stdin)).encode()).hexdigest())"; done
GOLDEN_HASHES: dict[int, str] = {
    0: "ab5c880f084c83307fea5a20ecf973de75ad84d6e2d638efe01dc62fd9508760",
    4193772206: "e1189bb2a3da32552c2c8d637a2ab590b7de1c9382c64fa0f4f0e453e4cb3ea6",
    480000000: "4ccc10f6b911b93091f35f44f73692c624d5fb36fd8582d60f1dc65d59a906e5",
    2020202020: "5182aa5aa36ebbcb40ae4451892f4f630c5d25eb1207aab1f4fd4f1e9df41f3a",
    1618033988: "593badd024ef20b93ef1b1db287ca38e28d6704b48b9a7a36fdd14273028cd10",
    7999999999: "12a18ea50360049b822ff06914d10877bae24ea176bb90e1216f2131eb51b83e",
}


def _golden_hash(seed: int) -> str:
    return hashlib.sha256(canonical_json(generate(seed)).encode()).hexdigest()


def test_golden_fixture_matches_committed_snapshot() -> None:
    """Frozen hashes pinned to (schema humanprofile/v0, marginals 2026.07-v1).
    A drift here means the deterministic stream changed under us — a Python or
    stdlib upgrade, or an unintended generator edit — which would silently
    invalidate every profile anyone reproduced from a seed. Fail loudly instead."""
    assert MARGINALS_VERSION == "2026.07-v1", (
        "marginals_version changed; regenerate GOLDEN_HASHES intentionally"
    )
    for seed, expected in GOLDEN_HASHES.items():
        assert _golden_hash(seed) == expected, (
            f"determinism drift at seed {seed}: got {_golden_hash(seed)}, "
            f"expected {expected}"
        )


def test_cohort_addressing_returns_only_matching_humans() -> None:
    """A cohort slice must be honest: every returned profile satisfies every
    filter, and a real slice actually yields members."""
    step = ADDRESS_SPACE // 6000
    filters = dict(region="south_asia", stance="guarded", min_age=25, max_age=45)
    matched = 0
    for i in range(6000):
        p = generate((i * step) % ADDRESS_SPACE)
        if cohort_match(p, **filters):
            matched += 1
            d = p["demographics"]
            assert d["region"] == "south_asia"
            assert p["consent_posture"]["privacy_stance"] == "guarded"
            assert 25 <= d["age"] <= 45
    assert matched > 0, "cohort filter matched nobody — slice is not addressable"


def test_empty_filters_match_everyone() -> None:
    step = ADDRESS_SPACE // 500
    for i in range(500):
        assert cohort_match(generate((i * step) % ADDRESS_SPACE)) is True
