from forecast_engine.forecast_generator import generate_forecast
from forecast_engine.trend_forecaster import forecast_trends
from forecast_engine.behavior_predictor import predict_behavior


def process_forecast(memories):

    forecast_data = generate_forecast(memories)

    trend_data = forecast_trends(memories)

    prediction_data = predict_behavior(memories)

    return {
        "forecast_summary": forecast_data,
        "trend_predictions": trend_data,
        "behavior_predictions": prediction_data
    }