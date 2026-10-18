# switch-ldn relay

A Cloudflare Worker and Durable Object that stand in for LdnServer (RyuLDN), so two
Switches running the ryu_ldn_nx fork can play Local Wireless games over `wss://`.
The wire contract with the Switch side is `../CONTRACT.md`; the design is in `../PLAN.md`.

- `src/index.ts`: Worker. It accepts only `GET /ldn` WebSocket upgrades with `X-Console-Id` and
  `Authorization: Bearer <64 hex>`, checks `sha256(token)` against the `TOKEN_<ID>` secret with
  `crypto.subtle.timingSafeEqual`, and answers 404 to everything else.
- `src/lobby.ts`: the `Lobby` Durable Object (one instance, `main`). It is a port of LdnServer's handlers
  and `HostedGame`, built on the hibernation API, with games kept in SQLite.
- `src/codec/`: the packed little-endian structs from `types.hpp`.
- `tools/`: desktop client, end-to-end test, TCP-to-WebSocket bridge, layout dump.

## Deploy

1. Generate one token per console and keep it for that console's `config.ini`:

   ```sh
   openssl rand -hex 32                   # the token: goes on the SD card only
   printf %s "$TOKEN" | sha256sum         # its hash: goes to Cloudflare
   ```

2. Store the **hash** (lowercase hex) as a Worker secret, one per console. The name comes from the
   console id: upper case, with `-` changed to `_`, so `switch-a` becomes `TOKEN_SWITCH_A`:

   ```sh
   npx wrangler secret put TOKEN_SWITCH_A
   npx wrangler secret put TOKEN_SWITCH_B
   ```

   CI (`.github/workflows/deploy.yml`) does the same from the GitHub secrets `TOKEN_SWITCH_A` and
   `TOKEN_SWITCH_B`, so those GitHub secrets must also hold the hashes, not the tokens.

3. `npx wrangler deploy` (or push to `main`). The relay is at `wss://switch-ldn.<subdomain>.workers.dev/ldn`.

To revoke a console, delete its secret (`npx wrangler secret delete TOKEN_SWITCH_B`). The other console is unaffected.

## Local testing

```sh
npm test               # typecheck + vitest in workerd: codec layout/round-trips, auth, lobby, hibernation
npm run test:e2e       # starts wrangler dev with throwaway tokens, runs two desktop clients, stops it
npm run test:e2e -- --url wss://switch-ldn.<subdomain>.workers.dev/ldn   # with LDN_TOKEN_A / LDN_TOKEN_B set
npm run test:e2e -- --tcp 127.0.0.1:30456   # same lobby scenario against a C# LdnServer, for comparison
```

To run the relay by hand, put the hashes in `.dev.vars` (`TOKEN_SWITCH_A=<sha256 hex>`, gitignored) and run `npm run dev`.
Then:

```sh
LDN_TOKEN=<token a> node --experimental-transform-types tools/client.ts host
LDN_TOKEN=<token b> node --experimental-transform-types tools/client.ts join
# Plain-TCP RyuLDN clients (Ryujinx, the sysmodule's tests/integration) through the relay:
LDN_TOKEN=<token a> node --experimental-transform-types tools/tcp-bridge.ts --listen 30456 --url ws://127.0.0.1:8787/ldn
```

The tools need Node 24 or later. Tokens are read from the environment, never from argv.

If `types.hpp` changes, run `tools/dump-layout.sh [path/to/ryu_ldn_nx]` (needs g++) to regenerate
`test/layout/types.json`. The codec test compares every struct size and field offset against that file.

## Free plan

- Each incoming WebSocket message counts as 1/20 of a Durable Object request. The free plan allows
  100,000 requests a day, which is about 2 million incoming messages. Outgoing messages are free.
- Game traffic (ProxyData) dominates. Two consoles at 60 packets a second each make about 430,000
  incoming messages an hour, so a fast real-time game gets about 4.5 hours a day. Turn-based games use far less.
- Limits reset at 00:00 UTC. Past them, calls fail; you are not billed.
- The Lobby logs `ldn: N incoming messages in 60s` about once a minute while consoles are connected.
  Watch it with `npx wrangler tail` during a real session before relying on an estimate.
  Workers Paid ($5 a month) lifts the caps.

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
- Liveness: a Durable Object alarm every 10 s replaces the C# ping loop, with the same rules. A session
  idle for more than 10 s gets `Ping{requester=0}`, and one that has not answered by the next tick is closed.
  After the object wakes from hibernation, every session counts as idle once.
