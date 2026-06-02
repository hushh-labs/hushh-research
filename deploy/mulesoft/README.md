# MuleSoft Managed Omni Gateway Connectivity

This folder contains the guarded Hussh-side handoff for MuleSoft Managed Omni Gateway in CloudHub 2.0 Private Spaces.

The scripts default to read-only or dry-run behavior. Live GCP network changes are externally visible infrastructure changes, so run `ACTION=apply` only after the partner CIDR, DNS, and VPN values have been reviewed.

The canonical current-state handoff is [MuleSoft Managed Omni Gateway Private Space Handoff](../../docs/reference/operations/mulesoft-managed-omni-private-space.md).

## Current Defaults

| Environment | Project | Region | Partner VPC | Hussh service subnet | Proxy-only subnet | MuleSoft CIDRs | Hussh ASN |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nonprod` | `hushh-pda-uat` | `us-east5` | `hushh-mulesoft-np-ohio-vpc` | `10.88.0.0/24` | `10.88.1.0/24` | `10.81.0.0/22` | `64520` |
| `prod` | `hushh-pda` | `us-east5` | `hushh-mulesoft-prod-ohio-v2-vpc` | `10.98.0.0/24` | `10.98.1.0/24` | `10.91.0.0/22` | `64521` |

Non-Prod and Prod are aligned to US East Ohio end to end for the MuleSoft private connectivity lane. The earlier Non-Prod `us-central1` foundation remains in GCP but is superseded for partner handoff until cleanup is explicitly approved.
Reserve `10.82.0.0/22` and `10.92.0.0/22` only for future second Private Spaces if MuleSoft explicitly provisions additional spaces. Do not describe those as active CIDRs for the current Non-Prod or Prod Private Space.

## Read-Only Inventory

Run this before sending final CIDRs or applying any infrastructure:

```bash
bash deploy/mulesoft/gcp_private_space_inventory.sh
```

The inventory checks:

- networks, subnets, routes, peerings, addresses, VPNs, routers, and Cloud SQL networking
- Cloud DNS and Serverless VPC Access API status without enabling disabled APIs
- overlap between proposed CIDRs and current GCP ranges
- overlap with MuleSoft disallowed ranges

## MuleSoft Live Verification

After the Anypoint Connected App credentials are available locally, verify the live MuleSoft Private Spaces:

```bash
bash deploy/mulesoft/verify_mulesoft_private_spaces.sh
```

The verifier checks the live MuleSoft Private Space region, status, version, CIDR, internal DNS, VPN remote Hussh IPs, and ASNs. It intentionally fails if Prod is still using `10.82.0.0/22`; the approved Prod target is `10.91.0.0/22`.

## Dry-Run Provisioning

Plan Non-Prod:

```bash
ENV=nonprod ACTION=plan bash deploy/mulesoft/provision_private_space_connectivity.sh
```

Plan Prod:

```bash
ENV=prod ACTION=plan bash deploy/mulesoft/provision_private_space_connectivity.sh
```

## Apply Foundation

Provision the custom VPC, service subnet, proxy-only subnet, Cloud Router, HA VPN gateway shell, private DNS zone, and inbound DNS forwarding policy:

```bash
ENV=nonprod ACTION=apply PHASE=foundation bash deploy/mulesoft/provision_private_space_connectivity.sh
ENV=prod ACTION=apply PHASE=foundation bash deploy/mulesoft/provision_private_space_connectivity.sh
```

This phase does not create VPN tunnels because MuleSoft must first provide peer tunnel values.

## Apply VPN Tunnels

After MuleSoft provides peer details, run with `PHASE=vpn`:

```bash
ENV=nonprod ACTION=apply PHASE=vpn \
  MULESOFT_VPN_IP_0=203.0.113.10 \
  MULESOFT_VPN_IP_1=203.0.113.11 \
  MULESOFT_ASN=64512 \
  HUSSH_BGP_IP_0=169.254.10.1 \
  MULESOFT_BGP_IP_0=169.254.10.2 \
  HUSSH_BGP_IP_1=169.254.11.1 \
  MULESOFT_BGP_IP_1=169.254.11.2 \
  VPN_SHARED_SECRET_0='replace-me' \
  VPN_SHARED_SECRET_1='replace-me' \
  bash deploy/mulesoft/provision_private_space_connectivity.sh
```

Do not commit tunnel secrets, partner peer IPs received under NDA, or generated resolver IPs if the partner marks them confidential.

MuleSoft's downloadable VPN connection guide is the source for `MULESOFT_VPN_IP_*`, `HUSSH_BGP_IP_*`, `MULESOFT_BGP_IP_*`, and `VPN_SHARED_SECRET_*`. Store the downloaded guides under `tmp/mulesoft-vpn-guides/` for local parsing only; do not commit them.

## Private Endpoint

The internal HTTPS endpoint is intentionally not auto-created by the foundation script. It needs a reviewed certificate and backend routing decision:

- private FQDN per environment
- certificate ownership for that FQDN
- exact partner API paths to expose
- Cloud Run ingress posture after public path dependency checks

Until that is approved, MuleSoft should treat internal DNS server IPs as pending until Hussh provisions Cloud DNS inbound forwarding.
