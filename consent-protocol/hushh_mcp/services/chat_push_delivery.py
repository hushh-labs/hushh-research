"""Chat-only FCM delivery, sealed previews and per-installation acceptance.

Provider acceptance is not a read receipt. Network failures retry only the
devices that did not accept. A stable OS tag makes crash-after-accept safe.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import time
from functools import lru_cache
from typing import Callable
from urllib.parse import urlsplit

from sqlalchemy import text

logger = logging.getLogger(__name__)
PREVIEW_INFO = b"hussh-chat-preview-v1:"


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def seal_preview(public: str, key_id: str, context: str, preview: dict) -> str:
    import os

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    peer = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), base64.urlsafe_b64decode(public + "=")
    )
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=PREVIEW_INFO + key_id.encode()
    ).derive(ephemeral.exchange(ec.ECDH(), peer))
    iv = os.urandom(12)
    plaintext = json.dumps(preview, separators=(",", ":"), ensure_ascii=False).encode()
    if len(plaintext) > 1800:
        raise ValueError("Preview exceeds transport budget")
    ciphertext = AESGCM(key).encrypt(iv, plaintext, f"{key_id}:{context}".encode())
    point = ephemeral.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return json.dumps([key_id, b64(point), b64(iv), b64(ciphertext)], separators=(",", ":"))


def thumbnail(photo: str | None) -> str:
    """Bounded inline raster avatar. Never fetch an untrusted remote URL."""
    if not photo or len(photo) > 410000:
        return ""
    return _thumbnail(photo, int(time.time()) // 120)


@lru_cache(maxsize=128)
def _thumbnail(photo: str, _time_bucket: int) -> str:
    try:
        from PIL import Image, ImageOps

        if photo.startswith(
            ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")
        ):
            raw = base64.b64decode(photo.split(",", 1)[1], validate=True)
        else:
            url = urlsplit(photo)
            if (
                url.scheme != "https"
                or url.hostname
                not in {
                    "lh3.googleusercontent.com",
                    "lh4.googleusercontent.com",
                    "lh5.googleusercontent.com",
                    "lh6.googleusercontent.com",
                }
                or url.port not in (None, 443)
                or url.username
                or url.password
                or len(photo) > 2048
            ):
                return ""
            import httpx

            with httpx.stream(
                "GET", photo, timeout=httpx.Timeout(2, connect=1), follow_redirects=False
            ) as response:
                if response.status_code != 200:
                    return ""
                chunks, size = [], 0
                deadline = time.monotonic() + 3
                for chunk in response.iter_bytes(8192):
                    size += len(chunk)
                    if size > 300 * 1024 or time.monotonic() > deadline:
                        return ""
                    chunks.append(chunk)
                raw = b"".join(chunks)
        with Image.open(io.BytesIO(raw)) as source:
            if (
                source.format not in {"PNG", "JPEG", "WEBP"}
                or source.width > 2048
                or source.height > 2048
                or getattr(source, "n_frames", 1) != 1
            ):
                return ""
            image = ImageOps.fit(source.convert("RGB"), (32, 32))
            out = io.BytesIO()
            image.save(out, format="JPEG", quality=45, optimize=True)
            data = out.getvalue()
            return (
                "data:image/jpeg;base64," + base64.b64encode(data).decode()
                if len(data) <= 750
                else ""
            )
    except Exception:
        return ""


def transport_bytes(payload: dict[str, str]) -> int:
    return len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def deliver_chat_push(
    db,
    user: str,
    *,
    event_id: str,
    kind: str,
    link: str,
    tag: str,
    context: str,
    data: dict[str, str],
    preview_for: Callable[[dict], str | None],
    eligible: Callable[..., bool] | None = None,
) -> bool:
    from api.utils.firebase_admin import ensure_firebase_admin

    configured, _ = ensure_firebase_admin()
    if not configured:
        return False
    from firebase_admin import messaging

    from api.utils.fcm_messages import build_push_message
    from hushh_mcp.services.push_tokens_service import (
        LEGACY_REGISTRY_OWNER_FILTER,
        PUSH_TOKEN_REGISTRY_SQL,
        remove_stale_push_token,
    )

    complete = True
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "DELETE FROM chat_push_device_deliveries WHERE accepted_at < now() - interval '3 days'"
            )
        )
        ids = (
            conn.execute(
                text(
                    f"SELECT id,source FROM ({PUSH_TOKEN_REGISTRY_SQL}) registrations WHERE user_id=:user"  # nosec B608 # Registry SQL is fixed; user is bound.
                ),
                {"user": user},
            )
            .mappings()
            .all()
        )
    for registration in ids:
        token_id = registration["id"]
        modern = registration["source"] == "installation"
        table = "user_push_installations" if modern else "user_push_tokens"
        legacy_filter = "" if modern else f" AND {LEGACY_REGISTRY_OWNER_FILTER}"
        stale_token = None
        if eligible is not None and not eligible(True):
            return True
        # Keep registration ownership stable through the bounded provider call.
        with db.engine.begin() as conn:
            from hushh_mcp.services.account_deletion_lifecycle_service import (
                AccountDeletionLifecycleService,
            )

            AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user])
            if conn.execute(
                text(
                    "SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash='sha256:' || encode(digest(:user,'sha256'),'hex')"
                ),
                {"user": user},
            ).scalar():
                return True
            row = (
                conn.execute(
                    text(
                        f"SELECT l.* FROM {table} l WHERE id=:id AND user_id=:user {legacy_filter} FOR UPDATE OF l"  # nosec B608 # Table/predicate use two fixed internal variants; IDs are bound.
                    ),
                    {"id": token_id, "user": user},
                )
                .mappings()
                .first()
            )
            if not row:
                continue
            params = {
                "event": event_id,
                "device": row["device_id"],
                "user": user,
                "direct": data.get("direct_message_id") if kind == "direct_message" else None,
                "circle": event_id.split(":")[-1] if kind == "location_circle_message" else None,
            }
            if conn.execute(
                text(
                    "SELECT 1 FROM chat_push_device_deliveries WHERE event_id=:event AND device_id=:device AND recipient_user_id=:user"
                ),
                params,
            ).scalar():
                continue
            if eligible is not None and not eligible(False, conn):
                return True
            payload = {
                **{
                    k: v
                    for k, v in data.items()
                    if k not in {"sender_label", "circle_label", "sender_avatar", "sender_ref"}
                },
                "type": kind,
                "message_id": event_id,
                "deep_link": link,
                "request_url": link,
                "notification_tag": tag,
                "notification_category": "ONE_CHAT",
                "chat_expires_at": data.get("chat_expires_at") or str(int(time.time()) + 86400),
            }
            try:
                try:
                    preview = preview_for(dict(row))
                except Exception:
                    preview = None  # Never lose an alert because its optional preview failed.
                if row.get("preview_key_id"):
                    payload["recipient_key_id"] = str(row["preview_key_id"])
                else:
                    payload["user_id"] = user  # Legacy doorbells retain their owner fence.
                if preview:
                    payload.update(chat_preview=preview, preview_context=context)
                identity = None
                if row.get("preview_public_key") and data.get("sender_label"):
                    identity = {
                        "sender": data["sender_label"],
                        "group": data.get("circle_label", ""),
                        "avatar": data.get("sender_avatar", ""),
                        "senderRef": data.get("sender_ref", ""),
                        "text": "",
                    }
                    # Identity is authoritative and sealed separately: a sender cannot spoof it.
                    for avatar in (identity["avatar"], ""):
                        identity["avatar"] = avatar
                        try:
                            payload["chat_identity"] = seal_preview(
                                row["preview_public_key"],
                                str(row["preview_key_id"]),
                                context,
                                identity,
                            )
                            payload["preview_context"] = context
                        except Exception:
                            payload.pop("chat_identity", None)
                        if transport_bytes(payload) <= 3000:
                            break
                # Leave room for APS, provider routing and presentation fields under 4 KiB.
                if transport_bytes(payload) > 3000:
                    payload.pop("chat_preview", None)
                if transport_bytes(payload) > 3000:
                    payload.pop("chat_identity", None)
                message = build_push_message(
                    messaging,
                    token=row["token"],
                    platform=row["platform"],
                    data=payload,
                    title="New message" if kind == "direct_message" else "Circle chat",
                    body="You have a new message"
                    if kind == "direct_message"
                    else "You have a new circle message",
                    request_url=link,
                    notification_tag=tag,
                    show_alert=True,
                )
                # Preview construction can yield to avatar IO; recheck the source
                # after that work, while the installation's delivery lock is held.
                if eligible is not None and not eligible(False, conn):
                    continue
                messaging.send(message)
                conn.execute(
                    text(
                        "INSERT INTO chat_push_device_deliveries(event_id, device_id, recipient_user_id, direct_message_id, circle_message_id) VALUES(:event, :device, :user, :direct, :circle) ON CONFLICT DO NOTHING"
                    ),
                    params,
                )
            except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                stale_token = row["token"]
            except Exception as exc:
                complete = False
                logger.warning(
                    "chat_push.device_failed kind=%s error_type=%s", kind, type(exc).__name__
                )
        # Release the modern provider lock before touching its legacy shadow:
        # old registration's DB trigger locks legacy then modern, never reverse.
        if stale_token:
            try:
                remove_stale_push_token(db, user, stale_token)
            except Exception:
                complete = False
    return complete
