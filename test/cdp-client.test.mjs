import assert from "node:assert/strict";
import test from "node:test";

import { CdpSession } from "../src/cdp-client.mjs";

const URL = "ws://127.0.0.1:9223/devtools/page/x";

// 假 WebSocket：构造后下一轮事件循环触发 onopen；对每条命令按 id 立即回包
function fakeWebSocket({ evaluateValue = 42 } = {}) {
  const sent = [];
  class FakeWebSocket {
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(text) {
      const message = JSON.parse(text);
      sent.push(message.method);
      const result = message.method === "Runtime.evaluate" ? { result: { type: "number", value: evaluateValue } } : {};
      setImmediate(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
    }
    close() {
      this.readyState = 3;
    }
  }
  return { FakeWebSocket, sent };
}

test("CdpSession：默认不 enable 任何域，open 后直接 evaluate", async () => {
  const { FakeWebSocket, sent } = fakeWebSocket();
  const session = new CdpSession(URL, { WebSocketImpl: FakeWebSocket });
  await session.open();
  assert.equal(await session.evaluate("6 * 7"), 42);
  session.close();
  assert.deepEqual(sent, ["Runtime.evaluate"]);
});

test("CdpSession：enableDomains 显式指定时在 open 阶段逐个 enable", async () => {
  const { FakeWebSocket, sent } = fakeWebSocket();
  const session = new CdpSession(URL, { WebSocketImpl: FakeWebSocket, enableDomains: ["Runtime", "Page"] });
  await session.open();
  session.close();
  assert.deepEqual(sent.sort(), ["Page.enable", "Runtime.enable"]);
});

test("CdpSession：enableDomains 非法时构造即抛错", () => {
  const { FakeWebSocket } = fakeWebSocket();
  for (const enableDomains of ["Runtime", [""], ["runtime"], ["Runtime.enable"], [1]]) {
    assert.throws(
      () => new CdpSession(URL, { WebSocketImpl: FakeWebSocket, enableDomains }),
      /enableDomains/,
      `enableDomains=${JSON.stringify(enableDomains)}`,
    );
  }
});
