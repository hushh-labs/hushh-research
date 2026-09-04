"""HumanProfile v0 deterministic generator.

profile(seed) is a PURE FUNCTION: the same seed always yields byte-identical
JSON, on any machine, forever (given the same MARGINALS_VERSION). That is the
whole scaling trick — an 8-billion-profile address space with zero storage.

Stdlib only. No network, no clock (timestamps are seed-derived), no randomness
outside random.Random(seed).
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from typing import Any

from . import marginals as M

SCHEMA_VERSION = "humanprofile/v0"
ADDRESS_SPACE = 8_000_000_000  # seeds [0, 8e9): one per human alive

# profile_id is sha256(seed) truncated to this many hex chars. 24 hex = 96 bits.
# At the full 8B population the expected number of id collisions is
# N^2 / (2 * 2^96) ~= 4e-10, so ids are unique across every human in the space.
# (A 64-bit / 16-hex id would collide ~1.7 times over 8B — not acceptable for an
# id that doubles as a stable user_id.)
PROFILE_ID_HEX = 24

SCHEMA_PATH = Path(__file__).parent / "schema" / "humanprofile_v0.schema.json"

# Fixed epoch for seed-derived "recent activity" timestamps so generation is
# reproducible (never wall-clock). 2026-01-01T00:00:00Z in epoch millis.
_EPOCH_2026_MS = 1_767_225_600_000


def _weighted(rng: random.Random, pairs: list[tuple[str, float]]) -> str:
    total = sum(w for _, w in pairs)
    x = rng.random() * total
    acc = 0.0
    for value, weight in pairs:
        acc += weight
        if x <= acc:
            return value
    return pairs[-1][0]


def _pick(rng: random.Random, pool: list[str], k: int) -> list[str]:
    k = max(0, min(k, len(pool)))
    return rng.sample(pool, k)


def _clamp(value: int, lo: int = 0, hi: int = 100) -> int:
    return max(lo, min(hi, value))


def profile_id_for_seed(seed: int) -> str:
    digest = hashlib.sha256(f"humanprofile/v0:{seed}".encode()).hexdigest()
    return f"synth_{digest[:PROFILE_ID_HEX]}"


def generate(seed: int) -> dict[str, Any]:
    """Generate the HumanProfile v0 document for a seed. Pure and deterministic."""
    if not 0 <= seed < ADDRESS_SPACE:
        raise ValueError(f"seed must be in [0, {ADDRESS_SPACE})")

    # noqa on S311: deterministic simulation, not cryptography — the whole design
    # is a reproducible pseudo-random stream keyed by (marginals_version, seed).
    rng = random.Random(hashlib.sha256(f"{M.MARGINALS_VERSION}:{seed}".encode()).digest())  # noqa: S311
    pid = profile_id_for_seed(seed)

    # ---- demographics (stratified) ----
    region = _weighted(rng, M.REGION_WEIGHTS)
    zone = rng.choice(M.COUNTRY_ZONES[region])
    band_index = int(_weighted(rng, [(str(i), w) for i, (_, _, w) in enumerate(M.AGE_BANDS)]))
    lo, hi, _ = M.AGE_BANDS[band_index]
    age = rng.randint(lo, hi)
    sex = _weighted(rng, M.SEX_WEIGHTS)
    urbanicity = _weighted(rng, M.URBANICITY[region])
    income_tier = _weighted(rng, M.INCOME_TIERS[region])
    education = "none_or_primary" if age < 12 else _weighted(rng, M.EDUCATION_BY_TIER[income_tier])

    if age < 15:
        occ_group, occ_status = "student", "student"
    elif age < 23 and rng.random() < 0.55:
        occ_group, occ_status = "student", "student"
    elif age >= 66 and rng.random() < 0.7:
        occ_group, occ_status = "retired", "retired"
    else:
        occ_group = _weighted(rng, M.OCCUPATION_BY_URBANICITY[urbanicity])
        occ_status = {
            "informal_gig": "gig",
            "homemaker": "homemaker",
            "unemployed": "unemployed",
        }.get(occ_group, "self_employed" if rng.random() < 0.25 else "employed")
    occ_title = rng.choice(M.OCCUPATION_TITLES[occ_group])

    household_type = next(
        _weighted(rng, dist) for cutoff, dist in M.HOUSEHOLD_BY_AGE if age <= cutoff
    )
    household_size = {
        "single": 1,
        "couple": 2,
        "shared": rng.randint(2, 5),
        "single_parent": rng.randint(2, 5),
        "nuclear_family": rng.randint(3, 6),
        "multigenerational": rng.randint(4, 10),
        "institutional": rng.randint(6, 14),
    }[household_type]
    dependents = 0
    if household_type in ("nuclear_family", "single_parent", "multigenerational") and age >= 20:
        dependents = rng.randint(0, min(5, household_size - 1))

    langs = M.LANGUAGES[region]
    languages = [langs[rng.randrange(min(4, len(langs)))]]
    while rng.random() < 0.45 and len(languages) < 3:
        extra = rng.choice(langs)
        if extra not in languages:
            languages.append(extra)

    disability: list[str] = []
    if rng.random() < 0.16:
        disability.append(
            rng.choice(["vision", "hearing", "mobility", "cognitive", "chronic_pain"])
        )
    else:
        disability.append("none")

    # ---- identity ----
    given_bank, family_bank = M.NAME_BANKS[region]
    given = rng.choice(given_bank)
    family = rng.choice(family_bank)
    # Keep sex coherent with the given name (a "Priya" is never emitted as male).
    # Intersex profiles keep their drawn sex and they/them pronouns regardless of
    # the name. This overrides only the drawn sex; no other field depends on it, so
    # every other value for a given seed is unchanged.
    if sex != "intersex":
        sex = M.GIVEN_NAME_SEX.get(given, sex)
    lang_tag = {
        "south_asia": "en-IN",
        "east_asia": "zh-CN",
        "sub_saharan_africa": "en-KE",
        "southeast_asia": "id-ID",
        "europe": "en-GB",
        "latam_caribbean": "es-MX",
        "mena": "ar-EG",
        "north_america": "en-US",
        "central_asia_oceania": "en-AU",
    }[region]
    email = f"{given.lower()}.{family.lower().replace(' ', '')}.{pid[-6:]}@profiles.example"
    phone_anchor = f"+999{seed % 10_000_000_000:010d}"  # +999 reserved/fictional prefix

    # ---- psychographics (mildly correlated axes) ----
    base = rng.gauss(50, 18)
    traits = {
        "openness": _clamp(
            int(rng.gauss(50 + (education in ("tertiary", "postgraduate")) * 8, 16))
        ),
        "conscientiousness": _clamp(int(rng.gauss(52, 16))),
        "extraversion": _clamp(int(rng.gauss(50, 18))),
        "agreeableness": _clamp(int(rng.gauss(54, 15))),
        "emotional_stability": _clamp(int(rng.gauss(base * 0.3 + 35, 14))),
    }
    risk_tolerance = _clamp(
        int(
            rng.gauss(
                38
                + traits["openness"] * 0.2
                + (income_tier in ("t4_50_to_200usd_day", "t5_over_200usd_day")) * 10
                - max(0, age - 50) * 0.4,
                14,
            )
        )
    )

    # ---- world model ----
    relationships = []
    rel_roles = [
        "parent",
        "sibling",
        "spouse",
        "child",
        "close friend",
        "cousin",
        "neighbor",
        "coworker",
        "mentor",
        "accountant",
        "doctor",
        "community elder",
    ]
    for role in _pick(rng, rel_roles, rng.randint(3, 7)):
        closeness = _weighted(
            rng, [("inner_circle", 0.25), ("close", 0.35), ("regular", 0.3), ("peripheral", 0.1)]
        )
        trusted_for = []
        if role in ("spouse", "parent") and closeness == "inner_circle":
            trusted_for = ["attr.financial", "attr.health", "attr.location"]
        elif role == "accountant":
            trusted_for = ["attr.financial"]
        elif role == "doctor":
            trusted_for = ["attr.health"]
        elif closeness in ("inner_circle", "close"):
            trusted_for = [rng.choice(["attr.location", "attr.social", "attr.entertainment"])]
        relationships.append({"role": role, "closeness": closeness, "trusted_for": trusted_for})

    places = [{"kind": "home", "label": f"{urbanicity} home, {zone}"}]
    if occ_status in ("employed", "self_employed", "gig"):
        places.append({"kind": "work", "label": occ_title})
    if occ_status == "student":
        places.append({"kind": "school", "label": "campus"})
    for kind in _pick(
        rng, ["market", "worship", "clinic", "gym", "third_place"], rng.randint(1, 3)
    ):
        places.append({"kind": kind, "label": kind})

    routines = _pick(
        rng,
        [
            "early riser",
            "evening market run",
            "weekly family call",
            "daily commute",
            "weekend religious service",
            "morning exercise",
            "late-night study",
            "seasonal harvest rhythm",
            "monthly remittance day",
            "weekly ledger day",
        ],
        rng.randint(2, 4),
    )

    devices = [_weighted(rng, M.DEVICES_BY_TIER[income_tier])]
    if rng.random() < 0.4:
        extra_device = _weighted(rng, M.DEVICES_BY_TIER[income_tier])
        if extra_device not in devices:
            devices.append(extra_device)

    # ---- knowledge model ----
    has_bank = income_tier not in ("t1_under_2usd_day",) or rng.random() < 0.35
    risk_profile = ("conservative", "balanced", "growth", "aggressive")[
        min(3, risk_tolerance // 26)
    ]
    holdings: list[dict[str, Any]] = []
    total_value = 0.0
    if age >= 18:
        wealth_scale = {
            "t1_under_2usd_day": 120,
            "t2_2_to_10usd_day": 900,
            "t3_10_to_50usd_day": 14_000,
            "t4_50_to_200usd_day": 90_000,
            "t5_over_200usd_day": 600_000,
        }[income_tier]
        n_holdings = 0 if wealth_scale < 500 else rng.randint(1, 3 + (wealth_scale > 50_000) * 4)
        asset_pools = {
            True: ["equity", "etf", "bond", "cash", "gold", "crypto", "real_estate"],
            False: ["cash", "gold", "livestock", "informal_savings"],
        }[wealth_scale >= 14_000]
        tickers = [
            "VTI",
            "VXUS",
            "BND",
            "GLD",
            "AAPL",
            "MSFT",
            "NVDA",
            "RELIANCE",
            "TSM",
            "SAP",
            "VALE",
            "BTC",
        ]
        for _ in range(n_holdings):
            asset = rng.choice(asset_pools)
            value = round(wealth_scale * rng.uniform(0.1, 0.9), 2)
            holdings.append(
                {
                    "ticker": rng.choice(tickers)
                    if asset in ("equity", "etf")
                    else asset.upper()[:6],
                    "asset_class": asset,
                    "value_usd": value,
                }
            )
            total_value += value
        if has_bank:
            cash = round(wealth_scale * rng.uniform(0.05, 0.4), 2)
            holdings.append({"ticker": "CASH", "asset_class": "cash", "value_usd": cash})
            total_value += cash
    debts = _pick(
        rng,
        [
            "home loan",
            "vehicle loan",
            "education loan",
            "shop credit",
            "medical debt",
            "credit card",
            "family loan",
        ],
        rng.randint(0, 2),
    )
    money_goals = _pick(rng, M.ASPIRATIONS_POOL, 2)

    knowledge_model = {
        "financial": {
            "has_bank_account": bool(has_bank),
            "risk_profile": risk_profile,
            "risk_score": risk_tolerance,
            "holdings": holdings,
            "total_value_usd": round(total_value, 2),
            "debts": debts,
            "money_goals": money_goals,
        },
        "professional": {
            "skills": _pick(
                rng,
                [
                    "negotiation",
                    "bookkeeping",
                    "customer care",
                    "coding",
                    "machine repair",
                    "teaching",
                    "logistics",
                    "design",
                    "irrigation",
                    "sales",
                    "writing",
                    "first aid",
                ],
                rng.randint(2, 4),
            ),
            "years_experience": max(0, age - 18 - rng.randint(0, 6))
            if occ_status not in ("student",)
            else 0,
            "work_style": rng.choice(
                [
                    "steady and careful",
                    "fast and improvisational",
                    "collaborative",
                    "independent",
                    "seasonal bursts",
                ]
            ),
        },
        "social": {
            "community_roles": _pick(
                rng,
                [
                    "religious group member",
                    "sports club",
                    "parents' association",
                    "savings circle",
                    "union member",
                    "volunteer",
                    "online community mod",
                ],
                rng.randint(0, 2),
            ),
            "network_size_bucket": _weighted(
                rng, [("tight", 0.3), ("moderate", 0.4), ("wide", 0.24), ("very_wide", 0.06)]
            ),
        },
        "health": {
            "fitness_habit": _weighted(
                rng,
                [
                    ("sedentary", 0.28),
                    ("light", 0.32),
                    ("moderate", 0.24),
                    ("active", 0.13),
                    ("athlete", 0.03),
                ],
            ),
            "conditions_bucket": (
                ["none"]
                if age < 35 and rng.random() < 0.75
                else _pick(
                    rng,
                    [
                        "metabolic",
                        "cardio",
                        "respiratory",
                        "musculoskeletal",
                        "mental_wellness",
                        "vision_hearing",
                    ],
                    rng.randint(1, 2),
                )
            ),
            "sleep_pattern": _weighted(
                rng, [("short", 0.22), ("irregular", 0.26), ("regular", 0.44), ("long", 0.08)]
            ),
        },
        "interests": _pick(rng, M.INTERESTS_POOL, rng.randint(3, 6)),
    }

    # ---- behavioral signals ----
    digital_hours = round(
        max(
            0.0,
            rng.gauss(
                {"feature_phone": 1.2, "none": 0.2}.get(devices[0], 3.8)
                + (age < 30) * 1.2
                - (age > 60) * 1.0,
                1.4,
            ),
        ),
        1,
    )
    behavioral = {
        "digital_hours_per_day": min(18.0, digital_hours),
        "primary_jobs_to_be_done": _pick(rng, M.JOBS_TO_BE_DONE_POOL, rng.randint(2, 4)),
        "shopping_style": _weighted(
            rng,
            [
                ("necessity_only", 0.24),
                ("value_hunter", 0.30),
                ("planner", 0.20),
                ("impulse", 0.14),
                ("premium", 0.07),
                ("ethical", 0.05),
            ],
        ),
        "media_diet": _pick(rng, M.MEDIA_DIET_POOL, rng.randint(2, 4)),
        "agent_use_cases": _pick(
            rng,
            [
                "taxes and paperwork",
                "price comparison",
                "appointment wrangling",
                "family logistics",
                "money tracking",
                "learning plans",
                "health reminders",
                "document vault",
                "job search",
                "translations",
            ],
            rng.randint(2, 4),
        ),
    }

    # ---- consent posture ----
    stance = _weighted(
        rng, [("open", 0.14), ("pragmatic", 0.46), ("guarded", 0.3), ("fortress", 0.1)]
    )
    stance_base = {"open": 72, "pragmatic": 55, "guarded": 34, "fortress": 15}[stance]
    share = {
        fam: _clamp(
            int(
                rng.gauss(
                    stance_base
                    + (12 if fam in ("attr.entertainment", "attr.shopping") else 0)
                    - (18 if fam in ("attr.health", "attr.financial") else 0),
                    12,
                )
            )
        )
        for fam in M.SCOPE_FAMILIES
    }
    consent_posture = {
        "privacy_stance": stance,
        "default_grant_duration_days": rng.choice([7, 14, 30, 30, 60, 90]),
        "share_willingness": share,
        "revocation_tendency": _weighted(
            rng, [("rarely", 0.5), ("sometimes", 0.38), ("often", 0.12)]
        ),
    }

    return {
        "schema_version": SCHEMA_VERSION,
        # Provenance: every document is self-describing and un-mistakable for real
        # data. `synthetic` is always true; `marginals_version` pins WHICH world
        # distributions produced this profile, so (seed + marginals_version) fully
        # reproduces it — the JSON alone is enough, no out-of-band context needed.
        "synthetic": True,
        "marginals_version": M.MARGINALS_VERSION,
        "seed": seed,
        "profile_id": pid,
        "identity": {
            "display_name": f"{given} {family}",
            "given_name": given,
            "family_name": family,
            "email": email,
            "phone_anchor": phone_anchor,
            "locale": lang_tag,
            "pronouns": {"female": "she/her", "male": "he/him", "intersex": "they/them"}[sex],
        },
        "demographics": {
            "region": region,
            "country_zone": zone,
            "age": age,
            "sex": sex,
            "urbanicity": urbanicity,
            "household": {"size": household_size, "type": household_type, "dependents": dependents},
            "education_level": education,
            "occupation": {"group": occ_group, "title": occ_title, "status": occ_status},
            "income_tier": income_tier,
            "languages": languages,
            "disability": disability,
        },
        "psychographics": {
            "traits": traits,
            "values": _pick(rng, M.VALUES_POOL, rng.randint(2, 4)),
            "aspirations": _pick(rng, M.ASPIRATIONS_POOL, rng.randint(1, 3)),
            "stressors": _pick(rng, M.STRESSORS_POOL, rng.randint(1, 3)),
            "risk_tolerance": risk_tolerance,
        },
        "world_model": {
            "relationships": relationships,
            "places": places,
            "routines": routines,
            "devices": devices,
        },
        "knowledge_model": knowledge_model,
        "behavioral_signals": behavioral,
        "consent_posture": consent_posture,
    }


def canonical_json(profile: dict[str, Any]) -> str:
    return json.dumps(profile, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text())
