from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services.profile_claim_receipts import claim_operations, committed_cards


def test_commit_identity_is_stable_owner_bound_and_domain_bound():
    operation = uuid4()
    cards = [{"card_id": "card-a", "domain": "professional"}]
    first = claim_operations("owner-a", operation, cards)
    assert first == claim_operations("owner-a", operation, cards)
    assert first != claim_operations("owner-b", operation, cards)
    assert first != claim_operations(
        "owner-a", operation, [{"card_id": "card-a", "domain": "personal"}]
    )
    with pytest.raises(ValueError):
        claim_operations("owner-a", operation, cards * 2)


@pytest.mark.asyncio
async def test_receipt_query_is_owner_scoped_and_requires_matching_domain():
    operations = claim_operations("owner-a", uuid4(), [{"card_id": "a", "domain": "professional"}])
    connection = AsyncMock()
    connection.fetch.return_value = [{"commit_id": operations[0]["commit_id"], "domain": "other"}]
    assert await committed_cards(connection, "owner-a", operations) == []
    assert connection.fetch.await_args.args[1] == "owner-a"
    connection.fetch.return_value = [
        {"commit_id": operations[0]["commit_id"], "domain": "professional"}
    ]
    assert await committed_cards(connection, "owner-a", operations) == ["a"]
