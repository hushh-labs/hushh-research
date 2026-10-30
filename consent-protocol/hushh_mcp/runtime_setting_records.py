"""Import-safe application and security settings records; hydration stays canonical."""

from dataclasses import dataclass


@dataclass(frozen=True)
class CoreSecuritySettings:
    app_signing_key: str
    vault_data_key: str
    google_api_key: str
    google_maps_api_key: str
    environment: str
    agent_id: str
    hushh_hackathon: bool
    default_consent_token_expiry_ms: int
    default_trust_link_expiry_ms: int


@dataclass(frozen=True)
class FirebaseCredentialSettings:
    admin_credentials_json: str


@dataclass(frozen=True)
class AppRuntimeSettings:
    environment: str
    app_frontend_origin: str
    runtime_profile: str = ""
    document_delivery_bucket: str = ""
    document_delivery_bucket_identity: str = ""
