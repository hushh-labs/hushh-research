"""HumanProfile v0 generator contract tests.

The three properties the 8B address space depends on:
1. Determinism — profile(seed) is byte-identical across calls.
2. Uniqueness — distinct seeds yield distinct profile_ids.
3. Validity + representativeness — every profile validates against the JSON
   Schema, and sampled marginals track the target world distributions.
"""

from __future__ import annotations

import collections

import jsonschema
import pytest

from scripts.synthetic_profiles.generator import (
    ADDRESS_SPACE,
    canonical_json,
    generate,
    load_schema,
    profile_id_for_seed,
)
from scripts.synthetic_profiles.marginals import REGION_WEIGHTS

SAMPLE = 400
STRIDE = ADDRESS_SPACE // SAMPLE


def _sample_seeds() -> list[int]:
    return [(i * STRIDE) % ADDRESS_SPACE for i in range(SAMPLE)]


def test_determinism_byte_identical() -> None:
    for seed in (0, 1, 42, 7_999_999_999, 4_193_772_206):
        assert canonical_json(generate(seed)) == canonical_json(generate(seed))


def test_uniqueness_of_profile_ids() -> None:
    ids = {profile_id_for_seed(seed) for seed in _sample_seeds()}
    assert len(ids) == SAMPLE


def test_schema_validity_across_sample() -> None:
    validator = jsonschema.Draft202012Validator(load_schema())
    for seed in _sample_seeds():
        errors = list(validator.iter_errors(generate(seed)))
        assert not errors, f"seed {seed}: {errors[0].message if errors else ''}"


def test_seed_bounds() -> None:
    with pytest.raises(ValueError):
        generate(-1)
    with pytest.raises(ValueError):
        generate(ADDRESS_SPACE)


def test_region_marginals_track_targets() -> None:
    counter: collections.Counter[str] = collections.Counter()
    for seed in _sample_seeds():
        counter[generate(seed)["demographics"]["region"]] += 1
    for region, weight in REGION_WEIGHTS:
        share = counter[region] / SAMPLE
        # Generous tolerance at n=400; the stats CLI reports tighter numbers at scale.
        assert abs(share - weight) < 0.07, f"{region}: {share:.2%} vs target {weight:.0%}"


def test_profiles_are_internally_consistent() -> None:
    for seed in _sample_seeds()[:120]:
        p = generate(seed)
        d = p["demographics"]
        fin = p["knowledge_model"]["financial"]
        if d["age"] < 15:
            assert d["occupation"]["group"] == "student"
            assert fin["holdings"] == []
        assert fin["total_value_usd"] == pytest.approx(
            sum(h["value_usd"] for h in fin["holdings"]), abs=0.05
        )
        assert p["identity"]["email"].endswith("@profiles.example")
        assert p["identity"]["phone_anchor"].startswith("+999")
