// Durable Object: the port of LdnServer's session handlers and HostedGame.
// One object ("main") holds every session and game, like the C# process.
//
// State:
//  - per socket: Session in serializeAttachment (survives hibernation)
//  - per game:   row in SQLite (NetworkInfo blob + JSON meta), loaded on wake
//  - MAC memory: SQLite table (MacAddressMemory.cs)
//
// Reply order follows the C# handlers. Where C# runs work on Task.Run
// (Disconnect/Close), the order used is the one that thread pool gives in practice.
import { DurableObject } from "cloudflare:workers";
import {
  ConnectPrivateRequest, ConnectRequest, CreateAccessPointPrivateRequest, CreateAccessPointRequest,
  DisconnectMessage, InitializeMessage, NetworkError, NetworkErrorMessage, NetworkInfo, NodeInfo,
  PacketId, PassphraseMessage, PingMessage, ProxyConfig, ProxyConnectRequest, ProxyConnectResponse,
  ProxyDataHeader, ProxyDisconnectMessage, ScanFilterFlag, ScanFilterFull, packet, parsePacket,
  type AddressEntry,
} from "./codec/types.ts";
import type { Struct } from "./codec/struct.ts";
import { BROADCAST, NETWORK_MASK, newDhcp, requestIp, returnIp, type Dhcp } from "./dhcp.ts";

const PING_INTERVAL = 10_000; // LdnServer.InactivityPingFrequency
const GHOST_AGE = 16 * 3600_000; // LdnServer.Scan skips games older than this
const MAC_TTL = 30 * 86400_000;
const BROADCAST_192 = 0xc0a800ff; // 192.168.0.255

interface Session {
  sid: string; // 32 hex chars; also the socket's tag
  console: string;
  mac: string; // 12 hex chars
  ip: number;
  nodeId: number;
  game: string | null;
  init: boolean;
  pass: string;
  wait: number; // ping id we are waiting on, -1 for none
  pingId: number;
}

interface Player {
  sid: string;
  ip: number;
  nodeId: number;
}

interface Game {
  id: string; // lowercase hex of the LDN session id
  info: NetworkInfo;
  owner: string;
  pass: string;
  createdAt: number;
  players: Player[]; // join order
  dhcp: Dhcp;
  closed: boolean; // closed games stay only while players still reference them, like C#
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** StringUtils.ReadUtf8String: bytes up to the first NUL. */
const readUtf8 = (b: Uint8Array) => {
  const end = b.indexOf(0);
  return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
};

/** C# MemoryMarshal.Read throws on short input; the C# server then drops the message. */
const read = <T>(s: Struct<T>, payload: Uint8Array): T | null => (payload.length < s.size ? null : s.decode(payload));

export class Lobby extends DurableObject<Env> {
  private games = new Map<string, Game>();
  private lastMsg = new Map<string, number>();
  private msgCount = 0;
  private countSince = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, info BLOB NOT NULL, meta TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS macs (id TEXT PRIMARY KEY, mac TEXT NOT NULL, at INTEGER NOT NULL);`);
    for (const row of sql.exec<{ id: string; info: ArrayBuffer; meta: string }>("SELECT id, info, meta FROM games")) {
      this.games.set(row.id, { id: row.id, info: NetworkInfo.decode(new Uint8Array(row.info)), ...JSON.parse(row.meta) });
    }
    this.reconcile();
  }

  // ---- plumbing -------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    const s: Session = {
      sid: randomHex(16),
      console: req.headers.get("X-Console-Id") ?? "",
      mac: randomHex(6),
      ip: 0,
      nodeId: 0,
      game: null,
      init: false,
      pass: "",
      wait: -1,
      pingId: 0,
    };
    this.ctx.acceptWebSocket(server, [s.sid]);
    server.serializeAttachment(s);
    this.lastMsg.set(s.sid, Date.now());
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
    const p = typeof msg === "string" ? null : parsePacket(new Uint8Array(msg));
    if (!p) {
      ws.close(1002, "protocol error");
      this.closed(ws);
      return;
    }
    this.msgCount++;
    const s = ws.deserializeAttachment() as Session;
    this.lastMsg.set(s.sid, Date.now());
    this.handle(ws, s, p.type, p.payload);
  }

  async webSocketClose(ws: WebSocket) {
    this.closed(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.closed(ws);
  }

  /** LdnSession.OnDisconnected. Idempotent: a second call finds no game. */
  private closed(ws: WebSocket) {
    const s = ws.deserializeAttachment() as Session | null;
    if (!s) return;
    this.disconnectFromGame(ws, s);
    this.lastMsg.delete(s.sid);
  }

  /** Replaces BackgroundPingTask + LdnSession.Ping. */
  async alarm() {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const s = ws.deserializeAttachment() as Session | null;
      if (!s) continue;
      if (s.wait !== -1) {
        // The last ping was not answered.
        ws.close(1000, "idle");
        this.closed(ws);
      } else if (now - (this.lastMsg.get(s.sid) ?? 0) > PING_INTERVAL) {
        s.wait = s.pingId;
        s.pingId = (s.pingId + 1) & 0xff;
        ws.serializeAttachment(s);
        this.send(ws, PacketId.Ping, PingMessage, { requester: 0, id: s.wait });
      }
    }
    if (now - this.countSince >= 60_000) {
      console.log(`ldn: ${this.msgCount} incoming messages in ${Math.round((now - this.countSince) / 1000)}s, ${sockets.length} sockets`);
      this.msgCount = 0;
      this.countSince = now;
    }
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL);
  }

  /** After a restart, drop players whose sockets are gone and close games whose owner is gone. */
  private reconcile() {
    const live = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Session | null)?.sid));
    for (const g of [...this.games.values()]) {
      for (const p of g.players.filter((p) => !live.has(p.sid))) this.leave(g, p.sid);
      if (!live.has(g.owner)) this.close(g);
      else if (this.games.has(g.id)) this.persist(g);
    }
  }

  private wsOf(sid: string): WebSocket | undefined {
    return this.ctx.getWebSockets(sid)[0];
  }

  private sendRaw(ws: WebSocket | undefined, bytes: Uint8Array) {
    try {
      ws?.send(bytes);
    } catch {
      // socket already closing; its close handler cleans up
    }
  }

  private send<T>(ws: WebSocket | undefined, type: PacketId, s?: Struct<T>, v?: T) {
    this.sendRaw(ws, packet(type, s && v ? s.encode(v) : undefined));
  }

  private error(ws: WebSocket, code: NetworkError) {
    this.send(ws, PacketId.NetworkError, NetworkErrorMessage, { error_code: code });
  }

  private persist(g: Game) {
    const { id, info, ...meta } = g;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO games (id, info, meta) VALUES (?, ?, ?)",
      id,
      NetworkInfo.encode(info).buffer as ArrayBuffer,
      JSON.stringify(meta),
    );
  }

  private drop(g: Game) {
    this.games.delete(g.id);
    this.ctx.storage.sql.exec("DELETE FROM games WHERE id = ?", g.id);
  }

  // ---- dispatch (LdnSession constructor) -----------------------------------

  private handle(ws: WebSocket, s: Session, type: number, payload: Uint8Array) {
    const game = s.game ? this.games.get(s.game) : undefined;
    switch (type) {
      case PacketId.Initialize: return this.initialize(ws, s, payload);
      case PacketId.Passphrase: return this.passphrase(ws, s, payload);
      case PacketId.CreateAccessPoint: {
        const r = read(CreateAccessPointRequest, payload);
        if (!r) return;
        if (s.game || !s.init) return this.error(ws, NetworkError.Unknown);
        return this.createAccessPoint(ws, s, randomHex(16), r, [], payload.subarray(CreateAccessPointRequest.size));
      }
      case PacketId.CreateAccessPointPrivate: {
        const r = read(CreateAccessPointPrivateRequest, payload);
        if (!r) return;
        if (s.game || !s.init) return this.error(ws, NetworkError.Unknown);
        const id = hex(r.security_parameter.session_id);
        return this.createAccessPoint(ws, s, id, r, r.address_list.addresses, payload.subarray(CreateAccessPointPrivateRequest.size));
      }
      case PacketId.Connect: {
        const r = read(ConnectRequest, payload);
        if (!r) return;
        if (!s.init) return this.error(ws, NetworkError.ConnectFailure);
        return this.connectImpl(ws, s, hex(r.network_info.network_id.session_id), r.user_config.user_name, r.local_communication_version);
      }
      case PacketId.ConnectPrivate: {
        const r = read(ConnectPrivateRequest, payload);
        if (!r) return;
        if (!s.init) return this.error(ws, NetworkError.ConnectFailure);
        return this.connectImpl(ws, s, hex(r.security_parameter.session_id), r.user_config.user_name, r.local_communication_version);
      }
      case PacketId.Scan: return this.scan(ws, s, payload);
      case PacketId.Disconnect: {
        if (payload.length < DisconnectMessage.size) return;
        return this.disconnectFromGame(ws, s);
      }
      case PacketId.Ping: {
        const r = read(PingMessage, payload);
        if (r && r.requester === 0 && r.id === s.wait) {
          s.wait = -1;
          ws.serializeAttachment(s);
        }
        return;
      }
      case PacketId.Reject: return game && this.reject(ws, s, game, payload);
      case PacketId.SetAcceptPolicy: {
        if (!game || payload.length < 1 || s.sid !== game.owner) return;
        game.info.ldn.station_accept_policy = payload[0];
        return this.syncNetwork(game);
      }
      case PacketId.SetAdvertiseData: {
        if (!game || s.sid !== game.owner) return;
        game.info.ldn.advertise_data_size = payload.length & 0xffff;
        game.info.ldn.advertise_data = payload.slice(0, 0x180);
        return this.syncNetwork(game);
      }
      case PacketId.ProxyConnect: return game && this.route(s, game, type, payload, ProxyConnectRequest.size);
      case PacketId.ProxyConnectReply: return game && this.route(s, game, type, payload, ProxyConnectResponse.size);
      case PacketId.ProxyData: return game && this.route(s, game, type, payload, ProxyDataHeader.size);
      case PacketId.ProxyDisconnect: return game && this.route(s, game, type, payload, ProxyDisconnectMessage.size);
      // ExternalProxy* (P2P) and everything else: ignored.
    }
  }

  // ---- handlers -------------------------------------------------------------

  /** Handlers/Initialize.cs + MacAddressMemory.TryFind */
  private initialize(ws: WebSocket, s: Session, payload: Uint8Array) {
    if (s.init) return;
    const m = read(InitializeMessage, payload);
    if (!m) return;
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM macs WHERE at < ?", now - MAC_TTL);
    const known = sql.exec<{ mac: string }>("SELECT mac FROM macs WHERE id = ?", hex(m.id)).toArray()[0];
    // Same id + same MAC as a previous session: keep the MAC. Otherwise a fresh one never handed out before.
    let mac = known?.mac === hex(m.mac_address) ? known.mac : "";
    while (!mac) {
      const c = randomHex(6);
      if (!sql.exec("SELECT 1 FROM macs WHERE mac = ?", c).toArray().length) mac = c;
    }
    sql.exec("INSERT OR IGNORE INTO macs (id, mac, at) VALUES (?, ?, ?)", s.sid, mac, now);
    s.mac = mac;
    s.init = true;
    ws.serializeAttachment(s);
    this.send(ws, PacketId.Initialize, InitializeMessage, { id: unhex(s.sid), mac_address: unhex(mac) });
  }

  /** Handlers/Passphrase.cs */
  private passphrase(ws: WebSocket, s: Session, payload: Uint8Array) {
    const m = read(PassphraseMessage, payload);
    if (!m) return;
    const p = readUtf8(m.passphrase);
    s.pass = p === "" || (p.length === 16 && /Ryujinx-[0-9a-f]{8}/.test(p)) ? p : "";
    ws.serializeAttachment(s);
  }

  /** Handlers/CreateAccessPoint.cs AccessPointConfigToNetworkInfo */
  private createAccessPoint(
    ws: WebSocket,
    s: Session,
    id: string,
    r: Pick<ReturnType<typeof CreateAccessPointRequest.decode>, "security_config" | "user_config" | "network_config" | "ryu_network_config">,
    dhcpConfig: AddressEntry[],
    advertise: Uint8Array,
  ) {
    if (advertise.length > 0x180) return; // C# CopyTo throws; the message is dropped
    const nc = r.network_config;
    const info = NetworkInfo.zero();
    info.network_id.intent_id.local_communication_id = nc.intent_id.local_communication_id;
    info.network_id.intent_id.scene_id = nc.intent_id.scene_id;
    info.network_id.session_id = unhex(id);
    info.common.channel = nc.channel;
    info.common.link_level = 3;
    info.common.network_type = 2;
    info.common.mac_address = unhex(s.mac);
    info.common.ssid.length = 32;
    info.common.ssid.name = new TextEncoder().encode("12345678123456781234567812345678");
    info.ldn.security_mode = r.security_config.security_mode;
    info.ldn.node_count_max = nc.node_count_max;
    info.ldn.advertise_data_size = advertise.length;
    info.ldn.advertise_data = advertise.slice();

    const me = NodeInfo.zero();
    me.mac_address = unhex(s.mac);
    me.is_connected = 1;
    me.user_name = r.user_config.user_name;
    me.local_communication_version = nc.local_communication_version;

    // P2P is not supported: treat the host's external proxy as unreachable, as C# does when it cannot reach it.
    if (r.ryu_network_config.external_proxy_port !== 0) this.error(ws, NetworkError.PortUnreachable);

    // LdnServer.CreateGame: an id clash is only allowed to replace the caller's own game.
    const old = this.games.get(id);
    if (old && !old.closed) {
      if (old.owner !== s.sid) return this.error(ws, NetworkError.Unknown);
      this.close(old);
      if (old.players.length) this.games.delete(old.id); // detach; still-joined players keep a dangling game id
    }
    const g: Game = {
      id,
      info,
      owner: s.sid,
      pass: s.pass,
      createdAt: Date.now(),
      players: [],
      dhcp: newDhcp(dhcpConfig),
      closed: false,
    };
    this.games.set(id, g);
    this.join(ws, s, g, me);
  }

  /** Handlers/Connect.cs ConnectImpl */
  private connectImpl(ws: WebSocket, s: Session, id: string, userName: Uint8Array, version: number) {
    const g = this.games.get(id);
    if (!g || g.closed) return this.error(ws, NetworkError.ConnectNotFound);
    const hostVersion = g.info.ldn.nodes[0].local_communication_version;
    if (version > hostVersion) return this.error(ws, NetworkError.VersionTooHigh);
    if (version < hostVersion) return this.error(ws, NetworkError.VersionTooLow);
    const node = NodeInfo.zero();
    node.mac_address = unhex(s.mac);
    node.is_connected = 1;
    node.user_name = userName;
    node.local_communication_version = version & 0xffff;
    if (!this.join(ws, s, g, node)) this.error(ws, NetworkError.TooManyPlayers);
  }

  /** HostedGame.Connect */
  private join(ws: WebSocket, s: Session, g: Game, node: NodeInfo): boolean {
    const ldn = g.info.ldn;
    const nodeId = ldn.nodes.findIndex((n) => n.is_connected === 0);
    if (g.closed || ldn.node_count === ldn.node_count_max || nodeId < 0) return false;

    s.ip = requestIp(g.dhcp, unhex(s.mac));
    this.send(ws, PacketId.ProxyConfig, ProxyConfig, { proxy_ip: s.ip, proxy_subnet_mask: NETWORK_MASK });

    node.ipv4_address = s.ip;
    node.node_id = nodeId;
    ldn.node_count++;
    ldn.nodes[nodeId] = node;
    s.nodeId = nodeId;

    this.syncNetwork(g); // to the players already in the game
    s.game = g.id;
    g.players.push({ sid: s.sid, ip: s.ip, nodeId });
    ws.serializeAttachment(s);
    this.persist(g);
    this.send(ws, PacketId.Connected, NetworkInfo, g.info);
    return true;
  }

  /** LdnServer.Scan + Handlers/Scan.cs (without the 200 ms sleep) */
  private scan(ws: WebSocket, s: Session, payload: Uint8Array) {
    const f = read(ScanFilterFull, payload);
    if (!f) return;
    const flag = f.flag & 0xff;
    const minTime = Date.now() - GHOST_AGE;
    const replies: Uint8Array[] = [];
    for (const g of this.games.values()) {
      if (g.closed || g.pass !== s.pass || g.id === s.game) continue;
      if (g.createdAt < minTime) continue;
      const info = g.info;
      if (info.ldn.station_accept_policy === 1) continue;
      const want = f.network_id.intent_id;
      const have = info.network_id.intent_id;
      if (flag & ScanFilterFlag.LocalCommunicationId && have.local_communication_id !== want.local_communication_id) continue;
      if (flag & ScanFilterFlag.SceneId && have.scene_id !== want.scene_id) continue;
      if (flag & ScanFilterFlag.SessionId && !eq(info.network_id.session_id, f.network_id.session_id)) continue;
      if (flag & ScanFilterFlag.Ssid) {
        const a = info.common.ssid, b = f.ssid;
        if (a.length > 33 || b.length > 33) return; // C# span slice throws: no replies at all
        if (!eq(a.name.subarray(0, a.length), b.name.subarray(0, b.length))) continue;
      }
      if (flag & ScanFilterFlag.NetworkType && info.common.network_type !== (f.network_type & 0xff)) continue;
      if (g.players.length === 0) continue;
      replies.push(packet(PacketId.ScanReply, NetworkInfo.encode(info)));
    }
    for (const r of replies) this.sendRaw(ws, r);
    this.send(ws, PacketId.ScanReplyEnd);
  }

  /** HostedGame.HandleReject */
  private reject(ws: WebSocket, s: Session, g: Game, payload: Uint8Array) {
    if (payload.length < 8) return;
    const nodeId = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
    let target: Player | undefined;
    if (s.sid !== g.owner || nodeId >= g.players.length) {
      this.error(ws, NetworkError.RejectFailed);
    } else {
      target = g.players.find((p) => p.nodeId === nodeId);
      if (target) this.detach(target.sid);
    }
    this.send(ws, PacketId.RejectReply);
    // C# runs the removal on Task.Run, after the reply above is queued.
    if (target) this.leave(g, target.sid);
  }

  /** LdnSession.DisconnectFromGame */
  private disconnectFromGame(ws: WebSocket, s: Session) {
    const g = s.game ? this.games.get(s.game) : undefined;
    if (!s.game) return;
    s.game = null;
    ws.serializeAttachment(s);
    if (!g) return;
    this.leave(g, s.sid);
    if (g.owner === s.sid) this.close(g);
  }

  /** Clears a session's game pointer (HostedGame.Disconnect's synchronous part). */
  private detach(sid: string) {
    const ws = this.wsOf(sid);
    const s = ws?.deserializeAttachment() as Session | undefined;
    if (ws && s) {
      s.game = null;
      ws.serializeAttachment(s);
    }
  }

  /** HostedGame.DisconnectInternal */
  private leave(g: Game, sid: string) {
    const p = g.players.find((x) => x.sid === sid);
    if (!p) return;
    g.players = g.players.filter((x) => x !== p);
    returnIp(g.dhcp, p.ip);
    // RemoveFromInfo: note it only scans the first node_count slots, as in C#.
    const ldn = g.info.ldn;
    const count = ldn.node_count;
    for (let i = 0; i < count; i++) {
      if (ldn.nodes[i].ipv4_address === p.ip) {
        ldn.node_count--;
        ldn.nodes[i].is_connected = 0;
      }
    }
    this.syncNetwork(g);
  }

  /** LdnServer.CloseGame + HostedGame.CloseInternal */
  private close(g: Game) {
    if (!g.closed) {
      g.closed = true;
      const bye = packet(PacketId.Disconnect, DisconnectMessage.encode({ disconnect_ip: 0 }));
      for (const p of g.players) this.sendRaw(this.wsOf(p.sid), bye);
    }
    if (g.players.length === 0) this.drop(g);
    else this.persist(g);
  }

  /** BroadcastNetworkInfoInLock, then persist (every caller has just changed the game). */
  private syncNetwork(g: Game) {
    const msg = packet(PacketId.SyncNetwork, NetworkInfo.encode(g.info));
    for (const p of g.players) this.sendRaw(this.wsOf(p.sid), msg);
    if (g.closed && g.players.length === 0) this.drop(g);
    else this.persist(g);
  }

  /** HostedGame.RouteMessage */
  private route(s: Session, g: Game, type: PacketId, payload: Uint8Array, size: number) {
    if (payload.length < size) return;
    // C# re-encodes the struct; ProxyData keeps the trailing data.
    const msg = packet(type, type === PacketId.ProxyData ? payload : payload.subarray(0, size));
    const dv = new DataView(msg.buffer, 12);
    const src = dv.getUint32(0, true);
    if (src === 0) dv.setUint32(0, s.ip, true); // bound on 0.0.0.0: others see the sender's IP
    else if (src !== s.ip) return; // can't pretend to be somebody else
    let dest = dv.getUint32(6, true);
    if (dest === BROADCAST_192) dest = BROADCAST; // routing only; the packet keeps 192.168.0.255
    if (dest === BROADCAST) {
      for (const p of g.players) this.sendRaw(this.wsOf(p.sid), msg); // includes the sender, as in C#
    } else {
      const p = g.players.find((x) => x.ip === dest);
      if (p) this.sendRaw(this.wsOf(p.sid), msg);
    }
  }
}
