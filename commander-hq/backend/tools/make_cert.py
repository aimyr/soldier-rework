"""Create local HTTPS certificates signed by a persistent development root CA.

Usage: python tools/make_cert.py [IP ...]
Import certs/root-ca.cer on the phone and enable trust for that root certificate.
Subsequent server certificates use the same root until it expires or is invalid.
Keep root-ca-key.pem and key.pem private; only the root certificate is imported.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import os
import socket
import sys
from pathlib import Path
from typing import Iterable

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

OUT = Path(__file__).resolve().parents[1] / "certs"


def primary_ipv4() -> str | None:
    """IPv4 address selected by the outbound route; UDP connect sends no packet."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def local_ipv4() -> list[str]:
    ips = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except socket.gaierror:
        pass
    primary = primary_ipv4()
    if primary:
        ips.add(primary)
    return sorted(ips)


def _public_bytes(key) -> bytes:
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def _write_key(path: Path, key: ec.EllipticCurvePrivateKey) -> None:
    # os.open applies 0600 at creation; chmod also repairs an existing file whose
    # mode was made too broad. No private material is written to stdout.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as file:
        if os.name != "nt":
            os.fchmod(file.fileno(), 0o600)
        file.write(key.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


def _load_root(out: Path, now: dt.datetime) -> tuple[ec.EllipticCurvePrivateKey, x509.Certificate] | None:
    try:
        key = serialization.load_pem_private_key((out / "root-ca-key.pem").read_bytes(), password=None)
        cert = x509.load_pem_x509_certificate((out / "root-ca.pem").read_bytes())
        if not isinstance(key, ec.EllipticCurvePrivateKey):
            return None
        public = cert.public_key()
        if not isinstance(public, ec.EllipticCurvePublicKey):
            return None
        if _public_bytes(key.public_key()) != _public_bytes(public) or cert.subject != cert.issuer:
            return None
        if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
            return None
        basic = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
        usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
        if not basic.ca or basic.path_length != 0 or not usage.key_cert_sign or not usage.crl_sign:
            return None
        public.verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm))
        if os.name != "nt":
            (out / "root-ca-key.pem").chmod(0o600)
        return key, cert
    except (FileNotFoundError, ValueError, TypeError, x509.ExtensionNotFound,
            InvalidSignature, UnsupportedAlgorithm):
        return None


def _create_root(now: dt.datetime) -> tuple[ec.EllipticCurvePrivateKey, x509.Certificate]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Soldier Rework Local Root CA")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                    key_encipherment=False, data_encipherment=False,
                                    key_agreement=False, key_cert_sign=True, crl_sign=True,
                                    encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def create_certificates(explicit_ips: Iterable[str] = (), out: Path = OUT,
                        now: dt.datetime | None = None) -> tuple[bool, list[str]]:
    """Return (root_reused, SAN IP addresses) after issuing a local HTTPS leaf."""
    # Validate CLI addresses before touching the existing certificate files.
    ips = sorted({str(ipaddress.ip_address(ip)) for ip in [*local_ipv4(), *explicit_ips]})
    now = now or dt.datetime.now(dt.timezone.utc)
    out.mkdir(parents=True, exist_ok=True)
    root = _load_root(out, now)
    reused = root is not None
    if root is None:
        root = _create_root(now)
        _write_key(out / "root-ca-key.pem", root[0])
        (out / "root-ca.pem").write_bytes(root[1].public_bytes(serialization.Encoding.PEM))
    root_key, root_cert = root
    # DER is the importable iPhone/Android certificate, never a private key.
    (out / "root-ca.cer").write_bytes(root_cert.public_bytes(serialization.Encoding.DER))

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "soldier-rework.local")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(root_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        # A renewed leaf cannot outlive the trusted root that issued it.
        .not_valid_after(min(now + dt.timedelta(days=30), root_cert.not_valid_after_utc))
        .add_extension(x509.SubjectAlternativeName(
            [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]),
            critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                    key_encipherment=False, data_encipherment=False,
                                    key_agreement=False, key_cert_sign=False, crl_sign=False,
                                    encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )
    _write_key(out / "key.pem", key)
    (out / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return reused, ips


def main() -> None:
    try:
        reused, ips = create_certificates(sys.argv[1:], OUT)
    except ValueError as exc:
        raise SystemExit(f"invalid IP address: {exc}") from exc
    print("certificate written to", OUT)
    print("local root CA:", "reused" if reused else "created (import root-ca.cer on your phone)")
    print("certificate IPs:", ", ".join(ips))


if __name__ == "__main__":
    main()
