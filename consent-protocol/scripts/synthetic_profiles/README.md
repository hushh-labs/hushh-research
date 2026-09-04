# Synthetic HumanProfile v0 — a planet-scale, zero-PII population

A pure, deterministic function `generate(seed) -> HumanProfile` over the seed
range `[0, 8_000_000_000)` — one address per human alive. Same seed, same human,
byte-identical, forever. No storage: any of the 8 billion profiles materializes
on demand and is thrown away. No real person's data is used or reproduced.

This is the substrate for training, evaluating, and red-teaming personal
superintelligence **before it ever touches a real human's life** — a
Scale-AI-caliber data asset with, structurally, none of the PII liability.

## What the scale claims actually mean (be precise; it's the point)

| Claim | What it means, exactly |
|---|---|
| **8B address space** | Seeds `[0, 8e9)`. Every seed is O(1)-addressable and reproducible. This is a *guarantee about coverage*, not a stored table. |
| **1B baseline** | A materialized sample of that space (JSONL, or landed on app tables). Not stored by default — generated when needed. Cost below. |
| **0 PII** | Names/emails/phones are synthetic anchors on reserved ranges (`@profiles.example`, `+999…`). Every document carries `synthetic: true`. |
| **∞ scenarios** | Any seed, any cohort slice, any marginals version — an unbounded scenario generator, not a fixed corpus. |

Measure it yourself — the benchmark reports real throughput and an *honest*
extrapolation, never a marketing number:

```
python -m scripts.synthetic_profiles.cli bench --count 50000
```

On a single modern core this is ~7–8k profiles/sec, so the **1B baseline is
tens of core-hours** (well under an hour on 64 cores) and the **full 8B is a few
core-hours on a modest cluster** — generation is embarrassingly parallel (pure
function of seed), so throughput scales ~linearly with cores. Storage stays at
zero because the seed *is* the profile.

## Design properties that survive scrutiny

- **Deterministic & machine-independent.** The RNG is seeded from
  `sha256(marginals_version : seed)`; output depends only on that. Frozen golden
  hashes (`tests/synthetic/test_scale_hardening.py`) fail loudly if a Python or
  stdlib upgrade ever perturbs the stream.
- **Unique ids across the whole space.** `profile_id` is a 96-bit (24-hex)
  sha256 truncation. Expected collisions across all 8B: ~4e-10. (A 64-bit id
  would have collided ~1.7 times — fixed.)
- **Self-describing provenance.** Every document embeds `synthetic: true` and
  its `marginals_version`, so `(seed + marginals_version)` reproduces it from the
  JSON alone — no out-of-band context, and nothing can be mistaken for real data.
- **Representative, not the rich-web sliver.** Region, age, income tier,
  urbanicity, education, occupation, household, devices, and consent posture are
  drawn against coarse 2026 world marginals (`marginals.py`). `stats` reports
  observed-vs-target deviation.
- **Internally coherent.** A "Priya" is never emitted male; children aren't
  investors; wealth tracks income tier; consent stance shapes share-willingness.

## The 90-second demo (deterministic, reproducible from an integer)

```bash
# 1. A vivid, coherent human from a single number — regenerate anywhere, same result.
python -m scripts.synthetic_profiles.cli generate --seed 4193772206

# 2. The population is honest about the whole world, not the online rich.
python -m scripts.synthetic_profiles.cli stats --count 20000

# 3. Prove the scale claim — measured throughput + honest core-hour extrapolation.
python -m scripts.synthetic_profiles.cli bench --count 50000

# 4. Address any sub-population for targeted training/eval — with an honest yield.
python -m scripts.synthetic_profiles.cli cohort --region sub_saharan_africa \
    --stance fortress --min-age 30 --max-age 55

# 5. Schema-valid, unique, deterministic — checked, not asserted.
python -m scripts.synthetic_profiles.cli validate --count 1000
```

The four curated showcase humans (open → pragmatic → guarded → fortress, across
regions) live in `heroes.py` and reproduce from their seeds alone.

## Layout

| File | Role |
|---|---|
| `generator.py` | `generate(seed)` — the pure function. Stdlib only. |
| `marginals.py` | Editable world distributions + name/gender banks. Bump `MARGINALS_VERSION` on change. |
| `heroes.py` | Curated showcase seeds with headlines. |
| `cli.py` | `generate` / `sample` / `stats` / `validate` / `bench` / `cohort`. |
| `schema/humanprofile_v0.schema.json` | The document contract (JSON Schema 2020-12). |

## Honest status

The generation engine, marginals, CLI, schema, and tests are real and green.
Landing profiles onto live app tables (vault keys, actor rows, PKM documents) and
persisting/tiering a standing 1B baseline in BigQuery/GCS are the next
increments — the engine makes them a throughput exercise, not a research risk.
