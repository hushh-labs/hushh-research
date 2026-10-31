"""Owner-scoped suggestion completion; never a profile or ownership write."""

from db.connection import get_pool
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id


class BusinessReviewNotCommitted(ValueError):
    """Some selected reviewed writes have not committed for this owner."""


async def business_profile_saved(user_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return bool(
            await conn.fetchval(
                "SELECT one_business_profile_saved FROM vault_keys WHERE user_id = $1", user_id
            )
        )


async def complete_business_profile(user_id: str, commits: list[tuple[str, str]]) -> None:
    """Mark once, verifying every receipt rather than trusting client saved state.

    Historical business reviews can contain multiple cards. One event alone
    must never finish a partially saved review. No event-based bulk backfill.
    """
    if not 1 <= len(commits) <= 64 or len(set(commits)) != len(commits):
        raise BusinessReviewNotCommitted()
    try:
        commit_ids = [
            derive_pkm_mutation_commit_id(user_id=user_id, domain=domain, plan_id=plan)
            for domain, plan in commits
        ]
    except ValueError:
        raise BusinessReviewNotCommitted() from None
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        owner = await conn.fetchrow(
            "SELECT one_business_profile_saved FROM vault_keys WHERE user_id = $1 FOR UPDATE",
            user_id,
        )
        if owner is None:
            raise BusinessReviewNotCommitted()
        if bool(owner["one_business_profile_saved"]):
            return  # Idempotent retry after a lost response.
        acknowledged = await conn.fetchval(
            """
            SELECT COUNT(*) FROM unnest($2::text[], $3::text[], $4::text[])
              AS wanted(domain, plan_id, commit_id)
            WHERE EXISTS (
              SELECT 1 FROM pkm_domain_commits c
              WHERE c.user_id = $1 AND c.domain = wanted.domain
                AND c.commit_id = wanted.commit_id::uuid AND c.commit_kind = 'mutation'
                AND c.result_content_revision IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pkm_events e
                  WHERE e.user_id = $1 AND e.domain = wanted.domain
                    AND e.metadata->>'data_version' = c.result_content_revision::text
                    AND e.operation_type = 'content_write'
                    AND e.source_agent = 'business_profile_review'
                    AND e.metadata->'provenance'->>'writer_id' = 'business_profile_review'
                    AND e.metadata->'provenance'->>'mutation_plan_id' = wanted.plan_id
                    AND NULLIF(e.metadata->'provenance'->>'confirmation_receipt_id', '') IS NOT NULL
                )
            )
            """,
            user_id,
            [domain for domain, _ in commits],
            [plan for _, plan in commits],
            commit_ids,
        )
        if acknowledged != len(commits):
            raise BusinessReviewNotCommitted()
        await conn.execute(
            "UPDATE vault_keys SET one_business_profile_saved = TRUE WHERE user_id = $1", user_id
        )
