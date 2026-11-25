"""Current public names only through the retained viewer-owned counterpart edge."""


def identity_projection(has, _columns):
    if (
        not has("feed_event_counterparts")
        or not has("actor_identity_cache")
        or not has("connections")
    ):
        return [], ["jsonb_build_object('search_current_name',NULL)"], {}
    return (
        [
            """LEFT JOIN feed_event_counterparts search_counterpart ON search_counterpart.feed_event_id=f.id
      LEFT JOIN actor_identity_cache search_identity ON search_identity.user_id=search_counterpart.counterpart_user_id
      AND EXISTS(SELECT 1 FROM connections name_relationship WHERE name_relationship.status='active'
        AND ((name_relationship.user_a_id=f.user_id AND name_relationship.user_b_id=search_counterpart.counterpart_user_id)
          OR (name_relationship.user_b_id=f.user_id AND name_relationship.user_a_id=search_counterpart.counterpart_user_id)))"""
        ],
        ["jsonb_build_object('search_current_name',left(search_identity.display_name,160))"],
        {},
    )
