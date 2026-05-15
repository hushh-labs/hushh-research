from timeline_engine.timeline import build_memory_timeline
from timeline_engine.trend_detector import detect_activity_trends
from timeline_engine.activity_mapper import generate_activity_heatmap


def process_timeline(memories):

    timeline = build_memory_timeline(memories)

    trends = detect_activity_trends(memories)

    heatmap = generate_activity_heatmap(memories)

    return {
        "timeline": timeline,
        "trends": trends,
        "heatmap": heatmap
    }