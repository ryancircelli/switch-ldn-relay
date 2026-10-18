# SD-card install kit (switch-a, switch-b)

Build one kit per console, pointing at your own Worker: `RELAY_HOST=switch-ldn.<subdomain>.workers.dev ./build.sh switch-a` (then `switch-b`). Each produces
`out/<id>/` (an SD-card root) and `out/<id>.zip`. Both hold that console's token, so keep
them off shared drives and never copy one console's kit to the other card.
`./check.sh out/<id>` re-checks a kit; `build.sh` runs it automatically.

## Atmosphère version

The sysmodule is built against **Atmosphère 1.12.1**: the `sysmodule/Atmosphere-libs` submodule
is pinned at `cf48d233` ("ams: bump version and add enum version support for 23.0.1", 2026-10-15),
which reports release 1.12.1 and supports firmware up to **23.0.1**. `build.sh` refuses to run if the
submodule moves.

- Run Atmosphère 1.12.1 on both cards: <https://github.com/Atmosphere-NX/Atmosphere/releases/tag/1.12.1>.
  A version mismatch crashes at boot with std::abort 0xFFE on title 4200000000000010; rename
  `atmosphere/contents/4200000000000010` to recover.
- 1.12.1 is also what makes the hosts file work on firmware 23.x (23.0.0 moved DNS to new c-ares
  commands; older Atmosphère silently ignores the hosts file there, so Nintendo is not blocked).

## 1. Delete from the card first

- `atmosphere/contents/4200000000000010/` (the whole folder; ldn_mitm and ryu_ldn_nx share this title ID,
  and old files left inside it survive a copy-over)
- `switch/ldnmitm_config/`
- `switch/.overlays/ldnmitm_config.ovl`
- Any `atmosphere/hosts/emummc_<id>.txt`: Atmosphère prefers it over `emummc.txt`, so the kit's list
  would be ignored. Merge any custom lines into the kit's `emummc.txt` instead.

## 2. Overlay prerequisites

The overlay is built on libultrahand, so Ultrahand is the recommended menu.

- Ultrahand Overlay v2.5.3: <https://github.com/ppkantorski/Ultrahand-Overlay/releases/tag/v2.5.3>.
  Extract `sdout.zip` to the SD root; it bundles nx-ovlloader v2.0.2.
- nx-ovlloader v2.0.2 on its own: <https://github.com/ppkantorski/nx-ovlloader/releases/tag/v2.0.2>
  (v2.0.3 is a pre-release that Ultrahand deliberately does not ship yet).
- Alternative: Tesla Menu v1.2.3 <https://github.com/WerWolv/Tesla-Menu/releases/tag/v1.2.3> with
  WerWolv's nx-ovlloader v1.0.7 <https://github.com/WerWolv/nx-ovlloader/releases/tag/v1.0.7>.
  Both are from 2023 and predate firmware 22; untested with this overlay.

## 3. Copy the kit

Copy the contents of `out/<id>/` (or extract `out/<id>.zip`) to the SD root of **that** console,
merging folders. It contains:

| Path | What |
| --- | --- |
| `atmosphere/contents/4200000000000010/` | ryu_ldn_nx sysmodule (`exefs.nsp`, `main.npdm`, `toolbox.json`, `flags/boot2.flag`) |
| `switch/.overlays/ryu_ldn_nx_overlay.ovl` | overlay |
| `config/ryu_ldn_nx/config.ini` | relay settings, this console's id and token |
| `config/ryu_ldn_nx/ca.pem` | 9 root certificates cut from the Mozilla bundle (see Sources) |
| `config/ryu_ldn_nx/gamelist.txt` | upstream game list |
| `atmosphere/hosts/emummc.txt` | Nintendo block list for emuMMC (replaces any existing one) |

Never put this kit on sysMMC: `emummc.txt` only applies to emuMMC, and sysMMC stays stock.

## 4. Optional: PRODINFO blanking (not in the kit)

A second Nintendo-blocking layer. It is left out of the kit because copying an `exosphere.ini`
would overwrite one you may already have. Add this to `sdmc:/exosphere.ini` by hand:

- File exists: under its `[exosphere]` section, set `blank_prodinfo_emummc=1` (change the
  existing line, which is normally `=0`). Leave every other line alone.
- File missing: create it with exactly these two lines.

  ```ini
  [exosphere]
  blank_prodinfo_emummc=1
  ```

Never set `blank_prodinfo_sysmmc`. Atmosphère's own template says PRODINFO blanking "is not known
to be safe" and is not encouraged, so treat it as optional.

## 5. Verify

- Run the 90DNS Tester homebrew on each console in emuMMC
  (<https://github.com/meganukebmp/Switch_90DNS_tester/releases>): every Nintendo domain should be blocked.
- After a boot, `atmosphere/logs/dns_mitm_startup.log` should say `Selected /hosts/emummc.txt`.
- For first tests, set `[debug] enabled = 1` in `config.ini` (log: `config/ryu_ldn_nx/ryu_ldn_nx.log`),
  check the token never appears in the log, then set it back to 0.

## Sources

| File | Source | SHA-256 |
| --- | --- | --- |
| `ca.pem` (cut from) | <https://curl.se/ca/cacert.pem>, matched against <https://curl.se/ca/cacert.pem.sha256> | `a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505` |
| `emummc.txt` (body) | <https://nintendohomebrew.com/assets/emummc.txt> (Last-Modified 2026-05-15), linked from the NH switch guide's [Blocking Nintendo servers](https://nh-server.github.io/switch-guide/extras/blocking_nintendo/) page | `51c031bbde08df34bd8ebc859b9bb8b635cd406d9fb57f83f17b25b88fdc04b1` |

`ca.pem` holds only the roots Cloudflare issues workers.dev certificates from: ISRG Root X1/X2
(Let's Encrypt), GTS Root R1/R3/R4 (Google Trust Services; R2 is not in Mozilla's set) and four SSL.com
roots (`CA_ROOTS` in `build.sh`). The full bundle cannot be used: it parses to about 328 KB and the
sysmodule refuses CA files over 64 KB. On 2026-10-18 the relay chained through GTS WE1 to GTS Root R4
(certificate expires 2026-12-27). If Cloudflare ever moves to a CA outside this list, the console
shows "TLS: certificate not trusted (ca_file)": add that root to `CA_ROOTS` and rebuild.
