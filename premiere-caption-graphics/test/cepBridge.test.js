import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callCepBridge,
  checkCepBridgeHealth,
  testCepWriteProof,
  probeSourceTextDeep,
  inspectSourceTextRawBytes,
  testRawBytesHelpers,
  CEP_WRITE_PROOF_SENTINEL,
  CEP_SOURCE_TEXT_PROBE_SENTINEL,
} from "../src/ppro/cepBridge.js";

function noopLog() {}

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function fakeJsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// --- callCepBridge ---

test("callCepBridge POSTs the command/payload/requestId as JSON to the /command endpoint", async () => {
  let capturedUrl = null;
  let capturedInit = null;
  await withFetch(
    async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return fakeJsonResponse(200, { ok: true, requestId: "whatever", result: { done: true } });
    },
    async () => {
      const result = await callCepBridge("createTextGraphic", { mogrtPath: "/x.mogrt" }, { log: noopLog });
      assert.equal(result.ok, true);
    }
  );

  assert.equal(capturedUrl, "http://localhost:3010/command");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers["Content-Type"], "application/json");
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.command, "createTextGraphic");
  assert.deepEqual(body.payload, { mogrtPath: "/x.mogrt" });
  assert.equal(typeof body.requestId, "string");
  assert.ok(body.requestId.length > 0);
});

test("callCepBridge returns the CEP bridge's JSON response verbatim on success", async () => {
  await withFetch(
    async () => fakeJsonResponse(200, { ok: true, requestId: "r1", result: { trackItemName: "Clip 01" } }),
    async () => {
      const result = await callCepBridge("createTextGraphic", {}, { log: noopLog });
      assert.deepEqual(result, { ok: true, requestId: "r1", result: { trackItemName: "Clip 01" } });
    }
  );
});

test("callCepBridge reports step:unreachable (not a crash) when fetch itself fails — the bridge isn't running", async () => {
  await withFetch(
    async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3010");
    },
    async () => {
      const result = await callCepBridge("createTextGraphic", {}, { log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "unreachable");
      assert.match(result.error, /CEP bridge unavailable/);
      assert.match(result.error, /ECONNREFUSED/);
    }
  );
});

test("callCepBridge reports step:timeout when the request is aborted", async () => {
  await withFetch(
    async (url, init) => {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
    async () => {
      const result = await callCepBridge("createTextGraphic", {}, { log: noopLog, timeoutMs: 20 });
      assert.equal(result.ok, false);
      assert.equal(result.step, "timeout");
      assert.match(result.error, /did not respond within 20ms/);
    }
  );
});

test("callCepBridge reports step:http when the bridge returns a non-2xx status", async () => {
  await withFetch(
    async () => fakeJsonResponse(500, { ok: false }),
    async () => {
      const result = await callCepBridge("createTextGraphic", {}, { log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "http");
      assert.match(result.error, /HTTP 500/);
    }
  );
});

test("callCepBridge reports step:parse when the response body isn't valid JSON", async () => {
  await withFetch(
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }),
    async () => {
      const result = await callCepBridge("createTextGraphic", {}, { log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "parse");
      assert.match(result.error, /non-JSON response/);
    }
  );
});

// --- checkCepBridgeHealth ---

test("checkCepBridgeHealth returns ok:true plus the bridge's health payload when reachable", async () => {
  await withFetch(
    async (url) => {
      assert.equal(url, "http://localhost:3010/health");
      return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
    },
    async () => {
      const result = await checkCepBridgeHealth();
      assert.equal(result.ok, true);
      assert.equal(result.extendscriptReady, true);
    }
  );
});

test("checkCepBridgeHealth returns ok:false (not a crash) when unreachable", async () => {
  await withFetch(
    async () => {
      throw new Error("connect ECONNREFUSED");
    },
    async () => {
      const result = await checkCepBridgeHealth();
      assert.equal(result.ok, false);
      assert.match(result.error, /ECONNREFUSED/);
    }
  );
});

// --- testCepWriteProof ---

test("testCepWriteProof returns step:mogrt-path without calling fetch at all when no mogrtPath is given", async () => {
  let fetchCalled = false;
  await withFetch(
    async () => {
      fetchCalled = true;
      return fakeJsonResponse(200, { ok: true });
    },
    async () => {
      const result = await testCepWriteProof({ mogrtPath: "", log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "mogrt-path");
    }
  );
  assert.equal(fetchCalled, false);
});

test("testCepWriteProof returns step:bridge-unavailable and never calls /command when the health check fails", async () => {
  const calledUrls = [];
  await withFetch(
    async (url) => {
      calledUrls.push(url);
      throw new Error("connect ECONNREFUSED");
    },
    async () => {
      const result = await testCepWriteProof({ mogrtPath: "/x.mogrt", log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "bridge-unavailable");
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health"]);
});

test("testCepWriteProof calls createTextGraphic with the sentinel/duration defaults and forwards the result; videoTrackIndex is omitted (not hard-coded to 0) when it can't be resolved outside a hosted UXP runtime", async () => {
  const calledUrls = [];
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      calledUrls.push(url);
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: { sourceTextWriteOk: true } });
    },
    async () => {
      const result = await testCepWriteProof({ mogrtPath: "/x.mogrt", log: noopLog });
      assert.equal(result.ok, true);
      assert.equal(result.result.sourceTextWriteOk, true);
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health", "http://localhost:3010/command"]);
  // Outside a hosted UXP runtime (as in this test), resolveTopVideoTrackIndexForCep()
  // can't reach a real project/sequence and returns undefined — the payload must
  // omit videoTrackIndex rather than fabricate a 0, per the fix for the
  // "importMGT() did not appear to add a clip to video track 0" bug.
  assert.deepEqual(capturedPayload, { mogrtPath: "/x.mogrt", text: CEP_WRITE_PROOF_SENTINEL, durationSec: 2 });
});

test("testCepWriteProof forwards an explicit videoTrackIndex verbatim without trying to resolve one", async () => {
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: {} });
    },
    async () => {
      await testCepWriteProof({ mogrtPath: "/x.mogrt", log: noopLog, videoTrackIndex: 12 });
    }
  );
  assert.equal(capturedPayload.videoTrackIndex, 12);
});

// --- probeSourceTextDeep ---

test("probeSourceTextDeep returns step:mogrt-path without calling fetch at all when no mogrtPath is given", async () => {
  let fetchCalled = false;
  await withFetch(
    async () => {
      fetchCalled = true;
      return fakeJsonResponse(200, { ok: true });
    },
    async () => {
      const result = await probeSourceTextDeep({ mogrtPath: "", log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "mogrt-path");
    }
  );
  assert.equal(fetchCalled, false);
});

test("probeSourceTextDeep returns step:bridge-unavailable and never calls /command when the health check fails", async () => {
  const calledUrls = [];
  await withFetch(
    async (url) => {
      calledUrls.push(url);
      throw new Error("connect ECONNREFUSED");
    },
    async () => {
      const result = await probeSourceTextDeep({ mogrtPath: "/x.mogrt", log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "bridge-unavailable");
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health"]);
});

test("probeSourceTextDeep calls probeSourceTextDeep (host command) with the newTextValue default and forwards the result; videoTrackIndex omitted (not hard-coded to 0) when unresolvable", async () => {
  const calledUrls = [];
  let capturedCommand = null;
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      calledUrls.push(url);
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      const body = JSON.parse(init.body);
      capturedCommand = body.command;
      capturedPayload = body.payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: { sourceTextFound: true, getValueRawType: "string" } });
    },
    async () => {
      const result = await probeSourceTextDeep({ mogrtPath: "/x.mogrt", log: noopLog });
      assert.equal(result.ok, true);
      assert.equal(result.result.sourceTextFound, true);
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health", "http://localhost:3010/command"]);
  assert.equal(capturedCommand, "probeSourceTextDeep");
  assert.deepEqual(capturedPayload, { mogrtPath: "/x.mogrt", newTextValue: CEP_SOURCE_TEXT_PROBE_SENTINEL });
});

test("probeSourceTextDeep forwards an explicit videoTrackIndex and newTextValue verbatim", async () => {
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: {} });
    },
    async () => {
      await probeSourceTextDeep({ mogrtPath: "/x.mogrt", log: noopLog, videoTrackIndex: 12, newTextValue: "__CUSTOM__" });
    }
  );
  assert.equal(capturedPayload.videoTrackIndex, 12);
  assert.equal(capturedPayload.newTextValue, "__CUSTOM__");
});

// --- inspectSourceTextRawBytes ---

test("inspectSourceTextRawBytes returns step:mogrt-path without calling fetch at all when no mogrtPath is given", async () => {
  let fetchCalled = false;
  await withFetch(
    async () => {
      fetchCalled = true;
      return fakeJsonResponse(200, { ok: true });
    },
    async () => {
      const result = await inspectSourceTextRawBytes({ mogrtPath: "", log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "mogrt-path");
    }
  );
  assert.equal(fetchCalled, false);
});

test("inspectSourceTextRawBytes returns step:bridge-unavailable and never calls /command when the health check fails", async () => {
  const calledUrls = [];
  await withFetch(
    async (url) => {
      calledUrls.push(url);
      throw new Error("connect ECONNREFUSED");
    },
    async () => {
      const result = await inspectSourceTextRawBytes({ mogrtPath: "/x.mogrt", log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "bridge-unavailable");
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health"]);
});

test("inspectSourceTextRawBytes calls the inspectSourceTextRawBytes host command with just mogrtPath (no text/duration fields) and forwards the result; videoTrackIndex omitted when unresolvable", async () => {
  const calledUrls = [];
  let capturedCommand = null;
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      calledUrls.push(url);
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      const body = JSON.parse(init.body);
      capturedCommand = body.command;
      capturedPayload = body.payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: { rawStringLength: 2 } });
    },
    async () => {
      const result = await inspectSourceTextRawBytes({ mogrtPath: "/x.mogrt", log: noopLog });
      assert.equal(result.ok, true);
      assert.equal(result.result.rawStringLength, 2);
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health", "http://localhost:3010/command"]);
  assert.equal(capturedCommand, "inspectSourceTextRawBytes");
  assert.deepEqual(capturedPayload, { mogrtPath: "/x.mogrt" });
});

test("inspectSourceTextRawBytes forwards an explicit videoTrackIndex verbatim without trying to resolve one", async () => {
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: {} });
    },
    async () => {
      await inspectSourceTextRawBytes({ mogrtPath: "/x.mogrt", log: noopLog, videoTrackIndex: 12 });
    }
  );
  assert.equal(capturedPayload.videoTrackIndex, 12);
});

test("inspectSourceTextRawBytes only includes skipFileSave in the payload when explicitly truthy", async () => {
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: {} });
    },
    async () => {
      await inspectSourceTextRawBytes({ mogrtPath: "/x.mogrt", log: noopLog, skipFileSave: true });
    }
  );
  assert.equal(capturedPayload.skipFileSave, true);
});

test("inspectSourceTextRawBytes omits skipFileSave from the payload when not requested", async () => {
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: {} });
    },
    async () => {
      await inspectSourceTextRawBytes({ mogrtPath: "/x.mogrt", log: noopLog });
    }
  );
  assert.equal("skipFileSave" in capturedPayload, false);
});

// --- testRawBytesHelpers ---

test("testRawBytesHelpers returns step:bridge-unavailable and never calls /command when the health check fails (no mogrtPath required at all)", async () => {
  const calledUrls = [];
  await withFetch(
    async (url) => {
      calledUrls.push(url);
      throw new Error("connect ECONNREFUSED");
    },
    async () => {
      const result = await testRawBytesHelpers({ log: noopLog });
      assert.equal(result.ok, false);
      assert.equal(result.step, "bridge-unavailable");
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health"]);
});

test("testRawBytesHelpers calls the testRawBytesHelpers host command with an empty payload by default and forwards the result", async () => {
  const calledUrls = [];
  let capturedCommand = null;
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      calledUrls.push(url);
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      const body = JSON.parse(init.body);
      capturedCommand = body.command;
      capturedPayload = body.payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: { rawStringLength: 7 } });
    },
    async () => {
      const result = await testRawBytesHelpers({ log: noopLog });
      assert.equal(result.ok, true);
      assert.equal(result.result.rawStringLength, 7);
    }
  );
  assert.deepEqual(calledUrls, ["http://localhost:3010/health", "http://localhost:3010/command"]);
  assert.equal(capturedCommand, "testRawBytesHelpers");
  assert.deepEqual(capturedPayload, {});
});

test("testRawBytesHelpers forwards an explicit testString verbatim", async () => {
  let capturedPayload = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith("/health")) return fakeJsonResponse(200, { ok: true, extendscriptReady: true });
      capturedPayload = JSON.parse(init.body).payload;
      return fakeJsonResponse(200, { ok: true, requestId: "r", result: {} });
    },
    async () => {
      await testRawBytesHelpers({ log: noopLog, testString: "hello" });
    }
  );
  assert.equal(capturedPayload.testString, "hello");
});
