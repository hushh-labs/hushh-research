# UAT TURN DNS record: mentor review

Status: proposed DNS change; this document does not modify DNS or enable calling.

## Requested record

| Field | Value |
| --- | --- |
| DNS zone | hushh.ai |
| Type | A |
| Host | turn-uat |
| Full hostname | turn-uat.hushh.ai |
| IPv4 address | 104.197.235.130 |
| TTL | Automatic |
| Proxy | DNS only; no HTTP/CDN proxy |

The IPv4 is a reserved Google Cloud regional static address, not a developer's
laptop address. On 17 October 2026, GCP reported it IN_USE by the following VM:

- Project: `hushh-pda-uat`
- Address resource: `hushh-uat-turn`, region `us-central1`
- VM: `hushh-uat-turn`, zone `us-central1-a`

TURN relays WebRTC audio when a direct peer connection cannot be established.
The DNS name permits hostname-validated TLS for restrictive networks.

## Verification requested from mentors

1. Confirm ownership of the public `hushh.ai` zone and approval for this UAT hostname.
2. Independently verify the IP assignment using the read-only command below.
3. Review the single-VM UAT scope, ongoing VM/IP/egress cost, and eventual capacity
   and redundancy requirements before production use.
4. Have the DNS owner add only the record above. Do not replace existing records,
   change nameservers, or expose credentials in this PR.

```bash
gcloud compute addresses describe hushh-uat-turn \
  --project=hushh-pda-uat --region=us-central1 \
  --format='json(name,address,status,users)'
dig +short NS hushh.ai
dig +short A turn-uat.hushh.ai
```

Public nameservers previously resolved to Namecheap BasicDNS. Confirm the current
provider before making the change. At the last session check the hostname did not
resolve; this is not a claim about its state at review time.

## After DNS approval

The operator must verify that public DNS returns the exact reserved address,
issue and validate a trusted TLS certificate, and prove authenticated TURN over
TLS/TCP 443 as well as rejection of invalid credentials. Certificate renewal and
calls across separate devices/networks also require verification.

Intended endpoints, pending that verification:

- `turn:turn-uat.hushh.ai:3478?transport=udp`
- `turns:turn-uat.hushh.ai:443?transport=tcp`

The earlier authenticated UDP relay smoke test passed, but this does not prove
full application calling, trusted TLS, or independent-device compatibility.
Calling code and deployment configuration remain separate from this DNS review.
This PR must not enable the calling flag or be treated as a calling release.

## Rollback

Remove only the newly added `turn-uat` A record if it is incorrect. Keep calling
disabled. Removing DNS does not stop the VM, close its ports, or stop billing;
resource shutdown is a separate operator action. Do not release the static IP
while any DNS record still points to it.

## Related local work

No calling implementation PR was found when this review was prepared. Prior
local commits on `feat/direct-message-audio-calls` are `8064b896a` (calling),
`e965fd90c` (deployment preparation), and `040cc760de` (relay provisioning).
These local commit IDs are context only; this PR does not publish those changes.
