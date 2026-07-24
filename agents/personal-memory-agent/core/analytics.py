from collections import Counter
from datetime import datetime


def analyze_productivity(memories):

    hours = []

    categories = []

    for memory in memories:

        metadata = memory.get("metadata", {})

        timestamp = metadata.get("timestamp")

        category = metadata.get("category")

        if category:
            categories.append(category)

        if timestamp:

            try:

                dt = datetime.fromisoformat(timestamp)

                hours.append(dt.hour)

            except Exception:
                pass

    category_counter = Counter(categories)

    hour_counter = Counter(hours)

    most_common_category = (
        category_counter.most_common(1)[0][0]
        if category_counter
        else "unknown"
    )

    most_productive_hour = (
        hour_counter.most_common(1)[0][0]
        if hour_counter
        else None
    )

    return {
        "top_category": most_common_category,
        "most_productive_hour": most_productive_hour,
        "total_memories": len(memories)
    }