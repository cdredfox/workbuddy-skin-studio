import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateThemeManifest } from "../src/theme-schema.mjs";

const expectedIds = [
  "bamboo-swordheart",
  "celestial-dancer",
  "cloud-cliff-pines",
  "inkblade-surge",
  "ocean-friends",
  "pine-crane-mist",
  "sea-scroll",
  "sunny-orchard",
];

test("the bundled catalog contains eight loadable themes", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "themes");
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(entries, expectedIds);

  const themes = await Promise.all(entries.map(async (id) => {
    const raw = JSON.parse(await readFile(join(root, id, "theme.json"), "utf8"));
    return validateThemeManifest(raw);
  }));
  assert.deepEqual(themes.map(({ id }) => id), expectedIds);
  assert.ok(themes.every(({ hero }) => hero === "hero.webp"));
  assert.ok(themes.every(({ heroUrl }) => heroUrl.includes("/releases/download/themes-v1.0.0/")));
  assert.ok(themes.every(({ heroSha256 }) => /^[0-9a-f]{64}$/.test(heroSha256)));
  assert.ok(themes.every(({ heroBytes }) => heroBytes < 500_000));
});
