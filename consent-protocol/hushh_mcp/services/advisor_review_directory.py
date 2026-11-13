"""Map discoverable verified identities to secure review targets, never by name."""

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.finance_sharing_service import FinanceSharingError, one, require_advisor
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


def candidates(viewer, *, query="", crds=None, connected=False, page=1, service=None):
    database = get_db()
    has_more = False
    if crds is None:
        connections = ConnectionsService()
        directory = (
            OneLocationAgentService().search_directory_candidates(
                owner_user_id=viewer,
                query=query,
                typed_search=True,
                audience="ria",
                name_only=True,
                page=page,
                limit=30,
                advisor_service=service,
                include_recommendations=False,
            )
            if service is not None
            else connections.list_connections_page(viewer, audience="ria", page=page, limit=30)
            if connected
            else connections.search_directory(
                viewer,
                query=query,
                audience="ria",
                name_only=True,
                typed_search=True,
                page=page,
                limit=30,
            )
        )
        has_more = directory["hasMore"]
        ids = [person["userId"] for person in directory["items"]]
    else:
        with database.engine.connect() as conn:
            ids = (
                conn.execute(
                    text("""SELECT user_id FROM ria_profiles
                WHERE COALESCE(to_jsonb(ria_profiles)->>'individual_crd',finra_crd)=ANY(:crds) LIMIT 30"""),
                    {"crds": crds},
                )
                .scalars()
                .all()
            )
    result = []
    visible = OneLocationAgentService().search_directory_candidates(
        owner_user_id=viewer,
        candidate_user_ids=list(ids),
        limit=30,
        include_recommendations=service is None,
    )
    eligible_ids = {person["userId"] for person in visible["items"]}
    with database.engine.begin() as conn:
        for uid in dict.fromkeys(ids):
            if uid == viewer or uid not in eligible_ids:
                continue
            try:
                require_advisor(conn, uid)
            except FinanceSharingError as exc:
                if exc.code == "FINANCE_ADVISOR_NOT_VERIFIED":
                    continue
                raise
            row = one(
                conn,
                """SELECT p.public_person_ref,r.display_name,r.bio,
                COALESCE(to_jsonb(r)->'services_offered', '[]'::jsonb) AS services_offered,
                COALESCE(to_jsonb(r)->>'individual_crd',r.finra_crd) AS crd,
                k.key_id,k.public_key_jwk
                FROM ria_profiles r JOIN actor_profiles p ON p.user_id=r.user_id
                LEFT JOIN LATERAL(SELECT key_id,public_key_jwk FROM one_location_recipient_keys
                    WHERE user_id=r.user_id AND status='active' ORDER BY created_at DESC LIMIT 1) k ON true
                WHERE r.user_id=:uid AND NOT EXISTS(SELECT 1 FROM direct_message_blocks
                    WHERE (blocker_user_id=:viewer AND blocked_user_id=:uid) OR (blocker_user_id=:uid AND blocked_user_id=:viewer))""",
                {"uid": uid, "viewer": viewer},
            )
            if row and row["public_person_ref"]:
                result.append(
                    {
                        "userId": uid,
                        "personRef": str(row["public_person_ref"]),
                        "name": row["display_name"],
                        "bio": (row["bio"] or "")[:250],
                        "crd": row["crd"],
                        "verified": True,
                        "servicesOffered": list(row["services_offered"] or []),
                        "keyId": row["key_id"],
                        "publicKeyJwk": row["public_key_jwk"],
                        "ready": bool(row["key_id"]),
                    }
                )
    return {"items": result, "hasMore": has_more}
