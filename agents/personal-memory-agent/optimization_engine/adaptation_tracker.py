def track_adaptation(reasoning, strategies):

    adaptation_results = []

    for reason in reasoning:

        adaptation_results.append(
            {
                "optimization_signal": reason,
                "adaptation_state": "recursive-improvement-active"
            }
        )

    for strategy in strategies:

        adaptation_results.append(
            {
                "strategy_signal": strategy,
                "adaptation_state": "strategic-refinement-active"
            }
        )

    return adaptation_results