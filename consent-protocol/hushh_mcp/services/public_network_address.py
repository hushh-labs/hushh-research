"""Import-safe public network-address policy shared by outbound adapters."""

import ipaddress


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if not ip.is_global or ip.is_multicast or ip.is_reserved or "%" in address:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        return (
            ip.ipv4_mapped is None
            and ip.sixtofour is None
            and ip.teredo is None
            and ip not in ipaddress.ip_network("64:ff9b::/96")
            and ip not in ipaddress.ip_network("64:ff9b:1::/48")
        )
    return True
