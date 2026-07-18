def generate_insights(analytics):

    insights = []

    top_category = analytics.get("top_category")

    productive_hour = analytics.get("most_productive_hour")

    total_memories = analytics.get("total_memories")

    if productive_hour is not None:

        insights.append(
            f"You appear most productive around {productive_hour}:00 hours."
        )

    if top_category:

        insights.append(
            f"Most of your stored activities are related to '{top_category}'."
        )

    insights.append(
        f"You currently have {total_memories} stored memories."
    )

    return insights