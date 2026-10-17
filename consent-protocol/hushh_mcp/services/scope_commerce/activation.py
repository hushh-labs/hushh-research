"""Activation capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import timedelta
from typing import Any, Awaitable, Callable
from uuid import UUID, uuid4

from .cost_review import require_negative_net_acknowledgement
from .domain import (
    MICRO_PER_CENT,
    CommerceError,
    account,
    integer,
    public,
)

AuthorityCheck = Callable[[Any, dict[str, Any]], Awaitable[Any]]


class ActivationLease:
    async def preparation_context(
        self,
        *,
        owner_user_id,
        purchase_id,
        source_revisions=None,
        negative_net_acknowledgement=None,
        conn=None,
    ):
        self._admit()

        async def operation(c):
            await self._environment(c)
            p = await self._row(
                c,
                "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1 AND owner_user_id=$2 FOR UPDATE",
                UUID(str(purchase_id)),
                owner_user_id,
            )
            now = await c.fetchval("SELECT clock_timestamp()")
            if (
                not p
                or p["status"] not in {"reserved", "preparing"}
                or now >= p["fulfillment_deadline"]
            ):
                raise CommerceError("reserved_purchase_required")
            await require_negative_net_acknowledgement(c, p, negative_net_acknowledgement)
            if p["status"] == "reserved" or (
                p["status"] == "preparing" and p["activation_at"] <= now
            ):
                # Owner gets five minutes to encrypt with a fixed authenticated
                # expiry. Re-preparation is explicit, never a shifted old AAD.
                activation = (now + timedelta(minutes=5)).replace(
                    microsecond=(now.microsecond // 1000) * 1000
                )
                if activation >= p["fulfillment_deadline"]:
                    raise CommerceError("fulfillment_expired")
                p = await self._row(
                    c,
                    "UPDATE scope_commerce_purchases SET status='preparing',preparation_id=$2,activation_at=$3,expires_at=$4,source_revisions=$5::jsonb,export_id=$6,export_revision=1 WHERE purchase_id=$1 RETURNING *",
                    p["purchase_id"],
                    uuid4(),
                    activation,
                    activation + timedelta(seconds=p["duration_seconds"]),
                    json.dumps(source_revisions or {}),
                    uuid4().hex,
                )
            elif (
                source_revisions is not None
                and json.loads(p["source_revisions"] or "{}") != source_revisions
            ):
                raise CommerceError("source_revision_changed")
            q = await self._row(
                c, "SELECT * FROM scope_commerce_quotes WHERE quote_id=$1", p["quote_id"]
            )
            key = await self._registered_key(c, p)
            result = public(p)
            result.update(
                {
                    "startsAtMs": int(p["activation_at"].timestamp() * 1000),
                    "expiresAtMs": int(p["expires_at"].timestamp() * 1000),
                    "grantId": p["request_id"],
                    "purpose": q["purpose"],
                    "refreshPolicy": q["refresh_policy"],
                    "scopeManifestRevision": q["scope_manifest_revision"],
                    "sourceRevisions": json.loads(p["source_revisions"] or "{}"),
                }
            )
            result.update(
                {
                    "connectorKeyId": key["connector_key_id"],
                    "connectorPublicKey": key["connector_public_key"],
                    "connectorWrappingAlg": key["connector_wrapping_alg"],
                }
            )
            return result

        return await self._transaction(operation, conn)

    async def prepare_export(
        self,
        *,
        owner_user_id,
        request_id,
        source_revisions=None,
        negative_net_acknowledgement=None,
        conn=None,
    ):
        p = await self.lookup_by_request(request_id, conn)
        if not p:
            raise CommerceError("purchase_unavailable")
        return await self.preparation_context(
            owner_user_id=owner_user_id,
            purchase_id=p["purchaseId"],
            source_revisions=source_revisions,
            negative_net_acknowledgement=negative_net_acknowledgement,
            conn=conn,
        )

    async def bind_consent_token(self, *, purchase_id, token, conn):
        if not token:
            raise CommerceError("canonical_grant_required")
        digest = hashlib.sha256(token.encode()).hexdigest()
        old = await conn.fetchval(
            "SELECT consent_token_hash FROM scope_commerce_purchases WHERE purchase_id=$1 FOR UPDATE",
            UUID(str(purchase_id)),
        )
        if old and old != digest:
            raise CommerceError("grant_binding_conflict")
        await conn.execute(
            "UPDATE scope_commerce_purchases SET consent_token_hash=$2 WHERE purchase_id=$1",
            UUID(str(purchase_id)),
            digest,
        )

    async def stage_export(
        self,
        *,
        owner_user_id,
        request_id,
        preparation_id,
        envelope,
        authority_check,
        negative_net_acknowledgement=None,
        conn=None,
    ):
        p = await self.lookup_by_request(request_id, conn)
        if not p:
            raise CommerceError("purchase_unavailable")
        metadata = (
            envelope.get("exportEnvelope")
            or envelope.get("export_envelope")
            or envelope.get("export_envelope_v2")
        )
        if not isinstance(metadata, dict) or not isinstance(metadata.get("aad"), dict):
            raise CommerceError("v2_export_required")
        aad = metadata["aad"]
        return await self.stage_activation(
            owner_user_id=owner_user_id,
            purchase_id=p["purchaseId"],
            preparation_id=preparation_id,
            export_id=metadata["export_id"],
            export_revision=aad["revision"],
            aad_sha256=metadata["aad_sha256"],
            ciphertext_sha256=metadata["ciphertext_sha256"],
            expires_at_ms=aad["expires_at_ms"],
            recipient_key_fingerprint=aad["recipient_key_fingerprint"],
            staged_export=envelope,
            authority_check=authority_check,
            negative_net_acknowledgement=negative_net_acknowledgement,
            conn=conn,
        )


class EncryptedActivation:
    async def stage_activation(
        self,
        *,
        owner_user_id,
        purchase_id,
        preparation_id,
        export_id,
        export_revision,
        aad_sha256,
        ciphertext_sha256,
        expires_at_ms,
        recipient_key_fingerprint,
        staged_export,
        authority_check: AuthorityCheck,
        negative_net_acknowledgement=None,
        conn=None,
    ):
        self._admit()
        if not callable(authority_check):
            raise CommerceError("canonical_authority_required")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", aad_sha256) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", ciphertext_sha256
        ):
            raise CommerceError("invalid_export_digest")
        integer(export_revision, 1, 10_000_000, "invalid_export_revision")
        if not staged_export or len(json.dumps(staged_export)) > 2_000_000:
            raise CommerceError("invalid_encrypted_stage")
        if set(staged_export) - {
            "ciphertext",
            "iv",
            "tag",
            "wrappedKey",
            "exportEnvelope",
            "sourceRevisions",
        } or not all(
            staged_export.get(k)
            for k in ("ciphertext", "iv", "tag", "wrappedKey", "exportEnvelope")
        ):
            raise CommerceError("encrypted_stage_fields_required")
        from hushh_mcp.consent.export_envelope import ConsentExportEnvelopeSubmissionV2

        try:
            submitted = ConsentExportEnvelopeSubmissionV2.model_validate(
                staged_export["exportEnvelope"]
            )
        except ValueError as exc:
            raise CommerceError("invalid_export_envelope") from exc
        if (
            submitted.export_id != export_id
            or submitted.aad.revision != export_revision
            or submitted.aad_sha256 != aad_sha256
            or submitted.ciphertext_sha256 != ciphertext_sha256
        ):
            raise CommerceError("export_metadata_mismatch")

        async def operation(c):
            return await self._tx_stage_activation(
                c,
                owner_user_id,
                purchase_id,
                preparation_id,
                export_id,
                export_revision,
                aad_sha256,
                ciphertext_sha256,
                expires_at_ms,
                recipient_key_fingerprint,
                staged_export,
                authority_check,
                submitted,
                negative_net_acknowledgement,
            )

        return await self._transaction(operation, conn)

    async def _tx_stage_activation(
        self,
        c: Any,
        owner_user_id: Any,
        purchase_id: Any,
        preparation_id: Any,
        export_id: Any,
        export_revision: Any,
        aad_sha256: Any,
        ciphertext_sha256: Any,
        expires_at_ms: Any,
        recipient_key_fingerprint: Any,
        staged_export: Any,
        authority_check: Any,
        submitted: Any,
        negative_net_acknowledgement: Any,
    ) -> Any:
        await self._environment(c)
        p = await self._row(
            c,
            "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1 AND owner_user_id=$2 FOR UPDATE",
            UUID(str(purchase_id)),
            owner_user_id,
        )
        if not p:
            raise CommerceError("purchase_unavailable")
        await require_negative_net_acknowledgement(c, p, negative_net_acknowledgement)
        if p["status"] == "staged":
            if (
                p["export_id"] != export_id
                or p["export_revision"] != export_revision
                or p["aad_sha256"] != aad_sha256
                or p["ciphertext_sha256"] != ciphertext_sha256
            ):
                raise CommerceError("staging_conflict")
            return public(p)
        await self._validate_staged_authority(
            c,
            p,
            preparation_id,
            export_id,
            export_revision,
            expires_at_ms,
            recipient_key_fingerprint,
            submitted,
            staged_export,
        )
        frozen = await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE a.purchase_id=$1 AND f.frozen)",
            p["purchase_id"],
        )
        if frozen:
            raise CommerceError("funding_disputed")
        if p["price_cents"]:
            await self._paid_admission(c)
        await self._registered_key(c, p)
        await self._finalize_canonical_grant(c, p, staged_export, authority_check)
        await self._consume_activation_reservation(c, p)
        p = await self._row(
            c,
            "UPDATE scope_commerce_purchases SET status='staged',export_id=$2,export_revision=$3,aad_sha256=$4,ciphertext_sha256=$5,staged_export=$6::jsonb WHERE purchase_id=$1 RETURNING *",
            p["purchase_id"],
            export_id,
            export_revision,
            aad_sha256,
            ciphertext_sha256,
            json.dumps(staged_export),
        )
        return public(p)

    async def _consume_activation_reservation(self, c: Any, p: dict[str, Any]):
        reservation = await self._row(
            c,
            "SELECT * FROM scope_commerce_reservations WHERE purchase_id=$1 FOR UPDATE",
            p["purchase_id"],
        )
        if not reservation or reservation["status"] != "held":
            raise CommerceError("reservation_unavailable")
        gross = p["price_cents"] * MICRO_PER_CENT
        fee = p["fee_micro_usd"]
        postings = {
            account("wallet_reserved", p["wallet_id"]): -gross,
            account("seller_pending", p["seller_id"]): max(0, gross - fee),
            account("processor_fees"): fee,
        }
        if fee > gross:
            postings[account("seller_debt", p["seller_id"])] = gross - fee
        await self._post(
            c, f"activate:{p['purchase_id']}", "staged_activation", postings, p["purchase_id"]
        )
        await c.execute(
            "UPDATE scope_commerce_reservations SET status='consumed' WHERE purchase_id=$1",
            p["purchase_id"],
        )

    async def _validate_staged_authority(
        self,
        c: Any,
        p: dict[str, Any],
        preparation_id: str,
        export_id: str,
        export_revision: int,
        expires_at_ms: int,
        recipient_key_fingerprint: str,
        submitted: Any,
        staged_export: dict[str, Any],
    ):
        now = await c.fetchval("SELECT clock_timestamp()")
        if (
            p["status"] != "preparing"
            or str(p["preparation_id"]) != str(preparation_id)
            or now >= p["activation_at"]
            or now >= p["fulfillment_deadline"]
        ):
            raise CommerceError("preparation_expired")
        if (
            int(p["expires_at"].timestamp() * 1000) != expires_at_ms
            or recipient_key_fingerprint != p["recipient_key_fingerprint"]
        ):
            raise CommerceError("export_authority_mismatch")
        if export_id != p["export_id"] or export_revision != p["export_revision"]:
            raise CommerceError("export_preparation_binding_mismatch")
        aad = submitted.aad
        if (
            aad.app_id != p["buyer_app_id"]
            or aad.grant_id != p["request_id"]
            or aad.machine_scope != p["machine_scope"]
            or aad.scope_handle != p["scope_handle"]
            or aad.recipient_key_fingerprint != p["recipient_key_fingerprint"]
            or aad.expires_at_ms != expires_at_ms
        ):
            raise CommerceError("export_authority_mismatch")
        expected_sources = json.loads(p["source_revisions"] or "{}")
        if staged_export.get("sourceRevisions", {}) != expected_sources:
            raise CommerceError("source_revision_changed")

    async def _finalize_canonical_grant(
        self,
        c: Any,
        p: dict[str, Any],
        staged_export: dict[str, Any],
        authority_check: AuthorityCheck,
    ):
        # Callback validates exact encrypted v2 AAD/key/source and writes
        # canonical grant+export+audit. An exception rolls the money back.
        finalized = await authority_check(
            c,
            {
                **p,
                "staged_export": staged_export,
                "source_revisions": json.loads(p["source_revisions"] or "{}"),
            },
        )
        if isinstance(finalized, dict) and finalized.get("consent_token"):
            await self.bind_consent_token(
                purchase_id=p["purchase_id"], token=finalized["consent_token"], conn=c
            )
        if not finalized or not await c.fetchval(
            "SELECT consent_token_hash FROM scope_commerce_purchases WHERE purchase_id=$1",
            p["purchase_id"],
        ):
            raise CommerceError("canonical_grant_required")
