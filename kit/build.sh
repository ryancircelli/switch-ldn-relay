#!/usr/bin/env bash
# Build the SD-card kit for one console: out/<id>/ laid out as an SD root, plus out/<id>.zip.
# Both contain the console's token: they are created mode 600/700 and are gitignored.
#
# Vendored inputs, pinned by SHA-256 below. To refresh, re-download, verify, then update the pin:
#   vendor/cacert.pem  https://curl.se/ca/cacert.pem  (must match https://curl.se/ca/cacert.pem.sha256)
#   vendor/emummc.txt  https://nintendohomebrew.com/assets/emummc.txt
#                      (linked from nh-server/switch-guide docs/extras/blocking_nintendo.md)
set -euo pipefail
umask 077

die() { echo "build.sh: $*" >&2; exit 1; }

ID=${1:-}
[[ $ID =~ ^[a-z0-9-]{1,32}$ ]] || die "usage: build.sh <console-id>   (id: a-z, 0-9, '-', 1..32 chars)"

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
REPO=${SDKIT_REPO:-$ROOT/ryu_ldn_nx-integration}   # branch fork/integration
DIST=${SDKIT_DIST:-$REPO/output}   # override only for testing
TOKEN_FILE=$ROOT/secrets/$ID.token
OUT=$HERE/out/$ID

RELAY_HOST=${RELAY_HOST:-}   # your own Worker, e.g. switch-ldn.<subdomain>.workers.dev
[[ $RELAY_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "set RELAY_HOST to your relay host, e.g. RELAY_HOST=switch-ldn.<subdomain>.workers.dev ./build.sh '$ID'"
TID=4200000000000010
CA_SHA256=a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505     # Mozilla certdata 2026-09-25
HOSTS_SHA256=51c031bbde08df34bd8ebc859b9bb8b635cd406d9fb57f83f17b25b88fdc04b1  # Last-Modified 2026-05-15
AMS_TARGET=1.12.1   # must match INSTALL.md
CA_ROOTS="ISRG Root X1|ISRG Root X2|GTS Root R1|GTS Root R3|GTS Root R4|SSL.com Root Certification Authority RSA|SSL.com Root Certification Authority ECC|SSL.com TLS RSA Root CA 2022|SSL.com TLS ECC Root CA 2022"

# --- inputs -------------------------------------------------------------------
[[ -d $DIST ]] || die "sysmodule dist output not found at $DIST.
  It is produced on branch fork/integration by building the overlay, then the sysmodule's
  'dist' target (make -C ryu_ldn_nx/overlay && make -C ryu_ldn_nx/sysmodule dist). Re-run once it exists."
for f in atmosphere/contents/$TID/exefs.nsp atmosphere/contents/$TID/main.npdm \
         atmosphere/contents/$TID/toolbox.json atmosphere/contents/$TID/flags/boot2.flag \
         switch/.overlays/ryu_ldn_nx_overlay.ovl config/ryu_ldn_nx/gamelist.txt; do
    [[ -f $DIST/$f ]] || die "dist output is incomplete: missing $f (the overlay must be built before 'make dist')"
done

hdr=$REPO/sysmodule/Atmosphere-libs/libvapours/include/vapours/ams/ams_api_version.h
ams=$(awk '/#define ATMOSPHERE_RELEASE_VERSION_(MAJOR|MINOR|MICRO) /{v = v s $3; s = "."} END {print v}' "$hdr")
[[ $ams == "$AMS_TARGET" ]] || die "Atmosphere-libs is now $ams, not $AMS_TARGET: update AMS_TARGET and INSTALL.md first"

echo "$CA_SHA256  $HERE/vendor/cacert.pem" | sha256sum -c --quiet - || die "vendor/cacert.pem does not match its pinned hash"
echo "$HOSTS_SHA256  $HERE/vendor/emummc.txt" | sha256sum -c --quiet - || die "vendor/emummc.txt does not match its pinned hash"

[[ -f $TOKEN_FILE ]] || die "no token file at $TOKEN_FILE"
token=$(<"$TOKEN_FILE")
[[ $token =~ ^[0-9a-f]{64}$ ]] || die "token in $TOKEN_FILE is not 64 lowercase hex characters"

# --- assemble -----------------------------------------------------------------
rm -rf -- "$OUT" "$OUT.zip"
mkdir -p "$OUT/config/ryu_ldn_nx" "$OUT/atmosphere/hosts"
# Only our sysmodule and overlay: config.ini.example is skipped (it still names upstream's server).
cp -r "$DIST/atmosphere/contents" "$OUT/atmosphere/"
cp -r "$DIST/switch" "$OUT/"
cp "$DIST/config/ryu_ldn_nx/gamelist.txt" "$OUT/config/ryu_ldn_nx/"
# Only the roots Cloudflare issues workers.dev certificates from: the full bundle parses to ~328 KB
# and the sysmodule refuses CA files over 64 KB. GTS Root R2 is not in Mozilla's set.
awk -v want="$CA_ROOTS" 'BEGIN { n = split(want, w, "|"); for (i = 1; i <= n; i++) keep[w[i]] = 1 }
    /^-----BEGIN CERTIFICATE-----$/ { on = (name in keep); if (on) { print name; got++ } }
    on { print } /^-----END CERTIFICATE-----$/ { on = 0 } /^=+$/ { name = prev } { prev = $0 }
    END { if (got != n) exit 1 }' "$HERE/vendor/cacert.pem" > "$OUT/config/ryu_ldn_nx/ca.pem" \
    || die "vendor/cacert.pem lacks one of the CA_ROOTS"

{
    echo "# Nintendo block list for emuMMC (dns.mitm). Source: https://nintendohomebrew.com/assets/emummc.txt"
    echo "# sha256 $HOSTS_SHA256, linked from https://nh-server.github.io/switch-guide/extras/blocking_nintendo/"
    cat "$HERE/vendor/emummc.txt"
} > "$OUT/atmosphere/hosts/emummc.txt"

cat > "$OUT/config/ryu_ldn_nx/config.ini" <<EOF
; ryu_ldn_nx config for $ID. Contains this console's secret token: never share or post this file.

[server]
host = $RELAY_HOST
port = 443
transport = wss
path = /ldn
console_id = $ID
token = $token
ca_file = sdmc:/config/ryu_ldn_nx/ca.pem

[ldn]
enabled = 1
disable_p2p = 1
; Hold while launching a game to use real Local Wireless instead of the relay.
; Names: A B X Y L R ZL ZR PLUS MINUS LSTICK RSTICK DLEFT DUP DRIGHT DDOWN, combine with +, or none.
; Avoid L and R: Atmosphere uses them at launch (L disables mods/cheats, R opens hbmenu).
real_wireless_button = ZR

[debug]
; Set enabled = 1 while testing; the log lands in config/ryu_ldn_nx/ryu_ldn_nx.log
enabled = 0
level = 1
EOF
unset token
chmod 600 "$OUT/config/ryu_ldn_nx/config.ini"

"$HERE/check.sh" "$OUT"

(cd "$OUT" && zip -qrX "../$ID.zip" .)
chmod 600 "$OUT.zip"
echo "built $OUT/ and $OUT.zip (Atmosphere $ams target)"
(cd "$OUT" && sha256sum atmosphere/contents/$TID/exefs.nsp switch/.overlays/ryu_ldn_nx_overlay.ovl)
