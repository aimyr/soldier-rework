import datetime as dt
import ipaddress
import os
import shutil
import stat
import subprocess

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID

from tools import make_cert


@pytest.fixture
def local_ips(monkeypatch):
    monkeypatch.setattr(make_cert, "local_ipv4", lambda: ["127.0.0.1", "192.168.1.4"])


def _load(path):
    return x509.load_pem_x509_certificate(path.read_bytes())


def test_root_reused_and_leaf_signed_for_localhost_and_all_ips(tmp_path, local_ips):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    reused, ips = make_cert.create_certificates(["172.20.10.2", "::1"], tmp_path, now)
    assert not reused and ips == ["127.0.0.1", "172.20.10.2", "192.168.1.4", "::1"]
    root_bytes = (tmp_path / "root-ca.pem").read_bytes()
    key_bytes = (tmp_path / "root-ca-key.pem").read_bytes()
    root = _load(tmp_path / "root-ca.pem")
    leaf = _load(tmp_path / "cert.pem")
    der_root = x509.load_der_x509_certificate((tmp_path / "root-ca.cer").read_bytes())
    assert der_root.fingerprint(hashes.SHA256()) == root.fingerprint(hashes.SHA256())
    assert root.subject == root.issuer and leaf.issuer == root.subject
    root.public_key().verify(root.signature, root.tbs_certificate_bytes, ec.ECDSA(root.signature_hash_algorithm))
    root.public_key().verify(leaf.signature, leaf.tbs_certificate_bytes, ec.ECDSA(leaf.signature_hash_algorithm))
    key = serialization.load_pem_private_key((tmp_path / "key.pem").read_bytes(), password=None)
    assert leaf.public_key().public_numbers() == key.public_key().public_numbers()

    basic = root.extensions.get_extension_for_class(x509.BasicConstraints)
    usage = root.extensions.get_extension_for_class(x509.KeyUsage)
    assert basic.critical and basic.value.ca and basic.value.path_length == 0
    assert usage.critical and usage.value.key_cert_sign and usage.value.crl_sign
    assert not root.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).critical
    assert not leaf.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    assert list(leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value) == [ExtendedKeyUsageOID.SERVER_AUTH]
    san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert san.get_values_for_type(x509.DNSName) == ["localhost"]
    assert set(san.get_values_for_type(x509.IPAddress)) == {ipaddress.ip_address(ip) for ip in ips}
    assert root.not_valid_before_utc == leaf.not_valid_before_utc == now - dt.timedelta(minutes=5)
    assert root.not_valid_after_utc == now + dt.timedelta(days=365)
    assert leaf.not_valid_after_utc == now + dt.timedelta(days=30)

    reused, _ = make_cert.create_certificates(["192.168.1.9"], tmp_path, now + dt.timedelta(seconds=1))
    assert reused
    assert (tmp_path / "root-ca.pem").read_bytes() == root_bytes
    assert (tmp_path / "root-ca-key.pem").read_bytes() == key_bytes
    renewed_leaf = _load(tmp_path / "cert.pem")
    assert renewed_leaf.serial_number != leaf.serial_number
    assert ipaddress.ip_address("192.168.1.9") in renewed_leaf.extensions.get_extension_for_class(
        x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)


def test_leaf_cannot_outlive_root_and_expired_root_is_replaced(tmp_path, local_ips):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    make_cert.create_certificates([], tmp_path, now)
    first_root = _load(tmp_path / "root-ca.pem")
    reused, _ = make_cert.create_certificates([], tmp_path, now + dt.timedelta(days=360))
    assert reused
    assert _load(tmp_path / "cert.pem").not_valid_after_utc == first_root.not_valid_after_utc
    reused, _ = make_cert.create_certificates([], tmp_path, now + dt.timedelta(days=366))
    assert not reused and _load(tmp_path / "root-ca.pem").serial_number != first_root.serial_number


def test_mismatched_root_key_is_replaced(tmp_path, local_ips):
    make_cert.create_certificates([], tmp_path)
    original = _load(tmp_path / "root-ca.pem")
    unrelated = ec.generate_private_key(ec.SECP256R1())
    (tmp_path / "root-ca-key.pem").write_bytes(unrelated.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    reused, _ = make_cert.create_certificates([], tmp_path)
    assert not reused and _load(tmp_path / "root-ca.pem").serial_number != original.serial_number


def test_invalid_ip_does_not_replace_existing_files(tmp_path, local_ips):
    make_cert.create_certificates([], tmp_path)
    original = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    with pytest.raises(ValueError):
        make_cert.create_certificates(["not-an-address"], tmp_path)
    assert original == {path.name: path.read_bytes() for path in tmp_path.iterdir()}


@pytest.mark.skipif(os.name == "nt", reason="Windows file modes do not implement POSIX permission bits")
def test_private_key_permissions_created_and_repaired(tmp_path, local_ips):
    make_cert.create_certificates([], tmp_path)
    for name in ("key.pem", "root-ca-key.pem"):
        assert stat.S_IMODE((tmp_path / name).stat().st_mode) == 0o600
        (tmp_path / name).chmod(0o644)
    make_cert.create_certificates([], tmp_path)
    for name in ("key.pem", "root-ca-key.pem"):
        assert stat.S_IMODE((tmp_path / name).stat().st_mode) == 0o600


def test_cli_reports_public_certificate_files_without_keys(tmp_path, local_ips, monkeypatch, capsys):
    monkeypatch.setattr(make_cert, "OUT", tmp_path)
    monkeypatch.setattr(make_cert.sys, "argv", ["make_cert.py", "172.20.10.2"])
    make_cert.main()
    message = capsys.readouterr().out
    assert "root-ca.cer" in message and "172.20.10.2" in message
    assert "PRIVATE KEY" not in message
    make_cert.main()
    assert "reused" in capsys.readouterr().out


@pytest.mark.skipif(shutil.which("openssl") is None, reason="OpenSSL CLI unavailable")
def test_openssl_accepts_leaf_for_tls_server(tmp_path, local_ips):
    make_cert.create_certificates([], tmp_path)
    result = subprocess.run(["openssl", "verify", "-purpose", "sslserver", "-CAfile",
                             str(tmp_path / "root-ca.pem"), str(tmp_path / "cert.pem")],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert ": OK" in result.stdout


def test_primary_ip_uses_outbound_route_and_failure_is_optional(monkeypatch):
    class RoutedSocket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def connect(self, address):
            assert address == ("8.8.8.8", 80)

        def getsockname(self):
            return "192.168.1.4", 34567

    monkeypatch.setattr(make_cert.socket, "socket", lambda *args: RoutedSocket())
    assert make_cert.primary_ipv4() == "192.168.1.4"

    def fail(*args):
        raise OSError("no route")

    monkeypatch.setattr(make_cert.socket, "socket", fail)
    assert make_cert.primary_ipv4() is None
