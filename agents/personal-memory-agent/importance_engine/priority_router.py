from importance_engine.importance_calculator import calculate_importance
from importance_engine.recency_analyzer import analyze_recency
from importance_engine.frequency_tracker import track_frequency


def process_priority_memories(memories):

    importance_scores = calculate_importance(memories)

    recent_activity = analyze_recency(memories)

    frequency_data = track_frequency(memories)

    sorted_memories = sorted(
        importance_scores,
        key=lambda x: x["importance_score"],
        reverse=True
    )

    return {
        "priority_memories": sorted_memories[:5],
        "recent_activity": recent_activity,
        "frequency_analysis": frequency_data
    }