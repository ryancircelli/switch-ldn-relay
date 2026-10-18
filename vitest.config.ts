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
          TOKEN_SWITCH_B: "",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
