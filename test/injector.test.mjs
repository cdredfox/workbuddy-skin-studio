import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateSavedNative,
  activateSavedSkin,
  applySkin,
  ensureRendererVideos,
  readSavedActiveSkin,
  removeSkin,
  skinStatus,
  uploadRendererVideo,
} from "../src/injector.mjs";

// 假 CDP Session：按表达式特征分流返回值，并记录完整调用序列
class FakeSession {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.calls = [];
    this.closed = false;
  }

  async open() {
    if (this.options.failOpen) throw new Error("connect refused");
  }

  close() {
    this.closed = true;
  }

  async evaluate(expression) {
    this.calls.push(expression);
    if (this.options.failEvaluate) throw new Error("renderer navigated");
    if (this.options.failVideo && expression.includes('objectStore("videos")')) throw new Error("video timed out");
    // rendererVideoSize：读 IndexedDB 里已存视频的字节数
    if (expression.includes('objectStore("videos").get(')) return this.options.storedSize ?? 0;
    // uploadRendererVideo 收尾：返回写入 Blob 的大小
    if (expression.includes("return blob.size")) return this.options.blobSize ?? 0;
    return true;
  }

  chunkPushes() {
    return this.calls.filter((call) => typeof call === "string" && call.includes("push(arr)")).length;
  }

  lastCall() {
    return this.calls.at(-1);
  }
}

// Session 工厂：收集实例，支持按 url 注入失败
function sessionFactory(options = {}, { failUrls = new Set() } = {}) {
  const sessions = [];
  class Session extends FakeSession {
    constructor(url) {
      super(url, failUrls.has(url) ? { failEvaluate: true } : options);
      sessions.push(this);
    }
  }
  return { Session, sessions };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-injector-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const target = (id) => ({ id, webSocketDebuggerUrl: `ws://127.0.0.1:9223/${id}` });

test("uploadRendererVideo：按 4MB 分块，写入大小一致后清理暂存", async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1); // 4MB + 1B → 2 块
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: bytes.length });
  await uploadRendererVideo(session, "demo", bytes);
  assert.equal(session.chunkPushes(), 2);
  assert.ok(session.lastCall().includes("delete window.__wbSkinVideoUpload"));
});

test("uploadRendererVideo：写入大小不符时抛错，且仍清理暂存", async () => {
  const bytes = Buffer.alloc(16, 1);
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: 8 });
  await assert.rejects(uploadRendererVideo(session, "demo", bytes), /大小不符/);
  assert.ok(session.lastCall().includes("delete window.__wbSkinVideoUpload"));
});

test("uploadRendererVideo：优先原生 Uint8Array.fromBase64，带 atob 回退与主线程让出", async () => {
  const bytes = Buffer.alloc(16, 1);
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: bytes.length });
  await uploadRendererVideo(session, "demo", bytes);
  const chunkCall = session.calls.find((call) => typeof call === "string" && call.includes("push(arr)"));
  assert.ok(chunkCall.includes("Uint8Array.fromBase64"));
  assert.ok(chunkCall.includes("atob("));
  assert.ok(chunkCall.includes("setTimeout(resolve, 0)"));
});

test("ensureRendererVideos：渲染进程已有同尺寸视频时跳过上传（stat 判重）", async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, "hero.mp4");
    await writeFile(videoPath, Buffer.alloc(1024, 7));
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    const warnings = await ensureRendererVideos({
      targets: [target("t1")],
      Session,
      entries: [{ kind: "video", id: "demo", videoPath }],
    });
    assert.deepEqual(warnings, []);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].chunkPushes(), 0);
  });
});

test("ensureRendererVideos：尺寸不一致时执行分块上传", async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, "hero.mp4");
    await writeFile(videoPath, Buffer.alloc(1024, 7));
    const { Session, sessions } = sessionFactory({ storedSize: 0, blobSize: 1024 });
    const warnings = await ensureRendererVideos({
      targets: [target("t1")],
      Session,
      entries: [{ kind: "video", id: "demo", videoPath }],
    });
    assert.deepEqual(warnings, []);
    assert.equal(sessions[0].chunkPushes(), 1);
  });
});

test("ensureRendererVideos：单个 target 失败只记警告，不阻塞其余 target", async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, "hero.mp4");
    await writeFile(videoPath, Buffer.alloc(1024, 7));
    const { Session, sessions } = sessionFactory(
      { storedSize: 0, blobSize: 1024 },
      { failUrls: new Set(["ws://127.0.0.1:9223/t1"]) },
    );
    const warnings = await ensureRendererVideos({
      targets: [target("t1"), target("t2")],
      Session,
      entries: [{ kind: "video", id: "demo", videoPath }],
    });
    assert.equal(sessions.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /t1/);
    assert.match(warnings[0], /renderer navigated/);
    assert.equal(sessions[1].chunkPushes(), 1); // 第二个 target 正常上传
  });
});

test("ensureRendererVideos：本地视频文件缺失时降级为警告而非抛错", async () => {
  const { Session, sessions } = sessionFactory();
  const warnings = await ensureRendererVideos({
    targets: [target("t1")],
    Session,
    entries: [{ kind: "video", id: "demo", videoPath: join(tmpdir(), "wss-no-such-file.mp4") }],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /读取内置视频文件失败/);
  assert.equal(sessions.length, 0);
});

test("ensureRendererVideos：无视频主题时不触碰任何 target", async () => {
  const { Session, sessions } = sessionFactory();
  const warnings = await ensureRendererVideos({
    targets: [target("t1")],
    Session,
    entries: [{ kind: "animated", id: "demo" }],
  });
  assert.deepEqual(warnings, []);
  assert.equal(sessions.length, 0);
});

// applySkin 的最小依赖：一个视频主题 + 一个图片主题，临时目录内真实文件
async function withThemes(fn) {
  return withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "hero.png"), png);
    await writeFile(join(dir, "poster.png"), png);
    await writeFile(join(dir, "hero.mp4"), Buffer.alloc(1024, 7));
    const image = { manifest: { id: "img", name: "Img", colors: {} }, heroPath: join(dir, "hero.png"), posterPath: null };
    const video = { manifest: { id: "vid", name: "Vid", colors: {} }, heroPath: join(dir, "hero.mp4"), posterPath: join(dir, "poster.png") };
    return fn({ image, video });
  });
}

test("applySkin：每个 target 一条会话，视频预置与菜单注入复用同一连接", async () => {
  await withThemes(async ({ image, video }) => {
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1"), target("t2")] },
    });
    assert.equal(result.applied, 2);
    assert.deepEqual(result.menuThemes, ["img", "vid"]);
    assert.deepEqual(result.videoWarnings, []);
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.ok(session.calls[0].includes('objectStore("videos").get('));
      assert.ok(session.lastCall().includes("__workbuddySkinTeardown"));
      assert.ok(session.closed);
    }
  });
});

test("applySkin：视频预置失败只记警告，换新连接后照常注入菜单", async () => {
  await withThemes(async ({ image, video }) => {
    let created = 0;
    const sessions = [];
    class Session extends FakeSession {
      constructor(url) {
        // 第一条连接视频阶段失败，其后的连接正常
        super(url, created++ === 0 ? { failVideo: true } : { storedSize: 1024 });
        sessions.push(this);
      }
    }
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    assert.equal(result.videoWarnings.length, 1);
    assert.match(result.videoWarnings[0], /video timed out/);
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].closed);
    assert.ok(sessions[1].lastCall().includes("__workbuddySkinTeardown"));
  });
});

test("removeSkin：先调菜单 teardown 再移除节点，并发处理所有 target", async () => {
  const { Session, sessions } = sessionFactory();
  const result = await removeSkin({
    port: 9223,
    deps: { Session, fetchRendererTargets: async () => [target("t1"), target("t2")] },
  });
  assert.deepEqual(result, { removed: 2 });
  for (const session of sessions) {
    const expression = session.lastCall();
    assert.ok(expression.indexOf("__workbuddySkinTeardown") < expression.indexOf(".remove()"));
  }
});

test("applySkin：CSS 主题资源内联为 data URL，菜单分组为 custom", async () => {
  await withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "logo.png"), png);
    await writeFile(
      join(dir, "skin.css"),
      'a { background: url("./logo.png"); } b { background: url( ./logo.png ); } c { background: url("https://x.test/y.png"); }',
    );
    const cssTheme = {
      manifest: { id: "css-theme", name: "CSS", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("data:image/png;base64"), "应内联 PNG 为 data URL");
    assert.ok(!expression.includes('url("./logo.png")'), "相对引用应全部被重写");
    assert.ok(expression.includes("https://x.test/y.png"), "绝对 URL 应原样保留");
    assert.ok(expression.includes('"group":"custom"'), "CSS 主题应标记为定制主题分组");
    assert.equal(sessions[0].calls.filter((call) => call.includes('objectStore("videos")')).length, 0, "无视频主题不应触碰 IndexedDB");
  });
});

test("applySkin：CSS 主题 manifest.group 为 palette 时前置拼接换色基座，菜单分组透传", async () => {
  await withTempDir(async (dir) => {
    // palette 主题的 skin.css 只是装饰层（签名渐变），基座由 buildPaletteCss 生成
    await writeFile(join(dir, "skin.css"), ".wb-home-route { background-image: linear-gradient(#000, #111) !important; }");
    const paletteTheme = {
      manifest: { id: "focus-night", name: "Focus Night", group: "palette", colors: { accent: "#67E8F9", secondary: "#2563EB", surface: "#090D13", text: "#EDF4FF" } },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: paletteTheme,
      themes: [paletteTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes('"group":"palette"'), "palette 分组应透传进菜单脚本");
    // 基座在前、装饰层在后（后者依赖前者定义的 --wb-surface 与覆盖顺序）
    const baseAt = expression.indexOf("WORKBUDDY_PALETTE:focus-night");
    const decorationAt = expression.indexOf(".wb-home-route { background-image:");
    assert.ok(baseAt >= 0, "注入 CSS 应含生成的配色基座");
    assert.ok(decorationAt > baseAt, "装饰层应拼在基座之后");
    // 基座核心：--cb-* 变量覆盖按 theme.json colors 取色
    assert.ok(expression.includes("--wb-accent: #67E8F9"));
    assert.ok(expression.includes("--cb-bg-primary: var(--wb-surface) !important"));
  });
});

test("applySkin：CSS 主题引用逃逸主题目录的资源时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), 'a { background: url("./../outside.png"); }');
    const cssTheme = {
      manifest: { id: "evil", name: "Evil", colors: {} },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: cssTheme,
        themes: [cssTheme],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /逃逸主题目录/,
    );
  });
});

test("applySkin：CSS 主题引用不支持的资源类型时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), 'a { src: url("./font.exe"); }');
    await writeFile(join(dir, "font.exe"), Buffer.alloc(4, 1));
    const cssTheme = {
      manifest: { id: "bad-asset", name: "Bad", colors: {} },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: cssTheme,
        themes: [cssTheme],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /不支持的资源类型/,
    );
  });
});

test("applySkin：CSS 主题的伴随 JS 透传进菜单脚本，相对资源内联为 data URL", async () => {
  await withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "hero.webp"), png);
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(join(dir, "skin.js"), 'const img = "./hero.webp"; return () => {};');
    const cssTheme = {
      manifest: { id: "css-js", name: "CssJs", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      jsPath: join(dir, "skin.js"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("data:image/webp;base64"), "js 内相对资源应内联为 data URL");
    assert.ok(!expression.includes('"./hero.webp"'), "js 内相对引用应全部被重写");
    assert.ok(expression.includes("runThemeJs"), "菜单脚本应包含伴随 JS 执行逻辑");
  });
});

test("applySkin：伴随 JS 引用逃逸主题目录的资源时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(join(dir, "skin.js"), 'const img = "../outside.webp"; return () => {};');
    const cssTheme = {
      manifest: { id: "evil-js", name: "EvilJs", colors: {} },
      cssPath: join(dir, "skin.css"),
      jsPath: join(dir, "skin.js"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: cssTheme,
        themes: [cssTheme],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /逃逸主题目录/,
    );
  });
});

test("applySkin：伴随 JS 内联音频资源（wav → audio/wav，mp3 → audio/mpeg）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.wav"), Buffer.alloc(8, 2));
    await writeFile(join(dir, "b.mp3"), Buffer.alloc(8, 3));
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(join(dir, "skin.js"), 'const a = new Audio("./a.wav"); const b = new Audio("./b.mp3"); return () => {};');
    const cssTheme = {
      manifest: { id: "qq-like", name: "QQ", colors: {} },
      cssPath: join(dir, "skin.css"),
      jsPath: join(dir, "skin.js"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("data:audio/wav;base64"));
    assert.ok(expression.includes("data:audio/mpeg;base64"));
    assert.ok(!expression.includes('"./a.wav"') && !expression.includes('"./b.mp3"'));
  });
});

test("applySkin：theme.json thumbnail 内联为 data URL 随条目下发（thumb 字段）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "a { color: red; }");
    await writeFile(join(dir, "thumb.webp"), Buffer.from("RIFFxxxxWEBP"));
    const cssTheme = {
      manifest: { id: "css-theme", name: "CSS", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      thumbnailPath: join(dir, "thumb.webp"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    const expected = `"thumb":"data:image/webp;base64,${Buffer.from("RIFFxxxxWEBP").toString("base64")}"`;
    assert.ok(expression.includes(expected), "条目应携带 thumbnail data URL");
  });
});

// ---- 轻量表达式（status / 读取 / 激活）：按 url 分派返回值的 Session ----

function valueSession(valuesByUrl) {
  const sessions = [];
  class Session {
    constructor(url) {
      this.url = url;
      this.calls = [];
      sessions.push(this);
    }
    async open() {}
    close() {
      this.closed = true;
    }
    async evaluate(expression) {
      this.calls.push(expression);
      return valuesByUrl.get(this.url);
    }
  }
  return { Session, sessions };
}

const lightTargets = [target("a"), target("b")];
const fetchLight = async () => lightTargets;

test("skinStatus：逐 target 汇总状态，表达式同时探测 style/menu 节点与主题 id", async () => {
  const { Session, sessions } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", { installed: true, menu: true, themeId: "miku-light" }],
      ["ws://127.0.0.1:9223/b", { installed: false, menu: false, themeId: null }],
    ]),
  );
  const result = await skinStatus({ port: 9223, deps: { fetchRendererTargets: fetchLight, Session } });
  assert.deepEqual(result, [
    { installed: true, menu: true, themeId: "miku-light" },
    { installed: false, menu: false, themeId: null },
  ]);
  assert.equal(sessions.length, 2);
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('getElementById("workbuddy-skin-style")'));
  assert.ok(expression.includes('getElementById("workbuddy-skin-menu")'));
  assert.ok(expression.includes("dataset.workbuddySkin"));
});

test("readSavedActiveSkin：返回第一个非空字符串；全为空/非字符串时返回 null", async () => {
  const { Session } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", ""],
      ["ws://127.0.0.1:9223/b", "custom-xyz"],
    ]),
  );
  const deps = { fetchRendererTargets: fetchLight, Session };
  assert.equal(await readSavedActiveSkin({ port: 9223, deps }), "custom-xyz");

  const empty = valueSession(new Map([["ws://127.0.0.1:9223/a", null], ["ws://127.0.0.1:9223/b", ""]]));
  assert.equal(await readSavedActiveSkin({ port: 9223, deps: { fetchRendererTargets: fetchLight, Session: empty.Session } }), null);
});

test("readSavedActiveSkin：表达式带 try/catch，localStorage 不可用时不打断渲染进程", async () => {
  const { Session, sessions } = valueSession(new Map([["ws://127.0.0.1:9223/a", null]]));
  await readSavedActiveSkin({ port: 9223, deps: { fetchRendererTargets: async () => [target("a")], Session } });
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('localStorage.getItem("workbuddySkinActive")'));
  assert.ok(/try \{[\s\S]*?\} catch \{/.test(expression));
});

test("activateSavedSkin：表达式带 setTheme 兜底，activated 只计成功 target", async () => {
  const { Session, sessions } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", true],
      ["ws://127.0.0.1:9223/b", false], // 菜单脚本缺失（__workbuddySkin 不存在）返回 false
    ]),
  );
  const result = await activateSavedSkin({
    port: 9223,
    id: "custom-xyz",
    fallbackId: "miku-light",
    deps: { fetchRendererTargets: fetchLight, Session },
  });
  assert.deepEqual(result, { activated: 1 });
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('api.applyCustom("custom-xyz")'));
  // 皮肤已被删除时 applyCustom 静默失败，需回落内置主题避免停在无皮肤状态
  assert.ok(expression.includes('api.setTheme("miku-light")'));
});

test("activateSavedNative：表达式按 mode 钉明暗，activated 只计成功 target", async () => {
  const { Session, sessions } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", true],
      ["ws://127.0.0.1:9223/b", true],
    ]),
  );
  const result = await activateSavedNative({ port: 9223, mode: "dark", deps: { fetchRendererTargets: fetchLight, Session } });
  assert.deepEqual(result, { activated: 2 });
  assert.ok(sessions[0].calls[0].includes('api.setNative("dark")'));
});
