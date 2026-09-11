"""Durable external-client bindings; consent_audit remains permission authority.

No provisioning, key custody or memory execution is inferred from a connection.
The service is PostgreSQL-only: absent migration/fencing refuses admission.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

from sqlalchemy import Connection, text

from db.db_client import get_db
from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.developer_registry_service import (
    SCHEMA_PROFILE_AGENTFORCE,
    DeveloperPrincipal,
)
from hushh_mcp.services.mcp_oauth_resource import configured_mcp_resource
from hushh_mcp.services.pod_access_audit import _owner_binding_denials
from hushh_mcp.types import AgentID, UserID


class ConsumerConnectionDenied(PermissionError):
    """Safe refusal; callers must not expose database exceptions or parameters."""


class ConsumerSetupRequired(ConsumerConnectionDenied):
    """An existing setup flow must finish before any memory approval is active."""


@dataclass(frozen=True)
class _ConsumerGrant:
    receipt: str
    token: str | None


def has_consumer_oauth_identity(principal: DeveloperPrincipal | None) -> bool:
    """Catalog eligibility only; runtime authorization always rechecks storage."""
    return bool(
        principal
        and principal.auth_source == "oauth"
        and principal.oauth_grant_type == "authorization_code"
        and principal.mcp_execution_mode == "execute"
        and principal.schema_profile != SCHEMA_PROFILE_AGENTFORCE
        and principal.subject_firebase_uid
        and principal.authorization_id
        and principal.oauth_resource
        and principal.oauth_resource == configured_mcp_resource()
    )


@dataclass(frozen=True)
class ConsumerConnection:
    connection_id: str
    generation: int
    deployment_id: str
    authorization_id: int
    client_name: str
    memory_access: bool
    grant_receipt: str | None
    grant_token: str | None = None


class ConsumerMcpConnections:
    def __init__(self, db=None):
        self._db = db if db is not None else get_db()

    @contextmanager
    def _transaction(self, owner: str) -> Iterator[Connection]:
        if not owner or self._db.engine.dialect.name != "postgresql":
            raise ConsumerConnectionDenied("Consumer connection authority unavailable")
        with self._db.engine.begin() as tx:
            if tx.execute(text("SHOW transaction_isolation")).scalar_one() != "read committed":
                raise ConsumerConnectionDenied("Consumer connection authority unavailable")
            # Account deletion uses exclusive locks in this existing order.
            for namespace in (171, 198):
                tx.execute(
                    text("SELECT pg_advisory_xact_lock_shared(hashtextextended(:owner, :ns))"),
                    {"owner": owner, "ns": namespace},
                )
            tombstone = "sha256:" + hashlib.sha256(owner.encode()).hexdigest()
            if tx.execute(
                text("SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash=:hash"),
                {"hash": tombstone},
            ).first():
                raise ConsumerConnectionDenied("Owner account unavailable")
            if not ConsentDBService.consumer_consent_fence_available(tx):
                raise ConsumerConnectionDenied("Consumer connection authority unavailable")
            yield tx

    @staticmethod
    def _oauth(tx: Connection, principal: DeveloperPrincipal) -> dict:
        if not has_consumer_oauth_identity(principal):
            raise ConsumerConnectionDenied("Connect with an owner-authenticated MCP session")
        row = (
            tx.execute(
                text("""
            SELECT a.*, apps.display_name FROM developer_oauth_authorizations a
            JOIN developer_oauth_tokens t ON t.authorization_id=a.id
            JOIN developer_oauth_clients c ON c.client_id=a.client_id AND c.app_id=a.app_id
            JOIN developer_apps apps ON apps.app_id=a.app_id
            WHERE a.id=:authorization AND t.id=:token AND a.status='consumed'
              AND a.subject_firebase_uid=:owner AND a.client_id=:client AND a.app_id=:app
              AND a.resource=:resource AND t.subject_firebase_uid=a.subject_firebase_uid
              AND t.app_id=a.app_id AND t.grant_type='authorization_code'
              AND t.token_kind='access' AND t.revoked_at IS NULL AND t.expires_at>:now
              AND t.mcp_execution_mode='execute' AND c.mcp_execution_mode='execute'
              AND c.revoked_at IS NULL AND apps.status='active'
            FOR SHARE OF a, t, c, apps
        """),
                {
                    "authorization": principal.authorization_id,
                    "token": principal.token_id,
                    "owner": principal.subject_firebase_uid,
                    "client": principal.oauth_client_id,
                    "app": principal.app_id,
                    "resource": principal.oauth_resource,
                    "now": int(time.time() * 1000),
                },
            )
            .mappings()
            .first()
        )
        if not row:
            raise ConsumerConnectionDenied("This MCP session is unavailable")
        return dict(row)

    @staticmethod
    def _deployment(tx: Connection, owner: str) -> str:
        row = (
            tx.execute(
                text("""
            SELECT hushh_id, status, backend_metadata FROM personal_agent_registry
            WHERE user_id=:owner FOR SHARE
        """),
                {"owner": owner},
            )
            .mappings()
            .first()
        )
        metadata = row["backend_metadata"] if row else None
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        normalized = dict(row, backend_metadata=metadata) if row else None
        if _owner_binding_denials(normalized, None):
            raise ConsumerSetupRequired("Finish private agent setup before enabling memory")
        return str(row["hushh_id"])

    @staticmethod
    def _binding(tx: Connection, ref: str, owner: str) -> dict:
        row = (
            tx.execute(
                text("""
            SELECT * FROM consumer_mcp_connections
            WHERE connection_id=:ref AND user_id=:owner FOR UPDATE
        """),
                {"ref": ref, "owner": owner},
            )
            .mappings()
            .first()
        )
        if not row:
            raise ConsumerConnectionDenied("This assistant connection is unavailable")
        binding = dict(row)
        if (
            binding["environment"] != get_app_runtime_settings().environment
            or binding["resource"] != configured_mcp_resource()
        ):
            raise ConsumerConnectionDenied("This assistant belongs to another environment")
        return binding

    @staticmethod
    def _grant_state(tx: Connection, binding: dict) -> _ConsumerGrant | None:
        row = (
            tx.execute(
                text("""
            SELECT token_id, request_id, action, expires_at FROM consent_audit
            WHERE user_id=:owner AND agent_id=:agent AND scope='cap.consumer.memory'
              AND action IN ('CONSENT_GRANTED','CONSUMER_TOKEN_ISSUED','REVOKED','CONSENT_DENIED')
            ORDER BY issued_at DESC, id DESC LIMIT 1
        """),
                {
                    "owner": binding["user_id"],
                    "agent": f"consumer_mcp:{binding['connection_id']}:{binding['generation']}",
                },
            )
            .mappings()
            .first()
        )
        if not row or row["action"] in {"REVOKED", "CONSENT_DENIED"}:
            return None
        receipt = str(row["request_id"] or row["token_id"] or "")
        token = None
        if row["action"] == "CONSUMER_TOKEN_ISSUED":
            candidate = str(row["token_id"] or "")
            valid, _reason, _claims = validate_token(
                candidate, expected_scope=ConsentScope.CAP_CONSUMER_MEMORY
            )
            if valid and row["expires_at"] is not None:
                token = candidate
        return _ConsumerGrant(receipt=receipt, token=token)

    @classmethod
    def _grant(cls, tx: Connection, binding: dict) -> str | None:
        state = cls._grant_state(tx, binding)
        return state.receipt if state else None

    @classmethod
    def _grant_token(cls, tx: Connection, binding: dict) -> str | None:
        state = cls._grant_state(tx, binding)
        return state.token if state else None

    @staticmethod
    def _match(binding: dict, authorization: dict, deployment: str) -> None:
        if (
            authorization["consumer_connection_id"] != binding["connection_id"]
            or authorization["consumer_generation"] != binding["generation"]
            or authorization["subject_firebase_uid"] != binding["user_id"]
            or authorization["app_id"] != binding["app_id"]
            or authorization["client_id"] != binding["client_id"]
            or authorization["resource"] != binding["resource"]
            or deployment != binding["deployment_id"]
        ):
            raise ConsumerConnectionDenied("This assistant connection changed; reconnect")

    @staticmethod
    def _review(
        binding: dict, authorization: dict, grant: _ConsumerGrant | None
    ) -> ConsumerConnection:
        return ConsumerConnection(
            connection_id=binding["connection_id"],
            generation=binding["generation"],
            deployment_id=binding["deployment_id"],
            authorization_id=authorization["id"],
            client_name=authorization["display_name"],
            memory_access=grant is not None and grant.token is not None,
            grant_receipt=grant.receipt if grant else None,
            grant_token=grant.token if grant else None,
        )

    @staticmethod
    def _issue_grant_token(
        tx: Connection,
        *,
        binding: dict,
        receipt: str,
        authorization_id: int | None,
    ) -> str:
        token = issue_token(
            UserID(binding["user_id"]),
            AgentID(f"consumer_mcp:{binding['connection_id']}:{binding['generation']}"),
            ConsentScope.CAP_CONSUMER_MEMORY,
            # Runtime credentials are renewable while standing consent remains active.
            expires_in_ms=15 * 60 * 1000,
        )
        ConsentDBService.append_consumer_memory_decision(
            tx,
            user_id=binding["user_id"],
            connection_id=binding["connection_id"],
            generation=binding["generation"],
            action="CONSUMER_TOKEN_ISSUED",
            receipt_ref=receipt,
            authorization_id=authorization_id,
            token_id=token.token,
            expires_at=token.expires_at,
        )
        return token.token

    @staticmethod
    def _owner_authorization(tx: Connection, *, owner: str, authorization_id: int) -> dict:
        row = (
            tx.execute(
                text("""
            SELECT a.*, apps.display_name FROM developer_oauth_authorizations a
            JOIN developer_oauth_clients c ON c.client_id=a.client_id AND c.app_id=a.app_id
            JOIN developer_apps apps ON apps.app_id=a.app_id
            WHERE a.id=:id AND a.subject_firebase_uid=:owner AND a.status='consumed'
              AND c.revoked_at IS NULL AND apps.status='active'
              AND c.mcp_execution_mode='execute'
            FOR SHARE OF a, c, apps
        """),
                {"id": authorization_id, "owner": owner},
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ConsumerConnectionDenied("This approval changed; review the connection again")
        return dict(row)

    def list_connections(self, *, owner: str, limit: int = 25, after: str = "") -> dict:
        """Owner-only connection metadata; never a credential or memory read."""
        if type(limit) is not int or limit < 1 or limit > 100:
            raise ConsumerConnectionDenied("Invalid connection page size")
        environment = get_app_runtime_settings().environment
        resource = configured_mcp_resource()
        with self._transaction(owner) as tx:
            rows = (
                tx.execute(
                    text("""
                SELECT b.*, apps.display_name FROM consumer_mcp_connections b
                JOIN developer_apps apps ON apps.app_id=b.app_id
                WHERE b.user_id=:owner AND b.environment=:environment
                  AND b.resource=:resource AND b.connection_id>:after
                ORDER BY b.connection_id LIMIT :limit
            """),
                    {
                        "owner": owner,
                        "environment": environment,
                        "resource": resource,
                        "after": after,
                        "limit": limit + 1,
                    },
                )
                .mappings()
                .all()
            )
            items = [
                {
                    "connection_id": row["connection_id"],
                    "generation": row["generation"],
                    "client_name": row["display_name"],
                    "memory_access": self._grant(tx, dict(row)) is not None,
                }
                for row in rows[:limit]
            ]
            return {
                "items": items,
                "next_cursor": items[-1]["connection_id"] if len(rows) > limit else None,
            }

    def list_receipts(self, principal: DeveloperPrincipal, *, limit: int = 25) -> dict:
        """Return bounded, non-bearer audit receipts for this owner connection."""
        if type(limit) is not int or limit < 1 or limit > 50:
            raise ConsumerConnectionDenied("Invalid receipt page size")
        owner = principal.subject_firebase_uid or ""
        with self._transaction(owner) as tx:
            authorization = self._oauth(tx, principal)
            connection_id = str(authorization.get("consumer_connection_id") or "")
            if not connection_id:
                raise ConsumerConnectionDenied("Complete the assistant connection first")
            binding = self._binding(tx, connection_id, owner)
            self._match(binding, authorization, self._deployment(tx, owner))
            agent = f"consumer_mcp:{connection_id}:{binding['generation']}"
            rows = (
                tx.execute(
                    text("""
                SELECT id, request_id, action, issued_at, expires_at, metadata
                FROM consent_audit
                WHERE user_id=:owner AND agent_id=:agent AND scope='cap.consumer.memory'
                ORDER BY id DESC LIMIT :limit
            """),
                    {"owner": owner, "agent": agent, "limit": limit},
                )
                .mappings()
                .all()
            )
            items: list[dict] = []
            for row in rows:
                metadata = row.get("metadata")
                if isinstance(metadata, str):
                    try:
                        metadata = json.loads(metadata)
                    except json.JSONDecodeError:
                        metadata = {}
                items.append(
                    {
                        "receipt_id": str(row.get("request_id") or "")[:128],
                        "action": str(row.get("action") or "")[:32],
                        "issued_at": int(row.get("issued_at") or 0),
                        "expires_at": (
                            int(row["expires_at"]) if row.get("expires_at") is not None else None
                        ),
                        "event_kind": str((metadata or {}).get("event_kind") or "")[:64],
                    }
                )
            return {"items": items}

    def review(
        self, *, owner: str, connection_id: str, authorization_id: int
    ) -> ConsumerConnection:
        """Secure owner review uses registered names and current server bindings."""
        with self._transaction(owner) as tx:
            binding = self._binding(tx, connection_id, owner)
            authorization = self._owner_authorization(
                tx, owner=owner, authorization_id=authorization_id
            )
            self._match(binding, authorization, self._deployment(tx, owner))
            return self._review(binding, authorization, self._grant_state(tx, binding))

    def prepare(self, principal: DeveloperPrincipal) -> ConsumerConnection:
        """Resume one binding; never provision infrastructure or manufacture consent."""
        owner = principal.subject_firebase_uid or ""
        # Initial untrusted lookup chooses a lock only; _oauth revalidates inside.
        with self._transaction(owner) as tx:
            resource = configured_mcp_resource()
            environment = get_app_runtime_settings().environment
            # Serialize competing first sessions before a row exists. All later
            # operations use the row lock; this lock never supplies authority.
            tx.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:binding, 938))"),
                {"binding": json.dumps([owner, principal.oauth_client_id, environment, resource])},
            )
            row = (
                tx.execute(
                    text("""
                SELECT connection_id FROM consumer_mcp_connections
                WHERE user_id=:owner AND client_id=:client AND environment=:environment
                  AND resource=:resource
            """),
                    {
                        "owner": owner,
                        "client": principal.oauth_client_id,
                        "environment": environment,
                        "resource": resource,
                    },
                )
                .mappings()
                .first()
            )
            binding = self._binding(tx, row["connection_id"], owner) if row else None
            authorization = self._oauth(tx, principal)
            deployment = self._deployment(tx, owner)
            if binding is None:
                ref = "cmc_" + secrets.token_hex(16)
                tx.execute(
                    text("""
                    INSERT INTO consumer_mcp_connections
                    (connection_id,user_id,app_id,client_id,environment,resource,deployment_id,created_at)
                    VALUES (:ref,:owner,:app,:client,:environment,:resource,:deployment,:now)
                """),
                    {
                        "ref": ref,
                        "owner": owner,
                        "app": authorization["app_id"],
                        "client": authorization["client_id"],
                        "environment": environment,
                        "resource": resource,
                        "deployment": deployment,
                        "now": int(time.time() * 1000),
                    },
                )
                binding = self._binding(tx, ref, owner)
            if authorization["consumer_connection_id"] is None:
                if authorization["id"] <= binding["authorization_floor_id"]:
                    raise ConsumerConnectionDenied("Sign in again to reconnect this assistant")
                if binding["deployment_id"] != deployment:
                    raise ConsumerConnectionDenied("Private agent binding changed; review setup")
                tx.execute(
                    text("""
                    UPDATE developer_oauth_authorizations SET consumer_connection_id=:ref,
                        consumer_generation=:generation WHERE id=:id
                """),
                    {
                        "ref": binding["connection_id"],
                        "generation": binding["generation"],
                        "id": authorization["id"],
                    },
                )
                authorization.update(
                    consumer_connection_id=binding["connection_id"],
                    consumer_generation=binding["generation"],
                )
            self._match(binding, authorization, deployment)
            return self._review(binding, authorization, self._grant_state(tx, binding))

    def approve(
        self, *, owner: str, connection_id: str, generation: int, authorization_id: int
    ) -> str:
        """Only the secure authenticated owner interface calls this approval seam."""
        with self._transaction(owner) as tx:
            binding = self._binding(tx, connection_id, owner)
            authorization = self._owner_authorization(
                tx, owner=owner, authorization_id=authorization_id
            )
            if binding["generation"] != generation:
                raise ConsumerConnectionDenied("This approval changed; review the connection again")
            self._match(binding, dict(authorization), self._deployment(tx, owner))
            grant = self._grant_state(tx, binding)
            if grant and grant.token:
                return grant.receipt
            if grant and grant.receipt:
                # A legacy standing grant can be upgraded in place with a
                # short-lived runtime credential; no second approval is created.
                self._issue_grant_token(
                    tx,
                    binding=binding,
                    receipt=grant.receipt,
                    authorization_id=authorization_id,
                )
                return grant.receipt
            receipt = "cmr_" + secrets.token_hex(16)
            ConsentDBService.append_consumer_memory_decision(
                tx,
                user_id=owner,
                connection_id=connection_id,
                generation=generation,
                action="CONSENT_GRANTED",
                receipt_ref=receipt,
                authorization_id=authorization_id,
            )
            self._issue_grant_token(
                tx,
                binding=binding,
                receipt=receipt,
                authorization_id=authorization_id,
            )
            return receipt

    def disconnect(self, *, owner: str, connection_id: str, generation: int) -> None:
        """Disconnect this assistant, including every bound OAuth session."""
        with self._transaction(owner) as tx:
            binding = self._binding(tx, connection_id, owner)
            if binding["generation"] > generation:
                return  # A retry cannot revoke a subsequently approved generation.
            if binding["generation"] != generation:
                raise ConsumerConnectionDenied("This assistant connection changed")
            ConsentDBService.append_consumer_memory_decision(
                tx,
                user_id=owner,
                connection_id=connection_id,
                generation=generation,
                action="REVOKED",
                receipt_ref="cmr_" + secrets.token_hex(16),
            )

    def disconnect_current(self, principal: DeveloperPrincipal, *, generation: int) -> dict:
        """Revoke only the MCP connection represented by this OAuth session.

        The owner may revoke any assistant from the authenticated Hussh UI.  An
        external assistant gets a narrower self-service operation: its OAuth
        authorization must name the same consumer binding, and the caller must
        repeat the current generation.  This prevents one client from revoking
        another client belonging to the same owner and makes delayed retries
        harmless after a reconnect.
        """
        owner = principal.subject_firebase_uid or ""
        if type(generation) is not int or generation < 1:
            raise ConsumerConnectionDenied("Invalid connection generation")
        with self._transaction(owner) as tx:
            authorization = self._oauth(tx, principal)
            connection_id = str(authorization.get("consumer_connection_id") or "")
            if not connection_id:
                raise ConsumerConnectionDenied("Complete the assistant connection first")
            binding = self._binding(tx, connection_id, owner)
            self._match(binding, authorization, self._deployment(tx, owner))
            if binding["generation"] != generation:
                raise ConsumerConnectionDenied("This assistant connection changed; reconnect")
            ConsentDBService.append_consumer_memory_decision(
                tx,
                user_id=owner,
                connection_id=connection_id,
                generation=generation,
                action="REVOKED",
                receipt_ref="cmr_" + secrets.token_hex(16),
            )
            return {"connection_id": connection_id, "generation": generation}

    @contextmanager
    def memory_transaction(
        self, principal: DeveloperPrincipal, *, operation: str
    ) -> Iterator[tuple[Connection, ConsumerConnection]]:
        """Hold the grant fence through a canonical database operation/commit.

        Callers still enforce memory type/secrets exclusions, CAS, encryption,
        idempotency and sharing impact. This grants no delete/share/action rights.
        Network execution must carry this generation and recheck at commit and
        result release; this SQL transaction cannot undo a remote side effect.
        """
        if operation not in {"read", "query", "save", "correct", "export"}:
            raise ConsumerConnectionDenied("This operation requires separate approval")
        owner = principal.subject_firebase_uid or ""
        with self._transaction(owner) as tx:
            row = (
                tx.execute(
                    text("""
                SELECT consumer_connection_id FROM developer_oauth_authorizations
                WHERE id=:id AND subject_firebase_uid=:owner
            """),
                    {"id": principal.authorization_id, "owner": owner},
                )
                .mappings()
                .first()
            )
            if not row or not row["consumer_connection_id"]:
                raise ConsumerConnectionDenied("Complete the assistant connection first")
            binding = self._binding(tx, row["consumer_connection_id"], owner)
            authorization = self._oauth(tx, principal)
            self._match(binding, authorization, self._deployment(tx, owner))
            grant = self._grant_state(tx, binding)
            if grant is None or grant.receipt is None:
                raise ConsumerConnectionDenied("Personal memory approval required")
            if grant.token is None:
                self._issue_grant_token(
                    tx,
                    binding=binding,
                    receipt=grant.receipt,
                    authorization_id=authorization["id"],
                )
                grant = self._grant_state(tx, binding)
            if grant is None or grant.token is None:
                raise ConsumerConnectionDenied("Personal memory approval required")
            yield tx, self._review(binding, authorization, grant)

    def admit_memory(self, principal: DeveloperPrincipal, *, operation: str) -> ConsumerConnection:
        """Snapshot a grant before remote execution, without holding a DB lock."""
        with self.memory_transaction(principal, operation=operation) as (_tx, connection):
            return connection

    def verify_memory_admission(
        self,
        principal: DeveloperPrincipal,
        *,
        operation: str,
        admitted: ConsumerConnection,
    ) -> ConsumerConnection:
        """Recheck generation and grant after an owner-pod operation."""
        with self.memory_transaction(principal, operation=operation) as (_tx, current):
            if (
                current.connection_id != admitted.connection_id
                or current.generation != admitted.generation
                or current.grant_receipt != admitted.grant_receipt
                or current.grant_token != admitted.grant_token
            ):
                raise ConsumerConnectionDenied("Memory approval changed while the pod worked")
            return current
