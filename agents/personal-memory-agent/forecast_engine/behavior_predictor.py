def predict_behavior(memories):

    predictions = []

    for memory in memories:

        document = memory.get("document", "")

        if "research" in document.lower():

            predictions.append(
                "Future sessions may become increasingly research-focused."
            )

        if "analytics" in document.lower():

            predictions.append(
                "Analytical workflows are likely to expand."
            )

        if "learning" in document.lower():

            predictions.append(
                "Learning-oriented memory patterns are growing."
            )

    if not predictions:

        predictions.append(
            "Insufficient behavioral history for advanced forecasting."
        )

    return list(set(predictions))