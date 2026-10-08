"""Bind a frozen profile selection to the existing atomic PKM commit ledger."""

from __future__ import annotations

from uuid import UUID, uuid5

from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id

PLAN_NAMESPACE = UUID("76f0e762-c176-5947-a680-7011af78b71f")


def claim_operations(
    user_id: str, operation_key: UUID, cards: list[dict[str, str]]
) -> list[dict[str, str]]:
    if not cards or len(cards) > 100 or len({card["card_id"] for card in cards}) != len(cards):
        raise ValueError("Invalid claim selection")
    operations = []
    for card in sorted(cards, key=lambda item: item["card_id"]):
        plan_id = "pkm_plan_" + uuid5(PLAN_NAMESPACE, f"{operation_key}:{card['card_id']}").hex
        operations.append(
            {
                "card_id": card["card_id"],
                "domain": card["domain"],
                "commit_id": derive_pkm_mutation_commit_id(
                    user_id=user_id, domain=card["domain"], plan_id=plan_id
                ),
            }
        )
    return operations


async def committed_cards(conn, user_id: str, operations: list[dict[str, str]]) -> list[str]:
    rows = await conn.fetch(
        "SELECT commit_id,domain FROM pkm_domain_commits WHERE user_id=$1 AND commit_kind='mutation' AND commit_id=ANY($2::uuid[])",
        user_id,
        [UUID(item["commit_id"]) for item in operations],
    )
    committed = {(str(row["commit_id"]), row["domain"]) for row in rows}
    return [
        item["card_id"] for item in operations if (item["commit_id"], item["domain"]) in committed
    ]
