import { parseSrt } from "./parseSrt.js";
import { parseVtt } from "./parseVtt.js";
import { parsePlainText } from "./parsePlainText.js";
import { parseWhisperJson } from "./parseWhisperJson.js";
import { parseAdobeTranscriptJson } from "./parseAdobeTranscriptJson.js";

/**
 * Detect a transcript's format from filename + content and parse it into
 * the unified Transcript shape ({ words, sourceFormat, hasWordTiming }).
 *
 * @param {string} content
 * @param {string} [filename]
 */
export function parseTranscript(content, filename = "") {
  const ext = filename.toLowerCase().split(".").pop();
  const trimmed = content.trim();

  if (ext === "srt") return parseSrt(content);
  if (ext === "vtt") return parseVtt(content);

  if (ext === "json" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const data = JSON.parse(trimmed);
    if (data.segments?.some((s) => Array.isArray(s.words)) || Array.isArray(data.words)) {
      // Prefer the Adobe shape when it matches, else fall back to Whisper-style.
      const looksAdobe =
        Array.isArray(data.words) &&
        data.words.length > 0 &&
        ("startTime" in data.words[0] || "start_time" in data.words[0]);
      return looksAdobe ? parseAdobeTranscriptJson(data) : parseWhisperJson(data);
    }
    return parseAdobeTranscriptJson(data);
  }

  if (/-->/.test(trimmed) && /^WEBVTT/i.test(trimmed)) return parseVtt(content);
  if (/-->/.test(trimmed)) return parseSrt(content);

  return parsePlainText(content);
}

export { parseSrt, parseVtt, parsePlainText, parseWhisperJson, parseAdobeTranscriptJson };
