from datetime import datetime


def analyze_recency(memories):

    recent_memories = []

    for memory in memories:

        metadata = memory.get("metadata", {})

        timestamp = metadata.get("timestamp")

        if timestamp:

            try:

                dt = datetime.fromisoformat(timestamp)

                recent_memories.append(
                    {
                        "memory": memory.get("document"),
                        "timestamp": str(dt)
                    }
                )

            except Exception:
                pass

    return recent_memories