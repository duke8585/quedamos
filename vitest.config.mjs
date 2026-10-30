import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The real worker in the Workers runtime, with a local D1 that gets the migrations applied.
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
          })),
        ],
        test: { name: "api", include: ["test/api.test.js"], setupFiles: ["test/apply-migrations.js"] },
      },
      {
        test: { name: "calendar", include: ["test/calendar.test.js"], environment: "node" },
      },
    ],
  },
});
