import { test } from "node:test";
import assert from "node:assert/strict";

import {
  locateTextComponent,
  locateSourceTextParam,
  computeMidpointTickTime,
  readSourceTextAttempts,
  readSourceTextValueOnly,
  testKeyframeCreation,
  testActionCreation,
  runTransaction,
  readBackSourceText,
  runSourceTextRoundTrip,
  cancelActiveSourceTextRoundTrip,
  cancelActiveReadSourceTextOnly,
  DEFAULT_SENTINEL,
} from "../src/ppro/sourceTextProbe.js";

function noopLog() {}

function neverResolves() {
  return new Promise(() => {});
}

// A fake TickTime-ish stand-in — only ever passed around and compared by
// identity in these tests, never inspected for real TickTime shape.
function fakeTickTime(seconds) {
  return { seconds, isFakeTickTime: true };
}

function fakePpro() {
  return {
    TickTime: {
      createWithSeconds: (seconds) => fakeTickTime(seconds),
    },
  };
}

// Mirrors test/diagnostics.test.js's fakeParam, extended with the
// Source-Text-round-trip-specific methods (createKeyframe,
// createSetValueAction, getValueAtTime) this module actually exercises,
// plus the non-keyframed value-getter surface (getValue, .value, and any
// arbitrary extra methods) readSourceTextValueOnly() probes.
function fakeSourceTextParam({
  displayName = "Source Text",
  isTimeVarying,
  areKeyframesSupported,
  getValueAtTime,
  createKeyframe,
  createSetValueAction,
  getValue,
  value,
  extraMethods = {},
} = {}) {
  return {
    displayName,
    ...(isTimeVarying !== undefined ? { isTimeVarying: () => isTimeVarying } : {}),
    ...(areKeyframesSupported !== undefined ? { areKeyframesSupported: () => areKeyframesSupported } : {}),
    ...(getValueAtTime ? { getValueAtTime } : {}),
    ...(createKeyframe ? { createKeyframe } : {}),
    ...(createSetValueAction ? { createSetValueAction } : {}),
    ...(getValue ? { getValue } : {}),
    ...(value !== undefined ? { value } : {}),
    ...extraMethods,
  };
}

function fakeComponent({ matchName, displayName, params }) {
  return {
    getMatchName: () => matchName,
    getDisplayName: () => displayName,
    getParamCount: () => params.length,
    getParam: (i) => params[i] ?? null,
  };
}

function fakeChain(components) {
  return { getComponentAtIndex: (i) => components[i] ?? null };
}

function fakeTrackItem({ inPoint, startTime, duration, chain } = {}) {
  return {
    getInPoint: () => inPoint ?? fakeTickTime(0),
    getStartTime: () => startTime ?? fakeTickTime(0),
    getDuration: () => duration ?? fakeTickTime(0),
    getComponentChain: () => chain ?? fakeChain([]),
  };
}

// --- locateTextComponent ---

test("locateTextComponent finds the AE.ADBE Text component among intrinsic ones and returns the full discovered list", async () => {
  const textComponent = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [] });
  const chain = fakeChain([
    fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] }),
    textComponent,
  ]);
  const { textInfo, discoveredComponents } = await locateTextComponent(chain, noopLog);
  assert.ok(textInfo);
  assert.equal(textInfo.componentIndex, 1);
  assert.equal(textInfo.matchName, "AE.ADBE Text");
  assert.equal(discoveredComponents.length, 2);
});

test("locateTextComponent returns textInfo:null when no AE.ADBE Text component exists on the chain", async () => {
  const chain = fakeChain([fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] })]);
  const { textInfo } = await locateTextComponent(chain, noopLog);
  assert.equal(textInfo, null);
});

// --- locateSourceTextParam ---

test("locateSourceTextParam finds the param by displayName === \"Source Text\", regardless of which index it's at", async () => {
  const params = [
    fakeSourceTextParam({ displayName: "Some Other Param" }),
    fakeSourceTextParam({ displayName: "Source Text" }),
    fakeSourceTextParam({ displayName: "Yet Another" }),
  ];
  const component = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params });
  const located = await locateSourceTextParam(component, 3, noopLog);
  assert.ok(located);
  assert.equal(located.paramIndex, 1);
  assert.equal(located.displayName, "Source Text");
  assert.equal(located.param, params[1]);
});

test("locateSourceTextParam matches displayName case-insensitively and trims whitespace", async () => {
  const params = [fakeSourceTextParam({ displayName: "  source text  " })];
  const component = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params });
  const located = await locateSourceTextParam(component, 0, noopLog);
  assert.ok(located);
  assert.equal(located.paramIndex, 0);
});

test("locateSourceTextParam returns null when no param has that exact displayName", async () => {
  const params = [fakeSourceTextParam({ displayName: "Position" }), fakeSourceTextParam({ displayName: "Scale" })];
  const component = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params });
  const located = await locateSourceTextParam(component, 0, noopLog);
  assert.equal(located, null);
});

test("locateSourceTextParam does NOT rely on a fixed param index — the same lookup finds Source Text whether it's param 0 or param 5", async () => {
  const atZero = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [fakeSourceTextParam({ displayName: "Source Text" })] });
  const atFive = fakeComponent({
    matchName: "AE.ADBE Text",
    displayName: "Text",
    params: [
      fakeSourceTextParam({ displayName: "A" }),
      fakeSourceTextParam({ displayName: "B" }),
      fakeSourceTextParam({ displayName: "C" }),
      fakeSourceTextParam({ displayName: "D" }),
      fakeSourceTextParam({ displayName: "E" }),
      fakeSourceTextParam({ displayName: "Source Text" }),
    ],
  });
  assert.equal((await locateSourceTextParam(atZero, 3, noopLog)).paramIndex, 0);
  assert.equal((await locateSourceTextParam(atFive, 3, noopLog)).paramIndex, 5);
});

// --- computeMidpointTickTime ---

test("computeMidpointTickTime derives a midpoint from getInPoint() + getDuration()/2", async () => {
  const trackItem = fakeTrackItem({ inPoint: fakeTickTime(10), duration: fakeTickTime(4) });
  const ppro = fakePpro();
  const midpoint = await computeMidpointTickTime(trackItem, ppro, noopLog);
  assert.ok(midpoint);
  assert.equal(midpoint.seconds, 12);
});

test("computeMidpointTickTime returns null when getInPoint() fails", async () => {
  const trackItem = { getInPoint: () => { throw new Error("boom"); }, getDuration: () => fakeTickTime(4) };
  const midpoint = await computeMidpointTickTime(trackItem, fakePpro(), noopLog);
  assert.equal(midpoint, null);
});

// --- readSourceTextAttempts ---

test("readSourceTextAttempts reads Source Text with every valid TickTime source, each labelled, and unwraps the resolved value", async () => {
  const trackItem = fakeTrackItem({ inPoint: fakeTickTime(1), startTime: fakeTickTime(0), duration: fakeTickTime(2) });
  const param = fakeSourceTextParam({ getValueAtTime: (t) => `value-at-${t.seconds}` });
  const results = await readSourceTextAttempts(trackItem, param, fakePpro(), noopLog, undefined);
  assert.equal(results.length, 4); // TickTime(0), getInPoint, getStartTime, midpoint
  assert.ok(results.every((r) => r.ok));
  assert.equal(results[0].label, "TickTime.createWithSeconds(0)");
  assert.equal(results[0].resolvedValue, "value-at-0");
  assert.equal(results.find((r) => r.label === "trackItem.getInPoint()").resolvedValue, "value-at-1");
});

test("readSourceTextAttempts never calls getValueAtTime with no argument — every call receives a constructed TickTime", async () => {
  const trackItem = fakeTrackItem({ inPoint: fakeTickTime(1), startTime: fakeTickTime(0), duration: fakeTickTime(2) });
  const receivedArgs = [];
  const param = fakeSourceTextParam({
    getValueAtTime: (t) => {
      receivedArgs.push(t);
      return "ok";
    },
  });
  await readSourceTextAttempts(trackItem, param, fakePpro(), noopLog, undefined);
  assert.ok(receivedArgs.length > 0);
  for (const arg of receivedArgs) {
    assert.notEqual(arg, undefined, "getValueAtTime must never be called with no argument");
    assert.ok(arg && arg.isFakeTickTime, "getValueAtTime must always receive a real TickTime-like object");
  }
});

test("readSourceTextAttempts records each failing/timed-out attempt independently instead of aborting the whole set", async () => {
  const trackItem = fakeTrackItem({ inPoint: fakeTickTime(1), startTime: fakeTickTime(5), duration: fakeTickTime(2) });
  const param = fakeSourceTextParam({
    getValueAtTime: (t) => {
      if (t.seconds === 0) throw new Error("read failed at 0");
      if (t.seconds === 1) return neverResolves();
      return `value-at-${t.seconds}`;
    },
  });
  const results = await readSourceTextAttempts(trackItem, param, fakePpro(), noopLog, undefined);
  const atZero = results.find((r) => r.label === "TickTime.createWithSeconds(0)");
  const atOne = results.find((r) => r.label === "trackItem.getInPoint()");
  const atStart = results.find((r) => r.label === "trackItem.getStartTime()");
  assert.equal(atZero.ok, false);
  assert.match(atZero.error, /read failed at 0/);
  assert.equal(atOne.ok, false);
  assert.equal(atOne.timedOut, true);
  assert.equal(atStart.ok, true);
  assert.equal(atStart.resolvedValue, "value-at-5");
});

test("readSourceTextAttempts stops issuing further reads once the scan budget is expired, marking the rest skipped", async () => {
  const trackItem = fakeTrackItem({ inPoint: fakeTickTime(1), startTime: fakeTickTime(0), duration: fakeTickTime(2) });
  let calls = 0;
  const param = fakeSourceTextParam({ getValueAtTime: () => { calls += 1; return "ok"; } });
  const expiredBudget = { isExpired: () => true, reason: () => "time budget exceeded" };
  const results = await readSourceTextAttempts(trackItem, param, fakePpro(), noopLog, expiredBudget);
  assert.equal(calls, 0);
  assert.ok(results.every((r) => r.skipped));
});

// --- testKeyframeCreation ---

test("testKeyframeCreation constructs a sentinel keyframe and confirms the sentinel string is preserved through unwrapValueDeep", async () => {
  const param = fakeSourceTextParam({
    createKeyframe: (v) => ({ value: v, constructor: { name: "Keyframe" } }),
  });
  const result = await testKeyframeCreation(param, DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.constructorName, "Keyframe");
  assert.equal(result.resolvedValue, DEFAULT_SENTINEL);
  assert.equal(result.sentinelPreserved, true);
});

test("testKeyframeCreation reports sentinelPreserved:false when the resolved value doesn't match (compatibility mismatch, not a crash)", async () => {
  const param = fakeSourceTextParam({ createKeyframe: () => ({ value: "SOMETHING ELSE" }) });
  const result = await testKeyframeCreation(param, DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.sentinelPreserved, false);
});

test("testKeyframeCreation records a thrown compatibility error instead of crashing", async () => {
  const param = fakeSourceTextParam({
    createKeyframe: () => { throw new Error("createKeyframe not supported for this param type"); },
  });
  const result = await testKeyframeCreation(param, DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /not supported/);
});

test("testKeyframeCreation is skipped once the scan budget is already expired", async () => {
  const param = fakeSourceTextParam({ createKeyframe: () => { throw new Error("should never be called"); } });
  const expiredBudget = { isExpired: () => true, reason: () => "time budget exceeded" };
  const result = await testKeyframeCreation(param, DEFAULT_SENTINEL, noopLog, expiredBudget);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
});

// --- testActionCreation ---

test("testActionCreation constructs a set-value action from a successfully-created keyframe", async () => {
  const fakeAction = { constructor: { name: "SetParamValueAction" } };
  const param = fakeSourceTextParam({ createSetValueAction: (kf, applyToAll) => (kf && applyToAll ? fakeAction : null) });
  const result = await testActionCreation(param, { some: "keyframe" }, noopLog, undefined);
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.action, fakeAction);
});

test("testActionCreation records a thrown error instead of crashing when action creation fails", async () => {
  const param = fakeSourceTextParam({ createSetValueAction: () => { throw new Error("incompatible param"); } });
  const result = await testActionCreation(param, { some: "keyframe" }, noopLog, undefined);
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /incompatible param/);
});

// --- runTransaction ---

test("runTransaction adds the action to the compound action and reports success when executeTransaction returns true", () => {
  let addedAction = null;
  const project = {
    lockedAccess: (fn) => fn(),
    executeTransaction: (build) => {
      build({ addAction: (a) => { addedAction = a; } });
      return true;
    },
  };
  const action = { id: "the-action" };
  const result = runTransaction(project, action, "Source Text", noopLog);
  assert.equal(result.ok, true);
  assert.equal(addedAction, action);
});

test("runTransaction reports failure without throwing when executeTransaction throws", () => {
  const project = {
    lockedAccess: (fn) => fn(),
    executeTransaction: () => { throw new Error("transaction rejected"); },
  };
  const result = runTransaction(project, { id: "action" }, "Source Text", noopLog);
  assert.equal(result.ok, false);
  assert.match(result.error, /transaction rejected/);
});

test("runTransaction reports failure when executeTransaction returns false", () => {
  const project = { lockedAccess: (fn) => fn(), executeTransaction: () => false };
  const result = runTransaction(project, { id: "action" }, "Source Text", noopLog);
  assert.equal(result.ok, false);
});

// --- readBackSourceText ---

test("readBackSourceText reacquires the chain/component/param fresh and confirms a matching sentinel read-back", async () => {
  const freshParam = fakeSourceTextParam({ displayName: "Source Text", getValueAtTime: () => DEFAULT_SENTINEL });
  const freshComponent = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [freshParam] });
  const freshChain = fakeChain([freshComponent]);
  const trackItem = { getComponentChain: () => freshChain };
  const result = await readBackSourceText(trackItem, fakePpro(), DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.resolvedValue, DEFAULT_SENTINEL);
});

test("readBackSourceText reports matched:false (not a crash) when the read-back value doesn't equal the sentinel", async () => {
  const freshParam = fakeSourceTextParam({ displayName: "Source Text", getValueAtTime: () => "not the sentinel" });
  const freshComponent = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [freshParam] });
  const trackItem = { getComponentChain: () => fakeChain([freshComponent]) };
  const result = await readBackSourceText(trackItem, fakePpro(), DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.matched, false);
});

test("readBackSourceText fails cleanly when the chain can't be reacquired at all", async () => {
  const trackItem = { getComponentChain: () => { throw new Error("gone"); } };
  const result = await readBackSourceText(trackItem, fakePpro(), DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /component chain/);
});

test("readBackSourceText fails cleanly when AE.ADBE Text is no longer found on the reacquired chain", async () => {
  const trackItem = { getComponentChain: () => fakeChain([fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] })]) };
  const result = await readBackSourceText(trackItem, fakePpro(), DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /AE.ADBE Text/);
});

test("readBackSourceText fails cleanly when Source Text is no longer found on the reacquired component", async () => {
  const freshComponent = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [fakeSourceTextParam({ displayName: "Something Else" })] });
  const trackItem = { getComponentChain: () => fakeChain([freshComponent]) };
  const result = await readBackSourceText(trackItem, fakePpro(), DEFAULT_SENTINEL, noopLog, undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /Source Text param/);
});

test("readBackSourceText is skipped once the scan budget is already expired", async () => {
  const trackItem = { getComponentChain: () => { throw new Error("should never be called"); } };
  const expiredBudget = { isExpired: () => true, reason: () => "time budget exceeded" };
  const result = await readBackSourceText(trackItem, fakePpro(), DEFAULT_SENTINEL, noopLog, expiredBudget);
  assert.equal(result.attempted, false);
  assert.equal(result.skipped, true);
});

// --- runSourceTextRoundTrip (orchestration/gating) ---

function fakeWritableParam({ readValue = DEFAULT_SENTINEL, keyframeOk = true, actionOk = true } = {}) {
  return fakeSourceTextParam({
    getValueAtTime: () => readValue,
    createKeyframe: keyframeOk ? (v) => ({ value: v }) : () => { throw new Error("createKeyframe unsupported"); },
    createSetValueAction: actionOk ? (kf) => ({ keyframe: kf }) : () => { throw new Error("createSetValueAction unsupported"); },
  });
}

test("runSourceTextRoundTrip runs the full success path: read, keyframe, action, transaction, read-back all succeed and match", async () => {
  const freshParam = fakeWritableParam();
  const freshComponent = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [freshParam] });
  const trackItem = fakeTrackItem({ chain: fakeChain([freshComponent]) });
  const project = { lockedAccess: (fn) => fn(), executeTransaction: (build) => { build({ addAction: () => {} }); return true; } };

  const report = await runSourceTextRoundTrip({
    project,
    trackItem,
    componentIndex: 3,
    paramIndex: 0,
    param: freshParam,
    displayName: "Source Text",
    isTimeVarying: false,
    // Deliberately `true` here (not the real confirmed Source Text value of
    // `false`) — this test exercises the write-path chain itself
    // (keyframe -> action -> transaction -> read-back), which is now gated
    // OFF entirely when areKeyframesSupported is false (see the dedicated
    // gating tests below). A real Source Text run never reaches this path.
    areKeyframesSupported: true,
    sentinel: DEFAULT_SENTINEL,
    log: noopLog,
    budget: undefined,
    ppro: fakePpro(),
  });

  assert.equal(report.keyframeCreation.ok, true);
  assert.equal(report.actionCreation.ok, true);
  assert.equal(report.transaction.ok, true);
  assert.equal(report.readBack.ok, true);
  assert.equal(report.readBack.matched, true);
  assert.equal(report.keyframeCreation.keyframe, undefined, "the live keyframe handle must be stripped from the returned report");
  assert.equal(report.actionCreation.action, undefined, "the live action handle must be stripped from the returned report");
});

test("runSourceTextRoundTrip skips action/transaction/read-back entirely when createKeyframe fails", async () => {
  const param = fakeWritableParam({ keyframeOk: false });
  const trackItem = fakeTrackItem({ chain: fakeChain([]) });
  const project = { lockedAccess: () => { throw new Error("must not be called"); }, executeTransaction: () => { throw new Error("must not be called"); } };

  const report = await runSourceTextRoundTrip({
    project,
    trackItem,
    componentIndex: 3,
    paramIndex: 0,
    param,
    displayName: "Source Text",
    isTimeVarying: false,
    areKeyframesSupported: true, // see the success-path test above for why this is `true`, not the real Source Text value.
    sentinel: DEFAULT_SENTINEL,
    log: noopLog,
    budget: undefined,
    ppro: fakePpro(),
  });

  assert.equal(report.keyframeCreation.ok, false);
  assert.equal(report.actionCreation.attempted, false);
  assert.equal(report.transaction.attempted, false);
  assert.equal(report.readBack.attempted, false);
});

test("runSourceTextRoundTrip skips transaction/read-back when action creation fails", async () => {
  const param = fakeWritableParam({ actionOk: false });
  const trackItem = fakeTrackItem({ chain: fakeChain([]) });
  const project = { lockedAccess: () => { throw new Error("must not be called"); }, executeTransaction: () => { throw new Error("must not be called"); } };

  const report = await runSourceTextRoundTrip({
    project,
    trackItem,
    componentIndex: 3,
    paramIndex: 0,
    param,
    displayName: "Source Text",
    isTimeVarying: false,
    areKeyframesSupported: true, // see the success-path test above for why this is `true`, not the real Source Text value.
    sentinel: DEFAULT_SENTINEL,
    log: noopLog,
    budget: undefined,
    ppro: fakePpro(),
  });

  assert.equal(report.keyframeCreation.ok, true);
  assert.equal(report.actionCreation.ok, false);
  assert.equal(report.transaction.attempted, false);
  assert.equal(report.readBack.attempted, false);
});

test("runSourceTextRoundTrip skips read-back when the transaction itself fails", async () => {
  const param = fakeWritableParam();
  const freshComponent = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [param] });
  const trackItem = fakeTrackItem({ chain: fakeChain([freshComponent]) });
  const project = { lockedAccess: (fn) => fn(), executeTransaction: () => false };

  const report = await runSourceTextRoundTrip({
    project,
    trackItem,
    componentIndex: 3,
    paramIndex: 0,
    param,
    displayName: "Source Text",
    isTimeVarying: false,
    areKeyframesSupported: true, // see the success-path test above for why this is `true`, not the real Source Text value.
    sentinel: DEFAULT_SENTINEL,
    log: noopLog,
    budget: undefined,
    ppro: fakePpro(),
  });

  assert.equal(report.actionCreation.ok, true);
  assert.equal(report.transaction.ok, false);
  assert.equal(report.readBack.attempted, false);
});

// --- cancelActiveSourceTextRoundTrip ---

test("cancelActiveSourceTextRoundTrip returns false when nothing is running", () => {
  assert.equal(cancelActiveSourceTextRoundTrip(), false);
});

test("cancelActiveReadSourceTextOnly returns false when nothing is running", () => {
  assert.equal(cancelActiveReadSourceTextOnly(), false);
});

// --- readSourceTextValueOnly ---
//
// Regression coverage for the confirmed real-host finding: Source Text
// reports isTimeVarying:false and areKeyframesSupported:false, and the old
// keyframe-first/getValueAtTime-first read strategy failed outright
// (createKeyframe threw "Illegal Parameter type"). These tests exercise
// the non-keyframed value-getter strategy this function now uses instead.

test("readSourceTextValueOnly reads a non-time-varying Source Text value via getValue() — the documented current-value getter", async () => {
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValue: () => "Hello Caption",
  });
  const trackItem = fakeTrackItem({});
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, "getValue");
  assert.equal(result.resolvedValue, "Hello Caption");
  const getValueAttempt = result.valueGetterAttempts.find((a) => a.name === "getValue");
  assert.equal(getValueAttempt.ok, true);
  assert.equal(getValueAttempt.kind, "method");
  assert.equal(getValueAttempt.typeofMember, "function");
});

test("readSourceTextValueOnly never calls createKeyframe (keyframes unsupported) — only non-keyframed getters are tried", async () => {
  let createKeyframeCalled = false;
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValue: () => "Hello Caption",
    createKeyframe: () => {
      createKeyframeCalled = true;
      throw new Error("Illegal Parameter type");
    },
  });
  const trackItem = fakeTrackItem({});
  await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);
  assert.equal(createKeyframeCalled, false, "readSourceTextValueOnly must never call createKeyframe");
});

test("readSourceTextValueOnly resolves getValue() when it returns a Promise, and records isPromise:true", async () => {
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValue: () => Promise.resolve("Async Caption Text"),
  });
  const trackItem = fakeTrackItem({});
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, "getValue");
  assert.equal(result.resolvedValue, "Async Caption Text");
  const getValueAttempt = result.valueGetterAttempts.find((a) => a.name === "getValue");
  assert.equal(getValueAttempt.isPromise, true);
});

test("readSourceTextValueOnly deeply unwraps a wrapped text value object (Keyframe-shaped { value: X }) returned by a value getter", async () => {
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValue: () => ({ value: "Wrapped Text" }),
  });
  const trackItem = fakeTrackItem({});
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, "getValue");
  assert.equal(result.resolvedValue, "Wrapped Text");
  const getValueAttempt = result.valueGetterAttempts.find((a) => a.name === "getValue");
  assert.ok(getValueAttempt.wrapperShape, "a wrapper object result should carry its own probed shape, not just a summary");
  assert.equal(getValueAttempt.wrapperShape.exists, true);
});

test("readSourceTextValueOnly falls back to a plain \".value\" property when there's no getValue() method", async () => {
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    value: "Direct Property Text",
  });
  const trackItem = fakeTrackItem({});
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, "value");
  assert.equal(result.resolvedValue, "Direct Property Text");
  const valueAttempt = result.valueGetterAttempts.find((a) => a.name === "value");
  assert.equal(valueAttempt.kind, "property");
});

test("readSourceTextValueOnly discovers and tries other *value*-named getters beyond the hardcoded candidates", async () => {
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    extraMethods: { getCurrentValue: () => "Discovered Method Text" },
  });
  const trackItem = fakeTrackItem({});
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, "getCurrentValue");
  assert.equal(result.resolvedValue, "Discovered Method Text");
});

test("readSourceTextValueOnly never invokes a discovered method that looks like a keyframe/AtTime/create/set/find call, even if its name contains \"value\"", async () => {
  let setValueCalled = false;
  let createValueCalled = false;
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValue: () => "Hello Caption",
    extraMethods: {
      setValue: () => { setValueCalled = true; throw new Error("must never be called — mutating method"); },
      createValueKeyframe: () => { createValueCalled = true; throw new Error("must never be called — keyframe method"); },
    },
  });
  const trackItem = fakeTrackItem({});
  await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);
  assert.equal(setValueCalled, false);
  assert.equal(createValueCalled, false);
});

test("readSourceTextValueOnly reports no working method (not a crash) when every getter is absent or returns null", async () => {
  const param = fakeSourceTextParam({ isTimeVarying: false, areKeyframesSupported: false });
  const trackItem = fakeTrackItem({});
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, null);
  assert.equal(result.resolvedValue, null);
});

test("readSourceTextValueOnly still tries getValueAtTime(TickTime) as a fallback alongside the non-keyframed getters", async () => {
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValueAtTime: () => "value-from-time-based-read",
  });
  const trackItem = fakeTrackItem({ inPoint: fakeTickTime(0), startTime: fakeTickTime(0), duration: fakeTickTime(0) });
  const result = await readSourceTextValueOnly(param, fakePpro(), trackItem, noopLog, undefined);

  assert.equal(result.workingMethod, "getValueAtTime");
  assert.equal(result.resolvedValue, "value-from-time-based-read");
  assert.ok(result.getValueAtTimeAttempts.length > 0);
});

// --- runSourceTextRoundTrip: createKeyframe gating on areKeyframesSupported ---

test("runSourceTextRoundTrip skips createKeyframe entirely when areKeyframesSupported is false — the confirmed real-host Source Text case", async () => {
  let createKeyframeCalled = false;
  const param = fakeSourceTextParam({
    isTimeVarying: false,
    areKeyframesSupported: false,
    getValue: () => "Hello Caption",
    createKeyframe: () => {
      createKeyframeCalled = true;
      throw new Error("Illegal Parameter type");
    },
  });
  const trackItem = fakeTrackItem({ chain: fakeChain([]) });
  const project = { lockedAccess: () => { throw new Error("must not be called"); }, executeTransaction: () => { throw new Error("must not be called"); } };

  const report = await runSourceTextRoundTrip({
    project,
    trackItem,
    componentIndex: 3,
    paramIndex: 0,
    param,
    displayName: "Source Text",
    isTimeVarying: false,
    areKeyframesSupported: false,
    sentinel: DEFAULT_SENTINEL,
    log: noopLog,
    budget: undefined,
    ppro: fakePpro(),
  });

  assert.equal(createKeyframeCalled, false, "createKeyframe must never be called when areKeyframesSupported is false");
  assert.equal(report.keyframeCreation.ok, false);
  assert.equal(report.keyframeCreation.skipped, true);
  assert.equal(report.actionCreation.attempted, false);
  assert.equal(report.transaction.attempted, false);
  assert.equal(report.readBack.attempted, false);
  assert.equal(report.valueRead.workingMethod, "getValue");
  assert.equal(report.valueRead.resolvedValue, "Hello Caption");
});

test("runSourceTextRoundTrip still attempts createKeyframe when areKeyframesSupported is null/unknown (not confirmed false)", async () => {
  const param = fakeWritableParam();
  const trackItem = fakeTrackItem({ chain: fakeChain([]) });
  const project = { lockedAccess: (fn) => fn(), executeTransaction: (build) => { build({ addAction: () => {} }); return true; } };

  const report = await runSourceTextRoundTrip({
    project,
    trackItem,
    componentIndex: 3,
    paramIndex: 0,
    param,
    displayName: "Source Text",
    isTimeVarying: null,
    areKeyframesSupported: null,
    sentinel: DEFAULT_SENTINEL,
    log: noopLog,
    budget: undefined,
    ppro: fakePpro(),
  });

  assert.equal(report.keyframeCreation.ok, true);
  assert.equal(report.keyframeCreation.skipped, undefined);
});
