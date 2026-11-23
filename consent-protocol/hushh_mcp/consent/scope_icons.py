"""Canonical Phosphor icon taxonomy and semantic resolver for dynamic scopes.

Every scope and dynamic PKM domain maps to a single flat Phosphor outline key
rendered by ``@/components/icons`` on Web, iOS, and Android. Sparkle glyphs are
strictly prohibited by platform design policy.
"""

from __future__ import annotations

import re

CANONICAL_PHOSPHOR_SCOPE_ICONS: frozenset[str] = frozenset(
    {
        "bank",
        "wallet",
        "credit-card",
        "receipt",
        "chart-line",
        "chart-pie",
        "coins",
        "shield-check",
        "lock-key",
        "identification-card",
        "user-circle",
        "users-three",
        "heart",
        "airplane",
        "fork-knife",
        "briefcase",
        "graduation-cap",
        "house",
        "car",
        "shopping-bag",
        "calendar-blank",
        "envelope-simple",
        "map-pin",
        "file-text",
        "book-open",
        "cpu",
        "globe",
        "buildings",
        "television",
        "folder-simple",
    }
)

PHOSPHOR_ICON_PROMPT_CHOICES: tuple[str, ...] = tuple(sorted(CANONICAL_PHOSPHOR_SCOPE_ICONS))

_LEGACY_ICON_ALIASES: dict[str, str] = {
    "landmark": "bank",
    "bank": "bank",
    "wallet": "wallet",
    "credit-card": "credit-card",
    "receipt": "receipt",
    "line-chart": "chart-line",
    "bar-chart-3": "chart-line",
    "chart-no-axes-column": "chart-line",
    "activity": "chart-line",
    "sparkles": "chart-line",  # Sparkles banned; derived analytics use chart-line.
    "pie-chart": "chart-pie",
    "coins": "coins",
    "shield": "shield-check",
    "shield-check": "shield-check",
    "key-round": "lock-key",
    "lock": "lock-key",
    "lock-key": "lock-key",
    "id-card": "identification-card",
    "identification-card": "identification-card",
    "user-round": "user-circle",
    "user-circle": "user-circle",
    "users": "users-three",
    "users-round": "users-three",
    "users-three": "users-three",
    "heart": "heart",
    "plane": "airplane",
    "airplane": "airplane",
    "utensils": "fork-knife",
    "fork-knife": "fork-knife",
    "briefcase": "briefcase",
    "graduation-cap": "graduation-cap",
    "home": "house",
    "house": "house",
    "car": "car",
    "shopping-bag": "shopping-bag",
    "calendar": "calendar-blank",
    "calendar-blank": "calendar-blank",
    "mail": "envelope-simple",
    "envelope": "envelope-simple",
    "envelope-simple": "envelope-simple",
    "map-pin": "map-pin",
    "map": "map-pin",
    "compass": "map-pin",
    "route": "map-pin",
    "file-text": "file-text",
    "file-pen": "file-text",
    "book-open": "book-open",
    "library": "book-open",
    "brain": "book-open",
    "cpu": "cpu",
    "globe": "globe",
    "link": "globe",
    "building": "buildings",
    "buildings": "buildings",
    "tv": "television",
    "television": "television",
}

_SEMANTIC_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "credit-card",
        (
            "liability",
            "liabilities",
            "credit",
            "loan",
            "mortgage",
            "debt",
            "card",
            "apr",
            "utilization",
        ),
    ),
    (
        "receipt",
        (
            "statement",
            "statements",
            "tax",
            "invoice",
            "receipt",
            "billing",
            "bill",
            "bills",
            "expense",
            "ledger",
            "1099",
            "w2",
        ),
    ),
    (
        "chart-pie",
        (
            "holding",
            "holdings",
            "portfolio",
            "allocation",
            "equity",
            "equities",
            "asset",
            "ira",
            "401k",
            "brokerage",
            "schwab",
            "fidelity",
            "vanguard",
        ),
    ),
    (
        "chart-line",
        (
            "analytics",
            "summary",
            "cashflow",
            "cash_flow",
            "performance",
            "net_worth",
            "networth",
            "market",
            "security",
            "securities",
            "stock",
            "yield",
        ),
    ),
    (
        "wallet",
        (
            "payout",
            "payouts",
            "stripe",
            "wallet",
            "payment",
            "payments",
            "income",
            "salary",
            "compensation",
            "earnings",
        ),
    ),
    (
        "bank",
        (
            "financial",
            "finance",
            "bank",
            "banking",
            "checking",
            "savings",
            "depository",
            "plaid",
            "chase",
            "bofa",
            "citibank",
            "treasury",
            "account",
            "accounts",
        ),
    ),
    (
        "identification-card",
        (
            "kyc",
            "passport",
            "license",
            "ssn",
            "ein",
            "verification",
            "citizenship",
            "visa",
            "immigration",
            "identity",
        ),
    ),
    (
        "heart",
        (
            "health",
            "medical",
            "fitness",
            "wellness",
            "workout",
            "sleep",
            "allergy",
            "medication",
            "clinical",
            "nutrition",
            "lab",
        ),
    ),
    (
        "airplane",
        (
            "travel",
            "flight",
            "airline",
            "hotel",
            "itinerary",
            "trip",
            "vacation",
            "loyalty",
            "miles",
            "airport",
        ),
    ),
    (
        "fork-knife",
        (
            "food",
            "dining",
            "restaurant",
            "cuisine",
            "coffee",
            "diet",
            "dietary",
            "meal",
            "recipe",
            "beverage",
        ),
    ),
    (
        "graduation-cap",
        (
            "education",
            "university",
            "college",
            "school",
            "degree",
            "course",
            "academic",
            "certification",
            "research",
        ),
    ),
    (
        "house",
        (
            "housing",
            "home",
            "real_estate",
            "lease",
            "rent",
            "property",
            "address",
            "residence",
            "utility",
        ),
    ),
    ("car", ("vehicle", "automotive", "car", "driving", "transit", "commute", "insurance_auto")),
    (
        "television",
        ("entertainment", "media", "music", "movie", "streaming", "gaming", "podcast", "show"),
    ),
    (
        "shopping-bag",
        (
            "shopping",
            "commerce",
            "retail",
            "order",
            "purchase",
            "wardrobe",
            "brand",
            "subscription",
        ),
    ),
    (
        "calendar-blank",
        (
            "calendar",
            "schedule",
            "meeting",
            "appointment",
            "availability",
            "event",
            "events",
            "reminder",
        ),
    ),
    ("envelope-simple", ("email", "gmail", "inbox", "newsletter", "correspondence", "message")),
    ("map-pin", ("location", "place", "places", "neighborhood", "city", "geography", "nearby")),
    (
        "cpu",
        (
            "engineering",
            "software",
            "code",
            "tech",
            "stack",
            "infrastructure",
            "cloud",
            "ai",
            "developer",
            "tooling",
        ),
    ),
    (
        "buildings",
        ("company", "organization", "enterprise", "vendor", "business", "businesses", "employer"),
    ),
    (
        "briefcase",
        ("professional", "career", "work", "employment", "resume", "role", "project", "consulting"),
    ),
    (
        "users-three",
        (
            "social",
            "family",
            "friends",
            "network",
            "relationship",
            "community",
            "circle",
            "people",
            "colleague",
        ),
    ),
    ("lock-key", ("security", "credential", "vault", "privacy", "permission", "consent")),
    (
        "book-open",
        ("wiki", "memory", "knowledge", "notes", "reading", "book", "journal", "biography"),
    ),
    (
        "user-circle",
        ("profile", "personal", "preference", "preferences", "lifestyle", "habit", "goal", "goals"),
    ),
    (
        "file-text",
        ("document", "documents", "contract", "legal", "policy", "archive", "record", "records"),
    ),
)

_TOKEN_SPLIT_RE = re.compile(r"[^a-z0-9]+")


def _tokenize(*parts: str | None) -> set[str]:
    tokens: set[str] = set()
    joined_parts: list[str] = []
    for part in parts:
        if not part:
            continue
        lowered = part.strip().lower()
        if not lowered:
            continue
        joined_parts.append(lowered.replace("-", "_").replace(" ", "_"))
        for tok in _TOKEN_SPLIT_RE.split(lowered):
            if tok:
                tokens.add(tok)
    haystack = " ".join(joined_parts)
    for _, keywords in _SEMANTIC_RULES:
        for kw in keywords:
            if "_" in kw and kw in haystack:
                tokens.add(kw)
    return tokens


def normalize_or_infer_scope_icon(
    *,
    icon_name: str | None = None,
    domain: str | None = None,
    scope: str | None = None,
    label: str | None = None,
    description: str | None = None,
) -> str:
    """Resolve an explicit or inferred Phosphor icon key without generic folder drift."""
    cleaned = (icon_name or "").strip().lower()
    if cleaned and cleaned not in {"folder", "folder-simple"}:
        if cleaned in CANONICAL_PHOSPHOR_SCOPE_ICONS:
            return cleaned
        mapped = _LEGACY_ICON_ALIASES.get(cleaned)
        if mapped:
            return mapped

    # Score finer scope/label tokens higher than broad parent domain tokens so
    # e.g. ``financial.liabilities`` picks ``credit-card`` while ``financial.accounts`` picks ``bank``.
    specific_tokens = _tokenize(scope, label, description)
    domain_tokens = _tokenize(domain)

    best_icon: str | None = None
    best_score = 0
    for candidate_icon, keywords in _SEMANTIC_RULES:
        specific_hits = sum(3 for kw in keywords if kw in specific_tokens)
        domain_hits = sum(1 for kw in keywords if kw in domain_tokens)
        score = specific_hits + domain_hits
        if score > best_score:
            best_score = score
            best_icon = candidate_icon

    if best_icon is not None:
        return best_icon
    return "folder-simple"
