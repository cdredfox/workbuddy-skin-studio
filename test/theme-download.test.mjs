import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadTheme, validateThemeManifest } from "../src/theme-schema.mjs";

const hero = Buffer.from("RIFF1234WEBPtest-theme-image");
const digest = createHash("sha256").update(hero).digest("hex");

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "remote-test",
    name: "Remote Test",
    hero: "hero.webp",
    heroUrl: "https://github.com/PaPaPiu/workbuddy-skin-studio/releases/download/themes-v1.0.0/remote-test.webp",
    heroSha256: digest,
    heroBytes: hero.length,
    colors: {
      accent: "#336699",
      secondary: "#997755",
      surface: "#F5F5F5",
      text: "#222222",
    },
    copy: null,
    ...overrides,
  };
}

async function fixture(t, configured = manifest()) {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-theme-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const themeDir = join(root, "theme");
  const cacheRoot = join(root, "cache");
  await mkdir(themeDir);
  await writeFile(join(themeDir, "theme.json"), JSON.stringify(configured));
  return { themeDir, cacheRoot };
}

test("downloads, verifies, and reuses a cached release asset", async (t) => {
  const { themeDir, cacheRoot } = await fixture(t);
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name === "content-length" ? String(hero.length) : null },
      arrayBuffer: async () => hero,
    };
  };

  const first = await loadTheme(themeDir, { cacheRoot, fetchImpl });
  const second = await loadTheme(themeDir, { cacheRoot, fetchImpl });
  assert.equal(requests, 1);
  assert.equal(first.heroPath, second.heroPath);
  assert.deepEqual(await readFile(first.heroPath), hero);
});

test("rejects a release asset with the wrong digest", async (t) => {
  const { themeDir, cacheRoot } = await fixture(t, manifest({
    heroSha256: "0".repeat(64),
  }));
  await assert.rejects(
    loadTheme(themeDir, {
      cacheRoot,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(hero.length) },
        arrayBuffer: async () => hero,
      }),
    }),
    /SHA-256/,
  );
});

test("rejects remote assets outside the project release namespace", () => {
  assert.throws(
    () => validateThemeManifest(manifest({
      heroUrl: "https://example.com/remote-test.webp",
    })),
    /GitHub Release URL/,
  );
});
