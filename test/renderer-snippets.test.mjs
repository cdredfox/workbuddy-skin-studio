import assert from "node:assert/strict";
import test from "node:test";

import { VIDEO_DB_NAME, VIDEO_DB_STORE } from "../src/constants.mjs";
import { BASE64_DECODE_SNIPPET, IDB_OPEN_SNIPPET, VIDEO_DB_LITERALS } from "../src/renderer-snippets.mjs";

// 把片段包装成可执行函数并取出其中定义的全局函数；externals 用于注入假 indexedDB / 旧内核 Uint8Array
function loadSnippet(snippet, name, externals = {}) {
  const factory = new Function(...Object.keys(externals), `${snippet}; return ${name};`);
  return factory(...Object.values(externals));
}

test("VIDEO_DB_LITERALS：与 constants 同源且已 JSON 转义，可直接拼进 CDP 表达式", () => {
  assert.equal(VIDEO_DB_LITERALS.db, JSON.stringify(VIDEO_DB_NAME));
  assert.equal(VIDEO_DB_LITERALS.store, JSON.stringify(VIDEO_DB_STORE));
});

test("IDB_OPEN_SNIPPET：可被 JS 引擎编译，库名/表名/版本与 constants 同源", () => {
  assert.doesNotThrow(() => new Function(IDB_OPEN_SNIPPET));
  assert.ok(IDB_OPEN_SNIPPET.includes(`indexedDB.open(${JSON.stringify(VIDEO_DB_NAME)}, 1)`));
  assert.ok(IDB_OPEN_SNIPPET.includes(`createObjectStore(${JSON.stringify(VIDEO_DB_STORE)})`));
  // 升级建表 + 成功/失败双兜底缺一不可：少了 onerror，库被阻塞时 Promise 会静默挂起
  for (const hook of ["onupgradeneeded", "onsuccess", "onerror"]) {
    assert.ok(IDB_OPEN_SNIPPET.includes(hook), `缺少 ${hook}`);
  }
});

test("IDB_OPEN_SNIPPET：回放 open→upgrade→success 握手，建表后 resolve 数据库实例", async () => {
  const created = [];
  const request = {};
  const db = { createObjectStore: (name) => created.push(name) };
  const indexedDB = {
    open() {
      queueMicrotask(() => {
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const open = loadSnippet(IDB_OPEN_SNIPPET, "wbSkinIdbOpen", { indexedDB });
  assert.equal(await open(), db);
  assert.deepEqual(created, [VIDEO_DB_STORE]);
});

test("IDB_OPEN_SNIPPET：打开失败时 reject，不静默挂起", async () => {
  const request = {};
  const indexedDB = {
    open() {
      queueMicrotask(() => {
        request.error = new Error("blocked");
        request.onerror?.();
      });
      return request;
    },
  };
  const open = loadSnippet(IDB_OPEN_SNIPPET, "wbSkinIdbOpen", { indexedDB });
  await assert.rejects(open(), /blocked/);
});

test("BASE64_DECODE_SNIPPET：可被 JS 引擎编译，解码结果正确，非法输入抛异常由调用方兜底", () => {
  const decode = loadSnippet(BASE64_DECODE_SNIPPET, "wbSkinDecodeBase64");
  assert.deepEqual([...decode("aGVsbG8=")], [104, 101, 108, 108, 111]);
  assert.ok(decode("AAECAwQ=") instanceof Uint8Array);
  assert.throws(() => decode("!!!not-base64!!!"));
});

test("BASE64_DECODE_SNIPPET：运行时支持 fromBase64 时优先走原生快路径", (t) => {
  if (typeof Uint8Array.fromBase64 !== "function") return t.skip("当前 Node 无 Uint8Array.fromBase64");
  let called = 0;
  class SpyUint8Array extends Uint8Array {
    static fromBase64(b64) {
      called += 1;
      return Uint8Array.fromBase64(b64);
    }
  }
  const decode = loadSnippet(BASE64_DECODE_SNIPPET, "wbSkinDecodeBase64", { Uint8Array: SpyUint8Array });
  assert.deepEqual([...decode("aGVsbG8=")], [104, 101, 108, 108, 111]);
  assert.equal(called, 1);
});

test("BASE64_DECODE_SNIPPET：无 fromBase64 的旧内核回退 atob 循环，结果与快路径一致", () => {
  // 不带 fromBase64 的构造函数模拟旧内核，强制走 atob 分支
  function LegacyUint8Array(length) {
    return new Uint8Array(length);
  }
  assert.equal(typeof LegacyUint8Array.fromBase64, "undefined");
  const decode = loadSnippet(BASE64_DECODE_SNIPPET, "wbSkinDecodeBase64", { Uint8Array: LegacyUint8Array });
  const bytes = decode("AAECAwT/");
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [0, 1, 2, 3, 4, 255]);
});
