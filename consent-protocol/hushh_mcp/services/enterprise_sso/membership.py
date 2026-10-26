"""Immutable Directory Sync attribution to the original application generation.

Only a fresh, verified SSO exchange may capture this relationship. Webhooks never
discover an owner by email. Retained hashes prevent a membership from being rebound
after local erasure; raw identity values stay in the existing generation authority.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_user_hash,
)

from .errors import EnterpriseSsoError
from .workos_adapter import DirectoryMembership, SsoProfile


def membership_hash(*parts: str) -> str:
    if any(not isinstance(p, str) or not 1 <= len(p) <= 255 or "\0" in p for p in parts):
        raise EnterpriseSsoError("sso_directory_binding_required", 503)
    payload = json.dumps(["hussh.workos.membership.v1", *parts], separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode()).hexdigest()


@dataclass(frozen=True)
class CapturedMembership:
    owner_id: str | None
    origin: str
    profile_hash: str


class MembershipPort(Protocol):
    def capture(
        self, owner_id: str, profile: SsoProfile, directory: DirectoryMembership | None, origin: str
    ) -> str | None: ...

    def offboard(self, organization: str, directory: str, person: str) -> CapturedMembership: ...


@contextmanager
def _connection():
    try:
        with get_db_connection() as conn:
            yield conn
    except EnterpriseSsoError:
        raise
    except Exception:
        raise EnterpriseSsoError("sso_identity_status_unavailable", 503) from None


def _capture_generation_zero(conn, owner_id: str, owner: str) -> None:
    row = (
        conn.execute(
            text(
                "SELECT * FROM account_generations WHERE identity_hash=:owner ORDER BY generation DESC LIMIT 1"
            ),
            {"owner": owner},
        )
        .mappings()
        .first()
    )
    # WorkOS enrollment of replacements is a separate, unsupported proof.
    # Never attach a freshly exchanged old membership to a latest owner.
    if row is not None and (row["generation"] != 0 or row["retired_at"] is not None):
        raise EnterpriseSsoError("sso_account_deleted", 403)
    if conn.execute(
        text("SELECT EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash=:owner)"),
        {"owner": owner},
    ).scalar_one():
        raise EnterpriseSsoError("sso_account_deleted", 403)
    conn.execute(
        text("""INSERT INTO account_generations
        (identity_hash,generation,owner_hash,identity_uid,owner_id)
        VALUES(:owner,0,:owner,:uid,:uid) ON CONFLICT DO NOTHING"""),
        {"owner": owner, "uid": owner_id},
    )


def _existing_profile_membership(conn, profile_key: str, owner: str, origin: str) -> str | None:
    existing = (
        conn.execute(
            text("SELECT * FROM account_workos_memberships WHERE profile_hash=:profile"),
            {"profile": profile_key},
        )
        .mappings()
        .first()
    )
    if existing is None:
        return None
    if existing["owner_hash"] != owner or existing["origin"] != origin:
        raise EnterpriseSsoError("sso_account_conflict", 409)
    if existing["offboarded_at"] is not None:
        raise EnterpriseSsoError("sso_deprovisioned", 403)
    return str(existing["membership_hash"])


class SqlMembershipStore:
    """Use the lifecycle lock order and account-generation store already in service."""

    def capture(
        self, owner_id: str, profile: SsoProfile, directory: DirectoryMembership | None, origin: str
    ) -> str | None:
        organization = str(profile.organization_id or "")
        profile_key = membership_hash(organization, profile.id)
        owner = account_deletion_user_hash(owner_id)
        if origin not in {"created", "linked"}:
            raise EnterpriseSsoError("sso_account_conflict", 409)
        with _connection() as conn:
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            conn.execute(text("SET LOCAL lock_timeout='3000ms'"))
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(
                conn, user_ids=(owner_id,)
            )
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:owner,199))"), {"owner": owner}
            )
            _capture_generation_zero(conn, owner_id, owner)
            if directory is None:
                return _existing_profile_membership(conn, profile_key, owner, origin)
            key = membership_hash(organization, directory.directory_id, directory.user_id)
            binding = membership_hash(
                organization,
                str(profile.connection_id or ""),
                profile.id,
                str(profile.idp_id or ""),
                directory.directory_id,
                directory.user_id,
            )
            conn.execute(
                text("""INSERT INTO account_workos_memberships
                (membership_hash,binding_hash,profile_hash,identity_hash,owner_hash,generation,origin)
                VALUES(:key,:binding,:profile,:owner,:owner,0,:origin) ON CONFLICT DO NOTHING"""),
                {
                    "key": key,
                    "binding": binding,
                    "profile": profile_key,
                    "owner": owner,
                    "origin": origin,
                },
            )
            captured = (
                conn.execute(
                    text("SELECT * FROM account_workos_memberships WHERE membership_hash=:key"),
                    {"key": key},
                )
                .mappings()
                .first()
            )
            if captured is None or any(
                captured[name] != value
                for name, value in {
                    "binding_hash": binding,
                    "profile_hash": profile_key,
                    "identity_hash": owner,
                    "owner_hash": owner,
                    "generation": 0,
                    "origin": origin,
                }.items()
            ):
                raise EnterpriseSsoError("sso_account_conflict", 409)
            if captured["offboarded_at"] is not None:
                raise EnterpriseSsoError("sso_deprovisioned", 403)
        return key

    def admit(self, key: str, owner_id: str) -> bool:
        """A late custom-token exchange never revives an offboarded membership."""
        with _connection() as conn:
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            return (
                conn.execute(
                    text("""SELECT EXISTS(SELECT 1 FROM account_workos_memberships m
                JOIN account_generations g ON g.identity_hash=m.identity_hash
                 AND g.owner_hash=m.owner_hash AND g.generation=m.generation
                WHERE m.membership_hash=:key AND m.owner_hash=:owner
                 AND m.offboarded_at IS NULL AND g.retired_at IS NULL AND g.owner_id=:uid)"""),
                    {"key": key, "owner": account_deletion_user_hash(owner_id), "uid": owner_id},
                ).scalar_one()
                is True
            )

    def admit_profile(self, profile_key: str, owner_id: str) -> bool:
        """A token issued before directory enrollment inherits subsequent offboarding."""
        with _connection() as conn:
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            row = (
                conn.execute(
                    text("""SELECT g.owner_id,g.retired_at FROM account_generations g
                WHERE g.owner_hash=:owner AND g.identity_hash=:owner AND g.generation=0"""),
                    {"owner": account_deletion_user_hash(owner_id)},
                )
                .mappings()
                .first()
            )
            if row is None or row["owner_id"] != owner_id or row["retired_at"] is not None:
                return False
            binding = (
                conn.execute(
                    text(
                        "SELECT owner_hash,offboarded_at FROM account_workos_memberships WHERE profile_hash=:profile"
                    ),
                    {"profile": profile_key},
                )
                .mappings()
                .first()
            )
            return binding is None or (
                binding["owner_hash"] == account_deletion_user_hash(owner_id)
                and binding["offboarded_at"] is None
            )

    def offboard(self, organization: str, directory: str, person: str) -> CapturedMembership:
        key = membership_hash(organization, directory, person)
        with _connection() as conn:
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            row = (
                conn.execute(
                    text("""SELECT m.*,g.owner_id,g.retired_at FROM account_workos_memberships m
                JOIN account_generations g ON g.owner_hash=m.owner_hash
                 AND g.identity_hash=m.identity_hash AND g.generation=m.generation
                WHERE m.membership_hash=:key"""),
                    {"key": key},
                )
                .mappings()
                .first()
            )
            if row is None:
                # Missing legacy evidence requires reconciliation, not an email guess.
                raise EnterpriseSsoError("sso_directory_binding_required", 503)
            conn.execute(
                text("""UPDATE account_workos_memberships SET offboarded_at=clock_timestamp()
                WHERE membership_hash=:key AND offboarded_at IS NULL"""),
                {"key": key},
            )
            owner = None if row["retired_at"] is not None else row["owner_id"]
            return CapturedMembership(owner, row["origin"], row["profile_hash"])
