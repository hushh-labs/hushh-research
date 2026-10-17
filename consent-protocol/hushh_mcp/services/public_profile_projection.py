"""Persist HusshOne's immutable public revision without re-assessing its meaning."""

import hashlib
import json
import os
from datetime import datetime
from uuid import UUID


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


async def store_prepared(conn, profile, *, candidate_entity_ids=()):
    from hushh_mcp.services.public_profile_assessment_client import validate_prepared_profile

    profile = validate_prepared_profile(profile)
    if profile["provenance"]["mode"] == "fixture":
        local_fixture = (
            os.getenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE") == "true"
            and os.getenv("ENVIRONMENT", "").lower() in {"local", "development", "test"}
            and not os.getenv("K_SERVICE")
            and os.getenv("DB_HOST") in {"localhost", "127.0.0.1"}
            and not os.getenv("DB_UNIX_SOCKET")
        )
        if not local_fixture or not str(
            await conn.fetchval("SELECT current_database()")
        ).startswith("hushh_profile_fixture_"):
            raise ValueError("Fixture profiles require explicitly isolated storage")
    entity_id = UUID(profile["entity_id"])
    payload = json.dumps(profile)
    revision = profile["revision"]
    row = await conn.fetchrow(
        """INSERT INTO one_public_profile_entities(entity_id,display_name,revision,prepared_payload)
           VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(entity_id) DO UPDATE
           SET display_name=EXCLUDED.display_name,revision=EXCLUDED.revision,
               prepared_payload=EXCLUDED.prepared_payload,updated_at=now()
           WHERE one_public_profile_entities.entity_id = ANY($5::uuid[])
             AND (one_public_profile_entities.revision<EXCLUDED.revision
              OR (one_public_profile_entities.revision=EXCLUDED.revision
                  AND one_public_profile_entities.prepared_payload=EXCLUDED.prepared_payload))
           RETURNING entity_id""",
        entity_id,
        profile["display_name"],
        revision,
        payload,
        list(candidate_entity_ids),
    )
    if row is None:
        raise ValueError("Conflicting public profile revision")
    for source in profile["sources"]:
        from urllib.parse import urlsplit

        await conn.execute(
            """INSERT INTO one_public_profile_sources(entity_id,source_url,source_domain,acquired_at)
               VALUES($1,$2,$3,$4) ON CONFLICT(entity_id,source_url) DO NOTHING""",
            entity_id,
            source,
            urlsplit(source).hostname,
            instant(profile["collected_at"]),
        )
    for fact in profile["facts"]:
        await conn.execute(
            """INSERT INTO one_public_profile_findings(entity_id,revision,category,claim,confidence,support,source_urls,observed_at,model_name,model_version,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(entity_id,revision,claim) DO NOTHING""",
            entity_id,
            revision,
            fact["category"],
            fact["claim"],
            fact["confidence"],
            fact["support"],
            fact["source_urls"],
            instant(fact["observed_at"]),
            profile["provenance"]["model"],
            profile["provenance"]["prompt_version"],
            instant(fact["collected_at"]),
        )
    return entity_id


async def bind_anchor(conn, entity_id, url):
    from hushh_mcp.services.public_profile_assessment_client import reject_public_contact
    from hushh_mcp.services.public_profile_discovery_service import _public_url

    reject_public_contact(url)
    if _public_url(url) != url:
        raise ValueError("Public profile anchor must be canonical")
    result = await conn.fetchval(
        """INSERT INTO one_public_profile_identity_anchors(entity_id,anchor_type,anchor_hash,canonical_url)
           VALUES($1,'profile_url',$2,$3) ON CONFLICT(anchor_type,anchor_hash) DO UPDATE
           SET canonical_url=EXCLUDED.canonical_url
           WHERE one_public_profile_identity_anchors.entity_id=EXCLUDED.entity_id RETURNING entity_id""",
        entity_id,
        hashlib.sha256(url.encode()).hexdigest(),
        url,
    )
    if result is None:
        raise ValueError("Profile URL maps to conflicting public entities")
