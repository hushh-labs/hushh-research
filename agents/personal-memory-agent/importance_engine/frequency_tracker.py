from collections import Counter


def track_frequency(memories):

    categories = []

    for memory in memories:

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        categories.append(category)

    counter = Counter(categories)

    frequency_results = []

    for category, count in counter.items():

        frequency_results.append(
            {
                "category": category,
                "frequency": count
            }
        )

    return frequency_results
