"""Read-only Firebase projections keyed by the captured application owner."""

from types import SimpleNamespace

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.account_generation_service import AccountGenerationService

FIELDS = (
    "disabled",
    "custom_claims",
    "provider_data",
    "email",
    "email_verified",
    "phone_number",
    "display_name",
    "user_metadata",
)


def owned_record(record, owner: str):
    # Copy only the fields consumed by the private audience projection. Firebase
    # export records can contain password hashes and must never be forwarded.
    return SimpleNamespace(
        uid=owner, firebase_uid=record.uid, **{key: getattr(record, key, None) for key in FIELDS}
    )


def captured_records(owners: list[str], lookup):
    """Resolve exact stored owners, never reinterpret an old attempt as new work."""
    identities = AccountGenerationService.firebase_identities_for_owners(owners)
    if not set(identities).issubset(owners) or len(set(identities.values())) != len(identities):
        raise ValueError("invalid audience owner mapping")
    reverse = {identity: owner for owner, identity in identities.items()}
    records = list(lookup(list(reverse))) if reverse else []
    returned = [record.uid for record in records]
    if len(set(returned)) != len(returned) or not set(returned).issubset(reverse):
        raise ValueError("invalid registered identity result")
    return [owned_record(record, reverse[record.uid]) for record in records]


CURRENT_OWNERS_SQL = """
SELECT requested.uid,
 CASE WHEN g.identity_hash IS NULL THEN requested.uid ELSE g.owner_id END AS owner
FROM unnest(CAST(:identities AS text[])) AS requested(uid)
LEFT JOIN LATERAL (
 SELECT identity_hash,identity_uid,owner_id,retired_at FROM account_generations
 WHERE identity_hash='sha256:'||encode(sha256(convert_to(requested.uid,'UTF8')),'hex')
 ORDER BY generation DESC LIMIT 1
) g ON true
WHERE (g.identity_hash IS NULL AND requested.uid !~ '^acct_[0-9a-f]{32}$')
 OR (g.identity_uid=requested.uid AND g.retired_at IS NULL)
"""


def current_records(records):
    """Directory-only current generation selection; this port grants no access.

    The caller uses this only when the same generation admission switch as HTTP
    authentication is enabled. Lifecycle and reporting checks still run later
    against the selected owner, so retirement during traversal excludes it.
    """
    if not records:
        return []
    identities = [record.uid for record in records]
    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
        rows = list(conn.execute(text(CURRENT_OWNERS_SQL), {"identities": identities}).mappings())
    owners = {row["uid"]: row["owner"] for row in rows}
    if (
        len(owners) != len(rows)
        or not set(owners).issubset(identities)
        or any(
            not isinstance(owner, str) or not 1 <= len(owner) <= 128 for owner in owners.values()
        )
        or len(set(owners.values())) != len(owners)
    ):
        raise ValueError("invalid audience owner mapping")
    return [owned_record(record, owners[record.uid]) for record in records if record.uid in owners]
