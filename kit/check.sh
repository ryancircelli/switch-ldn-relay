#!/usr/bin/env bash
# Sanity-check a built kit: check.sh out/<name>
# Never prints the token. Exit 0 = all good.
set -euo pipefail
KIT=${1:?usage: check.sh <kit-dir>}
[[ -d $KIT ]] || { echo "FAIL: no such kit dir: $KIT" >&2; exit 1; }

exec python3 -I - "$KIT" <<'PY'
import configparser, fnmatch, os, re, ssl, stat, sys

kit = sys.argv[1]
errors = []
def check(ok, msg):
    if not ok:
        errors.append(msg)

TID = "4200000000000010"
cfg_path = os.path.join(kit, "config/ryu_ldn_nx/config.ini")
ca_path = os.path.join(kit, "config/ryu_ldn_nx/ca.pem")
hosts_path = os.path.join(kit, "atmosphere/hosts/emummc.txt")

# 1. config.ini parses (same rules as the sysmodule: full-line ; or # comments, no inline comments)
host = ""
try:
    c = configparser.ConfigParser(interpolation=None, comment_prefixes=(";", "#"), strict=True)
    with open(cfg_path) as f:
        c.read_file(f)
    s, l = c["server"], c["ldn"]
    host = s.get("host", "")
    check(host != "", "[server] host is empty")
    check(s.get("port", "443") == "443", "[server] port is not 443")
    check(s.get("transport") == "wss", "[server] transport is not wss")
    check(s.get("path", "/ldn") == "/ldn", "[server] path is not /ldn")
    check(re.fullmatch(r"[0-9a-f]{64}", s.get("token", "")) is not None, "[server] token is not 64 lowercase hex characters")
    ca_file = s.get("ca_file", "sdmc:/config/ryu_ldn_nx/ca.pem")  # the sysmodule's default
    check(ca_file.startswith("sdmc:/") and os.path.isfile(os.path.join(kit, ca_file[6:])),
          "[server] ca_file does not point at a file inside the kit")
    check(l.get("disable_p2p", "1") == "1", "[ldn] disable_p2p is not 1")
    check(stat.S_IMODE(os.stat(cfg_path).st_mode) == 0o600, "config.ini is not mode 600")
except Exception as e:  # message names keys/sections only, never values
    errors.append(f"config.ini does not parse: {type(e).__name__}")

# 2. ca.pem parses, and every PEM block was loaded
try:
    with open(ca_path) as f:
        blocks = f.read().count("-----BEGIN CERTIFICATE-----")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cafile=ca_path)
    loaded = ctx.cert_store_stats()["x509_ca"]
    check(blocks > 0 and loaded == blocks, f"ca.pem: {loaded} of {blocks} certificates loaded")
    check(os.path.getsize(ca_path) <= 64 * 1024, "ca.pem is over the sysmodule's 64 KB limit")
except Exception as e:
    errors.append(f"ca.pem does not parse: {e}")

# 3. hosts file: well-formed, nothing Cloudflare, and the relay host is never redirected
try:
    with open(hosts_path) as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            check(len(parts) == 2, f"hosts line {n} is not '<ip> <host>'")
            low = line.lower()
            check("cloudflare" not in low and "workers.dev" not in low, f"hosts line {n} mentions Cloudflare")
            if host and len(parts) == 2:
                check(not fnmatch.fnmatchcase(host.lower(), parts[1].lower()), f"hosts line {n} would redirect the relay host")
except Exception as e:
    errors.append(f"hosts file unreadable: {e}")

# 4. sysmodule contents are exactly ours (no ldn_mitm leftovers) and the overlay is present
cdir = os.path.join(kit, "atmosphere/contents", TID)
found = sorted(os.path.relpath(os.path.join(d, f), cdir) for d, _, fs in os.walk(cdir) for f in fs)
check(found == ["exefs.nsp", "flags/boot2.flag", "main.npdm", "toolbox.json"], f"unexpected {TID} contents: {found}")
check(os.path.isfile(os.path.join(kit, "switch/.overlays/ryu_ldn_nx_overlay.ovl")), "overlay missing")
check(not os.path.exists(os.path.join(kit, "switch/ldnmitm_config")), "kit contains switch/ldnmitm_config")
check(not os.path.exists(os.path.join(kit, "switch/.overlays/ldnmitm_config.ovl")), "kit contains ldnmitm_config.ovl")

if errors:
    print("\n".join("FAIL: " + e for e in errors), file=sys.stderr)
    sys.exit(1)
print(f"check.sh: OK ({kit})")
PY
