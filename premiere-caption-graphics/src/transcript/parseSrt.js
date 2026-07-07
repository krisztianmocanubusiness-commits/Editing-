import { wordsFromTimedLines } from "./types.js";

const TIME_RE =
  /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function toSeconds(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** Parse .srt subtitle text into a Transcript. */
export function parseSrt(content) {
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const lines = [];

  for (const block of blocks) {
    const rows = block.split("\n").filter((r) => r.trim().length > 0);
    if (rows.length === 0) continue;

    const timeRowIndex = rows.findIndex((r) => TIME_RE.test(r));
    if (timeRowIndex === -1) continue;

    const match = rows[timeRowIndex].match(TIME_RE);
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    const text = rows
      .slice(timeRowIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();

    if (text) lines.push({ start, end, text });
  }

  return {
    words: wordsFromTimedLines(lines),
    sourceFormat: "srt",
    hasWordTiming: false,
  };
}
