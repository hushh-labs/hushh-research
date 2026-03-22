#!/usr/bin/env python3
"""Run a non-saving PKM structure-agent benchmark over chained prompt sequences.

This harness is intentionally evaluation-only:
- It never writes to PKM tables.
- It can replay against real UAT PKM baselines in read-only mode.
- It is designed to stress ontology, mutation handling, and domain compactness.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
MONOREPO_ROOT = CONSENT_PROTOCOL_ROOT.parent
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from hushh_mcp.services.domain_contracts import CANONICAL_DOMAIN_REGISTRY  # noqa: E402
from hushh_mcp.services.personal_knowledge_model_service import (  # noqa: E402
    PersonalKnowledgeModelService,
)
from hushh_mcp.services.pkm_agent_lab_service import get_pkm_agent_lab_service  # noqa: E402

DEFAULT_ENV_FILE = CONSENT_PROTOCOL_ROOT / ".env.local-uatdb.local"
DEFAULT_REPORT_PATH = CONSENT_PROTOCOL_ROOT / "artifacts" / "pkm_structure_agent_eval_latest.json"
DEFAULT_PRIMARY_MODEL = "gemini-3.1-flash-lite-preview"
DEFAULT_SECONDARY_MODEL = ""
DEFAULT_REFERENCE_MODEL = ""
DEFAULT_SHADOW_USERS = [
    "s3xmA4lNSAQFrIaOytnSGAOzXlL2",
    "UWHGeUyfUAbmEl5xwIPoWJ7Cyft2",
]
PHASE_ORDER = ("fresh_random_120", "fresh_chain_60", "fresh_chain_120")
PHASE_PROMPT_LIMIT = {
    "fresh_random_120": 120,
    "fresh_chain_60": 60,
    "fresh_chain_120": 120,
}
_GENERAL_DOMAIN_KEY = "general"
_FINANCIAL_HINTS = {
    "stock",
    "portfolio",
    "investment",
    "invest",
    "broker",
    "plaid",
    "retirement",
    "401k",
    "ira",
    "dividend",
    "volatility",
    "risk",
    "budget",
    "spending",
    "statement",
}
_FOOD_HINTS = {
    "food",
    "meal",
    "restaurant",
    "eat",
    "cuisine",
    "spicy",
    "breakfast",
    "lunch",
    "dinner",
}
_TRAVEL_HINTS = {
    "travel",
    "trip",
    "flight",
    "hotel",
    "airport",
    "airline",
    "seat",
    "packing",
}
_HEALTH_HINTS = {
    "allergic",
    "allergy",
    "health",
    "doctor",
    "sleep",
    "workout",
    "run",
    "hydrated",
    "gluten",
    "dairy",
}
_SHOPPING_HINTS = {
    "buy",
    "shopping",
    "brand",
    "purchase",
    "wishlist",
    "deliveries",
    "grocery",
}
_RELATIONSHIP_HINTS = {
    "mom",
    "dad",
    "wife",
    "husband",
    "spouse",
    "partner",
    "brother",
    "friend",
    "family",
    "daughter",
    "son",
    "cousin",
    "grandmother",
}
_PROFESSIONAL_HINTS = {
    "work",
    "office",
    "career",
    "calendar",
    "consulting",
    "professional",
    "meeting",
}


def _registry_override() -> list[dict[str, str]]:
    return [
        {
            "domain_key": entry.domain_key,
            "display_name": entry.display_name,
            "description": entry.description,
        }
        for entry in CANONICAL_DOMAIN_REGISTRY
        if entry.domain_key != _GENERAL_DOMAIN_KEY
    ]


@dataclass(frozen=True)
class PromptCase:
    case_id: str
    message: str
    expected_save_class: str
    expected_intent_class: str
    expected_mutation_intent: str
    expected_domains: tuple[str, ...]
    expect_confirmation: bool
    category: str


@dataclass(frozen=True)
class PersonaSeed:
    persona_id: str
    name: str
    cuisine: str
    alt_cuisine: str
    seat_preference: str
    corrected_seat_preference: str
    morning_routine: str
    health_fact: str
    relationship_fact: str
    shopping_brand: str
    goal: str
    deleted_habit: str
    home_base: str
    finance_preference: str


@dataclass
class EvaluationResult:
    case_id: str
    message: str
    category: str
    expected_save_class: str
    expected_intent_class: str
    expected_mutation_intent: str
    expected_domains: list[str]
    expect_confirmation: bool
    latency_ms: float
    actual_save_class: str
    actual_intent_class: str
    actual_mutation_intent: str
    actual_domain: str
    actual_write_mode: str
    requires_confirmation: bool
    validation_hints: list[str]
    used_fallback: bool
    timed_out: bool
    finance_contamination: bool
    unresolved_domain: bool
    save_class_ok: bool
    intent_ok: bool
    mutation_ok: bool
    domain_ok: bool
    confirmation_ok: bool
    schema_ok: bool


PERSONA_SEEDS: tuple[PersonaSeed, ...] = (
    PersonaSeed(
        persona_id="persona_01",
        name="Avery",
        cuisine="Chinese",
        alt_cuisine="Thai",
        seat_preference="aisle",
        corrected_seat_preference="window",
        morning_routine="run at 6:30 every morning",
        health_fact="I'm allergic to peanuts",
        relationship_fact="My spouse is Maya",
        shopping_brand="Patagonia",
        goal="save for a condo by 2028",
        deleted_habit="weekly meal prep",
        home_base="San Francisco",
        finance_preference="I prefer dividend-paying stocks",
    ),
    PersonaSeed(
        persona_id="persona_02",
        name="Jordan",
        cuisine="Indian",
        alt_cuisine="Japanese",
        seat_preference="window",
        corrected_seat_preference="aisle",
        morning_routine="journal before breakfast",
        health_fact="I get migraines from too little sleep",
        relationship_fact="My brother is Arjun",
        shopping_brand="Nike",
        goal="pay off my student loans in three years",
        deleted_habit="late-night caffeine",
        home_base="Seattle",
        finance_preference="I want lower portfolio volatility",
    ),
    PersonaSeed(
        persona_id="persona_03",
        name="Sam",
        cuisine="Italian",
        alt_cuisine="Mexican",
        seat_preference="aisle",
        corrected_seat_preference="window",
        morning_routine="stretch for 15 minutes after waking up",
        health_fact="I have a shellfish allergy",
        relationship_fact="My partner is Lucia",
        shopping_brand="Sony",
        goal="plan a sabbatical in 2027",
        deleted_habit="weekly takeout nights",
        home_base="Austin",
        finance_preference="I care most about long-term growth",
    ),
    PersonaSeed(
        persona_id="persona_04",
        name="Riley",
        cuisine="Korean",
        alt_cuisine="Mediterranean",
        seat_preference="window",
        corrected_seat_preference="aisle",
        morning_routine="walk the dog before work",
        health_fact="I'm lactose intolerant",
        relationship_fact="My daughter is Zoe",
        shopping_brand="Apple",
        goal="build a six-month emergency fund",
        deleted_habit="buying coffee every afternoon",
        home_base="Denver",
        finance_preference="I want more tax-efficient investing",
    ),
    PersonaSeed(
        persona_id="persona_05",
        name="Quinn",
        cuisine="Vietnamese",
        alt_cuisine="Greek",
        seat_preference="aisle",
        corrected_seat_preference="window",
        morning_routine="read for 20 minutes every morning",
        health_fact="I need to avoid gluten",
        relationship_fact="My best friend is Eliana",
        shopping_brand="Lululemon",
        goal="train for a half marathon",
        deleted_habit="Sunday doomscrolling",
        home_base="Chicago",
        finance_preference="I want more international diversification",
    ),
    PersonaSeed(
        persona_id="persona_06",
        name="Harper",
        cuisine="Mexican",
        alt_cuisine="Ethiopian",
        seat_preference="window",
        corrected_seat_preference="aisle",
        morning_routine="meditate before checking email",
        health_fact="I need to track my blood pressure",
        relationship_fact="My mom lives in Phoenix",
        shopping_brand="Levi's",
        goal="save for a family trip to Spain",
        deleted_habit="impulse grocery shopping",
        home_base="Los Angeles",
        finance_preference="I prefer index funds over single stocks",
    ),
    PersonaSeed(
        persona_id="persona_07",
        name="Blake",
        cuisine="Japanese",
        alt_cuisine="Chinese",
        seat_preference="aisle",
        corrected_seat_preference="window",
        morning_routine="lift weights before breakfast",
        health_fact="I need eight hours of sleep",
        relationship_fact="My son is Theo",
        shopping_brand="Adidas",
        goal="launch my consulting practice",
        deleted_habit="keeping unused subscriptions",
        home_base="Portland",
        finance_preference="I want steadier dividend income",
    ),
    PersonaSeed(
        persona_id="persona_08",
        name="Taylor",
        cuisine="Mediterranean",
        alt_cuisine="Indian",
        seat_preference="window",
        corrected_seat_preference="aisle",
        morning_routine="practice piano after coffee",
        health_fact="I need to avoid dairy",
        relationship_fact="My fiancé is Daniel",
        shopping_brand="Allbirds",
        goal="buy a house with a bigger kitchen",
        deleted_habit="booking red-eye flights",
        home_base="Boston",
        finance_preference="I prefer balanced portfolios",
    ),
    PersonaSeed(
        persona_id="persona_09",
        name="Morgan",
        cuisine="Thai",
        alt_cuisine="Italian",
        seat_preference="aisle",
        corrected_seat_preference="window",
        morning_routine="review my calendar after breakfast",
        health_fact="I should limit sodium",
        relationship_fact="My grandmother is Nora",
        shopping_brand="Dyson",
        goal="reduce monthly fixed expenses",
        deleted_habit="snacking after 10 pm",
        home_base="New York",
        finance_preference="I want to lower concentration risk",
    ),
    PersonaSeed(
        persona_id="persona_10",
        name="Casey",
        cuisine="Greek",
        alt_cuisine="Vietnamese",
        seat_preference="window",
        corrected_seat_preference="aisle",
        morning_routine="write for 30 minutes before work",
        health_fact="I need to stay hydrated during long flights",
        relationship_fact="My cousin is Priya",
        shopping_brand="Samsung",
        goal="take a month-long trip through Japan",
        deleted_habit="ordering lunch every workday",
        home_base="Miami",
        finance_preference="I prefer automatic monthly investing",
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark PKM structure agent without saving.")
    parser.add_argument(
        "--phase",
        choices=PHASE_ORDER,
        default="fresh_random_120",
        help="Benchmark phase: 120 fresh single-turn prompts, 60 chained prompts, or 120 chained prompts.",
    )
    parser.add_argument(
        "--env-file",
        default=str(DEFAULT_ENV_FILE),
        help="Optional env file for UAT-backed read-only shadow replay.",
    )
    parser.add_argument(
        "--json-out",
        default=str(DEFAULT_REPORT_PATH),
        help="Where to write the JSON benchmark report.",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_PRIMARY_MODEL,
        help="Primary PKM classifier candidate model.",
    )
    parser.add_argument(
        "--secondary-model",
        default=DEFAULT_SECONDARY_MODEL,
        help="Unused in the current single-model PKM eval flow.",
    )
    parser.add_argument(
        "--reference-model",
        default=DEFAULT_REFERENCE_MODEL,
        help="Unused in the current single-model PKM eval flow.",
    )
    parser.add_argument(
        "--per-prompt-timeout-seconds",
        type=float,
        default=25.0,
        help="Per-prompt live model timeout in seconds.",
    )
    parser.add_argument(
        "--skip-shadow",
        action="store_true",
        help="Skip the read-only UAT shadow replay.",
    )
    parser.add_argument(
        "--max-prompts-per-persona",
        type=int,
        default=max(PHASE_PROMPT_LIMIT.values()),
        help="Limit prompts per synthetic persona for quicker local iterations.",
    )
    parser.add_argument(
        "--shadow-users",
        nargs="*",
        default=DEFAULT_SHADOW_USERS,
        help="Optional explicit shadow replay user IDs.",
    )
    return parser.parse_args()


def _tokenize(message: str) -> set[str]:
    return {
        token.strip(".,!?;:\"'()[]{}").lower()
        for token in message.split()
        if token.strip(".,!?;:\"'()[]{}")
    }


def _normalized_expected_domains(
    *,
    domains: tuple[str, ...],
    intent: str,
    message: str,
) -> tuple[str, ...]:
    filtered = [domain for domain in domains if domain and domain != _GENERAL_DOMAIN_KEY]
    if filtered:
        return tuple(dict.fromkeys(filtered))

    lowered = message.lower()
    tokens = _tokenize(message)
    ranked: list[str] = []

    def _include_if(hints: set[str], domain: str) -> None:
        if any(token in tokens or token in lowered for token in hints):
            ranked.append(domain)

    _include_if(_FINANCIAL_HINTS, "financial")
    _include_if(_FOOD_HINTS, "food")
    _include_if(_TRAVEL_HINTS, "travel")
    _include_if(_HEALTH_HINTS, "health")
    _include_if(_SHOPPING_HINTS, "shopping")
    _include_if(_RELATIONSHIP_HINTS, "social")
    _include_if(_PROFESSIONAL_HINTS, "professional")

    intent_defaults = {
        "preference": ("food", "travel", "shopping", "professional"),
        "profile_fact": ("location", "social", "professional"),
        "routine": ("health", "professional"),
        "task_or_reminder": ("professional", "travel", "shopping", "social"),
        "plan_or_goal": ("financial", "travel", "professional", "health"),
        "relationship": ("social",),
        "health": ("health",),
        "travel": ("travel",),
        "shopping_need": ("shopping",),
        "financial_event": ("financial",),
        "correction": ("professional", "travel", "health", "food", "financial"),
        "deletion": ("professional", "travel", "health", "food", "financial"),
        "note": ("professional", "travel", "shopping", "food"),
        "ambiguous": ("professional", "travel", "shopping", "food"),
    }
    ordered = [
        *ranked,
        *intent_defaults.get(intent, ("professional", "travel", "shopping", "food")),
    ]
    unique = []
    seen = set()
    for domain in ordered:
        if domain and domain not in seen:
            seen.add(domain)
            unique.append(domain)
    return tuple(unique[:4] or ("professional", "travel", "shopping", "food"))


def _build_persona_chain(seed: PersonaSeed) -> list[PromptCase]:
    prompts: list[PromptCase] = []
    add = prompts.append
    health_fact_tail = seed.health_fact.lower().replace("i'm ", "").replace("i need to ", "")
    relationship_tail = (
        seed.relationship_fact.lower().replace("my ", "").replace(" is ", " and their name is ")
    )

    def case(
        index: int,
        *,
        message: str,
        save_class: str,
        intent: str,
        mutation: str,
        domains: tuple[str, ...],
        confirm: bool,
        category: str,
    ) -> None:
        add(
            PromptCase(
                case_id=f"{seed.persona_id}_{index:03d}",
                message=message,
                expected_save_class=save_class,
                expected_intent_class=intent,
                expected_mutation_intent=mutation,
                expected_domains=_normalized_expected_domains(
                    domains=domains,
                    intent=intent,
                    message=message,
                ),
                expect_confirmation=confirm,
                category=category,
            )
        )

    # 1-10 durable preferences and profile facts
    case(
        1,
        message=f"I like {seed.cuisine} food.",
        save_class="durable",
        intent="preference",
        mutation="create",
        domains=("food",),
        confirm=False,
        category="food_preference",
    )
    case(
        2,
        message=f"I also enjoy {seed.alt_cuisine} food.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("food",),
        confirm=False,
        category="food_preference",
    )
    case(
        3,
        message=f"I prefer {seed.seat_preference} seats when I fly.",
        save_class="durable",
        intent="preference",
        mutation="create",
        domains=("travel",),
        confirm=False,
        category="travel_preference",
    )
    case(
        4,
        message=seed.health_fact,
        save_class="durable",
        intent="health",
        mutation="create",
        domains=("health",),
        confirm=False,
        category="health",
    )
    case(
        5,
        message=seed.relationship_fact,
        save_class="durable",
        intent="relationship",
        mutation="create",
        domains=("social",),
        confirm=False,
        category="relationship",
    )
    case(
        6,
        message=f"My home base is {seed.home_base}.",
        save_class="durable",
        intent="profile_fact",
        mutation="create",
        domains=("location", "general"),
        confirm=False,
        category="profile_fact",
    )
    case(
        7,
        message=f"I usually {seed.morning_routine}.",
        save_class="durable",
        intent="routine",
        mutation="create",
        domains=("health", "general"),
        confirm=False,
        category="routine",
    )
    case(
        8,
        message=f"My favorite shopping brand is {seed.shopping_brand}.",
        save_class="durable",
        intent="preference",
        mutation="create",
        domains=("shopping",),
        confirm=False,
        category="shopping",
    )
    case(
        9,
        message=f"I want to {seed.goal}.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="create",
        domains=("financial", "travel", "general"),
        confirm=False,
        category="goal",
    )
    case(
        10,
        message=seed.finance_preference,
        save_class="durable",
        intent="financial_event",
        mutation="create",
        domains=("financial",),
        confirm=False,
        category="finance",
    )

    # 11-20 extensions and paraphrases
    case(
        11,
        message=f"I still really like {seed.cuisine} food.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("food",),
        confirm=False,
        category="duplicate_food",
    )
    case(
        12,
        message=f"When I travel, {seed.seat_preference} seats help me focus.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("travel",),
        confirm=False,
        category="travel_preference",
    )
    case(
        13,
        message=f"I keep coming back to {seed.shopping_brand} for basics.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("shopping",),
        confirm=False,
        category="shopping",
    )
    case(
        14,
        message=f"{seed.home_base} is still my primary base.",
        save_class="durable",
        intent="profile_fact",
        mutation="extend",
        domains=("location", "general"),
        confirm=False,
        category="profile_fact",
    )
    case(
        15,
        message=f"My goal is still to {seed.goal}.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="extend",
        domains=("financial", "travel", "general"),
        confirm=False,
        category="goal",
    )
    case(
        16,
        message=f"I usually {seed.morning_routine}, even on weekends.",
        save_class="durable",
        intent="routine",
        mutation="extend",
        domains=("health", "general"),
        confirm=False,
        category="routine",
    )
    case(
        17,
        message=f"I care about keeping {health_fact_tail}.",
        save_class="durable",
        intent="health",
        mutation="extend",
        domains=("health",),
        confirm=False,
        category="health",
    )
    case(
        18,
        message=f"I trust {relationship_tail}.",
        save_class="durable",
        intent="relationship",
        mutation="extend",
        domains=("social",),
        confirm=False,
        category="relationship",
    )
    case(
        19,
        message=f"I want my finances to reflect this too: {seed.finance_preference.lower()}.",
        save_class="durable",
        intent="financial_event",
        mutation="extend",
        domains=("financial",),
        confirm=False,
        category="finance",
    )
    case(
        20,
        message=f"I usually choose restaurants with {seed.cuisine.lower()} options.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("food",),
        confirm=False,
        category="food_preference",
    )

    # 21-30 ephemeral requests
    case(
        21,
        message="Remind me to call mom on Sunday.",
        save_class="ephemeral",
        intent="task_or_reminder",
        mutation="no_op",
        domains=("general",),
        confirm=False,
        category="ephemeral",
    )
    case(
        22,
        message="Remind me to book the hotel tomorrow.",
        save_class="ephemeral",
        intent="task_or_reminder",
        mutation="no_op",
        domains=("travel", "general"),
        confirm=False,
        category="ephemeral",
    )
    case(
        23,
        message="Remind me to review my statement after lunch.",
        save_class="ephemeral",
        intent="task_or_reminder",
        mutation="no_op",
        domains=("financial", "general"),
        confirm=False,
        category="ephemeral",
    )
    case(
        24,
        message="Don't let me forget to buy detergent later.",
        save_class="ephemeral",
        intent="task_or_reminder",
        mutation="no_op",
        domains=("shopping", "general"),
        confirm=False,
        category="ephemeral",
    )
    case(
        25,
        message="Make sure I text my brother tonight.",
        save_class="ephemeral",
        intent="task_or_reminder",
        mutation="no_op",
        domains=("social", "general"),
        confirm=False,
        category="ephemeral",
    )
    case(
        26,
        message="I need something for tomorrow.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        27,
        message="Save this for later.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        28,
        message="Remember that.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        29,
        message="I need help with that trip thing.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("travel", "general"),
        confirm=True,
        category="ambiguous",
    )
    case(
        30,
        message="Keep this in mind for me.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )

    # 31-40 corrections
    case(
        31,
        message=f"Actually I prefer {seed.corrected_seat_preference} seats now.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("travel",),
        confirm=False,
        category="correction",
    )
    case(
        32,
        message=f"Actually {seed.alt_cuisine} is a bigger favorite than {seed.cuisine}.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("food",),
        confirm=False,
        category="correction",
    )
    case(
        33,
        message=f"I changed my mind, {seed.shopping_brand} isn't my top brand anymore.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("shopping",),
        confirm=False,
        category="correction",
    )
    case(
        34,
        message=f"Actually my main goal is to {seed.goal}, not just think about it.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("financial", "travel", "general"),
        confirm=False,
        category="correction",
    )
    case(
        35,
        message="Actually I prefer quieter mornings now.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("health", "general"),
        confirm=False,
        category="correction",
    )
    case(
        36,
        message="Actually I do better with direct flights.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("travel",),
        confirm=False,
        category="correction",
    )
    case(
        37,
        message="Actually I care more about long-term flexibility than rigid routines.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("general",),
        confirm=False,
        category="correction",
    )
    case(
        38,
        message="Actually I want lower monthly spending than I used to.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("financial", "shopping"),
        confirm=False,
        category="correction",
    )
    case(
        39,
        message="Actually I don't want spicy food as often now.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("food",),
        confirm=False,
        category="correction",
    )
    case(
        40,
        message="Actually I care more about sleep consistency now.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("health",),
        confirm=False,
        category="correction",
    )

    # 41-50 deletions
    case(
        41,
        message=f"Forget that, I do not want {seed.deleted_habit} anymore.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("food", "health", "general"),
        confirm=False,
        category="deletion",
    )
    case(
        42,
        message="Delete my old aisle-seat preference.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("travel",),
        confirm=False,
        category="deletion",
    )
    case(
        43,
        message="Forget the note about late coffees.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("health", "general"),
        confirm=False,
        category="deletion",
    )
    case(
        44,
        message="Delete that old shopping preference.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("shopping",),
        confirm=False,
        category="deletion",
    )
    case(
        45,
        message="Forget the old meal preference for now.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("food",),
        confirm=False,
        category="deletion",
    )
    case(
        46,
        message="Delete my outdated travel seating note.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("travel",),
        confirm=False,
        category="deletion",
    )
    case(
        47,
        message="Forget that old budgeting note.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("financial", "general"),
        confirm=False,
        category="deletion",
    )
    case(
        48,
        message="Delete the old routine I mentioned before.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("health", "general"),
        confirm=False,
        category="deletion",
    )
    case(
        49,
        message="Forget that restaurant habit.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("food",),
        confirm=False,
        category="deletion",
    )
    case(
        50,
        message="Delete the old packing preference.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("travel",),
        confirm=False,
        category="deletion",
    )

    # 51-60 finance and cross-domain drift
    case(
        51,
        message="I want my portfolio to feel less concentrated.",
        save_class="durable",
        intent="financial_event",
        mutation="extend",
        domains=("financial",),
        confirm=False,
        category="finance",
    )
    case(
        52,
        message="I prefer automatic monthly investing.",
        save_class="durable",
        intent="financial_event",
        mutation="extend",
        domains=("financial",),
        confirm=False,
        category="finance",
    )
    case(
        53,
        message="I don't like high-volatility positions.",
        save_class="durable",
        intent="financial_event",
        mutation="extend",
        domains=("financial",),
        confirm=False,
        category="finance",
    )
    case(
        54,
        message="I want travel plans that match my budget.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="extend",
        domains=("travel", "financial"),
        confirm=False,
        category="cross_domain",
    )
    case(
        55,
        message="I like buying durable gear for trips.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("shopping", "travel"),
        confirm=False,
        category="cross_domain",
    )
    case(
        56,
        message="I want food choices that fit my health goals.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="extend",
        domains=("food", "health"),
        confirm=False,
        category="cross_domain",
    )
    case(
        57,
        message="I prefer subscriptions that are easy to cancel.",
        save_class="durable",
        intent="preference",
        mutation="create",
        domains=("subscriptions", "financial"),
        confirm=False,
        category="cross_domain",
    )
    case(
        58,
        message="I want fewer recurring charges this year.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="extend",
        domains=("subscriptions", "financial"),
        confirm=False,
        category="cross_domain",
    )
    case(
        59,
        message="I like to keep some cash ready for travel.",
        save_class="durable",
        intent="financial_event",
        mutation="extend",
        domains=("financial", "travel"),
        confirm=False,
        category="cross_domain",
    )
    case(
        60,
        message="I want healthier lunches at work.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="extend",
        domains=("food", "health", "professional"),
        confirm=False,
        category="cross_domain",
    )

    # 61-70 additional routines and durable facts
    case(
        61,
        message="I usually review my calendar right after coffee.",
        save_class="durable",
        intent="routine",
        mutation="extend",
        domains=("professional", "general"),
        confirm=False,
        category="routine",
    )
    case(
        62,
        message="I like calm hotel rooms away from elevators.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("travel",),
        confirm=False,
        category="travel_preference",
    )
    case(
        63,
        message="I care about staying hydrated on flights.",
        save_class="durable",
        intent="health",
        mutation="extend",
        domains=("health", "travel"),
        confirm=False,
        category="health",
    )
    case(
        64,
        message="I prefer grocery deliveries over crowded stores.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("shopping",),
        confirm=False,
        category="shopping",
    )
    case(
        65,
        message="I like smaller group dinners more than huge parties.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("social", "food"),
        confirm=False,
        category="social",
    )
    case(
        66,
        message="I want my home office to stay uncluttered.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("professional", "general"),
        confirm=False,
        category="professional",
    )
    case(
        67,
        message="I usually batch errands on Saturdays.",
        save_class="durable",
        intent="routine",
        mutation="extend",
        domains=("general",),
        confirm=False,
        category="routine",
    )
    case(
        68,
        message="I care about flight schedules that reduce stress.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("travel",),
        confirm=False,
        category="travel_preference",
    )
    case(
        69,
        message="I like meal plans that are simple to repeat.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("food", "health"),
        confirm=False,
        category="food_preference",
    )
    case(
        70,
        message="I prefer long-term plans over rushed decisions.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("general",),
        confirm=False,
        category="general_preference",
    )

    # 71-80 more ambiguity and confirmation pressure
    case(
        71,
        message="I want that to be easier.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        72,
        message="Remember what I said about weekends.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        73,
        message="This should matter later.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        74,
        message="Something about seats changed.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("travel", "general"),
        confirm=True,
        category="ambiguous",
    )
    case(
        75,
        message="Use that for my preferences.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        76,
        message="Store this somewhere useful.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        77,
        message="That matters for planning.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general",),
        confirm=True,
        category="ambiguous",
    )
    case(
        78,
        message="I need a better setup.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("general", "professional"),
        confirm=True,
        category="ambiguous",
    )
    case(
        79,
        message="Track the thing I mentioned about flights.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("travel", "general"),
        confirm=True,
        category="ambiguous",
    )
    case(
        80,
        message="This should stay in mind for money stuff.",
        save_class="ambiguous",
        intent="ambiguous",
        mutation="no_op",
        domains=("financial", "general"),
        confirm=True,
        category="ambiguous",
    )

    # 81-90 more corrections and deletes on established memories
    case(
        81,
        message="Actually I want less frequent restaurant meals.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("food",),
        confirm=False,
        category="correction",
    )
    case(
        82,
        message="Actually I can tolerate dairy better than before.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("health",),
        confirm=False,
        category="correction",
    )
    case(
        83,
        message="Forget the idea of premium cabins for now.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("travel",),
        confirm=False,
        category="deletion",
    )
    case(
        84,
        message="Actually I want fewer impulse purchases.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("shopping", "financial"),
        confirm=False,
        category="correction",
    )
    case(
        85,
        message="Delete the old note about red-eye flights.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("travel",),
        confirm=False,
        category="deletion",
    )
    case(
        86,
        message="Actually I want a more balanced investing style.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("financial",),
        confirm=False,
        category="correction",
    )
    case(
        87,
        message="Forget the old early-morning routine note.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("health", "general"),
        confirm=False,
        category="deletion",
    )
    case(
        88,
        message="Actually my main shopping rule is to buy less often.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("shopping",),
        confirm=False,
        category="correction",
    )
    case(
        89,
        message="Delete that old relationship note.",
        save_class="durable",
        intent="deletion",
        mutation="delete",
        domains=("social",),
        confirm=False,
        category="deletion",
    )
    case(
        90,
        message="Actually I want more direct, simple plans.",
        save_class="durable",
        intent="correction",
        mutation="correct",
        domains=("general",),
        confirm=False,
        category="correction",
    )

    # 91-100 duplicates and paraphrases
    case(
        91,
        message=f"I still like {seed.alt_cuisine} food a lot.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("food",),
        confirm=False,
        category="duplicate_food",
    )
    case(
        92,
        message=f"{seed.corrected_seat_preference.title()} seats are still best for me.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("travel",),
        confirm=False,
        category="duplicate_travel",
    )
    case(
        93,
        message=f"{seed.shopping_brand} still feels like the safest brand choice for me.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("shopping",),
        confirm=False,
        category="duplicate_shopping",
    )
    case(
        94,
        message="I still care a lot about sleep consistency.",
        save_class="durable",
        intent="health",
        mutation="extend",
        domains=("health",),
        confirm=False,
        category="duplicate_health",
    )
    case(
        95,
        message="I still want to reduce fixed expenses over time.",
        save_class="durable",
        intent="plan_or_goal",
        mutation="extend",
        domains=("financial", "subscriptions"),
        confirm=False,
        category="duplicate_finance",
    )
    case(
        96,
        message="My travel preferences still matter a lot to me.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("travel",),
        confirm=False,
        category="duplicate_travel",
    )
    case(
        97,
        message="I still prefer simple repeatable meals.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("food",),
        confirm=False,
        category="duplicate_food",
    )
    case(
        98,
        message="I still want automatic monthly investing.",
        save_class="durable",
        intent="financial_event",
        mutation="extend",
        domains=("financial",),
        confirm=False,
        category="duplicate_finance",
    )
    case(
        99,
        message="I still like calmer mornings.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("health", "general"),
        confirm=False,
        category="duplicate_general",
    )
    case(
        100,
        message="I still prefer fewer rushed decisions.",
        save_class="durable",
        intent="preference",
        mutation="extend",
        domains=("general",),
        confirm=False,
        category="duplicate_general",
    )

    if len(prompts) != 100:
        raise ValueError(f"Expected 100 persona prompts, got {len(prompts)}")
    return prompts


def build_synthetic_personas(max_prompts_per_persona: int = 100) -> list[dict[str, Any]]:
    personas = []
    for seed in PERSONA_SEEDS:
        prompts = _build_persona_chain(seed)
        personas.append(
            {
                "persona_id": seed.persona_id,
                "name": seed.name,
                "prompts": prompts[: max(1, min(max_prompts_per_persona, len(prompts)))],
            }
        )
    return personas


def _append_case(
    prompts: list[PromptCase],
    *,
    case_id: str,
    message: str,
    save_class: str,
    intent: str,
    mutation: str,
    domains: tuple[str, ...],
    confirm: bool,
    category: str,
) -> None:
    prompts.append(
        PromptCase(
            case_id=case_id,
            message=message,
            expected_save_class=save_class,
            expected_intent_class=intent,
            expected_mutation_intent=mutation,
            expected_domains=_normalized_expected_domains(
                domains=domains,
                intent=intent,
                message=message,
            ),
            expect_confirmation=confirm,
            category=category,
        )
    )


def _build_fresh_random_cases(seed: PersonaSeed) -> list[PromptCase]:
    prompts: list[PromptCase] = []
    shopping_brand = seed.shopping_brand
    health_statement = seed.health_fact.replace("I'm ", "I am ").replace("I'm", "I am")
    cases = [
        (
            f"If a menu has {seed.cuisine.lower()} options, that is usually where I start.",
            "durable",
            "preference",
            "create",
            ("food",),
            False,
            "taste",
        ),
        (
            f"When I fly, {seed.seat_preference} seats make the trip noticeably easier for me.",
            "durable",
            "preference",
            "create",
            ("travel",),
            False,
            "travel_preference",
        ),
        (
            f"A reliable morning for me starts when I {seed.morning_routine}.",
            "durable",
            "routine",
            "create",
            ("health", "professional"),
            False,
            "routine",
        ),
        (
            health_statement,
            "durable",
            "health",
            "create",
            ("health",),
            False,
            "health",
        ),
        (
            f"I tend to buy basics from {shopping_brand} before I look anywhere else.",
            "durable",
            "preference",
            "create",
            ("shopping",),
            False,
            "shopping",
        ),
        (
            f"My plans still revolve around living out of {seed.home_base}.",
            "durable",
            "profile_fact",
            "create",
            ("location",),
            False,
            "profile_fact",
        ),
        (
            f"One medium-term priority for me is to {seed.goal}.",
            "durable",
            "plan_or_goal",
            "create",
            ("financial", "travel", "professional"),
            False,
            "goal",
        ),
        (
            f"Please remember that {seed.finance_preference[0].lower() + seed.finance_preference[1:]}",
            "durable",
            "financial_event",
            "create",
            ("financial",),
            False,
            "finance_memory",
        ),
        (
            "Please remind me to review the brokerage paperwork after lunch.",
            "ephemeral",
            "task_or_reminder",
            "no_op",
            ("financial",),
            False,
            "finance_adjacent_ephemeral",
        ),
        (
            "There is something about my weekends I want stored, but I am not describing it clearly yet.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("professional", "travel", "shopping", "food"),
            True,
            "ambiguous",
        ),
        (
            f"Update this for me: I would now choose {seed.corrected_seat_preference} seats instead.",
            "durable",
            "correction",
            "correct",
            ("travel",),
            False,
            "correction",
        ),
        (
            f"Remove the old habit about {seed.deleted_habit} from what Kai remembers.",
            "durable",
            "deletion",
            "delete",
            ("food", "health", "shopping"),
            False,
            "deletion",
        ),
    ]
    for index, (message, save_class, intent, mutation, domains, confirm, category) in enumerate(
        cases, start=1
    ):
        _append_case(
            prompts,
            case_id=f"{seed.persona_id}_fresh_{index:03d}",
            message=message,
            save_class=save_class,
            intent=intent,
            mutation=mutation,
            domains=domains,
            confirm=confirm,
            category=category,
        )
    return prompts


def _build_fresh_chain(seed: PersonaSeed) -> list[PromptCase]:
    prompts: list[PromptCase] = []
    normalized_health_fact = seed.health_fact.replace("I'm", "I am")
    cases = [
        (
            f"I regularly scan for {seed.cuisine.lower()} places before picking a restaurant.",
            "durable",
            "preference",
            "create",
            ("food",),
            False,
            "food_create",
        ),
        (
            f"I settle down faster on flights when I book {seed.seat_preference} seats.",
            "durable",
            "preference",
            "create",
            ("travel",),
            False,
            "travel_create",
        ),
        (
            f"My most dependable mornings happen when I {seed.morning_routine}.",
            "durable",
            "routine",
            "create",
            ("health", "professional"),
            False,
            "routine_create",
        ),
        (
            seed.health_fact.replace("I'm ", "I am ").replace("I'm", "I am"),
            "durable",
            "health",
            "create",
            ("health",),
            False,
            "health_create",
        ),
        (
            f"A key person in my life is {seed.relationship_fact.replace('My ', '').replace('my ', '')}.",
            "durable",
            "relationship",
            "create",
            ("social",),
            False,
            "relationship_create",
        ),
        (
            f"I usually trust {seed.shopping_brand} when I need reliable basics.",
            "durable",
            "preference",
            "create",
            ("shopping",),
            False,
            "shopping_create",
        ),
        (
            f"I am currently based in {seed.home_base}.",
            "durable",
            "profile_fact",
            "create",
            ("location",),
            False,
            "profile_create",
        ),
        (
            f"A big goal for me is to {seed.goal}.",
            "durable",
            "plan_or_goal",
            "create",
            ("financial", "travel", "professional"),
            False,
            "goal_create",
        ),
        (
            f"Keep this in mind financially: {seed.finance_preference[0].lower() + seed.finance_preference[1:]}",
            "durable",
            "financial_event",
            "create",
            ("financial",),
            False,
            "finance_memory_create",
        ),
        (
            "Remind me to compare my brokerage paperwork tonight.",
            "ephemeral",
            "task_or_reminder",
            "no_op",
            ("financial",),
            False,
            "finance_adjacent_ephemeral",
        ),
        (
            "I want something about my routine captured, but I am not being specific enough yet.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("health", "professional"),
            True,
            "ambiguous",
        ),
        (
            f"I also keep coming back to {seed.alt_cuisine.lower()} meals when I want comfort food.",
            "durable",
            "preference",
            "extend",
            ("food",),
            False,
            "food_extend",
        ),
        (
            f"I still gravitate toward {seed.seat_preference} seats if I have the choice.",
            "durable",
            "preference",
            "extend",
            ("travel",),
            False,
            "travel_extend",
        ),
        (
            f"Weekends go better when I still {seed.morning_routine}.",
            "durable",
            "routine",
            "extend",
            ("health", "professional"),
            False,
            "routine_extend",
        ),
        (
            f"I still plan around this health fact: {normalized_health_fact}",
            "durable",
            "health",
            "extend",
            ("health",),
            False,
            "health_extend",
        ),
        (
            f"I still reference {seed.relationship_fact.replace('My ', '').replace('my ', '')} a lot in personal planning.",
            "durable",
            "relationship",
            "extend",
            ("social",),
            False,
            "relationship_extend",
        ),
        (
            f"{seed.shopping_brand} still feels like the safest low-friction shopping choice for me.",
            "durable",
            "preference",
            "extend",
            ("shopping",),
            False,
            "shopping_extend",
        ),
        (
            f"{seed.home_base} is still the place I anchor plans around.",
            "durable",
            "profile_fact",
            "extend",
            ("location",),
            False,
            "profile_extend",
        ),
        (
            f"I am still working toward {seed.goal}.",
            "durable",
            "plan_or_goal",
            "extend",
            ("financial", "travel", "professional"),
            False,
            "goal_extend",
        ),
        (
            f"My financial preference is still this: {seed.finance_preference[0].lower() + seed.finance_preference[1:]}",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "finance_memory_extend",
        ),
        (
            "Please remind me to send the travel receipt tomorrow afternoon.",
            "ephemeral",
            "task_or_reminder",
            "no_op",
            ("travel",),
            False,
            "travel_ephemeral",
        ),
        (
            "Store what I mean about family gatherings, but I am leaving it vague.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("social", "food"),
            True,
            "ambiguous",
        ),
        (
            f"Update my travel memory: {seed.corrected_seat_preference} seats are better for me now.",
            "durable",
            "correction",
            "correct",
            ("travel",),
            False,
            "travel_correction",
        ),
        (
            f"Update this food preference too: {seed.alt_cuisine.lower()} sounds better than {seed.cuisine.lower()} most of the time now.",
            "durable",
            "correction",
            "correct",
            ("food",),
            False,
            "food_correction",
        ),
        (
            f"I have changed my mind about brands; {seed.shopping_brand} is no longer the automatic default.",
            "durable",
            "correction",
            "correct",
            ("shopping",),
            False,
            "shopping_correction",
        ),
        (
            "Update my health memory: consistency matters more to me than intensity now.",
            "durable",
            "correction",
            "correct",
            ("health",),
            False,
            "health_correction",
        ),
        (
            "Update my work rhythm memory: I do better with fewer context switches now.",
            "durable",
            "correction",
            "correct",
            ("professional",),
            False,
            "professional_correction",
        ),
        (
            "Update my budget memory: steadier monthly spending matters more than short bursts of savings.",
            "durable",
            "correction",
            "correct",
            ("financial",),
            False,
            "finance_correction",
        ),
        (
            "I no longer want a note about hectic early mornings kept around.",
            "durable",
            "deletion",
            "delete",
            ("health", "professional"),
            False,
            "routine_deletion",
        ),
        (
            f"Delete the old idea about {seed.deleted_habit}.",
            "durable",
            "deletion",
            "delete",
            ("food", "health", "shopping"),
            False,
            "habit_deletion",
        ),
        (
            "Delete the outdated note about seat selection.",
            "durable",
            "deletion",
            "delete",
            ("travel",),
            False,
            "travel_deletion",
        ),
        (
            "Delete the older shopping rule I mentioned previously.",
            "durable",
            "deletion",
            "delete",
            ("shopping",),
            False,
            "shopping_deletion",
        ),
        (
            "Delete the older family planning note.",
            "durable",
            "deletion",
            "delete",
            ("social",),
            False,
            "relationship_deletion",
        ),
        (
            "Forget the old budgeting note I gave you earlier.",
            "durable",
            "deletion",
            "delete",
            ("financial",),
            False,
            "finance_deletion",
        ),
        (
            "I want my travel plans to fit both my energy and my budget.",
            "durable",
            "plan_or_goal",
            "extend",
            ("travel", "financial", "health"),
            False,
            "cross_domain",
        ),
        (
            "I buy less impulsively when shopping is tied to trip planning.",
            "durable",
            "preference",
            "extend",
            ("shopping", "travel"),
            False,
            "cross_domain",
        ),
        (
            "Food choices work best for me when they support steady energy.",
            "durable",
            "plan_or_goal",
            "extend",
            ("food", "health"),
            False,
            "cross_domain",
        ),
        (
            "I want my work week to leave more room for family time.",
            "durable",
            "plan_or_goal",
            "extend",
            ("professional", "social"),
            False,
            "cross_domain",
        ),
        (
            "I prefer spending plans that still leave room for travel.",
            "durable",
            "financial_event",
            "extend",
            ("financial", "travel"),
            False,
            "cross_domain",
        ),
        (
            "I value products that last a long time more than trendy launches.",
            "durable",
            "preference",
            "extend",
            ("shopping",),
            False,
            "shopping_preference",
        ),
        (
            "Calmer hotel environments are still worth paying a bit more for.",
            "durable",
            "preference",
            "extend",
            ("travel",),
            False,
            "travel_preference",
        ),
        (
            "Simple repeatable lunches are still better for me than novelty every day.",
            "durable",
            "preference",
            "extend",
            ("food", "health"),
            False,
            "food_preference",
        ),
        (
            "Smaller social dinners feel better than giant events for me.",
            "durable",
            "preference",
            "extend",
            ("social", "food"),
            False,
            "social_preference",
        ),
        (
            "I keep performing better when my calendar is not overloaded.",
            "durable",
            "routine",
            "extend",
            ("professional",),
            False,
            "professional_routine",
        ),
        (
            "I still want reminders kept out of durable PKM when they are one-off.",
            "ephemeral",
            "task_or_reminder",
            "no_op",
            ("professional",),
            False,
            "ephemeral",
        ),
        (
            "I need a cleaner way to describe what matters about home life.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("social", "location"),
            True,
            "ambiguous",
        ),
        (
            "I still look for restaurants where the menu feels easy to navigate.",
            "durable",
            "preference",
            "extend",
            ("food",),
            False,
            "food_duplicate",
        ),
        (
            "I still avoid travel choices that create unnecessary stress.",
            "durable",
            "preference",
            "extend",
            ("travel",),
            False,
            "travel_duplicate",
        ),
        (
            "I still buy fewer things when the shopping list is deliberate.",
            "durable",
            "routine",
            "extend",
            ("shopping",),
            False,
            "shopping_duplicate",
        ),
        (
            "I still do better when sleep consistency is protected.",
            "durable",
            "health",
            "extend",
            ("health",),
            False,
            "health_duplicate",
        ),
        (
            "I still want automatic investing decisions to stay simple.",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "finance_duplicate",
        ),
        (
            "My planning still works better when goals are concrete and time-boxed.",
            "durable",
            "plan_or_goal",
            "extend",
            ("professional", "financial"),
            False,
            "goal_duplicate",
        ),
        (
            "Actually, nonstop flights matter less to me than flexible arrival times now.",
            "durable",
            "correction",
            "correct",
            ("travel",),
            False,
            "travel_correction",
        ),
        (
            "Actually, I want food choices that are lighter in the evening now.",
            "durable",
            "correction",
            "correct",
            ("food", "health"),
            False,
            "food_correction",
        ),
        (
            "Actually, I want shopping defaults that reduce clutter, not just save money.",
            "durable",
            "correction",
            "correct",
            ("shopping",),
            False,
            "shopping_correction",
        ),
        (
            "Actually, the professional goal that matters most is reducing decision fatigue.",
            "durable",
            "correction",
            "correct",
            ("professional",),
            False,
            "professional_correction",
        ),
        (
            "Actually, capital preservation matters more to me than aggressive upside right now.",
            "durable",
            "correction",
            "correct",
            ("financial",),
            False,
            "finance_correction",
        ),
        (
            "Actually, I want travel days that leave more energy for the day after.",
            "durable",
            "correction",
            "correct",
            ("travel", "health"),
            False,
            "travel_health_correction",
        ),
        (
            "Delete the old note that tied productivity to very early starts.",
            "durable",
            "deletion",
            "delete",
            ("professional", "health"),
            False,
            "deletion",
        ),
        (
            "Delete the outdated preference about noisy restaurants.",
            "durable",
            "deletion",
            "delete",
            ("food",),
            False,
            "deletion",
        ),
        (
            "Delete the older note about buying premium versions by default.",
            "durable",
            "deletion",
            "delete",
            ("shopping",),
            False,
            "deletion",
        ),
        (
            "Delete the stale note about keeping too many tiny subscriptions.",
            "durable",
            "deletion",
            "delete",
            ("financial",),
            False,
            "deletion",
        ),
        (
            "Delete the older travel note about squeezing every connection.",
            "durable",
            "deletion",
            "delete",
            ("travel",),
            False,
            "deletion",
        ),
        (
            "Delete the older social note about always saying yes to invitations.",
            "durable",
            "deletion",
            "delete",
            ("social",),
            False,
            "deletion",
        ),
        (
            "Please remind me next Tuesday to ask about the insurance form.",
            "ephemeral",
            "task_or_reminder",
            "no_op",
            ("financial", "health"),
            False,
            "ephemeral",
        ),
        (
            "I am hinting at a preference about workdays, but not enough for you to store it yet.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("professional",),
            True,
            "ambiguous",
        ),
        (
            "I want to feel more settled at home, but I have not said what that means yet.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("location", "social"),
            True,
            "ambiguous",
        ),
        (
            "I want memory here, but I have not picked whether it belongs to travel or food.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("travel", "food"),
            True,
            "ambiguous",
        ),
        (
            "I want memory here, but it might be about money or planning and I am still unsure.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("financial", "professional"),
            True,
            "ambiguous",
        ),
        (
            "There is something I care about with weekends and family, but this is still too vague.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("social",),
            True,
            "ambiguous",
        ),
        (
            "I want lower-volatility positioning in the portfolio going forward.",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "finance_memory",
        ),
        (
            "Remember that broad index exposure still feels safer to me than picking individual names.",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "finance_memory",
        ),
        (
            "Remember that travel spending is easier for me when it is planned months ahead.",
            "durable",
            "plan_or_goal",
            "extend",
            ("travel", "financial"),
            False,
            "travel_finance",
        ),
        (
            "Remember that health tradeoffs matter more than speed when I travel.",
            "durable",
            "preference",
            "extend",
            ("travel", "health"),
            False,
            "travel_health",
        ),
        (
            "Remember that family visits deserve protected time in my calendar.",
            "durable",
            "plan_or_goal",
            "extend",
            ("social", "professional"),
            False,
            "social_professional",
        ),
        (
            "Remember that simpler wardrobes reduce decision fatigue for me.",
            "durable",
            "preference",
            "extend",
            ("shopping", "professional"),
            False,
            "shopping_professional",
        ),
        (
            "When a message is broad, I still want the PKM write to stay near the domain root.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "root_domain_note",
        ),
        (
            "When a memory is specific, it should land on the most stable subpath instead of a random detail slot.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "root_domain_note",
        ),
        (
            "Broad food preferences should stay compact unless there is a strong reason to split them further.",
            "durable",
            "note",
            "extend",
            ("food",),
            False,
            "root_domain_note",
        ),
        (
            "Broad travel memories should stay simple unless a durable subtree is clearly justified.",
            "durable",
            "note",
            "extend",
            ("travel",),
            False,
            "root_domain_note",
        ),
        (
            "Broad health constraints should stay compact unless the structure needs more detail.",
            "durable",
            "note",
            "extend",
            ("health",),
            False,
            "root_domain_note",
        ),
        (
            "I still prefer memory structures that are compact and easy to inspect later.",
            "durable",
            "preference",
            "extend",
            ("professional",),
            False,
            "meta_preference",
        ),
        (
            "I still want reminders kept separate from durable PKM facts.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_preference",
        ),
        (
            "I still want vague prompts to trigger confirmation instead of forced structure.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_preference",
        ),
        (
            "Update my meta preference too: compact domains matter more than over-fragmented structure.",
            "durable",
            "correction",
            "correct",
            ("professional",),
            False,
            "meta_correction",
        ),
        (
            "Delete the old assumption that every durable memory needs a deep path.",
            "durable",
            "deletion",
            "delete",
            ("professional",),
            False,
            "meta_deletion",
        ),
        (
            "Delete the old assumption that every durable preference needs its own narrow domain.",
            "durable",
            "deletion",
            "delete",
            ("professional",),
            False,
            "meta_deletion",
        ),
        (
            "I still lean toward flexible plans over overly rigid ones.",
            "durable",
            "preference",
            "extend",
            ("professional", "travel"),
            False,
            "broad_preference",
        ),
        (
            "I still keep returning to low-friction travel days.",
            "durable",
            "preference",
            "extend",
            ("travel",),
            False,
            "broad_preference",
        ),
        (
            "I still make better decisions when shopping choices are pre-filtered.",
            "durable",
            "routine",
            "extend",
            ("shopping",),
            False,
            "broad_preference",
        ),
        (
            "I still want dinner options that do not create decision fatigue.",
            "durable",
            "preference",
            "extend",
            ("food",),
            False,
            "broad_preference",
        ),
        (
            "I still want the portfolio to feel steadier than exciting.",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "finance_preference",
        ),
        (
            "I still want space in the calendar for personal recovery after travel.",
            "durable",
            "plan_or_goal",
            "extend",
            ("travel", "health", "professional"),
            False,
            "travel_health_goal",
        ),
        (
            "Actually, my strongest restaurant preference is predictability, not novelty.",
            "durable",
            "correction",
            "correct",
            ("food",),
            False,
            "food_correction",
        ),
        (
            "Actually, I prefer shorter travel days more than I prefer premium perks.",
            "durable",
            "correction",
            "correct",
            ("travel",),
            False,
            "travel_correction",
        ),
        (
            "Actually, the healthiest routine for me is the one I will repeat consistently.",
            "durable",
            "correction",
            "correct",
            ("health",),
            False,
            "health_correction",
        ),
        (
            "Actually, my best shopping rule is to buy less often and buy better.",
            "durable",
            "correction",
            "correct",
            ("shopping",),
            False,
            "shopping_correction",
        ),
        (
            "Actually, I want investing decisions that feel simpler, not more frequent.",
            "durable",
            "correction",
            "correct",
            ("financial",),
            False,
            "finance_correction",
        ),
        (
            "Actually, family planning should outrank opportunistic work requests when possible.",
            "durable",
            "correction",
            "correct",
            ("social", "professional"),
            False,
            "social_correction",
        ),
        (
            "Delete the stale note about maximizing every loyalty perk.",
            "durable",
            "deletion",
            "delete",
            ("travel",),
            False,
            "travel_deletion",
        ),
        (
            "Delete the stale note about chasing novelty in meals every week.",
            "durable",
            "deletion",
            "delete",
            ("food",),
            False,
            "food_deletion",
        ),
        (
            "Delete the stale note about impulse upgrades when shopping.",
            "durable",
            "deletion",
            "delete",
            ("shopping",),
            False,
            "shopping_deletion",
        ),
        (
            "Delete the stale note about letting volatility dictate my decisions.",
            "durable",
            "deletion",
            "delete",
            ("financial",),
            False,
            "finance_deletion",
        ),
        (
            "Delete the stale note about overpacking every trip.",
            "durable",
            "deletion",
            "delete",
            ("travel",),
            False,
            "travel_deletion",
        ),
        (
            "Delete the stale note about saying yes to every social request.",
            "durable",
            "deletion",
            "delete",
            ("social",),
            False,
            "social_deletion",
        ),
        (
            "I want the system to keep broad stable meaning even when the wording changes.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to ask before it invents a narrow subkey from a vague sentence.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to reuse stable domains before creating another one.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to keep finance separate from non-financial memory unless the meaning is truly financial.",
            "durable",
            "note",
            "extend",
            ("professional", "financial"),
            False,
            "meta_note",
        ),
        (
            "I want the system to keep consent scopes domain-first unless structure clearly justifies more detail.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to show the exact path it plans to update before save.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to show the exact scope surface that would be exposed for consent.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to keep ambiguous prompts out of durable PKM until I confirm.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to keep update and delete behavior explicit, not inferred after the fact.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to keep the model prompt crisp enough that the same intent lands consistently.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to favor stable roots before it reaches for deep subtrees.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
        (
            "I want the system to keep durable memory compact enough for inspection later.",
            "durable",
            "note",
            "extend",
            ("professional",),
            False,
            "meta_note",
        ),
    ]
    for index, (message, save_class, intent, mutation, domains, confirm, category) in enumerate(
        cases[:120], start=1
    ):
        _append_case(
            prompts,
            case_id=f"{seed.persona_id}_fresh_chain_{index:03d}",
            message=message,
            save_class=save_class,
            intent=intent,
            mutation=mutation,
            domains=domains,
            confirm=confirm,
            category=category,
        )
    return prompts


def build_phase_personas(
    *, phase: str, max_prompts_per_persona: int
) -> tuple[list[dict[str, Any]], bool]:
    prompt_limit = min(max_prompts_per_persona, PHASE_PROMPT_LIMIT[phase])
    if phase == "fresh_random_120":
        prompts: list[PromptCase] = []
        for seed in PERSONA_SEEDS:
            prompts.extend(_build_fresh_random_cases(seed))
        return [
            {
                "persona_id": "fresh_random_pack",
                "name": "Fresh Random Pack",
                "prompts": prompts[:prompt_limit],
            }
        ], False

    chain_seed = PERSONA_SEEDS[0]
    chain_prompts = _build_fresh_chain(chain_seed)[:prompt_limit]
    return [
        {
            "persona_id": chain_seed.persona_id,
            "name": chain_seed.name,
            "prompts": chain_prompts,
        }
    ], True


def _blank_state(
    domains: list[str] | None = None, memories: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return {
        "domains": list(domains or []),
        "memories": list(memories or []),
    }


def _schema_ok(result: dict[str, Any]) -> bool:
    required_top = {"intent_frame", "candidate_payload", "structure_decision", "write_mode"}
    if not required_top.issubset(result.keys()):
        return False
    frame = result.get("intent_frame")
    decision = result.get("structure_decision")
    if not isinstance(frame, dict) or not isinstance(decision, dict):
        return False
    return all(
        key in frame
        for key in (
            "save_class",
            "intent_class",
            "mutation_intent",
            "requires_confirmation",
            "candidate_domain_choices",
            "confidence",
        )
    ) and all(
        key in decision
        for key in (
            "action",
            "target_domain",
            "json_paths",
            "top_level_scope_paths",
            "externalizable_paths",
        )
    )


def _apply_preview_to_state(state: dict[str, Any], result: dict[str, Any], message: str) -> None:
    frame = result.get("intent_frame") or {}
    mutation = str(frame.get("mutation_intent") or "create")
    write_mode = str(result.get("write_mode") or "confirm_first")
    target_domain = str((result.get("structure_decision") or {}).get("target_domain") or "")
    target_entity_scope = str(result.get("target_entity_scope") or "")
    if write_mode != "can_save" or not target_domain:
        return

    if target_domain not in state["domains"]:
        state["domains"].append(target_domain)

    active_memories = [memory for memory in state["memories"] if memory.get("active", True)]
    matching = [
        memory
        for memory in active_memories
        if memory.get("domain") == target_domain
        and (
            target_entity_scope == ""
            or memory.get("entity_scope") == target_entity_scope
            or memory.get("intent_class") == frame.get("intent_class")
        )
    ]
    if mutation == "delete":
        for memory in matching[:1]:
            memory["active"] = False
        return
    if mutation in {"correct", "update"}:
        for memory in matching[:1]:
            memory["active"] = False

    if matching and mutation == "extend":
        # Keep state compact; extending an existing subtree updates the recent message.
        matching[0]["message"] = message
        matching[0]["intent_class"] = frame.get("intent_class")
        matching[0]["entity_scope"] = target_entity_scope or matching[0].get("entity_scope")
        return

    state["memories"].append(
        {
            "domain": target_domain,
            "entity_scope": target_entity_scope,
            "intent_class": frame.get("intent_class"),
            "message": message,
            "active": True,
        }
    )


async def _evaluate_case(
    *,
    service,
    case: PromptCase,
    state: dict[str, Any],
    user_id: str,
    model_override: str | None,
    strict_small_model: bool,
    per_prompt_timeout_seconds: float,
    domain_registry_override: list[dict[str, Any]],
) -> EvaluationResult:
    started_at = time.perf_counter()
    timed_out = False
    try:
        result = await asyncio.wait_for(
            service.generate_structure_preview(
                user_id=user_id,
                message=case.message,
                current_domains=list(state["domains"]),
                simulated_state=state,
                model_override=model_override,
                strict_small_model=strict_small_model,
                domain_registry_override=domain_registry_override,
            ),
            timeout=per_prompt_timeout_seconds,
        )
    except Exception:
        timed_out = True
        result = {
            "intent_frame": {
                "save_class": "",
                "intent_class": "",
                "mutation_intent": "",
                "requires_confirmation": False,
            },
            "structure_decision": {"target_domain": ""},
            "write_mode": "timeout",
            "validation_hints": ["model_timeout"],
            "used_fallback": True,
        }
    latency_ms = round((time.perf_counter() - started_at) * 1000, 2)
    frame = result.get("intent_frame") or {}
    decision = result.get("structure_decision") or {}
    actual_domain = str(decision.get("target_domain") or "")
    actual_write_mode = str(result.get("write_mode") or "")
    requires_confirmation = (
        bool(frame.get("requires_confirmation")) or actual_write_mode == "confirm_first"
    )
    validation_hints = list(result.get("validation_hints") or [])
    finance_contamination = (
        actual_domain == "financial"
        and "financial" not in case.expected_domains
        and case.expected_intent_class != "financial_event"
    )
    unresolved_domain = "unresolved_domain_choice" in validation_hints
    domain_ok = actual_domain in case.expected_domains
    if case.expected_save_class in {"ephemeral", "ambiguous"} or actual_write_mode in {
        "do_not_save",
        "confirm_first",
    }:
        domain_ok = not finance_contamination

    evaluation = EvaluationResult(
        case_id=case.case_id,
        message=case.message,
        category=case.category,
        expected_save_class=case.expected_save_class,
        expected_intent_class=case.expected_intent_class,
        expected_mutation_intent=case.expected_mutation_intent,
        expected_domains=list(case.expected_domains),
        expect_confirmation=case.expect_confirmation,
        latency_ms=latency_ms,
        actual_save_class=str(frame.get("save_class") or ""),
        actual_intent_class=str(frame.get("intent_class") or ""),
        actual_mutation_intent=str(frame.get("mutation_intent") or ""),
        actual_domain=actual_domain,
        actual_write_mode=actual_write_mode,
        requires_confirmation=requires_confirmation,
        validation_hints=validation_hints,
        used_fallback=bool(result.get("used_fallback")),
        timed_out=timed_out,
        finance_contamination=finance_contamination,
        unresolved_domain=unresolved_domain,
        save_class_ok=str(frame.get("save_class") or "") == case.expected_save_class,
        intent_ok=str(frame.get("intent_class") or "") == case.expected_intent_class,
        mutation_ok=str(frame.get("mutation_intent") or "") == case.expected_mutation_intent,
        domain_ok=domain_ok,
        confirmation_ok=requires_confirmation == case.expect_confirmation,
        schema_ok=_schema_ok(result),
    )
    _apply_preview_to_state(state, result, case.message)
    return evaluation


async def _run_synthetic_mode(
    *,
    service,
    personas: list[dict[str, Any]],
    mode_name: str,
    model_override: str | None,
    strict_small_model: bool,
    chain_state: bool,
    per_prompt_timeout_seconds: float,
) -> dict[str, Any]:
    registry_override = _registry_override()
    persona_reports = []
    all_results: list[EvaluationResult] = []
    for persona in personas:
        state = _blank_state()
        persona_results = []
        for case in persona["prompts"]:
            case_state = state if chain_state else _blank_state(domains=list(state["domains"]))
            evaluation = await _evaluate_case(
                service=service,
                case=case,
                state=case_state,
                user_id="synthetic-benchmark-user",
                model_override=model_override,
                strict_small_model=strict_small_model,
                per_prompt_timeout_seconds=per_prompt_timeout_seconds,
                domain_registry_override=registry_override,
            )
            persona_results.append(evaluation)
            all_results.append(evaluation)
        persona_reports.append(
            {
                "persona_id": persona["persona_id"],
                "name": persona["name"],
                "prompt_count": len(persona_results),
                "final_domains": sorted(state["domains"]),
                "active_memory_count": sum(
                    1 for entry in state["memories"] if entry.get("active", True)
                ),
                "results": [asdict(result) for result in persona_results],
            }
        )
    return {
        "mode": mode_name,
        "model_override": model_override or "",
        "strict_small_model": strict_small_model,
        "synthetic_prompt_count": len(all_results),
        "personas": persona_reports,
        "summary": _summarize_results(all_results),
    }


def _shadow_prompt_chain() -> list[PromptCase]:
    prompts = [
        (
            "shadow_001",
            "I like Chinese food.",
            "durable",
            "preference",
            "create",
            ("food",),
            False,
            "shadow_non_finance",
        ),
        (
            "shadow_002",
            "I prefer aisle seats when I fly.",
            "durable",
            "preference",
            "create",
            ("travel",),
            False,
            "shadow_non_finance",
        ),
        (
            "shadow_003",
            "I am allergic to peanuts.",
            "durable",
            "health",
            "create",
            ("health",),
            False,
            "shadow_non_finance",
        ),
        (
            "shadow_004",
            "Remind me to review my brokerage statement tomorrow.",
            "ephemeral",
            "task_or_reminder",
            "no_op",
            ("financial", "general"),
            False,
            "shadow_ephemeral",
        ),
        (
            "shadow_005",
            "I prefer dividend-paying stocks.",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "shadow_finance",
        ),
        (
            "shadow_006",
            "I want a lower-volatility portfolio.",
            "durable",
            "financial_event",
            "extend",
            ("financial",),
            False,
            "shadow_finance",
        ),
        (
            "shadow_007",
            "Actually I prefer growth over income now.",
            "durable",
            "correction",
            "correct",
            ("financial",),
            False,
            "shadow_finance",
        ),
        (
            "shadow_008",
            "Forget that old airline seat note.",
            "durable",
            "deletion",
            "delete",
            ("travel",),
            False,
            "shadow_non_finance",
        ),
        (
            "shadow_009",
            "I want simple repeatable meals.",
            "durable",
            "preference",
            "extend",
            ("food",),
            False,
            "shadow_non_finance",
        ),
        (
            "shadow_010",
            "I need something for tomorrow.",
            "ambiguous",
            "ambiguous",
            "no_op",
            ("general",),
            True,
            "shadow_ambiguous",
        ),
    ]
    return [
        PromptCase(
            case_id=case_id,
            message=message,
            expected_save_class=save_class,
            expected_intent_class=intent,
            expected_mutation_intent=mutation,
            expected_domains=_normalized_expected_domains(
                domains=domains,
                intent=intent,
                message=message,
            ),
            expect_confirmation=confirm,
            category=category,
        )
        for case_id, message, save_class, intent, mutation, domains, confirm, category in prompts
    ]


async def _load_shadow_state(
    service: PersonalKnowledgeModelService,
    *,
    user_id: str,
) -> dict[str, Any]:
    manifests = (
        service.supabase.table("pkm_manifests")
        .select("domain,top_level_scope_paths,summary_projection,path_count,manifest_version")
        .eq("user_id", user_id)
        .order("domain")
        .execute()
        .data
        or []
    )
    scope_rows = (
        service.supabase.table("pkm_scope_registry")
        .select("domain,scope_label,scope_handle")
        .eq("user_id", user_id)
        .order("domain")
        .execute()
        .data
        or []
    )
    memories = []
    domains = []
    for manifest in manifests:
        domain = str(manifest.get("domain") or "").strip()
        if not domain:
            continue
        domains.append(domain)
        scope_labels = [row for row in scope_rows if str(row.get("domain") or "").strip() == domain]
        for scope in scope_labels[:5]:
            memories.append(
                {
                    "domain": domain,
                    "entity_scope": str(
                        scope.get("scope_label") or scope.get("scope_handle") or ""
                    ),
                    "intent_class": "shadow_baseline",
                    "message": json.dumps(manifest.get("summary_projection") or {}),
                    "active": True,
                }
            )
    return _blank_state(domains=sorted(set(domains)), memories=memories)


async def _run_shadow_mode(
    *,
    service,
    pkm_service: PersonalKnowledgeModelService,
    shadow_users: list[str],
    mode_name: str,
    model_override: str | None,
    strict_small_model: bool,
    per_prompt_timeout_seconds: float,
) -> dict[str, Any]:
    registry_override = _registry_override()
    reports = []
    all_results: list[EvaluationResult] = []
    for user_id in shadow_users:
        state = await _load_shadow_state(pkm_service, user_id=user_id)
        user_results = []
        for case in _shadow_prompt_chain():
            evaluation = await _evaluate_case(
                service=service,
                case=case,
                state=state,
                user_id=user_id,
                model_override=model_override,
                strict_small_model=strict_small_model,
                per_prompt_timeout_seconds=per_prompt_timeout_seconds,
                domain_registry_override=registry_override,
            )
            user_results.append(evaluation)
            all_results.append(evaluation)
        reports.append(
            {
                "user_id": user_id,
                "initial_domains": sorted(set(state["domains"])),
                "results": [asdict(result) for result in user_results],
            }
        )
    return {
        "mode": mode_name,
        "model_override": model_override or "",
        "strict_small_model": strict_small_model,
        "shadow_prompt_count": len(all_results),
        "users": reports,
        "summary": _summarize_results(all_results),
    }


def _summarize_results(results: list[EvaluationResult]) -> dict[str, Any]:
    total = len(results)
    if total == 0:
        return {
            "prompt_count": 0,
            "schema_ok_rate": 0.0,
            "save_class_ok_rate": 0.0,
            "intent_ok_rate": 0.0,
            "mutation_ok_rate": 0.0,
            "domain_ok_rate": 0.0,
            "confirmation_ok_rate": 0.0,
            "fallback_rate": 0.0,
            "timeout_count": 0,
            "finance_contamination_count": 0,
            "unresolved_domain_count": 0,
            "fragmentation_score": 0.0,
        }

    def _rate(attr: str) -> float:
        hits = sum(1 for item in results if getattr(item, attr))
        return round(hits / total, 4)

    latencies = sorted(item.latency_ms for item in results)
    average_latency_ms = round(sum(latencies) / total, 2)
    p95_index = min(total - 1, max(0, int(total * 0.95) - 1))
    p95_latency_ms = round(latencies[p95_index], 2)

    fallback_rate = round(sum(1 for item in results if item.used_fallback) / total, 4)
    finance_contamination_count = sum(1 for item in results if item.finance_contamination)
    unresolved_domain_count = sum(1 for item in results if item.unresolved_domain)
    actual_domains = {
        item.actual_domain
        for item in results
        if item.actual_domain and item.actual_write_mode != "do_not_save"
    }
    expected_domains = {
        domain
        for item in results
        for domain in item.expected_domains
        if domain and domain != _GENERAL_DOMAIN_KEY
    }
    fragmentation_score = round(
        len(actual_domains) / max(1, len(expected_domains)),
        4,
    )
    return {
        "prompt_count": total,
        "average_latency_ms": average_latency_ms,
        "p95_latency_ms": p95_latency_ms,
        "schema_ok_rate": _rate("schema_ok"),
        "save_class_ok_rate": _rate("save_class_ok"),
        "intent_ok_rate": _rate("intent_ok"),
        "mutation_ok_rate": _rate("mutation_ok"),
        "domain_ok_rate": _rate("domain_ok"),
        "confirmation_ok_rate": _rate("confirmation_ok"),
        "fallback_rate": fallback_rate,
        "timeout_count": sum(1 for item in results if item.timed_out),
        "finance_contamination_count": finance_contamination_count,
        "unresolved_domain_count": unresolved_domain_count,
        "fragmentation_score": fragmentation_score,
    }


def _contract_signature(record: dict[str, Any]) -> tuple[str, str, str, str, str]:
    return (
        str(record.get("actual_save_class") or ""),
        str(record.get("actual_intent_class") or ""),
        str(record.get("actual_mutation_intent") or ""),
        str(record.get("actual_domain") or ""),
        str(record.get("actual_write_mode") or ""),
    )


def _compute_mode_stability(modes: list[dict[str, Any]]) -> dict[str, Any]:
    if len(modes) < 2:
        return {"compared_modes": 0, "exact_contract_stability_rate": 1.0}
    primary_persona_results = {}
    for persona in modes[0].get("personas") or []:
        for record in persona.get("results") or []:
            primary_persona_results[record["case_id"]] = _contract_signature(record)

    total = 0
    matches = 0
    for mode in modes[1:]:
        for persona in mode.get("personas") or []:
            for record in persona.get("results") or []:
                case_id = record["case_id"]
                primary = primary_persona_results.get(case_id)
                if primary is None:
                    continue
                total += 1
                if primary == _contract_signature(record):
                    matches += 1
    return {
        "compared_modes": len(modes) - 1,
        "exact_contract_stability_rate": round(matches / total, 4) if total else 1.0,
    }


def _mode_matrix(args: argparse.Namespace) -> list[tuple[str, str | None, bool]]:
    primary = (args.model or "").strip()
    return [("candidate_minimal", primary or DEFAULT_PRIMARY_MODEL, True)]


def _manual_kpi_summary(
    *,
    phase: str,
    synthetic_reports: list[dict[str, Any]],
    shadow_reports: list[dict[str, Any]],
    mode_stability: dict[str, Any],
) -> dict[str, Any]:
    return {
        "phase": phase,
        "synthetic_kpis": [
            {
                "mode": report["mode"],
                "model_override": report["model_override"],
                "strict_small_model": report["strict_small_model"],
                **report["summary"],
            }
            for report in synthetic_reports
        ],
        "shadow_kpis": [
            {
                "mode": report["mode"],
                "model_override": report["model_override"],
                "strict_small_model": report["strict_small_model"],
                **report["summary"],
            }
            for report in shadow_reports
        ],
        "synthetic_mode_stability": mode_stability,
        "latency_recommendation": {
            "recommended_fast_path_mode": synthetic_reports[0]["mode"] if synthetic_reports else "",
            "recommended_fast_path_model": synthetic_reports[0]["model_override"]
            if synthetic_reports
            else "",
            "selection_rule": "single-model minimal-thinking run on gemini-3.1-flash-lite-preview",
        },
    }


async def main() -> int:
    args = parse_args()
    env_file = Path(args.env_file).expanduser().resolve() if args.env_file else None
    if env_file and env_file.exists():
        load_dotenv(env_file, override=True)

    report_path = Path(args.json_out).expanduser().resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)

    service = get_pkm_agent_lab_service()
    pkm_service = PersonalKnowledgeModelService()
    personas, chain_state = build_phase_personas(
        phase=args.phase,
        max_prompts_per_persona=args.max_prompts_per_persona,
    )
    modes = _mode_matrix(args)

    synthetic_reports = []
    shadow_reports = []
    started_at = time.time()
    for mode_name, model_override, strict_small_model in modes:
        synthetic_reports.append(
            await _run_synthetic_mode(
                service=service,
                personas=personas,
                mode_name=mode_name,
                model_override=model_override,
                strict_small_model=strict_small_model,
                chain_state=chain_state,
                per_prompt_timeout_seconds=args.per_prompt_timeout_seconds,
            )
        )
        if not args.skip_shadow:
            shadow_reports.append(
                await _run_shadow_mode(
                    service=service,
                    pkm_service=pkm_service,
                    shadow_users=args.shadow_users,
                    mode_name=mode_name,
                    model_override=model_override,
                    strict_small_model=strict_small_model,
                    per_prompt_timeout_seconds=args.per_prompt_timeout_seconds,
                )
            )

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_seconds": round(time.time() - started_at, 2),
        "env_file": str(env_file) if env_file else "",
        "phase": args.phase,
        "synthetic_persona_count": len(personas),
        "synthetic_prompt_count": sum(len(persona["prompts"]) for persona in personas),
        "mode_matrix": [
            {
                "mode": mode_name,
                "model_override": model_override or "",
                "strict_small_model": strict_small_model,
            }
            for mode_name, model_override, strict_small_model in modes
        ],
        "synthetic_reports": synthetic_reports,
        "shadow_reports": shadow_reports,
        "synthetic_mode_stability": _compute_mode_stability(synthetic_reports),
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            _manual_kpi_summary(
                phase=args.phase,
                synthetic_reports=synthetic_reports,
                shadow_reports=shadow_reports,
                mode_stability=report["synthetic_mode_stability"],
            ),
            indent=2,
        )
    )
    print(f"Wrote PKM structure-agent report to {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
