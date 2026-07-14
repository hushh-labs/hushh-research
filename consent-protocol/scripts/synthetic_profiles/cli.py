"""CLI for the synthetic HumanProfile system.

Usage (from consent-protocol/):
    .venv/bin/python -m scripts.synthetic_profiles.cli generate --seed 4193772206
    .venv/bin/python -m scripts.synthetic_profiles.cli sample --count 1000 --out /tmp/profiles.jsonl
    .venv/bin/python -m scripts.synthetic_profiles.cli stats --count 20000
    .venv/bin/python -m scripts.synthetic_profiles.cli validate --count 500
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import time
from pathlib import Path

from .generator import ADDRESS_SPACE, canonical_json, generate, load_schema
from .marginals import MARGINALS_VERSION, REGION_WEIGHTS


def _cmd_generate(args: argparse.Namespace) -> int:
    profile = generate(args.seed)
    print(json.dumps(profile, indent=2, ensure_ascii=False))
    return 0


def _cmd_sample(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    step = max(1, ADDRESS_SPACE // args.count)
    with out.open("w", encoding="utf-8") as handle:
        for i in range(args.count):
            seed = (args.offset + i * step) % ADDRESS_SPACE
            handle.write(canonical_json(generate(seed)) + "\n")
    print(f"wrote {args.count} profiles to {out} (stride {step}, marginals {MARGINALS_VERSION})")
    return 0


def _cmd_stats(args: argparse.Namespace) -> int:
    counters: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    step = max(1, ADDRESS_SPACE // args.count)
    for i in range(args.count):
        p = generate((i * step) % ADDRESS_SPACE)
        d = p["demographics"]
        counters["region"][d["region"]] += 1
        counters["income_tier"][d["income_tier"]] += 1
        counters["urbanicity"][d["urbanicity"]] += 1
        counters["occupation"][d["occupation"]["group"]] += 1
        counters["privacy_stance"][p["consent_posture"]["privacy_stance"]] += 1
        age = d["age"]
        counters["age_band"][f"{(age // 15) * 15:>3}-{(age // 15) * 15 + 14}"] += 1

    print(f"population sample: {args.count} profiles (marginals {MARGINALS_VERSION})\n")
    for dim, counter in counters.items():
        print(f"== {dim} ==")
        for key, n in counter.most_common():
            share = n / args.count
            bar = "#" * int(share * 60)
            print(f"  {key:<24} {share:6.1%}  {bar}")
        print()

    expected = dict(REGION_WEIGHTS)
    worst = max((abs(counters["region"][r] / args.count - w), r) for r, w in expected.items())
    print(f"max region deviation from target marginals: {worst[0]:.2%} ({worst[1]})")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    try:
        import jsonschema
    except ImportError:
        print("jsonschema not installed in this environment", file=sys.stderr)
        return 1
    schema = load_schema()
    validator = jsonschema.Draft202012Validator(schema)
    step = max(1, ADDRESS_SPACE // args.count)
    seen_ids: set[str] = set()
    for i in range(args.count):
        seed = (i * step) % ADDRESS_SPACE
        profile = generate(seed)
        errors = sorted(validator.iter_errors(profile), key=str)
        if errors:
            print(f"seed {seed}: INVALID — {errors[0].message}", file=sys.stderr)
            return 1
        if profile["profile_id"] in seen_ids:
            print(f"seed {seed}: duplicate profile_id", file=sys.stderr)
            return 1
        seen_ids.add(profile["profile_id"])
        # Determinism: regenerating must be byte-identical.
        if canonical_json(generate(seed)) != canonical_json(profile):
            print(f"seed {seed}: NON-DETERMINISTIC", file=sys.stderr)
            return 1
    print(f"validated {args.count} profiles: schema-valid, unique, deterministic")
    return 0


def _cmd_bench(args: argparse.Namespace) -> int:
    """Measure real generation throughput and extrapolate — honestly — to the 1B
    baseline and the full 8B space. The address space is O(1)-addressable with
    zero storage, so "planet scale" is a throughput fact, not a storage claim."""
    n = args.count
    step = max(1, ADDRESS_SPACE // n)

    # Warm up (imports, name banks) so we time steady-state generation only.
    for i in range(min(1000, n)):
        generate((i * step) % ADDRESS_SPACE)

    latencies_us: list[float] = []
    start = time.perf_counter()
    for i in range(n):
        t0 = time.perf_counter()
        generate((i * step) % ADDRESS_SPACE)
        latencies_us.append((time.perf_counter() - t0) * 1e6)
    elapsed = time.perf_counter() - start

    per_sec = n / elapsed if elapsed > 0 else float("inf")
    latencies_us.sort()

    def pct(p: float) -> float:
        return latencies_us[min(len(latencies_us) - 1, int(p * len(latencies_us)))]

    def core_hours(target: int) -> float:
        return target / per_sec / 3600 if per_sec else float("inf")

    print(f"HumanProfile v0 generation benchmark (marginals {MARGINALS_VERSION})")
    print(f"  measured:      {n:,} profiles in {elapsed:.3f}s")
    print(f"  throughput:    {per_sec:,.0f} profiles/sec  (single core, this machine)")
    print(f"  latency/profile: p50 {pct(0.50):.1f}us  p99 {pct(0.99):.1f}us")
    print("  storage:       0 bytes — any of the 8B profiles is O(1) from its seed")
    print("  --- honest extrapolation at the measured single-core rate ---")
    print(
        f"  1B baseline:   ~{core_hours(1_000_000_000):,.1f} core-hours "
        f"(~{core_hours(1_000_000_000) / 64:,.1f}h on 64 cores)"
    )
    print(
        f"  full 8B space: ~{core_hours(ADDRESS_SPACE):,.1f} core-hours "
        f"(~{core_hours(ADDRESS_SPACE) / 64:,.1f}h on 64 cores)"
    )
    print(
        "  note: generation is embarrassingly parallel (pure function of seed); "
        "throughput scales ~linearly with cores."
    )
    return 0


def cohort_match(
    profile: dict,
    *,
    region: str | None = None,
    stance: str | None = None,
    income_tier: str | None = None,
    sex: str | None = None,
    min_age: int = 0,
    max_age: int = 105,
) -> bool:
    """True iff the profile falls in the requested sub-population. Pure predicate
    so the cohort contract is independently testable."""
    d = profile["demographics"]
    if region and d["region"] != region:
        return False
    if stance and profile["consent_posture"]["privacy_stance"] != stance:
        return False
    if income_tier and d["income_tier"] != income_tier:
        return False
    if sex and d["sex"] != sex:
        return False
    return min_age <= d["age"] <= max_age


def _cmd_cohort(args: argparse.Namespace) -> int:
    """Address a sub-population by demographic/consent filters — the world-model
    slice you'd hand a trainer or evaluator. Sweeps a strided sample and keeps
    the profiles that match, reporting the yield so the cohort size is honest."""
    step = max(1, ADDRESS_SPACE // args.scan)
    matches: list[dict] = []
    for i in range(args.scan):
        p = generate((i * step) % ADDRESS_SPACE)
        if not cohort_match(
            p,
            region=args.region,
            stance=args.stance,
            income_tier=args.income_tier,
            sex=args.sex,
            min_age=args.min_age,
            max_age=args.max_age,
        ):
            continue
        matches.append(p)
        if args.limit and len(matches) >= args.limit:
            break

    yield_rate = len(matches) / args.scan if args.scan else 0.0
    est_in_space = int(yield_rate * ADDRESS_SPACE)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8") as handle:
            for p in matches:
                handle.write(canonical_json(p) + "\n")
        print(f"wrote {len(matches)} matching profiles to {out}")
    else:
        for p in matches[:5]:
            idn = p["identity"]
            d = p["demographics"]
            print(
                f"  {idn['display_name']:<26} {d['region']:<20} age {d['age']:<3} "
                f"{d['income_tier']:<20} {p['consent_posture']['privacy_stance']}"
            )
        if len(matches) > 5:
            print(f"  ... and {len(matches) - 5} more")
    print(
        f"cohort yield: {len(matches)}/{args.scan} scanned = {yield_rate:.2%} "
        f"→ ~{est_in_space:,} such humans across the 8B space"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="synthetic_profiles", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_gen = sub.add_parser("generate", help="print one profile as JSON")
    p_gen.add_argument("--seed", type=int, required=True)
    p_gen.set_defaults(func=_cmd_generate)

    p_sample = sub.add_parser(
        "sample", help="write N profiles as JSONL, strided across the 8B space"
    )
    p_sample.add_argument("--count", type=int, default=1000)
    p_sample.add_argument("--offset", type=int, default=0)
    p_sample.add_argument("--out", type=str, required=True)
    p_sample.set_defaults(func=_cmd_sample)

    p_stats = sub.add_parser("stats", help="distribution report vs target marginals")
    p_stats.add_argument("--count", type=int, default=10000)
    p_stats.set_defaults(func=_cmd_stats)

    p_val = sub.add_parser("validate", help="schema + uniqueness + determinism check")
    p_val.add_argument("--count", type=int, default=500)
    p_val.set_defaults(func=_cmd_validate)

    p_bench = sub.add_parser("bench", help="measure throughput; extrapolate to 1B/8B (honest)")
    p_bench.add_argument("--count", type=int, default=50000)
    p_bench.set_defaults(func=_cmd_bench)

    p_cohort = sub.add_parser(
        "cohort", help="address a sub-population by demographic/consent filters"
    )
    p_cohort.add_argument(
        "--scan", type=int, default=20000, help="profiles to sweep across the 8B space"
    )
    p_cohort.add_argument(
        "--limit", type=int, default=0, help="stop after this many matches (0 = no cap)"
    )
    p_cohort.add_argument("--region", type=str, default=None)
    p_cohort.add_argument(
        "--stance", type=str, default=None, choices=["open", "pragmatic", "guarded", "fortress"]
    )
    p_cohort.add_argument("--income-tier", dest="income_tier", type=str, default=None)
    p_cohort.add_argument("--sex", type=str, default=None, choices=["female", "male", "intersex"])
    p_cohort.add_argument("--min-age", dest="min_age", type=int, default=0)
    p_cohort.add_argument("--max-age", dest="max_age", type=int, default=105)
    p_cohort.add_argument(
        "--out", type=str, default=None, help="write matches as JSONL (else print a preview)"
    )
    p_cohort.set_defaults(func=_cmd_cohort)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
