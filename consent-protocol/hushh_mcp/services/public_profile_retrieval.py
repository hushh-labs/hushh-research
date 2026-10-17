"""Candidate retrieval only; identity verdicts belong to HusshOne intelligence."""

from __future__ import annotations

import hashlib
import json
import math
import os


async def retrieve_candidates(
    conn,
    *,
    name: str,
    profile_url: str | None = None,
    embedding: list[float] | None = None,
    embedding_model: str | None = None,
    limit: int = 20,
):
    limit = max(1, min(limit, 20))
    rows = []
    if profile_url:
        rows.extend(
            await conn.fetch(
                """SELECT e.entity_id,e.prepared_payload FROM one_public_profile_identity_anchors a
               JOIN one_public_profile_entities e USING(entity_id)
               WHERE a.anchor_type='profile_url' AND a.anchor_hash=$1 AND e.status='active' AND e.prepared_payload IS NOT NULL LIMIT 1""",
                hashlib.sha256(profile_url.encode()).hexdigest(),
            )
        )
    rows.extend(
        await conn.fetch(
            """SELECT entity_id,prepared_payload FROM one_public_profile_entities
           WHERE status='active' AND prepared_payload IS NOT NULL AND search_document @@ plainto_tsquery('simple',$1)
           ORDER BY ts_rank(search_document,plainto_tsquery('simple',$1)) DESC,entity_id LIMIT $2""",
            name,
            limit,
        )
    )
    if embedding is not None:
        if (
            len(embedding) != 768
            or not embedding_model
            or any(not math.isfinite(v) for v in embedding)
        ):
            raise ValueError("Invalid versioned profile embedding")
        # pgvector 0.8+: bounded iterative scan also handles filtered/dead tuples.
        # Transaction-local settings cannot leak between pooled owners.
        async with conn.transaction():
            await conn.execute("SELECT set_config('hnsw.iterative_scan','strict_order',true)")
            await conn.execute(
                "SELECT set_config('hnsw.ef_search',$1,true)",
                str(
                    max(40, min(1000, int(os.getenv("ONE_PUBLIC_PROFILE_VECTOR_EF_SEARCH", "100"))))
                ),
            )
            await conn.execute("SELECT set_config('hnsw.max_scan_tuples','20000',true)")
            rows.extend(
                await conn.fetch(
                    """SELECT entity_id,prepared_payload FROM one_public_profile_entities
                   WHERE status='active' AND prepared_payload IS NOT NULL AND embedding_model=$2
                   ORDER BY embedding <=> $1::vector LIMIT $3""",
                    json.dumps(embedding),
                    embedding_model,
                    limit,
                )
            )

    result = []
    seen = set()
    for row in rows:
        if row["entity_id"] in seen:
            continue
        seen.add(row["entity_id"])
        value = row["prepared_payload"]
        result.append(json.loads(value) if isinstance(value, str) else value)
        if len(result) == limit:
            break
    return result


FIXTURE_EMBEDDING_MODEL = "fixture:shake768.v1"


def fixture_embedding(text: str) -> list[float]:
    """Synthetic vectors test the port, never semantic recall or model quality."""
    raw = hashlib.shake_256(text.encode()).digest(1536)
    return [(int.from_bytes(raw[i : i + 2], "big") - 32768) / 32768 for i in range(0, 1536, 2)]


async def refresh_fixture_embedding(conn, profile):
    from uuid import UUID

    content_hash = hashlib.sha256(
        json.dumps(
            {key: profile[key] for key in ("display_name", "facts", "summary")}, sort_keys=True
        ).encode()
    ).hexdigest()
    return await conn.execute(
        """UPDATE one_public_profile_entities SET embedding=$2::vector,embedding_model=$3,embedding_content_hash=$4
           WHERE entity_id=$1 AND (embedding_content_hash IS DISTINCT FROM $4 OR embedding_model IS DISTINCT FROM $3)""",
        UUID(profile["entity_id"]),
        json.dumps(fixture_embedding(profile["display_name"])),
        FIXTURE_EMBEDDING_MODEL,
        content_hash,
    )
