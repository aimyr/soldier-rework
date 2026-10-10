"""Create a self-signed TLS certificate so a phone on the same Wi-Fi/hotspot can use
the browser Geolocation API (browsers only allow it on HTTPS or localhost).

Usage:  python tools/make_cert.py [IP ...]   -> backend/certs/cert.pem, key.pem
The certificate lists the given IPs plus every IPv4 address of this laptop, so it
stays valid when the phone connects via the laptop's hotspot/LAN IP.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import socket
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

OUT = Path(__file__).resolve().parents[1] / "certs"


def local_ipv4() -> list[str]:
    ips = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except socket.gaierror:
        pass
    try:  # primary outbound interface (no packet is sent for UDP connect)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(ips)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    ips = sorted(set(local_ipv4()) | set(sys.argv[1:]))
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "squad-c2.local")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.SubjectAlternativeName(
            [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]),
            critical=False)
        .sign(key, hashes.SHA256())
    )
    (OUT / "key.pem").write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (OUT / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print("certificate written to", OUT)
    print("certificate IPs:", ", ".join(ips))


if __name__ == "__main__":
    main()
