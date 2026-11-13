# Capabilities and availability

[Product](README.md) · [System architecture](../architecture/system.md)

Choose hosting for the experience you need. An existing supported Shared account
continues without provisioning a private cloud. A private deployment does not
by itself establish that every capability has been installed and qualified.

| Capability | Shared | Owner-cloud deployment |
| --- | --- | --- |
| Chat, memory and supported connections | Owner-scoped, with the configured model and consent | Admitted private execution with verified model access |
| Files | Encrypted browser-managed experience where enabled | Encrypted owner storage where installed and qualified |
| Browser | Unavailable | Development-gated; exact image, host and model qualification required |
| Puppy | Unavailable | Owner-approved connection to a trusted computer |
| Software updates | Managed service version | Exact-release approval, recovery and installed-image verification |
| Recorded voice | Depends on configured provider and deployment | GCP requires authorized native model access; Azure remains disabled |
| Managed dedicated hosting | Not a Shared upgrade action | Provisioning remains unavailable outside admitted pilots |

Unknown placement requires a choice. Pending setup resumes the recorded operation;
it must not silently create another deployment or become Shared.

Switching clouds or returning to Shared is not an implicit information migration.
Review storage, recovery and removal consequences first. The
[hosting and lifecycle module](../architecture/modules/hosting.md) explains the boundaries;
[operational acceptance](../operations/acceptance/private-agents.md) records outstanding verification.
