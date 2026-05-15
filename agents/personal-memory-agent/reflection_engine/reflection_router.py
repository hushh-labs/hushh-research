from reflection_engine.reflection_generator import generate_reflections
from reflection_engine.behavior_analyzer import analyze_behavior
from reflection_engine.pattern_reflector import reflect_patterns


def process_reflections(memories):

    reflections = generate_reflections(memories)

    behavior_data = analyze_behavior(memories)

    pattern_reflections = reflect_patterns(behavior_data)

    return {
        "memory_reflections": reflections,
        "behavior_analysis": behavior_data,
        "pattern_reflections": pattern_reflections
    }