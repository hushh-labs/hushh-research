"""Contact-bound invitation. Acceptance grants neither findings nor sharing."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import uuid

from db.connection import get_pool
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users_async
from hushh_mcp.services.one_owner_admission import owner_setup_resolved
from hushh_mcp.services.world_model_service import owner_identity


def contact_commitment(contact: str) -> str:
    value = contact.strip().lower()
    if not (
        re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) or re.fullmatch(r"\+[1-9]\d{7,14}", value)
    ):
        raise ValueError("Enter an email or phone with country code")
    key = get_core_security_settings().app_signing_key.encode()
    return hmac.new(key, b"pwm-claim-contact-v1\x00" + value.encode(), hashlib.sha256).hexdigest()


async def verified_owner(user_id, consent_token, *, conn=None):
    identity = await owner_identity(
        user_id, consent_token, **({"conn": conn} if conn is not None else {})
    )
    if identity is None or not await owner_setup_resolved(user_id, conn=conn):
        raise PermissionError("Complete setup and verify your contact first")
    if (
        await validate_first_party_owner_token(
            user_id, consent_token, **({"conn": conn} if conn is not None else {})
        )
        is None
    ):
        raise PermissionError("Owner session ended")
    return identity


async def create(user_id, consent_token, contact):
    await verified_owner(user_id, consent_token)
    commitment = contact_commitment(contact)
    token = secrets.token_urlsafe(32)
    pool = await get_pool()
    # Transaction-scoped owner lock makes the outstanding-invitation cap shared.
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await lock_connection_graph_users_async(conn, user_ids=[user_id])
        await verified_owner(user_id, consent_token, conn=conn)
        await conn.execute("DELETE FROM pwm_claim_invitations WHERE expires_at < NOW()")
        count = await conn.fetchval(
            "SELECT count(*) FROM pwm_claim_invitations WHERE inviter_user_id=$1 AND state='pending'",
            user_id,
        )
        if count >= 20:
            raise ValueError("Revoke an invitation before creating another")
        row = await conn.fetchrow(
            """INSERT INTO pwm_claim_invitations
            (id, inviter_user_id, token_hash, contact_commitment) VALUES ($1,$2,$3,$4)
            RETURNING id, expires_at""",
            uuid.uuid4(),
            user_id,
            hashlib.sha256(token.encode()).hexdigest(),
            commitment,
        )
    return {"id": str(row["id"]), "token": token, "expires_at": row["expires_at"].isoformat()}


async def claim(user_id, consent_token, token):
    await verified_owner(user_id, consent_token)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        inviter = await conn.fetchval(
            "SELECT inviter_user_id FROM pwm_claim_invitations WHERE token_hash=$1", token_hash
        )
        if not inviter:
            raise ValueError("Invitation unavailable")
        await lock_connection_graph_users_async(conn, user_ids=[user_id, inviter])
        identity = await verified_owner(user_id, consent_token, conn=conn)
        commitments = [
            contact_commitment(value)
            for key, value in identity.items()
            if key in {"email", "phone_number"} and value
        ]
        row = await conn.fetchrow(
            """UPDATE pwm_claim_invitations SET state='claimed',
            recipient_user_id=$1, claimed_at=clock_timestamp(), consent_version='pwm-claim-v1'
            WHERE token_hash=$2 AND contact_commitment=ANY($3::text[]) AND state='pending'
            AND expires_at>clock_timestamp() AND inviter_user_id<>$1 RETURNING id""",
            user_id,
            token_hash,
            commitments,
            timeout=5,
        )
        if not row:
            raise ValueError("Invitation unavailable or verified contact does not match")
    return {"claimed": True, "sharing_granted": False, "research_started": False}


async def list_invitations(user_id, consent_token):
    await verified_owner(user_id, consent_token)
    pool = await get_pool()
    rows = await pool.fetch(
        """SELECT id,state,created_at,expires_at FROM pwm_claim_invitations
        WHERE inviter_user_id=$1 AND expires_at>NOW() ORDER BY created_at DESC LIMIT 20""",
        user_id,
        timeout=5,
    )
    return {
        "invitations": [
            {
                "id": str(row["id"]),
                "state": row["state"],
                "created_at": row["created_at"].isoformat(),
                "expires_at": row["expires_at"].isoformat(),
            }
            for row in rows
        ]
    }


async def revoke(user_id, consent_token, invitation_id):
    await verified_owner(user_id, consent_token)
    pool = await get_pool()
    # DELETE prevents retaining a target commitment after revocation.
    await pool.execute(
        "DELETE FROM pwm_claim_invitations WHERE id=$1 AND inviter_user_id=$2",
        invitation_id,
        user_id,
        timeout=5,
    )
    return {"revoked": True}
