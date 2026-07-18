def generate_response(intent, search_results, insights):

    if intent == "analytics":

        return {
            "response": (
                "Based on your stored memories, "
                + "you appear most productive during focused activity periods."
            ),
            "insights": insights
        }

    if intent == "summary":

        combined = " ".join(search_results)

        return {
            "response": (
                "Here is a summary of your recent memory activity:"
            ),
            "summary": combined[:500]
        }

    return {
        "response": "Relevant memories retrieved successfully.",
        "results": search_results
    }