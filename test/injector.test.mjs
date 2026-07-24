import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { applySkin } from "../src/injector.mjs";
import { validateThemeManifest } from "../src/theme-schema.mjs";

test("applySkin injects only the selected theme and removes the legacy menu", async (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, "..", "themes", "sunny-orchard", "theme.json");
  const manifest = validateThemeManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const temporary = await mkdtemp(join(tmpdir(), "workbuddy-injector-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const heroPath = join(temporary, "hero.webp");
  await writeFile(heroPath, Buffer.from("RIFF....WEBPtest-image"));
  const loadedTheme = { manifest, heroPath, root: dirname(manifestPath) };
  const expressions = [];

  class Session {
    async open() {}
    async evaluate(expression) {
      expressions.push(expression);
      return true;
    }
    close() {}
  }

  const result = await applySkin({
    loadedTheme,
    port: 9223,
    deps: {
      Session,
      waitForRendererTargets: async () => [{
        id: "renderer-1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/renderer-1",
      }],
    },
  });

  assert.deepEqual(result, {
    applied: 1,
    themeId: "sunny-orchard",
    targets: ["renderer-1"],
  });
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /WORKBUDDY_SKIN:sunny-orchard/);
  assert.match(expressions[0], /workbuddy-skin-menu/);
  assert.match(expressions[0], /\.remove\(\)/);
  assert.doesNotMatch(expressions[0], /createElement\("button"\)/);
  assert.doesNotMatch(expressions[0], /createElement\("input"\)/);
});
