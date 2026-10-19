# switch-ldn relay

A relay that lets Nintendo Switch consoles play Local Wireless games with each other over the internet.
It is a Cloudflare Worker with one Durable Object that stands in for LdnServer (RyuLDN). The consoles
run [ryu_ldn_nx](https://github.com/ryancircelli/ryu_ldn_nx), an Atmosphère sysmodule that carries
Local Wireless traffic to the relay over `wss://`.

**Each person runs their own relay.** There is no shared or public server. You deploy this Worker to
your own Cloudflare account (the free plan is enough for a couple of consoles), make a token for
your consoles, and keep it to yourself. Never share a token with other people; the Worker stores
only its SHA-256 hash.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ryancircelli/switch-ldn-relay)

## What you need

- A Cloudflare account (free plan).
- Node.js 22 or later (the desktop tools in `tools/` need 24).
- For the SD-card kits: bash, `openssl`, `curl`, `unzip`, `zip`, `python3`.
- Switches with Atmosphère 1.12.1 on emuMMC. See [kit/INSTALL.md](kit/INSTALL.md).

## 1. Make the tokens and SD-card kits

The kit needs your relay's hostname: `switch-ldn.<subdomain>.workers.dev`, where `<subdomain>` is your
account's workers.dev subdomain (shown in the Cloudflare dashboard under Workers & Pages). If you name
the Worker something other than `switch-ldn`, use that name instead.

```sh
git clone https://github.com/ryancircelli/switch-ldn-relay
cd switch-ldn-relay/kit
RELAY_HOST=switch-ldn.<subdomain>.workers.dev ./build.sh
```

One kit is enough: copy the same `kit/out/switches.zip` to every console you own, any number of them
(a room holds as many players as the game allows, up to 8). Each connection gets its own session and
MAC, so consoles sharing a token never collide.

The first build mints the token in `kit/secrets/switches.token` and prints the Worker secret name
(`TOKEN_SWITCHES`), the token's SHA-256, and the `npx wrangler secret put` command. The **hash** goes
to Cloudflare. The **token** stays in `kit/secrets/` and on your SD cards. Everything under
`kit/secrets/` and `kit/out/` is gitignored.

Optional: `./build.sh <name>` makes a kit with its own token (`secrets/<name>.token`, secret
`TOKEN_<NAME>`, `-` becomes `_`), for example to cut off one console without the others. Names are
`a-z`, `0-9` and `-`, up to 32 characters. The relay accepts any token whose hash matches any
`TOKEN_*` secret; the name is only a label.

## 2. Deploy your relay

**With the button:** click **Deploy to Cloudflare** above. It copies this repository into your GitHub
or GitLab account, creates the Durable Object, and deploys with Workers Builds. When it asks for
`TOKEN_SWITCHES`, paste the hash from step 1. Later pushes to your copy
redeploy it. The included GitHub Actions workflow only runs the tests in your copy, unless you give it
a `CLOUDFLARE_API_TOKEN` (see below).

**With wrangler:**

```sh
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put TOKEN_SWITCHES   # paste the hash from step 1
```

**From GitHub Actions:** `.github/workflows/deploy.yml` runs `npm test` on every push to `main` and
deploys when the repository has these secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`TOKEN_SWITCHES`, which must hold the hash, not the tokens. Without
`CLOUDFLARE_API_TOKEN` it skips the deploy step.

The relay is at `wss://switch-ldn.<subdomain>.workers.dev/ldn`. Every request that is not an
authenticated WebSocket upgrade gets an empty 404, so a 404 in a browser means it is running.

For another token (another kit id), add its secret the same way (`npx wrangler secret put TOKEN_<ID>`).
The GitHub Actions workflow only sets `TOKEN_SWITCHES`; secrets added by hand
stay in place across deploys.

## 3. Install on the consoles

Follow [kit/INSTALL.md](kit/INSTALL.md): what to delete from the card first, the overlay
prerequisites, copying the kit, and how to check that Nintendo's servers are blocked.

## Revoke a token

Delete its secret, e.g. `npx wrangler secret delete TOKEN_SWITCHES`, or remove it in the dashboard under the
Worker's Settings > Variables and Secrets. If GitHub Actions deploys your relay, also delete or replace
the GitHub secret, or the next deploy puts it back. Consoles with other tokens are unaffected; every console using that token is cut off.

To replace a token, delete `kit/secrets/<name>.token`, rebuild the kit, store the new hash, and copy the
new `config/ryu_ldn_nx/config.ini` to each card that used it. Tokens are checked only when a
console connects.

## Free plan

- Each incoming WebSocket message counts as 1/20 of a Durable Object request. The free plan allows
  100,000 requests a day, which is about 2 million incoming messages. Outgoing messages are free.
- Game traffic (ProxyData) dominates. Two consoles at 60 packets a second each make about 430,000
  incoming messages an hour, so a fast real-time game gets about 4.5 hours a day. Turn-based games use far less.
- Limits reset at 00:00 UTC. Past them, calls fail; you are not billed.
- The Lobby logs `ldn: N incoming messages in 60s` about once a minute while consoles are connected.
  Watch it with `npx wrangler tail` during a real session before relying on an estimate.
  Workers Paid ($5 a month) lifts the caps.

## How it works

The wire contract with the Switch side is [docs/CONTRACT.md](docs/CONTRACT.md).

- `src/index.ts`: Worker. It accepts only `GET /ldn` WebSocket upgrades with
  `Authorization: Bearer <64 hex>`, checks `sha256(token)` against every `TOKEN_*` secret with
  `crypto.subtle.timingSafeEqual`, and answers 404 to everything else.
- `src/lobby.ts`: the `Lobby` Durable Object (one instance, `main`). It is a port of
  [LdnServer](https://github.com/Ryujinx/LdnServer)'s handlers and `HostedGame` from C# to TypeScript,
  built on the hibernation API, with games kept in SQLite.
- `src/codec/`: the packed little-endian structs from the sysmodule's `types.hpp`.
- `tools/`: desktop client, end-to-end test, TCP-to-WebSocket bridge, layout dump.
- `kit/`: builds the SD-card kits (`build.sh`, `check.sh`, `INSTALL.md`).

## Local testing

```sh
npm test               # typecheck + vitest in workerd: codec layout/round-trips, auth, lobby, hibernation
npm run test:e2e       # starts wrangler dev with throwaway tokens, runs two desktop clients, stops it
npm run test:e2e -- --url wss://switch-ldn.<subdomain>.workers.dev/ldn   # with LDN_TOKEN_A / LDN_TOKEN_B set
npm run test:e2e -- --tcp 127.0.0.1:30456   # same lobby scenario against a C# LdnServer, for comparison
# Differential: one 40-step session against both servers, every received packet compared in order
LDN_TOKEN_A=.. LDN_TOKEN_B=.. node --experimental-transform-types tools/compare.ts --url ws://127.0.0.1:8787/ldn --tcp 127.0.0.1:30456
```

To run the relay by hand, copy `.dev.vars.example` to `.dev.vars` (gitignored), fill in the hashes
(`TOKEN_SWITCHES=<sha256 hex>`), and run `npm run dev`. Then:

```sh
LDN_TOKEN=<token a> node --experimental-transform-types tools/client.ts host
LDN_TOKEN=<token b> node --experimental-transform-types tools/client.ts join
# Plain-TCP RyuLDN clients (Ryujinx, the sysmodule's tests/integration) through the relay:
LDN_TOKEN=<token a> node --experimental-transform-types tools/tcp-bridge.ts --listen 30456 --url ws://127.0.0.1:8787/ldn
```

The tools need Node 24 or later. Tokens are read from the environment, never from argv.

If `types.hpp` changes, run `tools/dump-layout.sh [path/to/ryu_ldn_nx]` (needs g++) to regenerate
`test/layout/types.json`. The codec test compares every struct size and field offset against that file.

## Where the relay differs from LdnServer

These differences are deliberate. Everything else follows the C# handlers, including reply order.

- Not ported: P2P / ExternalProxy, the ban list and name filter, Redis analytics, and the game list.
  A host that asks for P2P (`external_proxy_port != 0`) gets `NetworkError PortUnreachable` and a relayed
  game, which is what C# does when it cannot reach the port.
- Scan replies without C#'s 200 ms sleep.
- MAC memory works when a client re-presents its previous session id and MAC. In C#, a hex-case mismatch
  means it never matches. The sysmodule always sends a fixed id, so for it every session gets a fresh MAC, as in C#.
- Short or malformed payloads are dropped silently, as in C#. One case differs: a join into a game whose
  node table is full answers `TooManyPlayers`, where C# throws.
- `ConnectPrivate` is accepted at its wire size, 0xBC. C#'s managed struct is 0xC0 (its `NetworkConfig` is
  8-aligned), so C# silently drops a 0xBC `ConnectPrivate` and private-room joins never work there.
- Liveness: a Durable Object alarm every 10 s replaces the C# ping loop, with the same rules. A session
  idle for more than 10 s gets `Ping{requester=0}`, and one that has not answered by the next tick is closed.
  After the object wakes from hibernation, every session counts as idle once.

## License

MIT; see [LICENSE](LICENSE). `src/lobby.ts` is a port of
[LdnServer](https://github.com/Ryujinx/LdnServer) (MIT, Ryujinx Team and Contributors), whose notice is
included in `LICENSE`. `kit/vendor/cacert.pem` is Mozilla's CA bundle as published by curl
(<https://curl.se/docs/caextract.html>), under the Mozilla Public License 2.0; the `ca.pem` in each kit
is cut from it.
