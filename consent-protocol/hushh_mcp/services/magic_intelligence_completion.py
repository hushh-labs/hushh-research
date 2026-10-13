"""Owner-scoped suggestion completion; never a profile or ownership write."""

from db.connection import get_pool
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id


class MagicReviewNotCommitted(ValueError):
    """Some selected reviewed writes have not committed for this owner."""


async def magic_intelligence_saved(user_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return bool(
            await conn.fetchval(
                "SELECT one_magic_intelligence_saved FROM vault_keys WHERE user_id = $1", user_id
            )
        )


async def complete_magic_intelligence(
    user_id: str,
    commits: list[tuple[str, str]],
    *,
    verify_only: bool = False,
    max_commits: int = 64,
) -> None:
    """Mark once, verifying every receipt rather than trusting client saved state.

    Personal reviews can contain multiple cards. One event alone
    must never finish a partially saved review. No event-based bulk backfill.
    """
    if not 1 <= len(commits) <= min(max_commits, 160) or len(set(commits)) != len(commits):
        raise MagicReviewNotCommitted()
    try:
        commit_ids = [
            derive_pkm_mutation_commit_id(user_id=user_id, domain=domain, plan_id=plan)
            for domain, plan in commits
        ]
    except ValueError:
        raise MagicReviewNotCommitted() from None
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        owner = await conn.fetchrow(
            "SELECT one_magic_intelligence_saved FROM vault_keys WHERE user_id = $1 FOR UPDATE",
            user_id,
        )
        if owner is None:
            raise MagicReviewNotCommitted()
        if not verify_only and bool(owner["one_magic_intelligence_saved"]):
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
                    AND e.source_agent = 'profile_research_review'
                    AND e.metadata->'provenance'->>'writer_id' = 'profile_research_review'
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
            raise MagicReviewNotCommitted()
        if verify_only:
            return
        await conn.execute(
            "UPDATE vault_keys SET one_magic_intelligence_saved = TRUE WHERE user_id = $1", user_id
        )
