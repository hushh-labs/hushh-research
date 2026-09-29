"""The one server-side answer to "is this scope sensitive?" (CONTRACT-2 C7).

Founder decision 2026-09-28: sensitive information never reaches the model.
For a sensitive scope the model gets a placeholder outline (field names only)
and the values are decrypted on the person's device into a secure card. Every
surface that has to make that call (the request catalog, request progress, the
"Shared with you" card, and the continuation admission that strips values
before a prompt is built) asks this module, so the answer cannot drift between
them.

The rule, in order:

1. Anything that is not a well-formed ``attr.<domain>`` scope is sensitive
   (deny by default: a scope we cannot classify is not one to relax for).
2. The tax, financial or banking, identity or government-id, health or medical
   and credentials domains are sensitive, by registry key or by the words in a
   dynamic domain or path (``tax_record``, ``medical_history.medications``).
3. An identifier-class key anywhere on the path (``fein``, ``tax_id``,
   ``passport_number``, ``date_of_birth``) is sensitive in ANY domain, by the
   field-level rule in ``field_sensitivity``: the same EIN must not be
   sensitive under "Tax record" and standard under "Legal entity" (localhost
   acceptance run 4, 2026-09-29).
4. A PKM sensitivity tag (``restricted``, ``confidential``, ``sensitive``)
   on the scope, or on any branch a wildcard covers, makes it sensitive. Tags
   only ever escalate; ``standard`` or ``public`` never downgrades rule 2.
5. Everything else ("Food preferences") is standard, and may reach the model
   through the existing continuation path. A standard item can still hold an
   identifier-class FIELD; ``field_sensitivity`` decides that per field.

Pure: no database, no network, no model. A pod can import it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from itertools import pairwise
from typing import Literal

from hushh_mcp.consent.field_sensitivity import field_key_is_sensitive
from hushh_mcp.consent.internal_path_keys import is_secret_shaped_key
from hushh_mcp.consent.segment_labels import humanize_segment
from hushh_mcp.services.domain_contracts import (
    INTERNAL_ONLY_DOMAIN_SLUGS,
    canonical_top_level_domain,
)

Sensitivity = Literal["sensitive", "standard"]
SENSITIVE: Sensitivity = "sensitive"
STANDARD: Sensitivity = "standard"

# Registry domains whose every branch is sensitive. ``ria`` is investment
# advice, ``wallet`` holds payment cards, and the internal-only domains hold
# connector and runtime secrets.
SENSITIVE_DOMAINS: frozenset[str] = frozenset(
    {"financial", "health", "identity", "ria", "wallet", *INTERNAL_ONLY_DOMAIN_SLUGS}
)

# Single words that mark a sensitive domain or path, grouped by the founder's
# five categories. Matched as whole words (after camelCase and separator
# splitting), with a trailing plural "s" folded, so "taxes" and "medications"
# match while "attaxis" or "syntax" do not.
_TAX_WORDS = frozenset({"tax", "taxe", "irs", "w2", "w9", "1040", "1099", "agi"})
_FINANCIAL_WORDS = frozenset(
    {
        "bank",
        "banking",
        "brokerage",
        "credit",
        "cvv",
        "debit",
        "finance",
        "financial",
        "holding",
        "iban",
        "income",
        "investment",
        "loan",
        "mortgage",
        "payroll",
        "paystub",
        "plaid",
        "portfolio",
        "routing",
        "salarie",
        "salary",
        "wage",
        "wallet",
    }
)
_IDENTITY_WORDS = frozenset(
    {
        "aadhaar",
        "birthdate",
        "dob",
        "ein",
        "identity",
        "itin",
        "passport",
        "ssn",
        "visa",
    }
)
_HEALTH_WORDS = frozenset(
    {
        "allergy",
        "allergie",
        "diagnose",
        "diagnosis",
        "disability",
        "health",
        "hipaa",
        "medical",
        "medication",
        "prescription",
        "therapy",
        "vaccination",
        "vaccine",
    }
)
_CREDENTIAL_WORDS = frozenset(
    {"credential", "otp", "passcode", "password", "pin", "secret", "token"}
)
SENSITIVE_WORDS: frozenset[str] = frozenset(
    {*_TAX_WORDS, *_FINANCIAL_WORDS, *_IDENTITY_WORDS, *_HEALTH_WORDS, *_CREDENTIAL_WORDS}
)
# Two-word phrases whose words are harmless alone ("social", "account").
SENSITIVE_PHRASES: frozenset[tuple[str, str]] = frozenset(
    {
        ("account", "number"),
        ("birth", "date"),
        ("date", "birth"),
        ("driver", "license"),
        ("drivers", "license"),
        ("government", "id"),
        ("gov", "id"),
        ("insurance", "policy"),
        ("lab", "result"),
        ("license", "number"),
        ("mental", "health"),
        ("national", "id"),
        ("net", "worth"),
        ("social", "security"),
        ("tax", "id"),
        ("w", "2"),
        ("w", "9"),
    }
)
# PKM sensitivity tags that mean "sensitive". ``sensitivity_label`` on manifest
# paths uses restricted / confidential; the catalog carries the word itself.
SENSITIVE_TAGS: frozenset[str] = frozenset({"confidential", "restricted", "secret", "sensitive"})

_WORD = re.compile(r"[a-z0-9]+")


def _words(raw: str) -> list[str]:
    """Whole words of one raw segment, camelCase-aware, plural "s" folded."""
    words = _WORD.findall(humanize_segment(raw).lower())
    return [word[:-1] if len(word) > 3 and word.endswith("s") else word for word in words]


def _raw_parts(scope: str) -> list[str]:
    return [part.strip() for part in str(scope or "").split(".") if part.strip() and part != "*"]


def words_are_sensitive(segment: str) -> bool:
    """Whether one domain name or path segment names sensitive information."""
    if is_secret_shaped_key(segment):
        return True
    words = _words(segment)
    if any(word in SENSITIVE_WORDS for word in words):
        return True
    return any(pair in SENSITIVE_PHRASES for pair in pairwise(words))


def tag_is_sensitive(tag: object) -> bool:
    return str(tag or "").strip().lower() in SENSITIVE_TAGS


def scope_sensitivity(scope: str | None, pkm_tags: Iterable[object] = ()) -> Sensitivity:
    """``"sensitive"`` or ``"standard"`` for one ``attr.*`` scope.

    ``pkm_tags`` are sensitivity tags already recorded for the scope or any
    branch it covers (a manifest path's ``sensitivity_label``, a catalog
    item's stored ``sensitivity``). They can only make a scope sensitive.
    """
    if any(tag_is_sensitive(tag) for tag in pkm_tags or ()):
        return SENSITIVE
    parts = _raw_parts(str(scope or ""))
    if len(parts) < 2 or parts[0].lower() != "attr":
        return SENSITIVE
    domain = parts[1].lower()
    if domain in SENSITIVE_DOMAINS or canonical_top_level_domain(domain) in SENSITIVE_DOMAINS:
        return SENSITIVE
    segments = parts[1:]
    if any(words_are_sensitive(segment) for segment in segments):
        return SENSITIVE
    # Field level: an identifier key is sensitive in any domain.
    if field_key_is_sensitive(segments[1:]):
        return SENSITIVE
    # A phrase can straddle two segments ("social.security_number").
    joined: list[str] = [word for segment in segments for word in _words(segment)]
    if any(pair in SENSITIVE_PHRASES for pair in pairwise(joined)):
        return SENSITIVE
    return STANDARD


def is_sensitive_scope(scope: str | None, pkm_tags: Iterable[object] = ()) -> bool:
    return scope_sensitivity(scope, pkm_tags) == SENSITIVE


def covers(parent_scope: str, child_scope: str) -> bool:
    """Whether ``parent_scope`` (possibly a wildcard) covers ``child_scope``."""
    parent = [part.lower() for part in _raw_parts(parent_scope)]
    child = [part.lower() for part in _raw_parts(child_scope)]
    return len(parent) >= 2 and child[: len(parent)] == parent


__all__ = [
    "SENSITIVE",
    "SENSITIVE_DOMAINS",
    "SENSITIVE_TAGS",
    "STANDARD",
    "Sensitivity",
    "covers",
    "is_sensitive_scope",
    "scope_sensitivity",
    "tag_is_sensitive",
    "words_are_sensitive",
]
