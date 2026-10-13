from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

SecurityListType = Literal["benchmark", "universe", "avoid", "screening", "custom"]
SecurityListOwner = Literal["system", "ria", "investor"]
SecurityListVisibility = Literal["private", "shared", "public"]


@dataclass(frozen=True)
class SecurityListDescriptor:
    list_id: str
    slug: str
    list_type: SecurityListType
    owner_type: SecurityListOwner
    visibility: SecurityListVisibility
    title: str
    description: str | None = None
    source_table: str | None = None
    supports_upload: bool = False


@dataclass(frozen=True)
class SecurityListMember:
    ticker: str
    company_name: str | None = None
    sector: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class UniverseListService(ABC):
    """Generic contract for queryable security lists used by Kai and future RIA uploads."""

    @abstractmethod
    def list_descriptors(self) -> list[SecurityListDescriptor]:
        """Return the registry metadata for the list family."""

    @abstractmethod
    async def list_members(self, list_id: str) -> list[SecurityListMember]:
        """Return parsed/queryable members for a concrete list id."""
