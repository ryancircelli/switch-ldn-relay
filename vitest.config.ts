import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Test token for console "switch-a" is 64 x "a"; the binding holds its SHA-256 hex.
export const TEST_TOKEN = "a".repeat(64);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TOKEN_SWITCH_A: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
          TOKEN_SWITCH_B: "", // an empty secret must never match
          TOKEN_FRIEND: "4ac281b4c9cf420d4641ab1644ce13cfde53b857ff57ac7a7ce8b09d9b52d7b9", // "b" * 63 + "c"
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
