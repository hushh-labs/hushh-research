"""Document delivery keys: operations over the owning store transaction port."""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    key_fingerprint,
)

from .state import iso


def _public_key(self, connection, contract, *, require_active=False):
    key = self._row(
        connection,
        """SELECT * FROM document_delivery_public_keys
      WHERE user_id=:user AND key_id=:key""",
        {"user": contract["recipient_user_id"], "key": contract["recipient_key_id"]},
    )
    if key is None or key["fingerprint"] != contract["recipient_key_fingerprint"]:
        raise DeliveryError("recipient_key_unavailable")
    if require_active:
        registry = self._row(
            connection,
            """SELECT connector_public_key FROM one_kyc_client_connectors
          WHERE user_id=:user AND connector_key_id=:key AND status='active' FOR SHARE""",
            {"user": contract["recipient_user_id"], "key": contract["recipient_key_id"]},
        )
        if (
            registry is None
            or key_fingerprint(registry["connector_public_key"]) != key["fingerprint"]
        ):
            raise DeliveryError("recipient_key_changed")
    return {
        "connectorKeyId": key["key_id"],
        "connectorPublicKey": key["public_key"],
        "connectorWrappingAlg": "X25519-AES256-GCM",
        "publicKeyFingerprint": key["fingerprint"],
    }


async def recipient_key(self, *, request_id, actor, purpose="delivery"):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        if purpose == "recovery":
            from hushh_mcp.services.document_delivery.recovery import proven_recovery_key

            self._paid(connection, request, contract)
            key = proven_recovery_key(self, connection, contract)
            if key is None:
                raise DeliveryError("recovery_key_proof_required")
            return key
        return self._public_key(connection, contract, require_active=False)

    return await self._transaction(operation)


async def issue_challenge(
    self, *, request_id, actor, key_id, fingerprint, nonce_hash, purpose="delivery"
):
    def operation(connection):
        request, contract = self._locked(connection, request_id=request_id, actor=actor)
        self._current(request, contract)
        if actor != contract["recipient_user_id"]:
            raise DeliveryError("recipient_key_mismatch", 403)
        if purpose == "recovery":
            self._paid(connection, request, contract)
            registry = self._row(
                connection,
                """SELECT * FROM one_kyc_client_connectors
              WHERE user_id=:user AND connector_key_id=:key AND status='active' FOR SHARE""",
                {"user": actor, "key": key_id},
            )
            if registry is None or key_fingerprint(registry["connector_public_key"]) != fingerprint:
                raise DeliveryError("recipient_key_changed")
            pinned = self._row(
                connection,
                """INSERT INTO document_delivery_public_keys(user_id,key_id,public_key,fingerprint)
              VALUES(:user,:key,:public,:fp) ON CONFLICT(user_id,key_id) DO UPDATE SET key_id=EXCLUDED.key_id
              WHERE document_delivery_public_keys.public_key=EXCLUDED.public_key AND document_delivery_public_keys.fingerprint=EXCLUDED.fingerprint
              RETURNING key_id""",
                {
                    "user": actor,
                    "key": key_id,
                    "public": registry["connector_public_key"],
                    "fp": fingerprint,
                },
            )
            if pinned is None:
                raise DeliveryError("recipient_key_id_reused")
            key = {
                "connectorKeyId": key_id,
                "connectorPublicKey": registry["connector_public_key"],
                "connectorWrappingAlg": "X25519-AES256-GCM",
                "publicKeyFingerprint": fingerprint,
            }
        else:
            if (
                key_id != contract["recipient_key_id"]
                or fingerprint != contract["recipient_key_fingerprint"]
            ):
                raise DeliveryError("recipient_key_mismatch", 403)
            key = self._public_key(connection, contract, require_active=False)
        count = connection.execute(
            text("""SELECT COUNT(*)
          FROM document_delivery_key_challenges WHERE request_id=:request AND expires_at>clock_timestamp()"""),
            {"request": request_id},
        ).scalar()
        if count >= 5:
            raise DeliveryError("challenge_rate_limited", 429)
        challenge_id, expires = str(uuid4()), datetime.now(UTC) + timedelta(minutes=5)
        connection.execute(
            text("""INSERT INTO document_delivery_key_challenges
          (challenge_id,request_id,user_id,key_id,fingerprint,nonce_hash,expires_at,purpose)
          VALUES(:id,:request,:user,:key,:fp,:hash,:expires,:purpose)"""),
            {
                "id": challenge_id,
                "request": request_id,
                "user": actor,
                "key": key_id,
                "fp": fingerprint,
                "hash": nonce_hash,
                "expires": expires,
                "purpose": purpose,
            },
        )
        return {"challengeId": challenge_id, "expiresAt": iso(expires), "key": key}

    return await self._transaction(operation)


async def verify_challenge(self, *, request_id, actor, challenge_id, plaintext):
    def operation(connection):
        request, contract = self._locked(connection, request_id=request_id, actor=actor)
        self._current(request, contract)
        if actor != contract["recipient_user_id"]:
            raise DeliveryError("recipient_required", 403)
        row = self._row(
            connection,
            """SELECT * FROM document_delivery_key_challenges
          WHERE challenge_id=:challenge AND request_id=:request AND user_id=:user FOR UPDATE""",
            {"challenge": challenge_id, "request": request_id, "user": actor},
        )
        if row is None or row["consumed_at"] is not None:
            return None
        success = (
            row["expires_at"] > datetime.now(UTC)
            and (
                row["purpose"] == "recovery"
                or row["key_id"] == contract["recipient_key_id"]
                and row["fingerprint"] == contract["recipient_key_fingerprint"]
            )
            and hmac.compare_digest(
                row["nonce_hash"], hashlib.sha256(plaintext.encode()).hexdigest()
            )
        )
        if row["purpose"] == "recovery":
            self._paid(connection, request, contract)
            registry = self._row(
                connection,
                """SELECT connector_public_key FROM one_kyc_client_connectors
              WHERE user_id=:user AND connector_key_id=:key AND status='active' FOR SHARE""",
                {"user": actor, "key": row["key_id"]},
            )
            success = bool(
                success
                and registry
                and key_fingerprint(registry["connector_public_key"]) == row["fingerprint"]
            )
        connection.execute(
            text("""UPDATE document_delivery_key_challenges SET consumed_at=clock_timestamp(),
          verified_at=CASE WHEN :success THEN clock_timestamp() ELSE NULL END WHERE challenge_id=:challenge"""),
            {"success": success, "challenge": challenge_id},
        )
        return (
            {
                "phase": "verified",
                "recipientKeyId": row["key_id"],
                "recipientKeyFingerprint": row["fingerprint"],
                "verifiedAt": iso(datetime.now(UTC)),
            }
            if success
            else None
        )

    result = await self._transaction(operation)
    if result is None:
        raise DeliveryError("key_challenge_failed", 403)
    return result
