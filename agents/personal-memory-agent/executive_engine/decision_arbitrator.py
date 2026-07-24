def decision_arbitrator(memories):

    arbitration_results = []

    for memory in memories:

        document = memory.get("document", "").lower()

        if "research" in document:

            arbitration_results.append(
                "Research-oriented planning receives higher strategic priority."
            )

        if "forecast" in document:

            arbitration_results.append(
                "Forecast-related reasoning requires executive validation."
            )

    if not arbitration_results:

        arbitration_results.append(
            "Executive arbitration monitoring remains active."
        )

    return list(set(arbitration_results))