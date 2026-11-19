"""Authored product scopes and bounded lexical matching; never action authority."""

import base64
import hashlib
import hmac
import json
import re
import unicodedata
from datetime import datetime
from typing import Any, Literal, TypedDict

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.feed_activity_policy import EVENTS, POLICY

SCOPES = POLICY["scopes"]


class FeedSearchCriteria(TypedDict, total=False):
    query: str
    person: str
    person_ref: str | None
    agent: str | None
    scope: str | None
    persona: Literal["investor", "ria"]
    from_at: datetime | None
    before_at: datetime | None
    cursor: str | None
    limit: int


class FeedSearchError(ValueError):
    pass


def normalized(value: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).lower()))


def scope_sql(alias: str) -> str:
    if alias not in {"g", "m", "keyed"}:
        raise ValueError("Authored SQL alias required")
    rules = " ".join(
        f"WHEN {alias}.event_type='{event}' THEN '{rule['scope']}'"
        for event, rule in EVENTS.items()
    )
    classified = " ".join(
        f"WHEN {alias}.subagent_id='{agent}' THEN '{scope}'"
        for agent, scope in POLICY["classified_scopes"].items()
    )
    connectors = " ".join(
        f"WHEN {alias}.event_type='connector_reconnect_required' AND {alias}.metadata->>'connector_key'='{key}' THEN '{scope}'"
        for key, scope in POLICY["connector_scopes"].items()
    )
    return f"CASE {classified} {connectors} ELSE CASE {rules} ELSE 'one' END END"


def terms_sql(alias: str) -> str:
    if alias != "m":
        raise ValueError("Authored SQL alias required")
    rules = []
    for event, rule in EVENTS.items():
        aliases = ",".join(
            "'" + term.replace("'", "''") + "'" for term in rule.get("search_terms", [])
        )
        rules.append(f"WHEN m.event_type='{event}' THEN ARRAY[{aliases}]::text[]")
    return "CASE " + " ".join(rules) + " ELSE ARRAY[]::text[] END"


def criteria_key(owner: str, values: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps([owner, values], sort_keys=True, default=str).encode()
    ).hexdigest()


def cursor_mac(encoded: str, key: str) -> str:
    secret = get_core_security_settings().app_signing_key.encode()
    message = json.dumps(["feed-activity-search-cursor-v1", key, encoded], separators=(",", ":"))
    return (
        base64.urlsafe_b64encode(hmac.new(secret, message.encode(), hashlib.sha256).digest())
        .decode()
        .rstrip("=")
    )


def decode_cursor(raw: str | int | None, key: str) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        if not isinstance(raw, str) or len(raw) > 1024:
            raise ValueError
        encoded, separator, signature = raw.rpartition(".")
        if not separator or not hmac.compare_digest(signature, cursor_mac(encoded, key)):
            raise ValueError
        raw = encoded
        value = json.loads(
            base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=b"-_", validate=True)
        )
        if (
            set(value) != {"v", "key", "snapshot", "rank", "at", "id", "revision"}
            or type(value["v"]) is not int
            or value["v"] != 1
            or value["key"] != key
            or not re.fullmatch(r"[0-9a-f]{32}", value["revision"])
        ):
            raise ValueError
        if any(
            not isinstance(value[k], int) or isinstance(value[k], bool) or value[k] < 0
            for k in ["snapshot", "rank", "id"]
        ):
            raise ValueError
        if (
            value["id"] > 9223372036854775807
            or value["snapshot"] > 9223372036854775807
            or datetime.fromisoformat(value["at"]).tzinfo is None
        ):
            raise ValueError
        if value["rank"] not in {0, 50, 80, 100} or not 0 < value["id"] <= value["snapshot"]:
            raise ValueError
        return value
    except (ValueError, KeyError, TypeError):
        raise FeedSearchError("Search changed. Start again.") from None


def encode_cursor(row: dict[str, Any], key: str, snapshot: int) -> str:
    value = {
        "v": 1,
        "key": key,
        "snapshot": snapshot,
        "revision": row["search_revision"],
        "rank": int(row["search_rank"]),
        "at": row["created_at"].isoformat(),
        "id": int(row["id"]),
    }
    encoded = (
        base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )
    return encoded + "." + cursor_mac(encoded, key)


def typo_suggestion(query: str, labels: list[str]) -> str | None:
    """Offer a unique single transposition only; never change the actual query."""
    words = normalized(query).split()
    for index, word in enumerate(words):
        if len(word) < 4:
            continue
        swaps = {word[:i] + word[i + 1] + word[i] + word[i + 2 :] for i in range(len(word) - 1)}
        matches = {
            part
            for label in labels
            for part in normalized(label).split()
            if part in swaps and part != word
        }
        if len(matches) == 1:
            return " ".join([*words[:index], matches.pop(), *words[index + 1 :]])
    return None
