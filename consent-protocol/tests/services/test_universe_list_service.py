from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from hushh_mcp.services.universe_list_service import (
    SecurityListDescriptor,
    SecurityListMember,
    UniverseListService,
)


class DummyUniverseListService(UniverseListService):
    def list_descriptors(self):
        return [
            SecurityListDescriptor(
                list_id="list1",
                slug="demo-list",
                list_type="universe",
                owner_type="system",
                visibility="public",
                title="Demo List",
            )
        ]

    async def list_members(self, list_id: str):
        return [
            SecurityListMember(
                ticker="AAPL",
                company_name="Apple Inc.",
                sector="Technology",
            )
        ]


def test_security_list_descriptor_defaults():
    descriptor = SecurityListDescriptor(
        list_id="list1",
        slug="demo",
        list_type="benchmark",
        owner_type="system",
        visibility="public",
        title="Demo",
    )

    assert descriptor.description is None
    assert descriptor.source_table is None
    assert descriptor.supports_upload is False


def test_security_list_member_defaults():
    member = SecurityListMember(
        ticker="AAPL",
    )

    assert member.company_name is None
    assert member.sector is None
    assert member.metadata == {}


def test_universe_service_returns_descriptors():
    service = DummyUniverseListService()

    descriptors = service.list_descriptors()

    assert len(descriptors) == 1
    assert descriptors[0].list_id == "list1"
    assert descriptors[0].slug == "demo-list"


@pytest.mark.asyncio
async def test_universe_service_returns_members():
    service = DummyUniverseListService()

    members = await service.list_members("list1")

    assert len(members) == 1
    assert members[0].ticker == "AAPL"
    assert members[0].company_name == "Apple Inc."


def test_descriptor_is_frozen():
    descriptor = SecurityListDescriptor(
        list_id="list1",
        slug="demo",
        list_type="benchmark",
        owner_type="system",
        visibility="public",
        title="Demo",
    )

    with pytest.raises(FrozenInstanceError):
        descriptor.title = "Changed"


def test_member_is_frozen():
    member = SecurityListMember(
        ticker="AAPL",
    )

    with pytest.raises(FrozenInstanceError):
        member.ticker = "MSFT"
