from collections import defaultdict
from datetime import datetime


def build_memory_timeline(memories):

    timeline = defaultdict(list)

    for memory in memories:

        metadata = memory.get("metadata", {})

        timestamp = metadata.get("timestamp")

        if timestamp:

            try:

                dt = datetime.fromisoformat(timestamp)

                date_key = dt.strftime("%Y-%m-%d")

                timeline[date_key].append(
                    memory.get("document")
                )

            except Exception:
                pass

    return dict(timeline)