def detect_intent(user_query: str):

    query = user_query.lower()

    if "productive" in query:
        return "analytics"

    if "summary" in query:
        return "summary"

    return "search"