from collections import defaultdict


def generate_activity_heatmap(memories):

    heatmap = defaultdict(int)

    for memory in memories:

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        heatmap[category] += 1

    results = []

    for category, count in heatmap.items():

        results.append(
            {
                "category": category,
                "activity_score": count
            }
        )

    return results