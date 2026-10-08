# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh Research
"""Credential-free validation of declared analytics streams and export membership."""


def validate_expected_streams(
    label: str,
    expected_streams: list[dict],
    streams_by_id: dict[str, dict],
    bigquery_links: list[dict],
) -> list[str]:
    failures: list[str] = []
    for expected_stream in expected_streams:
        stream_id = expected_stream["stream_id"]
        stream = streams_by_id.get(stream_id)
        if not stream:
            failures.append(f"{label}: missing expected stream {stream_id}")
            continue
        expected_type = expected_stream["type"]
        if stream.get("type") != expected_type:
            failures.append(
                f"{label}: stream {stream_id} type is {stream.get('type')} not {expected_type}"
            )
        package_name = expected_stream.get("package_name")
        if (
            package_name
            and stream.get("androidAppStreamData", {}).get("packageName")
            != package_name
        ):
            failures.append(f"{label}: stream {stream_id} Android package mismatch")
        if expected_stream.get("export_required"):
            resource = stream["name"]
            if not any(
                resource in link.get("exportStreams", [])
                and link.get("dailyExportEnabled")
                for link in bigquery_links
            ):
                failures.append(
                    f"{label}: Android stream {stream_id} missing from daily BigQuery export"
                )
        measurement_id = expected_stream.get("measurement_id")
        if measurement_id:
            actual_measurement_id = (
                stream.get("webStreamData", {}).get("measurementId")
                if isinstance(stream.get("webStreamData"), dict)
                else None
            )
            if actual_measurement_id != measurement_id:
                failures.append(
                    f"{label}: stream {stream_id} measurement ID is {actual_measurement_id} not {measurement_id}"
                )
        firebase_app_id = expected_stream.get("firebase_app_id")
        if firebase_app_id:
            stream_data_key = {
                "ANDROID_APP_DATA_STREAM": "androidAppStreamData",
                "IOS_APP_DATA_STREAM": "iosAppStreamData",
                "WEB_DATA_STREAM": "webStreamData",
            }.get(expected_type)
            stream_data = stream.get(stream_data_key) if stream_data_key else None
            actual_firebase_app_id = (
                stream_data.get("firebaseAppId")
                if isinstance(stream_data, dict)
                else None
            )
            if actual_firebase_app_id != firebase_app_id:
                failures.append(
                    f"{label}: stream {stream_id} Firebase app ID is {actual_firebase_app_id} not {firebase_app_id}"
                )

    return failures
