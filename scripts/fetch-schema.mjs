#!/usr/bin/env node
/**
 * Fetch the Baby Buddy OpenAPI schema into schema/babybuddy.openapi.yml.
 *
 * Two modes:
 *   (default)  Download the schema upstream commits for the pinned version
 *              (github.com/babybuddy/babybuddy@v<VERSION>/openapi-schema.yml). This is the
 *              reliable path: it's the exact, CI-generated schema for the version, and it
 *              works offline-of-the-instance.
 *   --live     Try the running instance at $BABYBUDDY_BASE_URL/api/schema/ with a token.
 *              NOTE: this instance's schema endpoint currently returns HTTP 500 (the
 *              drf-spectacular generator is broken server-side), so --live is expected to
 *              fail until that's fixed; the data API itself is healthy. Use the default.
 *
 * Env (optional, also read from a local .env):
 *   BABYBUDDY_VERSION    pinned version tag without the leading "v" (default: 2.9.2)
 *   BABYBUDDY_BASE_URL   e.g. https://babybuddy.example.com   (for --live)
 *   BABYBUDDY_TOKEN      DRF API token                        (for --live)
 *
 * After fetching, run `npm run gen:api` (or `npm run api:refresh` to do both).
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env — fine */
}

const OUT = "schema/babybuddy.openapi.yml";
const VERSION = process.env.BABYBUDDY_VERSION ?? "2.9.2";
const live = process.argv.includes("--live");

async function fromUpstream() {
  const url = `https://raw.githubusercontent.com/babybuddy/babybuddy/v${VERSION}/openapi-schema.yml`;
  process.stdout.write(`Fetching pinned upstream schema for v${VERSION}…\n  ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status} for v${VERSION}`);
  const text = await res.text();
  if (!text.startsWith("openapi:")) throw new Error("Upstream response did not look like an OpenAPI document");
  return text;
}

async function fromLiveInstance() {
  const base = process.env.BABYBUDDY_BASE_URL;
  const token = process.env.BABYBUDDY_TOKEN;
  if (!base || !token) throw new Error("--live needs BABYBUDDY_BASE_URL and BABYBUDDY_TOKEN (env or .env)");
  const url = `${base.replace(/\/+$/, "")}/api/schema/?format=json`;
  process.stdout.write(`Fetching live schema from instance…\n  ${url}\n`);
  const res = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith("<")) {
    throw new Error(
      `Instance schema endpoint failed (HTTP ${res.status}). This instance's /api/schema/ ` +
        `is broken (drf-spectacular 500s). Drop --live to use the pinned upstream schema.`,
    );
  }
  return text;
}

try {
  const schema = await (live ? fromLiveInstance() : fromUpstream());
  await writeFile(OUT, schema, "utf8");
  process.stdout.write(`✓ Wrote ${OUT} (${schema.length} bytes). Next: npm run gen:api\n`);
} catch (err) {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
