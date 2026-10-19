#!/usr/bin/env bash
# Build the SD-card kit: out/<name>/ laid out as an SD root, plus out/<name>.zip (name: switches).
# Both contain the console's token: they are created mode 600/700 and are gitignored.
#
#   RELAY_HOST=switch-ldn.<subdomain>.workers.dev ./build.sh [name]
#
# The token lives in secrets/<name>.token. If there is none, one is minted and the script prints the
# Worker secret name and the SHA-256 hash to store in Cloudflare (never the token itself).
#
# The sysmodule comes from the pinned ryu_ldn_nx release (RELEASE_TAG / RELEASE_SHA256 below),
# downloaded once into cache/. To use your own build instead:
#   SDKIT_DIST=<dir>    a 'make dist' output dir (an SD tree), used as is
#   SDKIT_REPO=<dir>    a ryu_ldn_nx checkout: uses <dir>/output unless SDKIT_DIST is set, and
#                       checks its Atmosphere-libs version against AMS_TARGET
#
# Vendored inputs, pinned by SHA-256 below. To refresh, re-download, verify, then update the pin:
#   vendor/cacert.pem  https://curl.se/ca/cacert.pem  (must match https://curl.se/ca/cacert.pem.sha256)
#   vendor/emummc.txt  https://nintendohomebrew.com/assets/emummc.txt
#                      (linked from nh-server/switch-guide docs/extras/blocking_nintendo.md)
set -euo pipefail
umask 077

die() { echo "build.sh: $*" >&2; exit 1; }

ID=${1:-switches}
[[ $ID =~ ^[a-z0-9-]{1,32}$ ]] || die "usage: build.sh [name]   (default switches; a-z, 0-9, '-', 1..32 chars)"

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${SDKIT_REPO:-}
DIST=${SDKIT_DIST:-${REPO:+$REPO/output}}   # empty: use the pinned release
TOKEN_FILE=$HERE/secrets/$ID.token
OUT=$HERE/out/$ID

RELAY_HOST=${RELAY_HOST:-}   # your own Worker, e.g. switch-ldn.<subdomain>.workers.dev
[[ $RELAY_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "set RELAY_HOST to your relay host, e.g. RELAY_HOST=switch-ldn.<subdomain>.workers.dev ./build.sh '$ID'"
TID=4200000000000010
CA_SHA256=a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505     # Mozilla certdata 2026-09-25
HOSTS_SHA256=51c031bbde08df34bd8ebc859b9bb8b635cd406d9fb57f83f17b25b88fdc04b1  # Last-Modified 2026-05-15
AMS_TARGET=1.12.1   # the pinned release is built against Atmosphere 1.12.1; must match INSTALL.md
RELEASE_TAG=wss-v2
RELEASE_SHA256=36720de50d703b8e416fd087fb23847e03011a80ca3dd1ec5a7edfc30d407b51   # sha256 of ryu_ldn_nx-release.zip at RELEASE_TAG
RELEASE_URL=https://github.com/ryancircelli/ryu_ldn_nx/releases/download/$RELEASE_TAG/ryu_ldn_nx-release.zip
CA_ROOTS="ISRG Root X1|ISRG Root X2|GTS Root R1|GTS Root R3|GTS Root R4|SSL.com Root Certification Authority RSA|SSL.com Root Certification Authority ECC|SSL.com TLS RSA Root CA 2022|SSL.com TLS ECC Root CA 2022"

# --- inputs -------------------------------------------------------------------
if [[ -z $DIST ]]; then
    [[ $RELEASE_SHA256 =~ ^[0-9a-f]{64}$ ]] || die "RELEASE_SHA256 in build.sh is not pinned yet ('$RELEASE_SHA256').
  Set it to the sha256 of $RELEASE_URL
  (download it and run sha256sum), or build the sysmodule yourself and pass SDKIT_DIST=<its output dir>."
    zip=$HERE/cache/ryu_ldn_nx-$RELEASE_TAG.zip
    mkdir -p "$HERE/cache"
    if [[ ! -f $zip ]]; then
        echo "downloading $RELEASE_URL"
        curl -fsSL --proto '=https' -o "$zip.part" "$RELEASE_URL" || die "download failed: $RELEASE_URL"
        mv -- "$zip.part" "$zip"
    fi
    echo "$RELEASE_SHA256  $zip" | sha256sum -c --quiet - \
        || { rm -f -- "$zip"; die "$zip does not match RELEASE_SHA256 (deleted; re-run to download again)"; }
    DIST=$HERE/cache/$RELEASE_TAG
    rm -rf -- "$DIST"
    mkdir -p "$DIST"
    unzip -q "$zip" -d "$DIST" || die "could not unzip $zip"
fi
[[ -d $DIST ]] || die "sysmodule dist output not found at $DIST.
  Build the overlay, then the sysmodule's 'dist' target
  (make -C ryu_ldn_nx/overlay && make -C ryu_ldn_nx/sysmodule dist), or unset SDKIT_DIST/SDKIT_REPO to use the release."
for f in atmosphere/contents/$TID/exefs.nsp atmosphere/contents/$TID/main.npdm \
         atmosphere/contents/$TID/toolbox.json atmosphere/contents/$TID/flags/boot2.flag \
         switch/.overlays/ryu_ldn_nx_overlay.ovl config/ryu_ldn_nx/gamelist.txt; do
    [[ -f $DIST/$f ]] || die "dist output is incomplete: missing $f (the overlay must be built before 'make dist')"
done

# A source checkout can be checked; the pinned release (or a bare SDKIT_DIST) is trusted to be AMS_TARGET.
ams=$AMS_TARGET
if [[ -n $REPO ]]; then
    hdr=$REPO/sysmodule/Atmosphere-libs/libvapours/include/vapours/ams/ams_api_version.h
    ams=$(awk '/#define ATMOSPHERE_RELEASE_VERSION_(MAJOR|MINOR|MICRO) /{v = v s $3; s = "."} END {print v}' "$hdr")
    [[ $ams == "$AMS_TARGET" ]] || die "Atmosphere-libs is now $ams, not $AMS_TARGET: update AMS_TARGET and INSTALL.md first"
fi

echo "$CA_SHA256  $HERE/vendor/cacert.pem" | sha256sum -c --quiet - || die "vendor/cacert.pem does not match its pinned hash"
echo "$HOSTS_SHA256  $HERE/vendor/emummc.txt" | sha256sum -c --quiet - || die "vendor/emummc.txt does not match its pinned hash"

minted=
if [[ ! -f $TOKEN_FILE ]]; then
    mkdir -p "$HERE/secrets"
    openssl rand -hex 32 > "$TOKEN_FILE"   # umask 077: mode 600
    minted=1
fi
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
; ryu_ldn_nx config. Contains your secret relay token: never share or post this file.
; Lines starting with ; are comments. A commented-out setting shows its default value:
; remove the ; in front of it to change it. Saving settings from the overlay rewrites this
; file without these comments.

[server]
; Your relay's address (your Cloudflare Worker).
host = $RELAY_HOST
; How the Switch talks to the relay: wss = encrypted WebSocket. Without it the relay is not used.
transport = wss
; Your secret token. The relay only lets in Switches that present it.
token = $token
; Relay port. 443 is the standard port for encrypted web traffic.
;port = 443
; Address on the relay that Switches connect to: wss://<host>/ldn.
;path = /ldn
; Certificates used to check that the relay is really yours before the token is sent.
; The kit puts this file here; only change it if you move the file.
;ca_file = sdmc:/config/ryu_ldn_nx/ca.pem

[ldn]
; 1 = games' Local Wireless goes through the relay. 0 = turn the relay off and use
; real Local Wireless only, as if this mod were not installed.
;enabled = 1
; Button(s) to hold while launching a game to use real Local Wireless for that game
; (for playing in the same room). Names: A B X Y L R ZL ZR PLUS MINUS LSTICK RSTICK
; DLEFT DUP DRIGHT DDOWN; combine with +, e.g. ZL+ZR; or none to disable.
; Avoid L and R: Atmosphere uses them at launch (L disables mods/cheats, R opens hbmenu).
;real_wireless_button = ZR
; 1 = all game traffic goes through the relay. 0 = let the host's Switch accept players
; directly; this relay does not support that, so leave it at 1.
;disable_p2p = 1
; Room code: with use_passphrase = 1, you only see rooms created with the same passphrase.
; Format: Ryujinx- followed by 8 characters from 0-9 and a-f, e.g. Ryujinx-1a2b3c4d.
; Your relay is already private to your token, so this is only needed to split rooms.
;use_passphrase = 0
;passphrase =

[debug]
; 1 = write a log to config/ryu_ldn_nx/ryu_ldn_nx.log (turn on while testing).
;enabled = 0
; How much the log says: 0 errors, 1 warnings, 2 normal activity (best for a first
; test), 3 everything.
;level = 1
EOF
hash=$(printf %s "$token" | sha256sum | cut -d' ' -f1)
unset token
chmod 600 "$OUT/config/ryu_ldn_nx/config.ini"

"$HERE/check.sh" "$OUT"

(cd "$OUT" && zip -qrX "../$ID.zip" .)
chmod 600 "$OUT.zip"
echo "built $OUT/ and $OUT.zip (Atmosphere $ams target)"
(cd "$OUT" && sha256sum atmosphere/contents/$TID/exefs.nsp switch/.overlays/ryu_ldn_nx_overlay.ovl)
if [[ -n $minted ]]; then
    secret=TOKEN_${ID^^}
    secret=${secret//-/_}
    cat <<EOF

New token minted in $TOKEN_FILE (keep it; it is only on this machine and in the kit).
Store its hash in your Worker before this console connects:
  secret name: $secret
  sha256:      $hash
  run:         npx wrangler secret put $secret    (paste the sha256 when asked)
or add it in the Cloudflare dashboard under the Worker's Settings > Variables and Secrets.
EOF
fi
