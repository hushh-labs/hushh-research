def reflect_patterns(behavior_data):

    dominant = behavior_data.get("dominant_behavior")

    reflections = []

    if dominant == "research":

        reflections.append(
            "Research activities dominate your memory behavior."
        )

    elif dominant == "coding":

        reflections.append(
            "Coding-oriented sessions appear most frequently."
        )

    elif dominant == "analytics":

        reflections.append(
            "Analytical thinking patterns are strongly visible."
        )

    else:

        reflections.append(
            "Behavioral patterns are gradually forming."
        )

    return reflections