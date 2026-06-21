from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.world_model import WorldModelDomainsResponse


def test_world_model_domain_list_enforces_pagination_cap() -> None:
    domains = [{"key": f"domain-{index}"} for index in range(201)]

    with pytest.raises(ValidationError):
        WorldModelDomainsResponse(domains=domains, count=len(domains))
