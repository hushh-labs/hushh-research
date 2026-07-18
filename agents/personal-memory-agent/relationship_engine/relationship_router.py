from relationship_engine.relationship_mapper import map_relationships
from relationship_engine.context_analyzer import analyze_context
from relationship_engine.memory_linker import link_memories


def process_relationships(memories):

    relationship_data = map_relationships(memories)

    context_data = analyze_context(memories)

    linked_data = link_memories(memories)

    return {
        "relationship_graph": relationship_data,
        "context_analysis": context_data,
        "linked_memories": linked_data
    }
