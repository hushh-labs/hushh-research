"""Closed capability-proof validation shared by pinned release tooling.

This module validates synthetic evidence only; it grants no runtime authority.
"""

from __future__ import annotations


def _valid_result(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("ready") is True
        and type(value.get("elapsed_ms")) is int
        and 0 <= value["elapsed_ms"] <= 65_000
        and set(value)
        <= {
            "ready",
            "elapsed_ms",
            "cited_sources",
            "fresh_page_retrieval_claimed",
            "http_receipts",
            "audio_bytes",
            "sample_rate",
            "chunks",
            "synthetic_phrase_verified",
            "dimensions",
            "function_round_trip",
            "input_sample_rate",
            "input_transcription_verified",
            "synthetic_content_verified",
            "streaming_observed",
            "steps",
        }
        and all(
            type(item) is bool
            if key
            in {
                "ready",
                "fresh_page_retrieval_claimed",
                "synthetic_phrase_verified",
                "function_round_trip",
                "input_transcription_verified",
                "synthetic_content_verified",
                "streaming_observed",
            }
            else type(item) is int and 0 <= item <= 10_000_000
            for key, item in value.items()
        )
    )


def _valid_compact_search(value: dict) -> bool:
    return (
        value.get("cited_sources", 0) > 0
        and value.get("fresh_page_retrieval_claimed") is False
        and value.get("synthetic_content_verified") is True
    )


def valid_capabilities(
    proof: object, provider: str, expected: dict, document: dict, *, generation: str
) -> bool:
    if not isinstance(proof, dict) or set(proof) != {
        "schema",
        "provider",
        "config_fingerprint",
        "policy_generation",
        "synthetic_only",
        "capabilities",
        "ready",
        "elapsed_ms",
    }:
        return False
    policy = document["managed_runtime_uat"]
    capabilities = proof["capabilities"]
    return (
        proof["schema"] == "managed_capabilities_probe.v1"
        and proof["provider"] == provider
        and proof["synthetic_only"] is True
        and proof["ready"] is True
        and proof["config_fingerprint"] == expected["config_fingerprint"]
        and proof["policy_generation"] == generation
        and type(proof["elapsed_ms"]) is int
        and 0 <= proof["elapsed_ms"] <= 600_000
        and isinstance(capabilities, dict)
        and set(capabilities) == set(policy["required_capabilities"])
        and all(_valid_result(value) for value in capabilities.values())
        and all(
            capabilities[name].get("synthetic_content_verified") is True
            for name in ("structured_text", "image_input", "pdf_input")
        )
        and capabilities["structured_text"].get("streaming_observed") is True
        and capabilities["public_search"].get("cited_sources", 0) > 0
        and capabilities["public_search"].get("fresh_page_retrieval_claimed") is False
        and (
            "compact_public_search" not in policy["required_capabilities"]
            or _valid_compact_search(capabilities["compact_public_search"])
        )
        and capabilities["public_source"].get("http_receipts") == 1
        and capabilities["location_transcription"].get("synthetic_phrase_verified")
        is True
        and capabilities["location_semantics"].get("steps") == 1
        and capabilities["narration"].get("audio_bytes", 0) > 0
        and capabilities["narration"].get("chunks", 0) > 0
        and capabilities["narration"].get("sample_rate") == 24000
        and capabilities["live_audio"].get("audio_bytes", 0) > 0
        and capabilities["live_audio"].get("sample_rate") == 24000
        and capabilities["live_audio"].get("input_sample_rate") == 16000
        and capabilities["live_audio"].get("function_round_trip") is True
        and capabilities["live_audio"].get("input_transcription_verified") is True
        and capabilities["embeddings"].get("dimensions") == 768
    )
