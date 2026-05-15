from evolution_engine.memory_reinforcer import reinforce_memories
from evolution_engine.memory_decay import decay_memories
from evolution_engine.evolution_tracker import track_evolution


def process_evolution(memories):

    reinforced = reinforce_memories(memories)

    decayed = decay_memories(memories)

    evolution_results = track_evolution(
        reinforced,
        decayed
    )

    return {
        "reinforced_memories": reinforced,
        "decayed_memories": decayed,
        "evolution_tracking": evolution_results
    }