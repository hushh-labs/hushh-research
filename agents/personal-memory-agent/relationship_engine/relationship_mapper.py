from collections import defaultdict


def map_relationships(memories):

    relationship_map = defaultdict(list)

    for memory in memories:

        document = memory.get("document", "").lower()

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        words = document.split()

        for word in words:

            if len(word) > 4:

                relationship_map[word].append(category)

    return dict(relationship_map)