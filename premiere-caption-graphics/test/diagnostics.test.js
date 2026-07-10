import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyComponent,
  readMatchName,
  readDisplayName,
  textLikeSignal,
  runScanWithGuaranteedCleanup,
} from "../src/ppro/diagnostics.js";
import { resolveHostValue, safeResolve, toSafeString, isPromiseLike } from "../src/ppro/introspect.js";

test("classifyComponent recognizes the known intrinsic component names, case-insensitively", () => {
  for (const name of ["Motion", "opacity", "Time Remapping", "CROP", "Channel Volume", "Volume"]) {
    const { classification } = classifyComponent({ displayName: name, matchName: null });
    assert.equal(classification, "intrinsic", `expected "${name}" to classify as intrinsic`);
  }
});

test("classifyComponent flags graphic/MOGRT signals in displayName or matchName", () => {
  assert.equal(classifyComponent({ displayName: "Graphic", matchName: null }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Essential Graphics", matchName: null }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Text", matchName: "AE.ADBE Text" }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Some MOGRT Layer", matchName: null }).classification, "graphic-or-mogrt");
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

test("classifyComponent still flags a genuinely AE.ADBE-prefixed but otherwise-unrecognized name via a specific signal (text), not the removed blanket ae.adbe signal", () => {
  // "ae.adbe" alone is no longer a graphic-or-mogrt signal (see the
  // regression test above for why) — only specific signals like "text"
  // still flag a component as a possible custom control.
  assert.equal(classifyComponent({ displayName: null, matchName: "AE.ADBE Text" }).classification, "graphic-or-mogrt");
  // An AE.ADBE-prefixed name with no specific signal and not in the known
  // intrinsic list falls through to effect-or-unknown, not graphic-or-mogrt.
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
