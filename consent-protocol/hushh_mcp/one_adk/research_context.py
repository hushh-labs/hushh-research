"""Explicit owner-approved discovery hints, separate from public evidence."""

from pydantic import Field, field_validator

from hushh_mcp.one_adk.world_model_contracts import Contract, ShortText


class OwnerResearchContext(Contract):
    """A frozen snapshot approved by the owner when requesting an update."""

    confirmed: list[ShortText] = Field(default_factory=list, max_length=269)
    permitted_public_research: bool = Field(strict=True)

    @field_validator("permitted_public_research")
    @classmethod
    def permission(cls, value):
        if not value:
            raise ValueError("Approve confirmed details for public research")
        return value


class OwnerDecisions(Contract):
    """Statements the owner already confirmed or rejected; model data only."""

    confirmed: list[ShortText] = Field(default_factory=list, max_length=269)
    rejected: list[ShortText] = Field(default_factory=list, max_length=269)


def confirmed_leads(context):
    return OwnerResearchContext.model_validate(context).confirmed if context is not None else []


def public_profile_leads(context):
    from hushh_mcp.one_adk.public_sources import OwnerPublicProfiles

    return OwnerPublicProfiles.model_validate(context).urls if context is not None else []


def approved_lead_inputs(profiles, leads):
    return {
        **({"owner_selected_public_profiles": profiles} if profiles else {}),
        **({"owner_confirmed_research_leads": leads} if leads else {}),
    }
