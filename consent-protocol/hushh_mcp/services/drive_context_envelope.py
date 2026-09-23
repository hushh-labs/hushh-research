"""Read-only, invocation-scoped Drive eligibility snapshot for a private agent turn.

Only ``DriveContextEnvelope`` crosses the API boundary. ``DriveContextAssembly``
retains retrieval targets for one in-process invocation; preview discards it.
This snapshot is never a Google permission or a substitute for a live read fence.
"""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from types import MappingProxyType
from typing import Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import bindparam, text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_store import (
    MAX_OWNER_DOCUMENTS,
    PROCESSING_DISCLOSURE_VERSION,
    DriveDocumentCipher,
)
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingCipher,
    DriveSharingError,
    SharingApproval,
)
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
    ExternalConnectorCredentialsService,
)
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    POLICY_HASH,
    SELECTED_POLICY,
    DriveReadError,
)

MAX_ENVELOPE_DOCUMENTS = 25
MAX_ENVELOPE_BYTES = 16 * 1024
MAX_AUTHORITY_ROWS = 1024
CONSTRAINTS = ("read-only", "cite source_refs", "no exfiltration")


class DriveContextDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_ref: str = Field(min_length=32, max_length=64)
    label: Literal["Document"] = "Document"
    origin: Literal["own_selection", "shared_grant"]
    owner_display: str | None = Field(default=None, max_length=160)
    period_start: date | None = None
    period_end: date | None = None
    grant_revision: int | None = Field(default=None, ge=1)
    revocation_revision: int | None = Field(default=None, ge=0)
    connection_generation: int = Field(ge=1)

    @model_validator(mode="after")
    def revision_fields_match_origin(self):
        if self.origin == "own_selection" and (
            self.grant_revision is not None or self.revocation_revision is not None
        ):
            raise ValueError("own selection has no grant revision")
        if self.origin == "shared_grant" and (
            self.grant_revision is None or self.revocation_revision is None
        ):
            raise ValueError("shared grant requires revision evidence")
        return self


class DriveContextEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    envelope_version: Literal[1] = 1
    turn_id: str = Field(min_length=1, max_length=128)
    assembled_at: datetime
    documents: tuple[DriveContextDocument, ...] = ()
    constraints: tuple[Literal["read-only", "cite source_refs", "no exfiltration"], ...] = (
        CONSTRAINTS
    )


@dataclass(frozen=True)
class GrantDependency:
    operation_id: str
    request_id: str
    review_revision: int
    revocation_revision: int


@dataclass(frozen=True)
class DriveContextBinding:
    actor_user_id: str
    turn_id: str
    document_id: str
    document_user_id: str
    connection_generation: int
    active_version: str
    source_version: str
    processing_revision: int
    grants: tuple[GrantDependency, ...] = ()


@dataclass(frozen=True)
class DriveContextAssembly:
    public: DriveContextEnvelope
    _bindings: Mapping[str, DriveContextBinding] = field(repr=False)

    def resolve(self, source_ref: str, *, actor_user_id: str, turn_id: str) -> DriveContextBinding:
        """Resolve only within this assembly. A ref alone never authorizes retrieval."""
        if actor_user_id != self._actor or turn_id != self.public.turn_id:
            raise DriveReadError("source_unavailable")
        binding = self._bindings.get(source_ref)
        if binding is None or binding.actor_user_id != actor_user_id or binding.turn_id != turn_id:
            raise DriveReadError("source_unavailable")
        return binding

    @property
    def _actor(self) -> str:
        return next(iter(self._bindings.values())).actor_user_id if self._bindings else ""


@dataclass(frozen=True)
class _Candidate:
    row: dict
    file_id: str = field(repr=False)
    file_lock: str = field(repr=False)
    origin: Literal["own_selection", "shared_grant"] = "own_selection"
    grant: GrantDependency | None = None


class DriveContextEnvelopeBuilder:
    """Stateless builder; all bindings belong to a returned assembly, never a singleton."""

    def __init__(
        self,
        db=None,
        *,
        document_cipher: DriveDocumentCipher | None = None,
        sharing_cipher: DriveSharingCipher | None = None,
        credentials: ExternalConnectorCredentialsService | None = None,
    ):
        self.db = db or get_db()
        self.document_cipher = document_cipher or DriveDocumentCipher()
        self.sharing_cipher = sharing_cipher or DriveSharingCipher()
        self.credentials = credentials or ExternalConnectorCredentialsService(db=self.db)

    async def assemble(self, user_id: str, turn_id: str) -> DriveContextEnvelope:
        """Public diagnostic projection; the invocation-local binding map is discarded."""
        return (await self.assemble_for_invocation(user_id, turn_id)).public

    async def assemble_for_invocation(self, user_id: str, turn_id: str) -> DriveContextAssembly:
        """Future chat/voice callers retain this object only for their live turn."""
        if not isinstance(user_id, str) or not 1 <= len(user_id) <= 128:
            raise DriveReadError("invalid_argument")
        if not isinstance(turn_id, str) or not 1 <= len(turn_id) <= 128:
            raise DriveReadError("invalid_argument")
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveReadError("connector_unavailable")

        candidates = await asyncio.to_thread(self._snapshot, user_id)
        assembled_at = datetime.now(UTC)
        documents: list[DriveContextDocument] = []
        bindings: dict[str, DriveContextBinding] = {}
        for candidate in candidates:
            row = candidate.row
            source_ref = secrets.token_urlsafe(24)
            grant = candidate.grant
            documents.append(
                DriveContextDocument(
                    source_ref=source_ref,
                    origin=candidate.origin,
                    # Provider metadata has no trustworthy per-document coverage
                    # or authorized owner display. A request's period is not coverage.
                    owner_display=None,
                    period_start=None,
                    period_end=None,
                    grant_revision=grant.review_revision if grant else None,
                    revocation_revision=grant.revocation_revision if grant else None,
                    connection_generation=row["connection_generation"],
                )
            )
            bindings[source_ref] = DriveContextBinding(
                actor_user_id=user_id,
                turn_id=turn_id,
                document_id=str(row["document_id"]),
                document_user_id=user_id,
                connection_generation=row["connection_generation"],
                active_version=row["active_version"],
                source_version=row["source_version"],
                processing_revision=row["processing_revision"],
                grants=(grant,) if grant else (),
            )
        envelope = DriveContextEnvelope(
            turn_id=turn_id, assembled_at=assembled_at, documents=tuple(documents)
        )
        if (
            len(documents) > MAX_ENVELOPE_DOCUMENTS
            or len(envelope.model_dump_json().encode()) > MAX_ENVELOPE_BYTES
        ):
            raise DriveReadError("narrow_selection_required")
        return DriveContextAssembly(envelope, MappingProxyType(bindings))

    def _snapshot(self, user_id: str) -> list[_Candidate]:
        try:
            with self.db.engine.connect() as connection, connection.begin():
                connection.execute(
                    text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                )
                connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                return self._read_snapshot(connection, user_id)
        except SQLAlchemyError:
            raise DriveReadError("document_storage_unavailable", retryable=True) from None

    def _read_snapshot(self, connection, user_id: str) -> list[_Candidate]:
        account_row = (
            connection.execute(
                text("""SELECT * FROM user_external_connector_connections
                WHERE user_id=:user AND connector_id='google_drive'"""),
                {"user": user_id},
            )
            .mappings()
            .first()
        )
        if account_row is None:
            raise DriveReadError("connect_required")
        account = dict(account_row)
        if (
            account["status"] != "connected"
            or account["validation_state"] != "verified"
            or account["verified_policy_hash"] != POLICY_HASH
            or account["connection_generation"] < 1
        ):
            raise DriveReadError("connection_changed")
        policy = (
            connection.execute(
                text("SELECT * FROM external_mcp_connectors WHERE connector_id='google_drive'")
            )
            .mappings()
            .first()
        )
        if (
            policy is None
            or not policy["is_active"]
            or policy["transport_kind"] != "google_drive_rest"
            or policy["mcp_endpoint"] != DRIVE_BASE
            or policy["capability_policy"] != SELECTED_POLICY
        ):
            raise DriveReadError("connector_policy_changed")
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveReadError("connector_unavailable")

        rows = [
            dict(row)
            for row in connection.execute(
                text("""SELECT * FROM connected_documents
                    WHERE user_id=:user AND connector_id='google_drive'
                      AND connection_generation=:generation AND status='ready'
                      AND active_version IS NOT NULL AND processing_enabled
                      AND processing_disclosure_version=:disclosure
                    ORDER BY document_id LIMIT :limit"""),
                {
                    "user": user_id,
                    "generation": account["connection_generation"],
                    "disclosure": PROCESSING_DISCLOSURE_VERSION,
                    "limit": MAX_OWNER_DOCUMENTS + 1,
                },
            ).mappings()
        ]
        if len(rows) > MAX_OWNER_DOCUMENTS:
            raise DriveReadError("narrow_selection_required")
        if not rows:
            return []
        selected: list[_Candidate] = []
        for row in rows:
            metadata = self.document_cipher.open(row)
            file_id = metadata.get("file_id")
            if not isinstance(file_id, str):
                raise DriveReadError("document_storage_unavailable")
            try:
                file_lock = self.sharing_cipher.file_lock(file_id)
            except DriveSharingError:
                raise DriveReadError("document_storage_unavailable") from None
            selected.append(_Candidate(row, file_id, file_lock))

        query = text("""SELECT o.operation_id,o.user_id,o.request_id,o.review_revision,
                  o.document_id,o.connection_generation,o.file_lock_hmac,o.kind,
                  o.parent_operation_id,o.state,
                  CASE WHEN o.kind='grant' AND o.state IN ('succeeded','preexisting')
                    THEN o.plan_envelope END AS plan_envelope,
                  (o.receipt_envelope IS NOT NULL) AS has_receipt,
                  r.recipient_user_id, r.revision AS request_revision,
                  r.recipient_binding, m.revocation_revision,
                  m.private_request_erased_at, v.decision AS review_decision
            FROM drive_share_permission_operations o
            LEFT JOIN drive_share_management_contexts m
              ON m.request_id=o.request_id AND m.user_id=o.user_id
            LEFT JOIN drive_share_requests r
              ON r.request_id=o.request_id AND r.user_id=o.user_id
            LEFT JOIN drive_share_reviews v
              ON v.request_id=o.request_id AND v.revision=o.review_revision
            WHERE o.file_lock_hmac IN :locks
            ORDER BY o.created_at,o.operation_id LIMIT :limit""").bindparams(
            bindparam("locks", expanding=True)
        )
        operations = [
            dict(row)
            for row in connection.execute(
                query,
                {
                    "locks": list({item.file_lock for item in selected}),
                    "limit": MAX_AUTHORITY_ROWS + 1,
                },
            ).mappings()
        ]
        if len(operations) > MAX_AUTHORITY_ROWS:
            raise DriveReadError("incomplete_authority")
        by_lock: dict[str, list[dict]] = {}
        for operation in operations:
            by_lock.setdefault(operation["file_lock_hmac"], []).append(operation)
        result: list[_Candidate] = []
        credential: dict | None = None
        for item in selected:
            relevant = [
                op
                for op in by_lock.get(item.file_lock, [])
                if op["kind"] == "grant"
                and op["user_id"] != user_id
                and op["recipient_user_id"] == user_id
            ]
            erased = [
                op
                for op in by_lock.get(item.file_lock, [])
                if op["kind"] == "grant"
                and op["user_id"] != user_id
                and op["recipient_user_id"] is None
            ]
            if erased:
                # The management context deliberately retains no recipient.
                # It can fence a candidate, never authorize it.
                raise DriveReadError("incomplete_authority")
            if not relevant:
                result.append(item)
                continue
            if credential is None:
                try:
                    credential = self.credentials.open_credential(
                        user_id=user_id, connector_id="google_drive", row=account
                    )
                except ExternalConnectorCredentialError:
                    raise DriveReadError("connection_changed") from None
                if not credential.get("subject") or credential.get("accountLabel") != account.get(
                    "connected_account_label"
                ):
                    raise DriveReadError("connection_changed")
            valid: list[GrantDependency] = []
            for grant in relevant:
                descendants = [
                    op
                    for op in by_lock[item.file_lock]
                    if op["kind"] == "revoke" and op["parent_operation_id"] == grant["operation_id"]
                ]
                if any(op["state"] in {"succeeded", "absent"} for op in descendants):
                    continue
                if descendants and any(
                    op["state"] not in {"succeeded", "absent"} for op in descendants
                ):
                    raise DriveReadError("incomplete_authority")
                if grant["state"] in {"queued", "not_dispatched", "rejected", "absent"}:
                    continue
                if grant["state"] not in {"succeeded", "preexisting"}:
                    raise DriveReadError("incomplete_authority")
                valid.append(self._validate_grant(grant, item, user_id, credential))
            if len(valid) > 1:
                raise DriveReadError("incomplete_authority")
            if valid:
                result.append(
                    _Candidate(item.row, item.file_id, item.file_lock, "shared_grant", valid[0])
                )
            # A known grant-backed target cannot fall through to own_selection.
        return result

    def _validate_grant(
        self, grant: dict, selected: _Candidate, user_id: str, credential: dict
    ) -> GrantDependency:
        try:
            if (
                grant["private_request_erased_at"] is not None
                or grant["review_decision"] != "approved"
                or grant["request_revision"] != grant["review_revision"]
                or grant["revocation_revision"] is None
                or (not grant["has_receipt"] and grant["state"] == "succeeded")
            ):
                raise ValueError("incomplete grant lineage")
            plan = self.sharing_cipher.open(
                grant["plan_envelope"],
                user_id=grant["user_id"],
                resource_id=str(grant["operation_id"]),
                purpose="permission-plan",
            )
            approval = SharingApproval.model_validate(plan["approval"])
            recipient = plan["recipient"]
            approved_source = next(
                (
                    source
                    for source in approval.sources
                    if str(source.document_id) == str(grant["document_id"])
                ),
                None,
            )
            if (
                str(approval.request_id) != str(grant["request_id"])
                or approval.revision != grant["review_revision"]
                or approval.owner_user_id != grant["user_id"]
                or approval.recipient_user_id != user_id
                or approval.recipient_binding != grant["recipient_binding"]
                or approval.connection_generation != grant["connection_generation"]
                or approved_source is None
                or plan["file_id"] != selected.file_id
                or plan["source_version"] != approved_source.source_version
                or approved_source.source_fingerprint
                != self.document_cipher.fingerprint(grant["user_id"], plan["file_id"])
                or recipient["user_id"] != user_id
                or recipient["subject"] != credential["subject"]
                or recipient["email"] != credential["accountLabel"]
                or self.sharing_cipher.digest(
                    "recipient",
                    [recipient["user_id"], recipient["subject"], recipient["email"]],
                )
                != approval.recipient_binding
            ):
                raise ValueError("grant binding changed")
            return GrantDependency(
                operation_id=str(grant["operation_id"]),
                request_id=str(grant["request_id"]),
                review_revision=grant["review_revision"],
                revocation_revision=grant["revocation_revision"],
            )
        except (KeyError, TypeError, ValueError, ValidationError, DriveSharingError):
            raise DriveReadError("incomplete_authority") from None
