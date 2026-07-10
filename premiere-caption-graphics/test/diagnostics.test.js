import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyComponent,
  readMatchName,
  readDisplayName,
  textLikeSignal,
  runScanWithGuaranteedCleanup,
  discoverComponents,
  prioritizeTextFirst,
  probeTextComponentDeep,
  stabilizeComponentChain,
  MOGRT_INIT_TIMEOUT_MESSAGE,
} from "../src/ppro/diagnostics.js";
import { resolveHostValue, safeResolve, toSafeString, isPromiseLike } from "../src/ppro/introspect.js";
import { createScanBudget } from "../src/ppro/deepProbe.js";

test("classifyComponent recognizes the known intrinsic component names, case-insensitively", () => {
  for (const name of ["Motion", "opacity", "Time Remapping", "CROP", "Channel Volume", "Volume"]) {
    const { classification } = classifyComponent({ displayName: name, matchName: null });
    assert.equal(classification, "intrinsic", `expected "${name}" to classify as intrinsic`);
  }
});

test("classifyComponent flags graphic/MOGRT signals in displayName or matchName", () => {
  assert.equal(classifyComponent({ displayName: "Graphic", matchName: null }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Essential Graphics", matchName: null }).classification, "graphic-or-mogrt");
  // "AE.ADBE Text Document" contains "text" but is NOT an exact match for
  // the confirmed AE.ADBE Text component matchName, so it falls to the
  // weaker graphic-or-mogrt signal rather than the "text-editing" tier.
  assert.equal(classifyComponent({ displayName: "Text", matchName: "AE.ADBE Text Document" }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Some MOGRT Layer", matchName: null }).classification, "graphic-or-mogrt");
});

test("classifyComponent classifies an exact AE.ADBE Text matchName as text-editing — the confirmed real MOGRT text control, distinct from both intrinsic and the generic graphic-or-mogrt signal tier", () => {
  const byMatchName = classifyComponent({ displayName: "Text", matchName: "AE.ADBE Text" });
  assert.equal(byMatchName.classification, "text-editing");
  assert.match(byMatchName.reason, /confirmed via a real host run/);

  // Also matches on displayName alone if that's the only field carrying it.
  const byDisplayName = classifyComponent({ displayName: "AE.ADBE Text", matchName: null });
  assert.equal(byDisplayName.classification, "text-editing");
});

test("classifyComponent falls back to effect-or-unknown for anything unrecognized", () => {
  const result = classifyComponent({ displayName: "Gaussian Blur", matchName: null });
  assert.equal(result.classification, "effect-or-unknown");
  assert.match(result.reason, /human judgment/);
});

test("classifyComponent treats AE.ADBE Opacity/Motion/Graphic Group as intrinsic, not as discovered custom controls (real Premiere Pro 26.3 regression)", () => {
  // Confirmed real-host bug: a Premiere-native "Hello World" MOGRT reported
  // exactly these three components, and the earlier classifier (which used
  // a bare "ae.adbe" substring as a "this is custom MOGRT content" signal)
  // misclassified all three as "graphic-or-mogrt" — i.e. reported the scan
  // as having found real controls when it had only found the same
  // intrinsic components every graphic clip has.
  const cases = [
    { displayName: "AE.ADBE Opacity", matchName: null },
    { displayName: null, matchName: "AE.ADBE Opacity" },
    { displayName: "AE.ADBE Motion", matchName: null },
    { displayName: null, matchName: "AE.ADBE Motion" },
    { displayName: "AE.ADBE Graphic Group", matchName: null },
    { displayName: null, matchName: "AE.ADBE Graphic Group" },
    { displayName: "Opacity", matchName: "AE.ADBE Opacity" },
    { displayName: "Motion", matchName: "AE.ADBE Motion" },
  ];
  for (const info of cases) {
    const result = classifyComponent(info);
    assert.equal(
      result.classification,
      "intrinsic",
      `expected ${JSON.stringify(info)} to classify as intrinsic, got "${result.classification}"`
    );
  }
});

test("classifyComponent no longer treats a bare ae.adbe prefix as a graphic-or-mogrt signal", () => {
  // "ae.adbe" alone is no longer a graphic-or-mogrt signal (removed after
  // it misclassified the three confirmed intrinsic components — see the
  // regression test above). An AE.ADBE-prefixed name with no specific
  // signal and not in the known intrinsic/text-editing lists falls through
  // to effect-or-unknown, not graphic-or-mogrt.
  assert.equal(classifyComponent({ displayName: null, matchName: "AE.ADBE SomeUnknownThing" }).classification, "effect-or-unknown");
});

test("classifyComponent does not misclassify a param-level name (e.g. Scale) as intrinsic just because it sounds related", () => {
  // "Scale" is a *param* under the "Motion" component in real Premiere usage,
  // not a component name itself — classifyComponent only recognizes exact
  // known component names, so a caller passing a param name here should not
  // silently get "intrinsic".
  assert.equal(classifyComponent({ displayName: "Scale", matchName: null }).classification, "effect-or-unknown");
});

test("classifyComponent never throws when given a raw (unresolved) Promise instead of a string — the confirmed Premiere Pro 26.3 crash shape", () => {
  // Confirmed real-host crash: `TrackItem.matchName` returned a live Promise
  // instead of a string, and the old classifyComponent called
  // `(matchName || "").trim()` on it directly → "trim is not a function".
  // classifyComponent itself must be defense-in-depth safe against this,
  // even though callers are now expected to resolve first (see the
  // readMatchName/readDisplayName tests below).
  const unresolvedPromise = Promise.resolve("AE.ADBE Text");
  assert.doesNotThrow(() => classifyComponent({ displayName: unresolvedPromise, matchName: unresolvedPromise }));
  const result = classifyComponent({ displayName: unresolvedPromise, matchName: unresolvedPromise });
  assert.equal(result.classification, "effect-or-unknown"); // not a string, so no name/matchName signal can match
  // Prevent an unhandled-rejection false alarm from the promise created above.
  unresolvedPromise.catch(() => {});
});

test("isPromiseLike recognizes real Promises and thenables, and rejects plain values", () => {
  assert.equal(isPromiseLike(Promise.resolve(1)), true);
  assert.equal(isPromiseLike({ then: () => {} }), true);
  assert.equal(isPromiseLike("a string"), false);
  assert.equal(isPromiseLike(null), false);
  assert.equal(isPromiseLike(undefined), false);
  assert.equal(isPromiseLike(42), false);
});

test("resolveHostValue awaits a resolved Promise and returns its value", async () => {
  const result = await resolveHostValue(Promise.resolve("AE.ADBE Text"), "fallback");
  assert.equal(result, "AE.ADBE Text");
});

test("resolveHostValue passes through a plain (non-Promise) value unchanged", async () => {
  const result = await resolveHostValue("plain string", "fallback");
  assert.equal(result, "plain string");
});

test("resolveHostValue catches a rejected Promise and returns the fallback instead of throwing", async () => {
  const rejected = Promise.reject(new Error("host getter failed"));
  const loggedLines = [];
  const result = await resolveHostValue(rejected, "fallback", { log: (msg, level) => loggedLines.push({ msg, level }) });
  assert.equal(result, "fallback");
  assert.equal(loggedLines.length, 1);
  assert.match(loggedLines[0].msg, /host getter failed/);
  assert.equal(loggedLines[0].level, "warn");
});

test("resolveHostValue never throws for a rejected Promise even without a log callback", async () => {
  await assert.doesNotReject(() => resolveHostValue(Promise.reject(new Error("boom")), "fallback"));
});

test("safeResolve catches a synchronous throw from the getter", async () => {
  const result = await safeResolve(() => {
    throw new Error("sync boom");
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /sync boom/);
});

test("safeResolve awaits and resolves a Promise-returning getter", async () => {
  const result = await safeResolve(() => Promise.resolve("AE.ADBE Text"));
  assert.deepEqual(result, { ok: true, value: "AE.ADBE Text" });
});

test("safeResolve catches a rejected Promise from the getter", async () => {
  const result = await safeResolve(() => Promise.reject(new Error("async boom")));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /async boom/);
});

test("toSafeString converts non-string values safely and passes strings through unchanged", () => {
  assert.equal(toSafeString("already a string"), "already a string");
  assert.equal(toSafeString(42), "42");
  assert.equal(toSafeString(null), null);
  assert.equal(toSafeString(undefined), null);
});

test("readMatchName resolves a plain-string matchName property", async () => {
  assert.deepEqual(await readMatchName({ matchName: "AE.ADBE Text" }), { value: "AE.ADBE Text", source: "matchName (property)" });
});

test("readMatchName falls back to getMatchName() when the property is absent", async () => {
  assert.deepEqual(await readMatchName({ getMatchName: () => "AE.ADBE Position" }), {
    value: "AE.ADBE Position",
    source: "getMatchName() (method)",
  });
});

test("readMatchName returns null/null when neither accessor exists", async () => {
  assert.deepEqual(await readMatchName({}), { value: null, source: null });
});

test("readMatchName never throws even if the accessor itself throws synchronously", async () => {
  const poison = {
    get matchName() {
      throw new Error("boom");
    },
  };
  await assert.doesNotReject(() => readMatchName(poison));
  assert.deepEqual(await readMatchName(poison), { value: null, source: null });
});

test("readMatchName awaits a matchName property that resolves to a string (Promise.resolve case)", async () => {
  // The confirmed Premiere Pro 26.3 shape: `trackItem.matchName` returned a
  // live Promise instead of a plain string.
  const result = await readMatchName({ matchName: Promise.resolve("AE.ADBE Text") });
  assert.deepEqual(result, { value: "AE.ADBE Text", source: "matchName (property)" });
});

test("readMatchName safely falls through when a matchName property is a rejected Promise, without crashing", async () => {
  const poisonPromise = Promise.reject(new Error("host getter rejected"));
  const result = await readMatchName({ matchName: poisonPromise, getMatchName: () => "AE.ADBE Position" });
  // The rejected property attempt is skipped (fallback null), so the second
  // attempt (getMatchName()) is tried and wins.
  assert.deepEqual(result, { value: "AE.ADBE Position", source: "getMatchName() (method)" });
});

test("readMatchName returns null/null (not a crash) when every attempt is a rejected Promise", async () => {
  const rejectedA = Promise.reject(new Error("boom A"));
  const rejectedB = Promise.reject(new Error("boom B"));
  const result = await readMatchName({ matchName: rejectedA, getMatchName: () => rejectedB });
  assert.deepEqual(result, { value: null, source: null });
});

test("readDisplayName resolves a plain string and awaits a Promise-returning displayName", async () => {
  assert.equal(await readDisplayName({ displayName: "Motion" }), "Motion");
  assert.equal(await readDisplayName({ displayName: Promise.resolve("Motion") }), "Motion");
});

test("readDisplayName returns null (not a crash) for a rejected Promise", async () => {
  const result = await readDisplayName({ displayName: Promise.reject(new Error("boom")) });
  assert.equal(result, null);
});

test("textLikeSignal matches on either displayName or matchName containing text-related words", () => {
  assert.equal(textLikeSignal("Source Text", null), true);
  assert.equal(textLikeSignal("Whatever", "AE.ADBE Text"), true);
  assert.equal(textLikeSignal("Font Size", null), false);
  assert.equal(textLikeSignal(null, null), false);
});

test("textLikeSignal never throws when given a raw Promise instead of a string", () => {
  const p = Promise.resolve("Source Text");
  assert.doesNotThrow(() => textLikeSignal(p, null));
  assert.equal(textLikeSignal(p, null), false); // not a string, so no signal — safe default, not a crash
  p.catch(() => {});
});

test("runScanWithGuaranteedCleanup runs cleanupFn even when scanFn throws, and captures the error instead of re-throwing", async () => {
  let cleanupCalls = 0;
  const cleanupFn = async () => {
    cleanupCalls += 1;
    return { ok: true, value: true };
  };
  const scanFn = async () => {
    throw new Error("scan crashed");
  };

  const { report, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(scanFn, cleanupFn);

  assert.equal(cleanupCalls, 1, "cleanupFn must run even though scanFn threw");
  assert.ok(scanError instanceof Error);
  assert.match(scanError.message, /scan crashed/);
  assert.equal(report, undefined);
  assert.deepEqual(cleanupResult, { ok: true, value: true });
});

test("runScanWithGuaranteedCleanup runs cleanupFn exactly once on the success path too, and returns the scan's report", async () => {
  let cleanupCalls = 0;
  const cleanupFn = async () => {
    cleanupCalls += 1;
    return { ok: true, value: true };
  };
  const scanFn = async () => ({ components: ["fake report"] });

  const { report, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(scanFn, cleanupFn);

  assert.equal(cleanupCalls, 1);
  assert.equal(scanError, null);
  assert.deepEqual(report, { components: ["fake report"] });
  assert.deepEqual(cleanupResult, { ok: true, value: true });
});

test("runScanWithGuaranteedCleanup still surfaces cleanupFn's own result even when scanFn also throws (cleanup failure isn't swallowed)", async () => {
  const cleanupFn = async () => ({ ok: false, error: new Error("cleanup also failed") });
  const scanFn = async () => {
    throw new Error("scan crashed");
  };

  const { scanError, cleanupResult } = await runScanWithGuaranteedCleanup(scanFn, cleanupFn);

  assert.match(scanError.message, /scan crashed/);
  assert.equal(cleanupResult.ok, false);
  assert.match(cleanupResult.error.message, /cleanup also failed/);
});

test("runScanWithGuaranteedCleanup logs the scan crash when a log callback is given, without throwing", async () => {
  const loggedLines = [];
  const cleanupFn = async () => ({ ok: true, value: true });
  const scanFn = async () => {
    throw new Error("scan crashed");
  };
  await assert.doesNotReject(() =>
    runScanWithGuaranteedCleanup(scanFn, cleanupFn, (msg, level) => loggedLines.push({ msg, level }))
  );
  assert.ok(loggedLines.some((l) => /scan crashed/.test(l.msg) && l.level === "error"));
});

// --- Regression tests: discovery-first architecture (component-discovery
// pass, AE.ADBE Text prioritization, dedicated Text extraction pass). ---

function noopLog() {}

function fakeParam({ displayName, value, position, isTimeVarying, areKeyframesSupported, startValueConstructorName = "Keyframe" } = {}) {
  // `constructor` as an own data property on the prototype shadows the
  // inherited Object.prototype.constructor, so `startValue.constructor.name`
  // reads back `startValueConstructorName` — without ever touching the
  // real, global `Object` constructor (which `Object.defineProperty(
  // startValueProto.constructor, "name", ...)` would have done, since a
  // plain object's inherited `.constructor` IS the global `Object`
  // function).
  const startValueProto = { constructor: { name: startValueConstructorName } };
  if (value !== undefined) Object.defineProperty(startValueProto, "value", { enumerable: false, get: () => value });
  if (position !== undefined) Object.defineProperty(startValueProto, "position", { enumerable: false, get: () => position });
  const startValue = Object.create(startValueProto);

  return {
    displayName,
    getStartValue: () => startValue,
    ...(isTimeVarying !== undefined ? { isTimeVarying: () => isTimeVarying } : {}),
    ...(areKeyframesSupported !== undefined ? { areKeyframesSupported: () => areKeyframesSupported } : {}),
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

test("prioritizeTextFirst moves a text-editing component before intrinsic ones, preserving relative order otherwise", () => {
  const components = [
    { componentIndex: 0, classification: "intrinsic" },
    { componentIndex: 1, classification: "intrinsic" },
    { componentIndex: 2, classification: "intrinsic" },
    { componentIndex: 3, classification: "text-editing" },
  ];
  const ordered = prioritizeTextFirst(components);
  assert.deepEqual(ordered.map((c) => c.componentIndex), [3, 0, 1, 2]);
});

test("prioritizeTextFirst is a no-op (preserves order) when there is no text-editing component", () => {
  const components = [
    { componentIndex: 0, classification: "intrinsic" },
    { componentIndex: 1, classification: "effect-or-unknown" },
  ];
  assert.deepEqual(prioritizeTextFirst(components).map((c) => c.componentIndex), [0, 1]);
});

test("discoverComponents finds AE.ADBE Text among intrinsic components using only matchName/displayName/paramCount reads (no per-param work)", async () => {
  const chain = {
    getComponentAtIndex: (i) => {
      const components = [
        fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] }),
        fakeComponent({ matchName: "AE.ADBE Motion", displayName: "Motion", params: [] }),
        fakeComponent({ matchName: "AE.ADBE Graphic Group", displayName: "Graphic", params: [] }),
        fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: Array.from({ length: 22 }, (_, i) => fakeParam({ displayName: `Param ${i}` })) }),
      ];
      return components[i] ?? null;
    },
  };

  const { components, partial } = await discoverComponents(chain, noopLog, undefined);
  assert.equal(partial, false);
  assert.equal(components.length, 4);
  const text = components.find((c) => c.classification === "text-editing");
  assert.ok(text, "expected a text-editing component to be discovered");
  assert.equal(text.componentIndex, 3);
  assert.equal(text.matchName, "AE.ADBE Text");
  assert.equal(text.paramCount, 22);
});

test("probeTextComponentDeep probes all 22 params of a Text component and resolves each one's displayName and getStartValue().value, completing quickly (no unrelated timeout calls)", async () => {
  const params = Array.from({ length: 22 }, (_, i) =>
    fakeParam({ displayName: `Text Param ${i}`, value: i % 2 === 0 ? `value-${i}` : { x: i, y: i * 2 }, isTimeVarying: false, areKeyframesSupported: true })
  );
  const componentInfo = {
    componentIndex: 3,
    component: { getParam: (i) => params[i] ?? null },
    matchName: "AE.ADBE Text",
    displayName: "Text",
    paramCount: 22,
  };

  const start = Date.now();
  const result = await probeTextComponentDeep(componentInfo, noopLog, undefined);
  const elapsed = Date.now() - start;

  assert.equal(result.partial, false);
  assert.equal(result.params.length, 22);
  assert.ok(elapsed < 2000, `expected the 22-param Text probe to complete quickly with no timeouts involved, took ${elapsed}ms`);

  for (let i = 0; i < 22; i++) {
    const entry = result.params[i];
    assert.equal(entry.paramIndex, i);
    assert.equal(entry.displayName, `Text Param ${i}`);
    assert.equal(entry.startValueConstructor, "Keyframe");
    assert.equal(entry.timedOut, false);
    assert.deepEqual(entry.errors, []);
    if (i % 2 === 0) {
      assert.equal(entry.value.kind, "string");
    } else {
      assert.equal(entry.value.kind, "point-like");
    }
  }
});

test("probeTextComponentDeep stops early and marks partial when the budget expires mid-scan, instead of finishing all 22 params", async () => {
  const cancelToken = { cancelled: false };
  const budget = createScanBudget({ totalMs: 60000, cancelToken });
  let paramsRead = 0;
  const params = Array.from({ length: 22 }, (_, i) => {
    const p = fakeParam({ displayName: `Text Param ${i}`, value: i });
    const originalGetStartValue = p.getStartValue;
    p.getStartValue = () => {
      paramsRead += 1;
      if (paramsRead === 5) cancelToken.cancelled = true; // expire the budget partway through
      return originalGetStartValue();
    };
    return p;
  });
  const componentInfo = {
    componentIndex: 3,
    component: { getParam: (i) => params[i] ?? null },
    matchName: "AE.ADBE Text",
    displayName: "Text",
    paramCount: 22,
  };

  const result = await probeTextComponentDeep(componentInfo, noopLog, budget);
  assert.equal(result.partial, true);
  assert.ok(result.params.length < 22, `expected fewer than 22 params to have been probed, got ${result.params.length}`);
});

// --- Regression tests: component-chain stabilization (a host chain that
// evolves asynchronously after MOGRT insertion — confirmed real-host
// behavior: AE.ADBE Text can take a couple of seconds to appear). ---

test("stabilizeComponentChain polls until AE.ADBE Text appears, reacquiring a fresh chain object every time (poll 1: 3, poll 2: 3, poll 3: 4 including AE.ADBE Text)", async () => {
  const threeIntrinsic = [
    fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] }),
    fakeComponent({ matchName: "AE.ADBE Motion", displayName: "Motion", params: [] }),
    fakeComponent({ matchName: "AE.ADBE Graphic Group", displayName: "Graphic", params: [] }),
  ];
  const fourWithText = [
    ...threeIntrinsic,
    fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: Array.from({ length: 22 }, (_, i) => fakeParam({ displayName: `Param ${i}` })) }),
  ];
  const componentListsPerCall = [threeIntrinsic, threeIntrinsic, fourWithText];

  const chainObjects = [];
  let callCount = 0;
  const trackItem = {
    getComponentChain: () => {
      const idx = Math.min(callCount, componentListsPerCall.length - 1);
      const components = componentListsPerCall[idx];
      const chain = { getComponentAtIndex: (i) => components[i] ?? null };
      chainObjects.push(chain);
      callCount += 1;
      return chain;
    },
  };

  const result = await stabilizeComponentChain(trackItem, noopLog, {
    startedAt: Date.now(),
    sleepFn: async () => {},
  });

  assert.equal(callCount, 3, "expected exactly 3 polls (stopping as soon as Text appears)");
  assert.equal(new Set(chainObjects).size, 3, "every poll must reacquire a distinct chain object, not reuse a previous one");
  assert.equal(result.textFound, true);
  assert.equal(result.discovery.components.length, 4);
  assert.ok(result.discovery.components.some((c) => c.classification === "text-editing"));
  assert.equal(result.timeline.length, 3);
  assert.deepEqual(result.timeline.map((t) => t.componentCount), [3, 3, 4]);
  assert.ok(result.timeline[2].components.includes("AE.ADBE Text"));
});

test("stabilizeComponentChain's final discovery uses fresh Component references from the LAST poll, not a stale earlier one", async () => {
  const pollAOpacity = fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] });
  pollAOpacity.__pollTag = "A";
  const pollBOpacity = fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] });
  pollBOpacity.__pollTag = "B";
  const pollBText = fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [] });

  const lists = [[pollAOpacity], [pollBOpacity, pollBText]];
  let callCount = 0;
  const trackItem = {
    getComponentChain: () => {
      const components = lists[Math.min(callCount, lists.length - 1)];
      callCount += 1;
      return { getComponentAtIndex: (i) => components[i] ?? null };
    },
  };

  const result = await stabilizeComponentChain(trackItem, noopLog, { startedAt: Date.now(), sleepFn: async () => {} });

  assert.equal(result.textFound, true);
  assert.equal(callCount, 2, "expected exactly 2 polls (stopping once Text appears on poll 2)");
  const opacityEntry = result.discovery.components.find((c) => c.matchName === "AE.ADBE Opacity");
  assert.equal(opacityEntry.component.__pollTag, "B", "expected the fresh (2nd-poll) Opacity reference, not the stale 1st-poll one");
});

test("stabilizeComponentChain exits polling immediately once Text is found, without extra polls", async () => {
  let callCount = 0;
  const withText = [fakeComponent({ matchName: "AE.ADBE Text", displayName: "Text", params: [] })];
  const trackItem = {
    getComponentChain: () => {
      callCount += 1;
      return { getComponentAtIndex: (i) => withText[i] ?? null };
    },
  };
  await stabilizeComponentChain(trackItem, noopLog, { startedAt: Date.now(), sleepFn: async () => {} });
  assert.equal(callCount, 1, "Text found on the very first poll — no further polls should happen");
});

test("stabilizeComponentChain times out and produces a discovery timeline when AE.ADBE Text never appears, logging the exact required message", async () => {
  const threeIntrinsic = [
    fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] }),
    fakeComponent({ matchName: "AE.ADBE Motion", displayName: "Motion", params: [] }),
    fakeComponent({ matchName: "AE.ADBE Graphic Group", displayName: "Graphic", params: [] }),
  ];
  const trackItem = { getComponentChain: () => ({ getComponentAtIndex: (i) => threeIntrinsic[i] ?? null }) };

  const loggedLines = [];
  const result = await stabilizeComponentChain(trackItem, (msg, level) => loggedLines.push({ msg, level }), {
    startedAt: Date.now(),
    sleepFn: async () => {},
    maxWaitMs: 0,
  });

  assert.equal(result.textFound, false);
  assert.ok(result.timeline.length >= 1);
  assert.equal(result.timeline[0].componentCount, 3);
  assert.ok(loggedLines.some((l) => l.msg.includes(MOGRT_INIT_TIMEOUT_MESSAGE) && l.level === "warn"));
  // Never claims categorically that the template has no Text component.
  assert.ok(!loggedLines.some((l) => /does not have|has no AE\.ADBE Text|lacks an? AE\.ADBE Text/i.test(l.msg)));
});

test("stabilizeComponentChain stops polling when cancelled, without waiting for the (much longer) timeout or minimum wait", async () => {
  const threeIntrinsic = [fakeComponent({ matchName: "AE.ADBE Opacity", displayName: "Opacity", params: [] })];
  const cancelToken = { cancelled: false };
  let callCount = 0;
  const trackItem = {
    getComponentChain: () => {
      callCount += 1;
      if (callCount === 1) cancelToken.cancelled = true;
      return { getComponentAtIndex: (i) => threeIntrinsic[i] ?? null };
    },
  };
  const result = await stabilizeComponentChain(trackItem, noopLog, {
    startedAt: Date.now(),
    sleepFn: async () => {},
    cancelToken,
    maxWaitMs: 60000,
    minWaitMs: 60000,
  });
  assert.equal(callCount, 1, "expected polling to stop right after cancellation, not continue toward the very long timeout");
  assert.equal(result.textFound, false);
});

test("stabilizeComponentChain never throws even when getComponentChain fails on every poll, and still terminates (so cleanup is never skipped)", async () => {
  const trackItem = {
    getComponentChain: () => {
      throw new Error("host getComponentChain failed");
    },
  };
  const result = await stabilizeComponentChain(trackItem, noopLog, { startedAt: Date.now(), sleepFn: async () => {}, maxWaitMs: 0 });
  assert.equal(result.textFound, false);
  assert.equal(result.discovery.components.length, 0);
  assert.equal(result.timeline.length, 1);
});
