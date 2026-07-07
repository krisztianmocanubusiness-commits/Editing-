/**
 * Parse word-level JSON produced by Whisper-family ASR tools (whisper.cpp,
 * faster-whisper, OpenAI API verbose_json, etc). We accept a few common
 * shapes rather than one rigid schema:
 *
 *   { segments: [ { words: [ { word|text, start, end } ], ... } ] }
 *   { words: [ { word|text, start, end } ] }
 */
export function parseWhisperJson(content) {
  const data = typeof content === "string" ? JSON.parse(content) : content;
  const words = [];

  const collectFrom = (wordArr) => {
    for (const w of wordArr || []) {
      const text = (w.word ?? w.text ?? "").trim();
      if (!text) continue;
      words.push({
        text,
        start: Number(w.start ?? w.begin ?? 0),
        end: Number(w.end ?? w.stop ?? 0),
        confidence: w.probability ?? w.confidence,
      });
    }
  };

  if (Array.isArray(data.segments)) {
    for (const seg of data.segments) {
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        collectFrom(seg.words);
      } else if (seg.text) {
        // Segment-only timing, no word timing: fall back to even split.
        const tokens = String(seg.text).trim().split(/\s+/).filter(Boolean);
        const start = Number(seg.start ?? 0);
        const end = Number(seg.end ?? start);
        const per = Math.max(end - start, 0.001) / Math.max(tokens.length, 1);
        tokens.forEach((t, i) =>
          words.push({ text: t, start: start + i * per, end: start + (i + 1) * per })
        );
      }
    }
  } else if (Array.isArray(data.words)) {
    collectFrom(data.words);
  }

  return {
    words,
    sourceFormat: "whisper-json",
    hasWordTiming: words.length > 0,
  };
}
