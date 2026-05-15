from collections import Counter


def analyze_behavior(memories):

    categories = []

    for memory in memories:

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        categories.append(category)

    counter = Counter(categories)

    dominant_behavior = None

    if counter:

        dominant_behavior = counter.most_common(1)[0][0]

    return {
        "dominant_behavior": dominant_behavior,
        "activity_distribution": dict(counter)
    }