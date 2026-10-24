"""Synthetic Cloud identity for route units that inject the model runner."""


def enable_managed_vertex(monkeypatch) -> None:
    """Select real ADC admission without changing generic units' ingress door."""
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "false")
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    for name in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"):
        monkeypatch.delenv(name, raising=False)


def owner_vertex_session(monkeypatch) -> dict:
    """Real owner-cloud topology and app-role session for ADC route proof."""
    for name, value in {
        "HUSSH_POD_MODE": "true",
        "HUSSH_ID": "ha1_processing_fixture",
        "HUSSH_POD_USER_ADC_ENABLED": "true",
        "GOOGLE_CLOUD_PROJECT": "owner-processing-fixture",
        "HUSSH_POD_KMS_KEY": (
            "projects/owner-processing-fixture/locations/global/keyRings/test/cryptoKeys/test"
        ),
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    return {"role": "app", "hushh_id": "ha1_processing_fixture"}
