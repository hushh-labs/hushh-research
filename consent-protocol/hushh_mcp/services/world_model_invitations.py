"""Contact-bound invitation. Acceptance grants neither findings nor sharing."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
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


async def create(
    user_id,
    consent_token,
    contact,
    *,
    preview_draft_id=None,
    selected_fact_ids=None,
    introduction="",
    secondary_contact=None,
    subject_name=None,
):
    from hushh_mcp.services import world_model_source_review as reviews

    preview = None
    if preview_draft_id:
        draft = await reviews.read(user_id, consent_token, preview_draft_id)
        if draft["purpose"] != "invitation":
            raise ValueError("Prepare a professional preview first")
        report = json.loads(json.dumps(draft["result"]["report"]))
        selected = set(selected_fact_ids or [])
        valid = {f"{s['kind']}:{i}" for s in report["sections"] for i, _ in enumerate(s["facts"])}
        if not selected or not selected <= valid:
            raise ValueError("Select supported preview facts")
        for section in report["sections"]:
            section["facts"] = [
                fact
                for index, fact in enumerate(section["facts"])
                if f"{section['kind']}:{index}" in selected
            ]
        report["sections"] = [section for section in report["sections"] if section["facts"]]
        # Summary is omitted from the transferable shape: unchecked facts cannot leak through it.
        report["summary"] = (
            "Public professional details selected by the inviter. Review what belongs to you."
        )
        preview = {"report": report, "introduction": introduction[:500], "prepared_by": "inviter"}

    if subject_name is not None:
        subject_name = subject_name.strip()
        if not subject_name or len(subject_name) > 160 or any(ord(c) < 32 for c in subject_name):
            raise ValueError("Enter the recipient's name")
        if preview is None:
            preview = {"has_preview": False, "subject_name": subject_name}

    await verified_owner(user_id, consent_token)
    commitment = contact_commitment(contact)
    secondary_commitment = contact_commitment(secondary_contact) if secondary_contact else None
    if secondary_commitment == commitment:
        secondary_commitment = None
    token = secrets.token_urlsafe(32)
    invitation_id = uuid.uuid4()
    envelope = seal_preview(token, invitation_id, preview) if preview is not None else None
    pool = await get_pool()
    # Transaction-scoped owner lock makes the outstanding-invitation cap shared.
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await lock_connection_graph_users_async(conn, user_ids=[user_id])
        await verified_owner(user_id, consent_token, conn=conn)
        if preview_draft_id:
            current_draft = await reviews.STORE.get(user_id, conn=conn)
            if (
                not current_draft
                or current_draft.get("fence") != draft.get("fence")
                or current_draft.get("revision") != draft.get("revision")
            ):
                raise ValueError("Preview changed before invitation creation")
        await conn.execute("DELETE FROM pwm_claim_invitations WHERE expires_at < NOW()")
        count = await conn.fetchval(
            "SELECT count(*) FROM pwm_claim_invitations WHERE inviter_user_id=$1 AND state='pending'",
            user_id,
        )
        if count >= 20:
            raise ValueError("Revoke an invitation before creating another")
        row = await conn.fetchrow(
            """INSERT INTO pwm_claim_invitations
            (id, inviter_user_id, token_hash, contact_commitment,secondary_contact_commitment,preview_envelope,preview_version) VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING id, expires_at""",
            invitation_id,
            user_id,
            hashlib.sha256(token.encode()).hexdigest(),
            commitment,
            secondary_commitment,
            envelope,
            1 if envelope else None,
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
            """SELECT * FROM pwm_claim_invitations WHERE token_hash=$1
            AND (contact_commitment=ANY($2::text[]) OR secondary_contact_commitment=ANY($2::text[]))
            AND expires_at>clock_timestamp()
            AND inviter_user_id<>$3 FOR UPDATE""",
            token_hash,
            commitments,
            user_id,
            timeout=5,
        )
        if not row or row["state"] not in {"pending", "claimed"}:
            raise ValueError("Invitation unavailable or verified contact does not match")
        if row["state"] == "claimed":
            if row["recipient_user_id"] != user_id:
                raise ValueError("Invitation unavailable")
            return {
                "claimed": True,
                "sharing_granted": False,
                "research_started": False,
                "draft_id": str(row["recipient_draft_id"])
                if row.get("recipient_draft_id")
                else None,
            }
        draft_id = None
        if row.get("preview_envelope"):
            preview = open_preview(token, row["id"], row["preview_envelope"])
            if "report" in preview:
                from hushh_mcp.services import world_model_source_review as reviews

                draft_id = uuid.uuid4()
                prior = await reviews.STORE.get(user_id, conn=conn)
                # Do not overwrite a recipient's unreviewed source draft.
                if prior and (
                    (
                        prior.get("status") == "pending"
                        and time.time() - max(prior.get("starts") or [0]) < 180
                    )
                    or (
                        prior.get("status") == "offered"
                        and time.time() - prior.get("finished_at", 0) < 86400
                    )
                ):
                    raise ValueError("Review or discard your existing source draft first")
                result = {
                    "status": "offered",
                    "pkm_written": False,
                    "draft_id": str(draft_id),
                    "report": preview["report"],
                    "search_suggestions": [],
                }
                state = {
                    "job_id": str(draft_id),
                    "status": "offered",
                    "result": result,
                    "purpose": "owner",
                    "allowed_use": "reviewable_fact",
                    "source_origin": "claimed_professional_preview",
                    "finished_at": time.time(),
                    "starts": (prior or {}).get("starts", []),
                }
                if (
                    await reviews.scoped_store(consent_token).write(
                        user_id, state, prior, conn=conn
                    )
                    is None
                ):
                    raise ValueError("Recipient draft changed")
        await conn.execute(
            """UPDATE pwm_claim_invitations SET state='claimed',recipient_user_id=$1,
            claimed_at=NOW(),consent_version='pwm-claim-v1',recipient_draft_id=$3,
            preview_envelope=NULL WHERE id=$2""",
            user_id,
            row["id"],
            draft_id,
            timeout=5,
        )
    return {
        "claimed": True,
        "sharing_granted": False,
        "research_started": False,
        "draft_id": str(draft_id) if draft_id else None,
    }


def _preview_cipher(token, invitation_id):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise ValueError("Invalid invitation")
    aad = f"pwm-professional-preview-v1:{invitation_id}:{hashlib.sha256(token.encode()).hexdigest()}".encode()
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=str(invitation_id).encode(),
        info=b"pwm-preview-v1",
    ).derive(token.encode())
    return AESGCM(key), aad


def seal_preview(token, invitation_id, preview):
    cipher, aad = _preview_cipher(token, invitation_id)
    nonce = secrets.token_bytes(12)
    return nonce + cipher.encrypt(nonce, json.dumps(preview).encode(), aad)


def open_preview(token, invitation_id, envelope):
    cipher, aad = _preview_cipher(token, invitation_id)
    return json.loads(cipher.decrypt(envelope[:12], envelope[12:], aad))


async def preview(token):
    pool = await get_pool()
    row = await pool.fetchrow(
        """SELECT id,preview_envelope FROM pwm_claim_invitations
        WHERE token_hash=$1 AND state='pending' AND expires_at>NOW()""",
        hashlib.sha256(token.encode()).hexdigest(),
        timeout=5,
    )
    if not row:
        raise ValueError("Preview unavailable")
    if not row["preview_envelope"]:
        # A claim link can be issued without a professional preview. Possession of
        # a live token proves only that this invitation is available to continue.
        return {"has_preview": False}
    return open_preview(token, row["id"], row["preview_envelope"])


async def reject(user_id, consent_token, token):
    await verified_owner(user_id, consent_token)
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        inviter = await conn.fetchval(
            "SELECT inviter_user_id FROM pwm_claim_invitations WHERE token_hash=$1", token_hash
        )
        if not inviter:
            return {"rejected": True}
        await lock_connection_graph_users_async(conn, user_ids=[user_id, inviter])
        identity = await verified_owner(user_id, consent_token, conn=conn)
        commitments = [
            contact_commitment(identity[k]) for k in ("email", "phone_number") if identity.get(k)
        ]
        await conn.execute(
            """DELETE FROM pwm_claim_invitations WHERE token_hash=$1
            AND (contact_commitment=ANY($2::text[]) OR secondary_contact_commitment=ANY($2::text[]))
            AND state='pending'""",
            token_hash,
            commitments,
            timeout=5,
        )
    return {"rejected": True}


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
