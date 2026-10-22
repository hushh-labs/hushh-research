"""Read-only customer reporting policy; never changes product access or accounts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Mapping

from hushh_mcp.runtime_settings import one_magic_intelligence_cohorts
from hushh_mcp.services.email_auth.identity import enterprise_account_deprovisioned


def reporting_identifiers(record) -> tuple[str, ...] | None:
    """Read only allowlisted auth fields; never serialize auth export records."""
    if (
        record.disabled
        or enterprise_account_deprovisioned(record.custom_claims or {})
        or not (record.provider_data or record.email or record.phone_number)
        or not isinstance(record.uid, str)
        or not 1 <= len(record.uid) <= 128
    ):
        return None
    return (str(record.email or ""), *(str(p.email or "") for p in record.provider_data))


async def current_reporting_records(user_ids: Iterable[str]) -> dict[str, dict]:
    """Bounded, production-only read of current and linked-provider deny identifiers."""
    from firebase_admin import auth

    from api.utils.firebase_admin import get_firebase_auth_app

    ids = sorted(set(user_ids))
    if not ids:
        return {}
    if len(ids) > 50 or any(not isinstance(uid, str) or not 1 <= len(uid) <= 128 for uid in ids):
        raise ValueError("Customer reporting identity bound exceeded")
    app = get_firebase_auth_app()
    if app is None or app.project_id != "hushh-pda":
        raise ValueError("Customer reporting identity source unavailable")
    result = await asyncio.wait_for(
        asyncio.to_thread(auth.get_users, [auth.UidIdentifier(uid) for uid in ids], app=app),
        timeout=6,
    )
    records = list(result.users)
    missing = list(result.not_found)
    missing_ids = [item.uid for item in missing if isinstance(item, auth.UidIdentifier)]
    returned_ids = [record.uid for record in records]
    if (
        len(missing_ids) != len(missing)
        or len(set(returned_ids + missing_ids)) != len(ids)
        or sorted(returned_ids + missing_ids) != ids
    ):
        raise ValueError("Invalid customer reporting identities")
    identifiers = {}
    for record in records:
        if record.uid not in ids:
            raise ValueError("Unexpected customer reporting identity")
        emails = reporting_identifiers(record)
        if emails is not None:
            created = getattr(getattr(record, "user_metadata", None), "creation_timestamp", None)
            registered = None
            if (
                isinstance(created, (int, float))
                and not isinstance(created, bool)
                and math.isfinite(created)
                and 0 < created <= datetime.now(timezone.utc).timestamp() * 1000
            ):
                registered = datetime.fromtimestamp(created / 1000, timezone.utc).isoformat()
            identifiers[record.uid] = {"emails": emails, "registeredAt": registered}
    return identifiers


async def current_reporting_identifiers(user_ids: Iterable[str]) -> dict[str, tuple[str, ...]]:
    return {uid: row["emails"] for uid, row in (await current_reporting_records(user_ids)).items()}


@dataclass(frozen=True)
class ReportingPolicy:
    account_ids: frozenset[str]
    emails: frozenset[str]
    domains: frozenset[str]
    revision: str

    def eligible(self, uid: str, identity: Mapping | None, emails: Iterable[str] = ()) -> bool:
        # This is positive production-backend identity evidence, not an activity claim.
        if not identity or uid in self.account_ids:
            return False
        email = str(identity.get("email") or "").strip()
        phone = str(identity.get("phone_number") or "").strip()
        if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", email) and not (
            identity.get("phone_verified") is True and re.fullmatch(r"\+[1-9][0-9]{6,14}", phone)
        ):
            return False
        for address in (email, *emails):
            address = str(address or "").strip().lower()
            domain = address.rpartition("@")[2]
            if address in self.emails or any(
                domain == blocked or domain.endswith("." + blocked) for blocked in self.domains
            ):
                return False
        return True

    def proof(self) -> dict:
        return {"scope": "production_registered_contacts", "policyRevision": self.revision}


class ReportingPolicyUnavailable(RuntimeError):
    """A server policy outage, never caller request validation."""


def reporting_policy() -> ReportingPolicy:
    try:
        return _reporting_policy()
    except (ValueError, TypeError):
        raise ReportingPolicyUnavailable("Customer reporting policy unavailable") from None


def _reporting_policy() -> ReportingPolicy:
    """The explicit roster is secret-backed and required; bad/missing policy fails closed."""
    raw = os.getenv("ONE_PLG_REPORTING_POLICY_JSON", "")
    if not raw or len(raw) > 250_000:
        raise ValueError("Customer reporting policy unavailable")
    value = json.loads(raw)
    keys = {"version", "excludedAccountIds", "excludedEmails", "excludedDomains"}
    if (
        not isinstance(value, dict)
        or set(value) != keys
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise ValueError("Invalid customer reporting policy")
    for key in keys - {"version"}:
        items = value[key]
        if (
            not isinstance(items, list)
            or len(items) > 5000
            or any(
                not isinstance(item, str)
                or not item.strip()
                or len(item) > 254
                or re.search(r"[\x00-\x1f\x7f]", item)
                for item in items
            )
        ):
            raise ValueError("Invalid customer reporting policy")
    ids = {item.strip() for item in value["excludedAccountIds"]}
    if any(len(uid) > 128 for uid in ids):
        raise ValueError("Invalid customer reporting policy")
    for key in ("REVIEWER_UID", "REVIEWER_COUNTERPART_UID"):
        reviewer = os.getenv(key, "").strip()
        if reviewer:
            ids.add(reviewer)
    emails = {item.strip().lower() for item in value["excludedEmails"]}
    emails.update(
        address.strip().lower() for cohort in one_magic_intelligence_cohorts() for address in cohort
    )
    if any(not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", email) for email in emails):
        raise ValueError("Invalid customer reporting policy")
    domains = {item.strip().lower() for item in value["excludedDomains"]}
    if any(
        not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain)
        for domain in domains
    ):
        raise ValueError("Invalid customer reporting policy")
    if not (ids or emails or domains):
        raise ValueError("Customer reporting exclusions are not configured")
    revision = hashlib.sha256(
        json.dumps(
            ["production_registered_contacts_v1", sorted(ids), sorted(emails), sorted(domains)],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return ReportingPolicy(frozenset(ids), frozenset(emails), frozenset(domains), revision)
