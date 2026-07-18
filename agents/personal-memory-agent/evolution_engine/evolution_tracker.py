def track_evolution(reinforced, decayed):

    evolution_data = []

    for reinforce, decay in zip(reinforced, decayed):

        evolution_data.append(
            {
                "memory": reinforce["memory"],
                "reinforcement_score": reinforce["reinforcement_score"],
                "decay_score": decay["decay_score"],
                "evolution_state": "adaptive"
            }
        )

    return evolution_data