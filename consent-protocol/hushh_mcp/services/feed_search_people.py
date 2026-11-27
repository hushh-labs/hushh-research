"""One confident identity from canonical contact or verified client authority."""

from urllib.parse import quote

from starlette.concurrency import run_in_threadpool

from hushh_mcp.services.feed_search_contract import normalized


def unique_name_match(rows, query, name_key, identity_key):
    terms = normalized(query).split()
    if not terms or any(len(term) < 2 for term in terms):
        return None
    matches = {
        str(row.get(identity_key)): row
        for row in rows
        if row.get(identity_key)
        and isinstance(row.get(name_key), str)
        and all(
            any(word.startswith(term) for word in normalized(row[name_key]).split())
            for term in terms
        )
    }
    exact = {
        key: row for key, row in matches.items() if normalized(row[name_key]) == normalized(query)
    }
    # Same-name people remain ambiguous even if one happens to be first.
    candidates = exact or matches
    return next(iter(candidates.values())) if len(candidates) == 1 else None


async def identity_top_hit(owner: str, query: str, scope: str | None, persona: str):
    tokens = normalized(query).split()
    if not tokens or any(len(token) < 2 for token in tokens):
        return None
    if persona == "ria" and scope in {None, "advisor"}:
        from hushh_mcp.services.ria_iam_service import (
            IAMSchemaNotReadyError,
            RIAIAMPolicyError,
            RIAIAMService,
        )

        service = RIAIAMService()
        try:
            await service.require_ria_verified(owner)
            page = await service.list_ria_clients(
                owner, query=normalized(query).split()[0], limit=100
            )
            if not page.get("has_more"):
                match = unique_name_match(
                    page.get("items", []), query, "investor_display_name", "investor_user_id"
                )
                if match:
                    await service.get_ria_workspace(owner, str(match["investor_user_id"]))
                    return {
                        "kind": "client",
                        "label": match["investor_display_name"],
                        "href": "/ria/clients/"
                        + quote(str(match["investor_user_id"]), safe="")
                        + "?from=%2Fone%2Ffeed",
                    }
        except (RIAIAMPolicyError, IAMSchemaNotReadyError):
            return None
        if scope == "advisor":
            return None
    from hushh_mcp.services.connections_service import ConnectionsService

    rows = await run_in_threadpool(ConnectionsService().list_connections, owner)
    match = unique_name_match(rows, query, "displayName", "userId")
    if match and match.get("publicPersonRef"):
        return {
            "kind": "person",
            "label": match["displayName"],
            "href": "/people/"
            + quote(str(match["publicPersonRef"]), safe="")
            + "?from=%2Fone%2Ffeed",
        }
    return None


def resolve_search_person(owner: str, person_ref: str) -> str | None:
    from hushh_mcp.services.person_profile_service import (
        PersonProfileNotFoundError,
        PersonProfileService,
    )

    try:
        user_id, relationship = PersonProfileService().get_relationship_target(
            viewer_user_id=owner, public_person_ref=person_ref
        )
    except PersonProfileNotFoundError:
        return None
    return user_id if relationship.get("status") == "connected" else None


async def identity_ref_top_hit(owner: str, person_ref: str, scope: str | None, persona: str):
    from hushh_mcp.services.person_profile_service import PersonProfileService

    user_id = await run_in_threadpool(resolve_search_person, owner, person_ref)
    if not user_id:
        return None
    if persona == "ria" and scope in {None, "advisor"}:
        from hushh_mcp.services.ria_iam_service import (
            IAMSchemaNotReadyError,
            RIAIAMPolicyError,
            RIAIAMService,
        )

        try:
            service = RIAIAMService()
            await service.require_ria_verified(owner)
            await service.get_ria_workspace(owner, user_id)
            profile = await run_in_threadpool(PersonProfileService().get_public_profile, person_ref)
            return {
                "kind": "client",
                "label": profile["displayName"],
                "href": "/ria/clients/" + quote(user_id, safe="") + "?from=%2Fone%2Ffeed",
            }
        except (RIAIAMPolicyError, IAMSchemaNotReadyError):
            if scope == "advisor":
                return None
    profile = await run_in_threadpool(PersonProfileService().get_public_profile, person_ref)
    return {
        "kind": "person",
        "label": profile["displayName"],
        "href": "/people/" + quote(person_ref, safe="") + "?from=%2Fone%2Ffeed",
    }
