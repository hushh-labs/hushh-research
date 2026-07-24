def generate_forecast(memories):

    forecast_results = []

    total_memories = len(memories)

    if total_memories > 10:

        forecast_results.append(
            "Memory growth is rapidly increasing."
        )

    elif total_memories > 5:

        forecast_results.append(
            "Behavioral memory activity is steadily evolving."
        )

    else:

        forecast_results.append(
            "Memory activity is still in the early learning stage."
        )

    return forecast_results