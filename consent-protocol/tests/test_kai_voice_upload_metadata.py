from api.routes.kai.voice import _normalize_audio_upload_metadata


def test_normalize_audio_upload_metadata_strips_codec_suffix() -> None:
    filename, content_type = _normalize_audio_upload_metadata(
        filename="kai-voice.webm",
        content_type="audio/webm;codecs=opus",
    )
    assert filename == "kai-voice.webm"
    assert content_type == "audio/webm"


def test_normalize_audio_upload_metadata_maps_video_webm() -> None:
    filename, content_type = _normalize_audio_upload_metadata(
        filename="recording.webm",
        content_type="video/webm",
    )
    assert filename == "recording.webm"
    assert content_type == "audio/webm"


def test_normalize_audio_upload_metadata_uses_extension_when_content_type_missing() -> None:
    filename, content_type = _normalize_audio_upload_metadata(
        filename="capture.m4a",
        content_type=None,
    )
    assert filename == "capture.m4a"
    assert content_type == "audio/mp4"


def test_normalize_audio_upload_metadata_prefers_mime_hint_when_content_type_is_generic() -> None:
    filename, content_type = _normalize_audio_upload_metadata(
        filename="voice-input",
        content_type="application/octet-stream",
        mime_hint="audio/webm;codecs=opus",
    )
    assert filename == "voice-input.webm"
    assert content_type == "audio/webm"


def test_normalize_audio_upload_metadata_detects_wav_from_bytes_without_extension() -> None:
    wav_header = b"RIFF\x00\x00\x00\x00WAVEfmt "
    filename, content_type = _normalize_audio_upload_metadata(
        filename="voice-input",
        content_type="application/octet-stream",
        audio_bytes=wav_header,
    )
    assert filename == "voice-input.wav"
    assert content_type == "audio/wav"
