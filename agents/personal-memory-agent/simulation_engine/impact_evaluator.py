def evaluate_impact(outcomes):

    impact_results = []

    for outcome in outcomes:

        if "complexity" in outcome.lower():

            impact_results.append(
                {
                    "impact_level": "high",
                    "evaluation": outcome
                }
            )

        else:

            impact_results.append(
                {
                    "impact_level": "moderate",
                    "evaluation": outcome
                }
            )

    return impact_results