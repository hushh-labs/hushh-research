"""Chunk custody shares the qualified object port and independent cleanup ledger."""

import hashlib
import hmac
import json
import secrets
from uuid import uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import DeliveryError, canonical


def aad(row, ordinal):
    return canonical(
        [
            "one-server-copy-v2",
            str(row["request_id"]),
            str(row["file_ref"]),
            row["source_digest"],
            ordinal,
        ]
    )


def file_key(store, row):
    return bytes.fromhex(store.open(row, "key_envelope", "background-copy-key-v2")["key"])


def decrypt(store, row, chunk, ciphertext):
    descriptor = chunk["descriptor"]
    if (
        len(ciphertext) != descriptor["bytes"] + 28
        or len(ciphertext) != descriptor["ciphertextBytes"]
        or hashlib.sha256(ciphertext).hexdigest() != descriptor["sha256"]
        or not hmac.compare_digest(ciphertext[:12], bytes.fromhex(descriptor["iv"]))
    ):
        raise DeliveryError("copy_integrity_mismatch")
    return AESGCM(file_key(store, row)).decrypt(
        ciphertext[:12], ciphertext[12:], aad(row, chunk["ordinal"])
    )


def _reserve(connection, store, objects, row, ordinal, descriptor, object_key, ciphertext_bytes):
    request, _ = store.file_authority(connection, row, store.owner(row), lease=True)
    connection.execute(
        text("""INSERT INTO document_delivery_background_chunks
      (file_ref,ordinal,request_id,object_key,bucket_identity,descriptor)
      VALUES(:ref,:ordinal,:request,:key,:bucket,CAST(:descriptor AS jsonb))"""),
        {
            "ref": row["file_ref"],
            "ordinal": ordinal,
            "request": row["request_id"],
            "key": object_key,
            "bucket": objects.identity,
            "descriptor": json.dumps(descriptor),
        },
    )
    connection.execute(
        text("""INSERT INTO document_delivery_cleanup
      (cleanup_id,request_id,bucket_identity,object_key,ciphertext_bytes,held_by_background,next_attempt_at)
      VALUES(:id,:request,:bucket,:key,:bytes,TRUE,TIMESTAMPTZ 'infinity')"""),
        {
            "id": str(uuid4()),
            "request": row["request_id"],
            "bucket": objects.identity,
            "key": object_key,
            "bytes": ciphertext_bytes,
        },
    )


async def save(service, row, ordinal, plaintext):
    store, objects = service.store, service.objects
    nonce = secrets.token_bytes(12)
    ciphertext = nonce + AESGCM(file_key(store, row)).encrypt(
        nonce, bytes(plaintext), aad(row, ordinal)
    )
    descriptor = {
        "iv": nonce.hex(),
        "bytes": len(plaintext),
        "ciphertextBytes": len(ciphertext),
        "sha256": hashlib.sha256(ciphertext).hexdigest(),
    }
    object_key = f"background-v2/{uuid4()}"

    await store._transaction(
        lambda c: _reserve(c, store, objects, row, ordinal, descriptor, object_key, len(ciphertext))
    )
    # Inventory exists before any remote session or write. A cut-short write is
    # never retried as another POST; the next slice stops and cleanup reconciles.
    session = await objects.initiate(object_key, len(ciphertext))
    envelope = store.sharing_cipher.seal(
        {"session": session},
        user_id="document-delivery",
        resource_id=object_key,
        purpose="upload-session",
    )

    def dispatched(connection):
        store.file_authority(connection, row, store.owner(row), lease=True)
        connection.execute(
            text("""UPDATE document_delivery_cleanup SET upload_session_envelope=CAST(:session AS jsonb),
          session_observed_at=clock_timestamp(),write_dispatched_at=clock_timestamp() WHERE object_key=:key"""),
            {"session": json.dumps(envelope), "key": object_key},
        )

    try:
        await store._transaction(dispatched)
    except BaseException:
        # The session is empty: cancellation creates no unrecorded payload.
        await objects.session_terminal(session, object_key, len(ciphertext), None)
        raise
    generation = await objects.send(session, object_key, ciphertext)

    def observed(connection):
        # Receipt custody must commit even if authority ended while uploading.
        connection.execute(
            text("""UPDATE document_delivery_cleanup SET object_generation=:generation,
          write_settled_at=clock_timestamp() WHERE object_key=:key"""),
            {"key": object_key, "generation": generation},
        )
        connection.execute(
            text(
                "UPDATE document_delivery_background_chunks SET object_generation=:generation WHERE object_key=:key"
            ),
            {"key": object_key, "generation": generation},
        )

    await store._transaction(observed)
    await store.current(row)


async def read(service, row, chunk):
    if chunk["bucket_identity"] != service.objects.identity or chunk["object_generation"] is None:
        raise DeliveryError("upload_outcome_unknown")
    ciphertext, generation = await service.objects.read(
        chunk["object_key"], limit=chunk["descriptor"]["ciphertextBytes"]
    )
    if ciphertext is None or generation != chunk["object_generation"]:
        raise DeliveryError("copy_integrity_mismatch")
    return decrypt(service.store, row, chunk, ciphertext)
