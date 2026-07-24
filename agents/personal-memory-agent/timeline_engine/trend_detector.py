from collections import Counter


def detect_activity_trends(memories):

    categories = []

    for memory in memories:

        metadata = memory.get("metadata", {})

        category = metadata.get("category")

        if category:

            categories.append(category)

    counter = Counter(categories)

    trends = []

    for category, count in counter.items():

        trends.append(
            {
                "category": category,
                "count": count
            }
        )

    return trends