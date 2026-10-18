# WssClient <-> relay contract (both sides must match)

- URL: `wss://<host>/ldn` (port 443). Locally: `ws://127.0.0.1:8787/ldn` via `wrangler dev`.
- Upgrade request headers: `Upgrade: websocket`, `X-Console-Id: <id>` (lowercase a-z0-9-, 1..32 chars),
  `Authorization: Bearer <64 lowercase hex chars>`.
- Worker stores per console a secret `TOKEN_<ID upper, '-' -> '_'>` = lowercase hex SHA-256 of the token
  (e.g. console `switch-a` -> `TOKEN_SWITCH_A`). Any failure -> HTTP 404, empty body.
- After 101: binary messages only. One message = exactly one RyuLDN packet: 12-byte LdnHeader
  (magic 0x4E444C52, type u8, version u8 = 1, 2 reserved, dataSize i32 at 0x08) + dataSize payload bytes,
  little-endian, layout exactly as `sysmodule/source/protocol/types.hpp` in [ryu_ldn_nx](https://github.com/ryancircelli/ryu_ldn_nx). Text messages, bad magic/version,
  or dataSize != message length - 12 -> relay closes with code 1002.
- WebSocket-level ping/pong is handled by the platform; LDN `Ping` packets are relayed/answered as LdnServer does.
- Relay never echoes tokens; closes the socket with 1000 on Disconnect handling only if LdnServer would.
