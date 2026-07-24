def simulate_outcomes(scenarios):

    outcomes = []

    for scenario in scenarios:

        if "workload" in scenario.lower():

            outcomes.append(
                "Simulation predicts increased reasoning complexity."
            )

        else:

            outcomes.append(
                "Simulation predicts stable autonomous cognition."
            )

    return outcomes