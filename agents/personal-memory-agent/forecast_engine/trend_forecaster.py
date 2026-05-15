from collections import Counter


def forecast_trends(memories):

    categories = []

    for memory in memories:

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        categories.append(category)

    counter = Counter(categories)

    predicted_trends = []

    for category, count in counter.items():

        if count >= 3:

            predicted_trends.append(
                f"{category} activity is expected to increase."
            )

    if not predicted_trends:

        predicted_trends.append(
            "Behavioral patterns are still stabilizing."
        )

    return predicted_trends