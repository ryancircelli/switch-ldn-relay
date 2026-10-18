// Worker: authenticate the WebSocket upgrade, then hand it to the Lobby.
// Anything that is not a valid, authenticated upgrade gets an empty 404.
export { Lobby } from "./lobby.ts";

const notFound = () => new Response(null, { status: 404 });
const CONSOLE_ID = /^[a-z0-9-]{1,32}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when sha256(token) equals the TOKEN_<ID> secret. Never logs the token. */
export async function tokenIsValid(env: Env, consoleId: string, token: string): Promise<boolean> {
  if (!CONSOLE_ID.test(consoleId) || !TOKEN.test(token)) return false;
  const secret = (env as unknown as Record<string, unknown>)["TOKEN_" + consoleId.toUpperCase().replaceAll("-", "_")];
  if (typeof secret !== "string") return false;
  const want = enc.encode(secret.trim().toLowerCase());
  const got = enc.encode(await sha256Hex(token));
  return want.byteLength === got.byteLength && crypto.subtle.timingSafeEqual(want, got);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/ldn" || req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return notFound();
    }
    const consoleId = req.headers.get("X-Console-Id") ?? "";
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!(await tokenIsValid(env, consoleId, token))) return notFound();

    const headers = new Headers(req.headers);
    headers.delete("Authorization"); // the token goes no further than this function
    const lobby = env.LOBBY.get(env.LOBBY.idFromName("main"), { locationHint: "enam" });
    return lobby.fetch(new Request(req.url, { headers }));
  },
} satisfies ExportedHandler<Env>;
