// Tunable latency and safety limits.
export const FIRST_CHUNK_LENGTH = 160;
export const LATER_CHUNK_LENGTH = 160;
export const FETCH_TIMEOUT_MS = 60_000;
export const FIRST_RECORD_TIMEOUT_MS = 75_000;
export const STREAM_IDLE_TIMEOUT_MS = 90_000;
export const HEALTH_TIMEOUT_MS = 3_000;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_CHUNK_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_CHUNKS = 128;
export const MAX_RECORD_BYTES = Math.ceil(MAX_CHUNK_AUDIO_BYTES * 4 / 3) + 1024;
export const MAX_WIRE_BYTES = Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + (MAX_STREAM_CHUNKS * 1024);
export const STREAM_PROTOCOL_VERSION = "1";
export const AUDIO_TRIM_PADDING_SECONDS = 0.04;
export const AUDIO_BOUNDARY_OVERLAP_SECONDS = 0.04;
export const AUTO_READ_POLL_MS = 100;
export const AUTO_READ_HIDDEN_POLL_MS = 1_000;
export const MAX_AUTO_QUEUE_CHARS = 2_000;
export const MAX_AUTO_QUEUE_SEGMENTS = 8;
export const MAX_AUTO_SOURCE_CHARS = 20_000;

export const STORAGE_KEY = "pi-web.chatterbox-tts.settings.v1";
export const DIRECT_ENDPOINT = "http://192.168.200.42:9004";
export const SAME_ORIGIN_PROXY_PATH = "/chatterbox-tts";

export function defaultEndpoint(locationObject = globalThis.location) {
  if (locationObject?.protocol === "https:" && locationObject.origin) {
    return `${locationObject.origin}${SAME_ORIGIN_PROXY_PATH}`;
  }
  return DIRECT_ENDPOINT;
}

export const DEFAULT_SETTINGS = Object.freeze({
  endpoint: defaultEndpoint(),
  voice: "alloy",
  speed: 1,
  autoRead: false,
});

export const DOM_CONTRACT = Object.freeze({
  appSelector: "pi-web-app",
  chatSelector: "chat-view",
  assistantSelector: "article.msg.assistant, section.group-msg.assistant",
  userSelector: "article.msg.user",
  actionSelector: ":scope > .msg-header .msg-actions",
  directPartSelector: ":scope > formatted-text.part",
  buttonMarker: "data-chatterbox-tts",
  liveMarker: "data-chatterbox-tts-live",
});

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateEndpoint(value, pageProtocol = undefined) {
  if (typeof value !== "string" || !value.trim()) {
    throw errorWithCode("Enter a Chatterbox server URL.", "endpoint");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw errorWithCode("The Chatterbox server URL is invalid.", "endpoint");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw errorWithCode("The Chatterbox server must use HTTP or HTTPS.", "endpoint");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw errorWithCode("The server URL cannot contain credentials, a query, or a fragment.", "endpoint");
  }
  if (pageProtocol === "https:" && url.protocol === "http:") {
    throw errorWithCode("An HTTPS PI WEB page cannot send speech text to an HTTP server.", "mixed-content");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function validateSettings(candidate, options = {}) {
  if (!candidate || typeof candidate !== "object") throw errorWithCode("Invalid settings.", "settings");
  const endpoint = validateEndpoint(candidate.endpoint, options.pageProtocol);
  const voice = typeof candidate.voice === "string" ? candidate.voice.trim() : "";
  const speed = typeof candidate.speed === "number" ? candidate.speed : Number(candidate.speed);
  const autoRead = candidate.autoRead === true;
  if (!voice) throw errorWithCode("Voice cannot be empty.", "voice");
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw errorWithCode("Speed must be from 0.25 to 4.", "speed");
  }
  return { endpoint, voice, speed, autoRead };
}

export function loadSettings(storage = globalThis.localStorage, locationObject = globalThis.location) {
  const defaults = { ...DEFAULT_SETTINGS, endpoint: defaultEndpoint(locationObject) };
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return defaults;
    const saved = JSON.parse(raw);
    // Migrate the original LAN-only default when PI WEB is accessed through
    // HTTPS. The same-origin proxy keeps Authentik credentials and avoids the
    // browser's HTTPS-to-HTTP mixed-content block.
    if (locationObject?.protocol === "https:" && saved?.endpoint === DIRECT_ENDPOINT) {
      saved.endpoint = defaults.endpoint;
    }
    return validateSettings(saved, { pageProtocol: locationObject?.protocol });
  } catch {
    return defaults;
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  const valid = validateSettings(settings);
  storage?.setItem(STORAGE_KEY, JSON.stringify(valid));
  return valid;
}

function decodeBasicEntities(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const hex = name[1]?.toLowerCase() === "x";
      const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return entities[name.toLowerCase()] ?? whole;
  });
}

export function markdownToSpeech(markdown) {
  if (typeof markdown !== "string") return "";
  return decodeBasicEntities(markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_~]/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/gu, " ")
    .trim());
}

function proseOutsideFences(markdown) {
  const output = [];
  let fence;
  for (const line of markdown.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/u, "");
    if (!fence) {
      const backtick = body.match(/^\s{0,3}(`{3,})[^`]*$/u)?.[1];
      const tilde = body.match(/^\s{0,3}(~{3,}).*$/u)?.[1];
      const marker = backtick ?? tilde;
      if (marker) {
        fence = { character: marker[0], length: marker.length };
        continue;
      }
    } else {
      const closing = body.match(/^\s{0,3}(`{3,}|~{3,})[\t ]*$/u)?.[1];
      if (closing && closing[0] === fence.character && closing.length >= fence.length) {
        fence = undefined;
        continue;
      }
    }
    if (!fence) output.push(line);
  }
  return output.join("");
}

function stableInlinePrefix(markdown) {
  const output = [];
  const opens = [];
  let escaped = false;
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (escaped) { output.push(character); escaped = false; continue; }
    if (character === "\\") { output.push(character); escaped = true; continue; }
    if (character === "`") {
      const marker = markdown.slice(index).match(/^`+/u)?.[0] ?? "`";
      const closeAt = markdown.indexOf(marker, index + marker.length);
      if (closeAt < 0) return output.join("");
      output.push(" ");
      index = closeAt + marker.length - 1;
      continue;
    }
    const top = opens.at(-1);
    if (character === "<" && /[A-Za-z!/?]/u.test(markdown[index + 1] ?? "")) {
      opens.push({ type: "angle", outputIndex: output.length });
    }
    else if (character === ">" && top?.type === "angle") opens.pop();
    else if (character === "[") opens.push({
      type: "bracket", outputIndex: Math.max(0, output.length - (output.at(-1) === "!" ? 1 : 0)),
    });
    else if (character === "]" && top?.type === "bracket") {
      opens.pop();
      if (markdown[index + 1] === "(") opens.push({ type: "link", outputIndex: top.outputIndex });
    } else if (character === ")" && top?.type === "link") opens.pop();
    output.push(character);
  }
  if (escaped) output.pop();
  if (opens.length) output.length = Math.min(...opens.map((open) => open.outputIndex));
  return output.join("");
}

function stableSentenceEnd(speech) {
  const matcher = /[.!?\u3002\uff01\uff1f]+["'\u201d\u2019)]*(?=\s|$)/gu;
  const abbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)|\b[A-Za-z]|\be\.g|\bi\.e)\.$/iu;
  let end = 0;
  for (const match of speech.matchAll(matcher)) {
    const candidate = speech.slice(0, match.index + match[0].length);
    if (!abbreviation.test(candidate) && !/\d\.\d$/u.test(candidate)) end = candidate.length;
  }
  return end;
}

export function streamingSpeechSnapshot(markdown, final = false) {
  if (typeof markdown !== "string") return { source: "", speech: "" };
  const bounded = markdown.slice(0, MAX_AUTO_SOURCE_CHARS);
  const source = stableInlinePrefix(proseOutsideFences(bounded));
  const speech = markdownToSpeech(source);
  if (final) return { source: bounded, speech };
  const end = stableSentenceEnd(speech);
  return { source: bounded, speech: speech.slice(0, end).trim() };
}

function graphemeEndAtOrBefore(text, limit) {
  if (text.length <= limit) return text.length;
  if (globalThis.Intl?.Segmenter) {
    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    let end = 0;
    for (const part of segments) {
      const next = part.index + part.segment.length;
      if (next > limit) break;
      end = next;
    }
    return end || [...text][0]?.length || 1;
  }
  let end = 0;
  for (const value of text) {
    if (end + value.length > limit) break;
    end += value.length;
  }
  return end || 1;
}

function sentenceEnds(text, limit) {
  const ends = [];
  const expression = /[.!?。！？]+(?:["'”’)]*)?(?=\s|$)/gu;
  for (const match of text.matchAll(expression)) {
    const end = match.index + match[0].length;
    if (end <= limit) ends.push(end);
    else break;
  }
  return ends;
}

function prefixLength(text, limit, first) {
  const sentences = sentenceEnds(text, limit);
  if (first && sentences.length) return sentences[0];
  if (text.length <= limit) return text.length;
  if (sentences.length) return sentences.at(-1);
  const safe = graphemeEndAtOrBefore(text, limit);
  const prefix = text.slice(0, safe);
  let whitespace = -1;
  for (const match of prefix.matchAll(/\s+/gu)) whitespace = match.index;
  return whitespace > 0 ? whitespace : safe;
}

export function chunkSpeech(text, firstLimit = FIRST_CHUNK_LENGTH, laterLimit = LATER_CHUNK_LENGTH) {
  let remaining = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
  const chunks = [];
  while (remaining) {
    const limit = chunks.length === 0 ? firstLimit : laterLimit;
    const end = prefixLength(remaining, limit, chunks.length === 0);
    const chunk = remaining.slice(0, end).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(end).trim();
  }
  return chunks;
}

export function discoverChatRoot(documentObject = globalThis.document) {
  const appRoot = documentObject?.querySelector?.(DOM_CONTRACT.appSelector)?.shadowRoot;
  return appRoot?.querySelector?.(DOM_CONTRACT.chatSelector)?.shadowRoot;
}

export function enumerateAssistantMessages(root) {
  return Array.from(root?.querySelectorAll?.(DOM_CONTRACT.assistantSelector) ?? []);
}

export function deriveMessageIdentity(message, ordinal = 0) {
  const names = ["data-message-id", "data-anchor", "data-message-index", "data-index", "aria-posinset", "id"];
  for (const name of names) {
    const value = message?.getAttribute?.(name);
    if (value) return `${name}:${value}`;
  }
  return `assistant-index:${ordinal}`;
}

export function locateActionContainer(message) {
  return message?.querySelector?.(DOM_CONTRACT.actionSelector) ?? null;
}

export function extractAssistantText(message) {
  return Array.from(message?.querySelectorAll?.(DOM_CONTRACT.directPartSelector) ?? [])
    .map((part) => typeof part.text === "string" ? part.text : part.textContent ?? "")
    .map((text) => text.trim()).filter(Boolean).join("\n\n");
}

export function hasEnhancementMarker(actions) {
  return Boolean(actions?.querySelector?.(`[${DOM_CONTRACT.buttonMarker}]`));
}

function isAudioMime(value) {
  const mime = (value || "").split(";", 1)[0].trim().toLowerCase();
  return mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave" || mime === "audio/vnd.wave";
}

export async function readAudioResponse(response, maximum = MAX_AUDIO_BYTES) {
  if (!response?.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 240); } catch { /* ignored */ }
    throw errorWithCode(`Chatterbox returned HTTP ${response?.status ?? "unknown"}${detail ? `: ${detail}` : ""}`, "http");
  }
  if (!isAudioMime(response.headers?.get?.("content-type"))) {
    throw errorWithCode("Chatterbox returned an unsupported audio format.", "mime");
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw errorWithCode("The audio response is too large.", "size");

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw errorWithCode("The audio response is too large.", "size");
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes.buffer;
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximum) throw errorWithCode("The audio response is too large.", "size");
  return bytes;
}

function exactKeys(record, expected) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function decodeStrictBase64(value, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum * 4 / 3) + 4
      || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw errorWithCode("The stream contains invalid base64 audio.", "protocol");
  }
  let binary;
  try { binary = globalThis.atob(value); }
  catch { throw errorWithCode("The stream contains invalid base64 audio.", "protocol"); }
  if (binary.length > maximum) throw errorWithCode("A streamed audio chunk is too large.", "size");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
      || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") {
    throw errorWithCode("The stream contains a malformed WAV chunk.", "protocol");
  }
  return bytes;
}

export class StreamProtocolParser {
  constructor(options = {}) {
    this.maximumChunkBytes = options.maximumChunkBytes ?? MAX_CHUNK_AUDIO_BYTES;
    this.maximumTotalBytes = options.maximumTotalBytes ?? MAX_AUDIO_BYTES;
    this.maximumChunks = options.maximumChunks ?? MAX_STREAM_CHUNKS;
    this.expectedIndex = 0;
    this.totalBytes = 0;
    this.terminal = false;
  }

  parseLine(bytes) {
    if (this.terminal) throw errorWithCode("The stream contains data after its terminal record.", "protocol");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw errorWithCode("The stream is not valid UTF-8.", "protocol"); }
    let record;
    try { record = JSON.parse(text); }
    catch { throw errorWithCode("The stream contains malformed JSON.", "protocol"); }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
      throw errorWithCode("The stream contains an invalid record.", "protocol");
    }
    if (record.type === "audio") {
      if (!exactKeys(record, ["type", "index", "audio", "mime_type"]) || record.mime_type !== "audio/wav"
          || !Number.isSafeInteger(record.index) || record.index !== this.expectedIndex) {
        throw errorWithCode("The stream contains an invalid audio index or record.", "protocol");
      }
      if (this.expectedIndex >= this.maximumChunks) throw errorWithCode("The stream has too many audio chunks.", "size");
      const audio = decodeStrictBase64(record.audio, this.maximumChunkBytes);
      this.totalBytes += audio.byteLength;
      if (this.totalBytes > this.maximumTotalBytes) throw errorWithCode("The streamed audio is too large.", "size");
      const index = this.expectedIndex;
      this.expectedIndex += 1;
      return { type: "audio", index, audio };
    }
    if (record.type === "done") {
      if (!exactKeys(record, ["type", "chunks"]) || !Number.isSafeInteger(record.chunks)
          || record.chunks !== this.expectedIndex) {
        throw errorWithCode("The stream has an invalid completion record.", "protocol");
      }
      this.terminal = true;
      return { type: "done", chunks: record.chunks };
    }
    if (record.type === "error") {
      if (!exactKeys(record, ["type", "error"]) || typeof record.error !== "string"
          || !record.error || record.error.length > 240) {
        throw errorWithCode("The stream has an invalid error record.", "protocol");
      }
      this.terminal = true;
      return { type: "error", error: record.error };
    }
    throw errorWithCode("The stream contains an unknown record type.", "protocol");
  }
}

function appendBytes(left, right) {
  if (!left.length) return right.slice();
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

export class NDJSONRecordReader {
  constructor(body, options = {}) {
    if (!body?.getReader) throw errorWithCode("The streaming response has no readable body.", "protocol");
    this.reader = body.getReader();
    this.parser = options.parser ?? new StreamProtocolParser(options);
    this.maximumRecordBytes = options.maximumRecordBytes ?? MAX_RECORD_BYTES;
    this.maximumWireBytes = options.maximumWireBytes ?? MAX_WIRE_BYTES;
    this.buffer = new Uint8Array(0);
    this.wireBytes = 0;
    this.ended = false;
  }

  async readMore(waitForRead) {
    const result = await waitForRead(this.reader.read());
    if (result.done) { this.ended = true; return; }
    if (!(result.value instanceof Uint8Array)) throw errorWithCode("The stream returned invalid bytes.", "protocol");
    this.wireBytes += result.value.byteLength;
    if (this.wireBytes > this.maximumWireBytes) throw errorWithCode("The stream response is too large.", "size");
    this.buffer = appendBytes(this.buffer, result.value);
  }

  async ensureTerminalEof(waitForRead) {
    if (this.buffer.length) throw errorWithCode("The stream contains data after its terminal record.", "protocol");
    while (!this.ended) {
      await this.readMore(waitForRead);
      if (this.buffer.length) throw errorWithCode("The stream contains data after its terminal record.", "protocol");
    }
  }

  async next(waitForRead = (promise) => promise) {
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline >= 0) {
        if (newline === 0 || newline > this.maximumRecordBytes) {
          throw errorWithCode("The stream contains an invalid or oversized record.", "size");
        }
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const record = this.parser.parseLine(line);
        if (record.type === "done" || record.type === "error") await this.ensureTerminalEof(waitForRead);
        return record;
      }
      if (this.ended) {
        if (this.buffer.length) throw errorWithCode("The final stream record is missing its newline.", "protocol");
        throw errorWithCode("The stream ended before a terminal record.", "protocol");
      }
      if (this.buffer.length > this.maximumRecordBytes) throw errorWithCode("A stream record is too large.", "size");
      await this.readMore(waitForRead);
    }
  }

  async cancel() {
    try { await this.reader.cancel(); } catch { /* cancellation is best effort */ }
    this.reader.releaseLock?.();
  }

  release() { this.reader.releaseLock?.(); }
}

function isNDJSON(value) {
  return (value || "").split(";", 1)[0].trim().toLowerCase() === "application/x-ndjson";
}

export function newRequestId(cryptoObject = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoObject?.getRandomValues?.(bytes);
  if (bytes.every((value) => value === 0)) bytes[15] = 1;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function recordClientTelemetry(event, fetchObject = globalThis.fetch) {
  if (typeof fetchObject !== "function" || typeof document === "undefined") return;
  const payload = {
    version: 1,
    events: [{
      type: "api", requestId: event.requestId, operation: "api.unknown", method: "POST",
      outcome: event.outcome, ...(event.status === undefined ? {} : { status: event.status }),
      durationMs: Math.max(0, Math.min(3_600_000, event.durationMs)),
      online: globalThis.navigator?.onLine !== false,
      visible: document.visibilityState === "visible",
    }],
  };
  void fetchObject("/api/client-telemetry", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), keepalive: true,
  }).catch(() => {});
}

export function audioPlaybackWindow(buffer) {
  const fallbackDuration = Number.isFinite(buffer?.duration) && buffer.duration > 0
    ? buffer.duration
    : Math.max(0.001, ((buffer?.bytes?.byteLength ?? 44) - 44) / 48_000);
  if (typeof buffer?.getChannelData !== "function" || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0) {
    return { offset: 0, duration: fallbackDuration };
  }
  try {
    const sampleRate = buffer.sampleRate;
    const channels = Math.max(1, buffer.numberOfChannels ?? 1);
    const frames = buffer.length ?? Math.round(fallbackDuration * sampleRate);
    const windowFrames = Math.max(1, Math.round(sampleRate * 0.02));
    const energies = [];
    let peakEnergy = 0;
    for (let start = 0; start < frames; start += windowFrames) {
      const end = Math.min(frames, start + windowFrames);
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
      }
      const energy = sum / Math.max(1, (end - start) * channels);
      energies.push(energy);
      peakEnergy = Math.max(peakEnergy, energy);
    }
    const threshold = Math.max(2.5e-7, peakEnergy * 0.0004);
    const first = energies.findIndex((energy) => energy >= threshold);
    let last = energies.length - 1;
    while (last >= 0 && energies[last] < threshold) last -= 1;
    if (first < 0 || last < first) return { offset: 0, duration: fallbackDuration };
    const paddingFrames = Math.round(sampleRate * AUDIO_TRIM_PADDING_SECONDS);
    const startFrame = Math.max(0, (first * windowFrames) - paddingFrames);
    const endFrame = Math.min(frames, ((last + 1) * windowFrames) + paddingFrames);
    if (endFrame - startFrame < sampleRate * 0.1) return { offset: 0, duration: fallbackDuration };
    return { offset: startFrame / sampleRate, duration: (endFrame - startFrame) / sampleRate };
  } catch {
    return { offset: 0, duration: fallbackDuration };
  }
}

export class ChatterboxPlayer {
  constructor(dependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch?.bind(globalThis);
    this.getSettings = dependencies.getSettings ?? (() => loadSettings());
    this.createAudioContext = dependencies.createAudioContext ?? (() => {
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable.");
      return new AudioContextClass();
    });
    this.pageProtocol = dependencies.pageProtocol ?? (() => globalThis.location?.protocol);
    this.setTimeout = dependencies.setTimeout ?? globalThis.setTimeout?.bind(globalThis);
    this.clearTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout?.bind(globalThis);
    this.now = dependencies.now ?? (() => Date.now());
    this.logger = dependencies.logger ?? globalThis.console;
    this.onState = dependencies.onState ?? (() => {});
    this.telemetry = dependencies.telemetry ?? recordClientTelemetry;
    this.context = undefined;
    this.autoplayKeepalive = undefined;
    this.activeRun = undefined;
    this.nextRunId = 0;
  }

  isActive(run) { return this.activeRun === run && !run.cancelled; }

  emit(run, state, detail = {}) {
    if (!this.isActive(run)) return;
    this.onState({ run, state, ...detail });
  }

  async prime(run) {
    if (!this.context || this.context.state === "closed") {
      this.releaseAutoplay();
      this.context = this.createAudioContext();
    }
    await this.context.resume?.();
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
  }

  async primeForAutoplay() {
    if (!this.context || this.context.state === "closed") {
      this.releaseAutoplay();
      this.context = this.createAudioContext();
    }
    await this.context.resume?.();
    if (this.context.state !== "running") throw errorWithCode("Tap Enable Auto-Read again to unlock audio.", "autoplay");
    if (!this.autoplayKeepalive && this.context.createBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.context.createBuffer(1, this.context.sampleRate || 24_000, this.context.sampleRate || 24_000);
      source.buffer.getChannelData?.(0).fill(1e-7);
      source.loop = true;
      source.connect(this.context.destination);
      source.start(0);
      this.autoplayKeepalive = source;
    }
  }

  releaseAutoplay() {
    const source = this.autoplayKeepalive;
    this.autoplayKeepalive = undefined;
    if (!source) return;
    try { source.stop(); } catch { /* already ended */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
  }

  recordRun(run, outcome, status) {
    if (run.telemetrySent) return;
    run.telemetrySent = true;
    this.telemetry?.({
      requestId: run.requestId, outcome, status,
      durationMs: this.now() - run.startedAt,
    });
  }

  stop() {
    const run = this.activeRun;
    if (!run) return;
    run.cancelled = true;
    this.recordRun(run, "abort");
    run.controller.abort();
    run.wake?.();
    run.wake = undefined;
    void run.reader?.cancel();
    run.reader = undefined;
    for (const source of run.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    run.sources.clear();
    for (const settle of [...run.settlements]) settle();
    run.settlements.clear();
    run.source = undefined;
    this.activeRun = undefined;
    this.onState({ run, state: "idle" });
  }

  async toggle({ messageId, button, text }) {
    if (this.activeRun?.messageId === messageId) {
      this.stop();
      return { status: "cancelled" };
    }
    this.stop();
    const run = Object.seal({
      id: ++this.nextRunId, messageId, button, controller: new AbortController(),
      source: undefined, sources: new Set(), settlements: new Set(), reader: undefined, cancelled: false,
      requestId: newRequestId(), startedAt: this.now(), telemetrySent: false,
      mode: "manual", queue: [], queueChars: 0, final: false, wake: undefined, scheduled: undefined,
      reopenEpoch: 0,
    });
    this.activeRun = run;
    this.emit(run, "loading", { chunkIndex: 0 });
    try {
      await this.prime(run);
      const speech = markdownToSpeech(text);
      if (!speech) throw errorWithCode("This message has no speakable text.", "empty");
      const settings = validateSettings(this.getSettings(), { pageProtocol: this.pageProtocol?.() });
      const streamed = await this.playStream(run, speech, settings);
      if (streamed === "fallback") await this.playLegacy(run, speech, settings);
      if (!this.isActive(run)) return { status: "stale" };
      this.recordRun(run, "success", 200);
      this.activeRun = undefined;
      this.onState({ run, state: "idle" });
      return { status: "complete" };
    } catch (error) {
      if (!this.isActive(run) || error?.code === "stale") return { status: "stale" };
      const outcome = error?.code === "timeout" ? "timeout"
        : error?.code === "protocol" || error?.code === "mime" ? "parse"
          : error?.code === "http" ? "http.other" : "network";
      this.recordRun(run, outcome);
      this.logger?.error?.("Chatterbox TTS failed", { requestId: run.requestId, error });
      this.emit(run, "error", { message: this.publicError(error) });
      this.activeRun = undefined;
      return { status: "error", error };
    } finally {
      const reader = run.reader;
      run.reader = undefined;
      if (reader) {
        if (this.isActive(run)) reader.release();
        else void reader.cancel();
      }
    }
  }

  publicError(error) {
    const known = {
      empty: error.message, "mixed-content": error.message, mime: error.message,
      size: error.message, endpoint: error.message, timeout: error.message,
    };
    return known[error?.code] ?? "Speech could not be generated. See the browser console for details.";
  }

  withDeadline(run, promise, milliseconds, message) {
    if (milliseconds <= 0) {
      const error = errorWithCode(message, "timeout");
      run.controller.abort(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clearTimeout?.(timer);
        callback(value);
      };
      const timer = this.setTimeout?.(() => {
        const error = errorWithCode(message, "timeout");
        run.controller.abort(error);
        finish(reject, error);
      }, milliseconds);
      promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  requestBody(input, settings) {
    return JSON.stringify({
      model: "chatterbox", input, voice: settings.voice, response_format: "wav", speed: settings.speed,
    });
  }

  async playStream(run, speech, settings, options = {}) {
    const firstDeadline = this.now() + FIRST_RECORD_TIMEOUT_MS;
    const firstWait = (promise) => this.withDeadline(
      run, promise, firstDeadline - this.now(), "The first speech chunk timed out.",
    );
    const response = await firstWait(this.fetch(`${settings.endpoint}/v1/audio/speech/stream`, {
      method: "POST", headers: {
        "Content-Type": "application/json", "X-Chatterbox-Request-Id": run.requestId,
      },
      body: this.requestBody(speech, settings), signal: run.controller.signal,
    }));
    if (response?.status === 404 || response?.status === 405) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      return "fallback";
    }
    if (!response?.ok) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      throw errorWithCode(`Chatterbox returned HTTP ${response?.status ?? "unknown"}`, "http");
    }
    if (!isNDJSON(response.headers?.get?.("content-type"))) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      throw errorWithCode("Chatterbox returned an unsupported stream format.", "mime");
    }
    if (response.headers?.get?.("x-chatterbox-stream-version") !== STREAM_PROTOCOL_VERSION) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      throw errorWithCode("Chatterbox returned an unsupported stream protocol version.", "protocol");
    }

    const records = new NDJSONRecordReader(response.body);
    run.reader = records;
    let record = await records.next(firstWait);
    if (record.type === "error") throw errorWithCode(record.error, "server");
    if (record.type !== "audio") throw errorWithCode("The stream completed without audio.", "protocol");
    let prepared = await this.decodeChunk(run, record.audio);
    let current = await this.schedulePrepared(run, prepared, record.index, undefined, options.requestedStart);

    while (true) {
      if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
      // Pull/decode one successor while the current source plays, then put it
      // on the same AudioContext timeline before relying on an onended event.
      const outcome = await this.nextPreparedStreamRecord(run, records).then(
        (successor) => ({ successor }), (error) => ({ error }),
      );
      if (outcome.error) throw outcome.error;
      const { successor } = outcome;
      if (successor.record.type === "done") {
        if (options.waitForPlayback !== false) await current.ended;
        break;
      }
      const nextStart = current.endAt - AUDIO_BOUNDARY_OVERLAP_SECONDS;
      const scheduled = await this.schedulePrepared(
        run, successor.prepared, successor.record.index, undefined, nextStart,
      );
      await current.ended;
      current = scheduled;
      record = successor.record;
      prepared = successor.prepared;
    }
    records.release();
    run.reader = undefined;
    return options.waitForPlayback === false ? { scheduled: current } : "streamed";
  }

  async startAuto({ messageId, button }) {
    this.stop();
    if (!this.context || this.context.state !== "running") {
      throw errorWithCode("Auto-Read needs a user gesture to unlock audio.", "autoplay");
    }
    const run = Object.seal({
      id: ++this.nextRunId, messageId, button, controller: new AbortController(),
      source: undefined, sources: new Set(), settlements: new Set(), reader: undefined, cancelled: false,
      requestId: newRequestId(), startedAt: this.now(), telemetrySent: false,
      mode: "auto", queue: [], queueChars: 0, final: false, wake: undefined, scheduled: undefined,
      reopenEpoch: 0,
    });
    this.activeRun = run;
    this.emit(run, "loading", { chunkIndex: 0 });
    void this.drainAuto(run);
    return run;
  }

  enqueueAuto(run, speech) {
    const text = typeof speech === "string" ? speech.trim() : "";
    if (!text || !this.isActive(run) || run.mode !== "auto" || run.final) return false;
    const separatorChars = run.queue.length >= MAX_AUTO_QUEUE_SEGMENTS ? 1 : 0;
    if (run.queueChars + separatorChars + text.length > MAX_AUTO_QUEUE_CHARS) return false;
    if (run.queue.length >= MAX_AUTO_QUEUE_SEGMENTS) {
      const last = run.queue.length - 1;
      run.queue[last] = `${run.queue[last]} ${text}`;
    } else run.queue.push(text);
    run.queueChars += separatorChars + text.length;
    run.wake?.();
    run.wake = undefined;
    return true;
  }

  reopenAuto(run) {
    if (!this.isActive(run) || run.mode !== "auto") return false;
    run.reopenEpoch += 1;
    run.final = false;
    run.wake?.();
    run.wake = undefined;
    return true;
  }

  finishAuto(run) {
    if (!this.isActive(run) || run.mode !== "auto") return;
    run.final = true;
    run.wake?.();
    run.wake = undefined;
  }

  async drainAuto(run) {
    try {
      const settings = validateSettings(this.getSettings(), { pageProtocol: this.pageProtocol?.() });
      while (this.isActive(run)) {
        if (run.queue.length) {
          const speech = run.queue.shift();
          run.queueChars -= speech.length;
          run.requestId = newRequestId();
          const requestedStart = run.scheduled?.endAt === undefined
            ? undefined : run.scheduled.endAt - AUDIO_BOUNDARY_OVERLAP_SECONDS;
          const result = await this.playStream(run, speech, settings, {
            waitForPlayback: false, requestedStart,
          });
          run.scheduled = result.scheduled;
          continue;
        }
        if (run.final) {
          if (run.scheduled) {
            const scheduled = run.scheduled;
            const epoch = run.reopenEpoch;
            let wake;
            const reopened = new Promise((resolve) => {
              wake = () => resolve("reopened");
              run.wake = wake;
            });
            const outcome = await Promise.race([
              scheduled.ended.then(() => "ended"), reopened,
            ]);
            if (run.wake === wake) run.wake = undefined;
            if (!this.isActive(run)) return;
            if (outcome === "reopened"
              || epoch !== run.reopenEpoch
              || scheduled !== run.scheduled
              || !run.final
              || run.queue.length) continue;
          }
          this.recordRun(run, "success", 200);
          this.activeRun = undefined;
          this.onState({ run, state: "idle" });
          return;
        }
        await new Promise((resolve) => { run.wake = resolve; });
        run.wake = undefined;
      }
    } catch (error) {
      if (!this.isActive(run) || error?.code === "stale") return;
      this.recordRun(run, error?.code === "timeout" ? "timeout" : "network");
      this.logger?.error?.("Chatterbox Auto-Read failed", { requestId: run.requestId, error });
      this.emit(run, "error", { message: this.publicError(error) });
      this.activeRun = undefined;
    } finally {
      const reader = run.reader;
      run.reader = undefined;
      if (reader) {
        if (this.isActive(run)) reader.release();
        else void reader.cancel();
      }
    }
  }

  async nextPreparedStreamRecord(run, records) {
    const idleWait = (promise) => this.withDeadline(run, promise, STREAM_IDLE_TIMEOUT_MS, "The speech stream became idle.");
    const record = await records.next(idleWait);
    if (record.type === "error") throw errorWithCode(record.error, "server");
    if (record.type === "done") return { record };
    return { record, prepared: await this.decodeChunk(run, record.audio) };
  }

  async decodeChunk(run, bytes) {
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const buffer = await this.context.decodeAudioData(copy);
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
    return buffer;
  }

  async playLegacy(run, speech, settings) {
    const chunks = chunkSpeech(speech);
    let prepared = await this.prepareLegacyChunk(run, chunks[0], settings);
    for (let index = 0; index < chunks.length; index += 1) {
      if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
      const playback = this.playPrepared(run, prepared, index, chunks.length);
      const next = index + 1 < chunks.length
        ? this.prepareLegacyChunk(run, chunks[index + 1], settings).then(
          (successor) => ({ successor }), (error) => ({ error }),
        ) : undefined;
      await playback;
      if (next) {
        const outcome = await next;
        if (outcome.error) throw outcome.error;
        prepared = outcome.successor;
      }
    }
  }

  async prepareLegacyChunk(run, input, settings) {
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
    const response = await this.withDeadline(run, this.fetch(`${settings.endpoint}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Chatterbox-Request-Id": run.requestId,
      },
      body: this.requestBody(input, settings),
      signal: run.controller.signal,
    }), FETCH_TIMEOUT_MS, "Speech request timed out.");
    const bytes = await readAudioResponse(response);
    return await this.decodeChunk(run, new Uint8Array(bytes));
  }

  async schedulePrepared(run, buffer, chunkIndex, chunkCount, requestedStart) {
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
    // Mobile WebKit can suspend an unlocked AudioContext during a synthesis gap.
    if (this.context.state === "suspended") await this.context.resume();
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
    const window = audioPlaybackWindow(buffer);
    const contextNow = Number.isFinite(this.context.currentTime) ? this.context.currentTime : 0;
    const startAt = Math.max(contextNow + 0.01, requestedStart ?? contextNow + 0.01);
    const source = this.context.createBufferSource();
    let settled = false;
    let settle;
    const ended = new Promise((resolve) => {
      settle = () => {
        if (settled) return;
        settled = true;
        run.sources.delete(source);
        run.settlements.delete(settle);
        try { source.disconnect(); } catch { /* ignored */ }
        if (run.source === source) run.source = undefined;
        resolve();
      };
    });
    run.source = source;
    run.sources.add(source);
    run.settlements.add(settle);
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = settle;
    source.start(startAt, window.offset, window.duration);
    this.emit(run, "playing", { chunkIndex, chunkCount });
    return { ended, endAt: startAt + window.duration };
  }

  async playPrepared(run, buffer, chunkIndex, chunkCount) {
    const scheduled = await this.schedulePrepared(run, buffer, chunkIndex, chunkCount);
    await scheduled.ended;
  }

  async dispose() {
    this.stop();
    this.releaseAutoplay();
    if (this.context && this.context.state !== "closed") await this.context.close?.();
    this.context = undefined;
  }
}

export function setButtonState(button, state, message = "") {
  if (!button) return;
  const errorLabel = message || "Speech could not be generated";
  const values = {
    idle: ["🔊", "Speak this assistant message", "false"],
    loading: ["…", "Generating speech… Click to cancel", "true"],
    playing: ["■", "Stop speech", "true"],
    error: [`⚠ ${errorLabel.slice(0, 64)}`, errorLabel, "false"],
  };
  const [symbol, label, pressed] = values[state] ?? values.idle;

  // PI WEB's chat observer watches child-list mutations. Reassigning textContent
  // unconditionally from inside reconciliation creates a self-sustaining
  // observer loop that can lock the browser tab. Keep every update idempotent.
  if (button.textContent !== symbol) button.textContent = symbol;
  if (button.title !== label) button.title = label;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
  if (button.dataset.state !== state) button.dataset.state = state;
}

export function setLiveRegionText(region, text) {
  if (region && region.textContent !== text) region.textContent = text;
}

export function shouldStopForDetachedButton(run, chatRoot) {
  return Boolean(run && run.mode !== "auto" && !chatRoot.contains?.(run.button));
}

export function createCoalescedCallback(
  callback,
  schedule = globalThis.queueMicrotask?.bind(globalThis) ?? ((task) => Promise.resolve().then(task)),
) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      callback();
    });
  };
}

let browserRuntime;

const PLUGIN_UPDATE_INTERVAL_MS = 30_000;
const PLUGIN_MANIFEST_PATH = "/pi-web-plugins/manifest.json";

export function inspectAutoReadView(root, documentObject = globalThis.document) {
  const view = root?.host;
  if (!view || view.shadowRoot !== root || view.isConnected === false) return { available: false };
  if (typeof view.sessionId !== "string" || typeof view.status?.isStreaming !== "boolean") {
    return { available: false };
  }
  const messages = enumerateAssistantMessages(root);
  const users = Array.from(root.querySelectorAll?.(DOM_CONTRACT.userSelector) ?? []);
  const latestAssistant = messages.at(-1);
  const latestUser = users.at(-1);
  const assistantIndex = Number(latestAssistant?.getAttribute?.("data-index"));
  const userIndex = Number(latestUser?.getAttribute?.("data-index"));
  const assistantFollowsUser = !latestUser || (Number.isFinite(assistantIndex) && assistantIndex > userIndex);
  const message = assistantFollowsUser ? latestAssistant : undefined;
  const messageIdentity = message ? deriveMessageIdentity(message, messages.length - 1) : undefined;
  const responseIdentity = latestUser
    ? deriveMessageIdentity(latestUser, users.length - 1)
    : messageIdentity;
  const button = message?.querySelector?.(`[${DOM_CONTRACT.buttonMarker}]`);
  const responseLive = view.status.isStreaming
    || view.isSendingPrompt === true
    || view.status.isBashRunning === true
    || view.activity?.phase === "active";
  return {
    available: true,
    view,
    sessionId: view.sessionId,
    isStreaming: responseLive,
    hidden: documentObject?.visibilityState === "hidden",
    turnId: responseIdentity ? `${view.sessionId}:response:${responseIdentity}` : undefined,
    // Keep this identical to the button's DOM identity so reconciliation can
    // transfer an active Auto-Read run when Lit replaces the message element.
    messageId: messageIdentity,
    message,
    button,
    text: message ? extractAssistantText(message) : "",
  };
}

export class AutoReadController {
  constructor(player, dependencies = {}) {
    this.player = player;
    const telemetry = dependencies.telemetry ?? recordClientTelemetry;
    this.telemetry = (event) => telemetry({
      requestId: newRequestId(), durationMs: 0, ...event,
    });
    this.onNotice = dependencies.onNotice ?? (() => {});
    this.enabled = false;
    this.generation = 0;
    this.sessionId = undefined;
    this.baselineTurnId = undefined;
    this.turnId = undefined;
    this.messageId = undefined;
    this.lastRaw = "";
    this.committedSpeech = "";
    this.run = undefined;
    this.suppressedTurnId = undefined;
  }

  baseline(snapshot) {
    this.sessionId = snapshot?.available ? snapshot.sessionId : undefined;
    this.baselineTurnId = snapshot?.available ? snapshot.turnId : undefined;
  }

  async enable(snapshot) {
    const transition = ++this.generation;
    await this.player.primeForAutoplay();
    if (transition !== this.generation) return false;
    this.enabled = true;
    this.baseline(snapshot);
    return true;
  }

  disable(snapshot) {
    this.enabled = false;
    this.cancel(false);
    this.baseline(snapshot);
  }

  playbackFailed() {
    this.enabled = false;
    this.onNotice("Auto-Read paused. Use Enable / Resume to unlock audio again.");
    this.cancel(true);
  }

  cancel(suppress = true) {
    this.generation += 1;
    if (suppress && this.turnId) this.suppressedTurnId = this.turnId;
    this.player.stop();
    this.turnId = undefined;
    this.messageId = undefined;
    this.run = undefined;
    this.lastRaw = "";
    this.committedSpeech = "";
  }

  suppressCurrent() { this.cancel(true); }

  enqueueSnapshot(raw, final) {
    if (typeof raw !== "string" || raw.length > MAX_AUTO_SOURCE_CHARS) {
      this.cancel(true);
      return false;
    }
    if (this.lastRaw && !raw.startsWith(this.lastRaw)) {
      this.telemetry?.({ outcome: "auto.revision", sourceChars: raw.length });
      this.cancel(true);
      return false;
    }
    this.lastRaw = raw;
    const { speech } = streamingSpeechSnapshot(raw, final);
    if (!speech.startsWith(this.committedSpeech)) {
      this.telemetry?.({ outcome: "auto.projection_revision", sourceChars: raw.length });
      this.cancel(true);
      return false;
    }
    const delta = speech.slice(this.committedSpeech.length).trim();
    if (delta) {
      if (!this.player.enqueueAuto(this.run, delta)) {
        this.telemetry?.({ outcome: "auto.backpressure", queueChars: this.run?.queueChars ?? 0 });
        this.onNotice("Auto-Read paused because speech fell behind the response.");
        this.suppressedTurnId = this.turnId;
        this.player.finishAuto(this.run);
        this.turnId = undefined;
        this.messageId = undefined;
        this.run = undefined;
        this.lastRaw = "";
        this.committedSpeech = "";
        return false;
      }
      this.telemetry?.({ outcome: "auto.segment", inputChars: delta.length });
      this.committedSpeech = speech;
    }
    return true;
  }

  async poll(snapshot) {
    if (!this.enabled) { this.baseline(snapshot); return; }
    if (!snapshot?.available || snapshot.hidden) {
      if (this.turnId) this.cancel(false);
      this.baseline(snapshot);
      return;
    }
    if (snapshot.sessionId !== this.sessionId) {
      this.cancel(false);
      this.baseline(snapshot);
      return;
    }
    if (this.suppressedTurnId) {
      const nextTurn = snapshot.turnId && snapshot.turnId !== this.suppressedTurnId;
      if (nextTurn) {
        this.baselineTurnId = this.suppressedTurnId;
        this.suppressedTurnId = undefined;
      } else if (!snapshot.isStreaming) {
        this.suppressedTurnId = undefined;
        this.baseline(snapshot);
        return;
      } else return;
    }
    if (!this.turnId) {
      if (!snapshot.turnId || !snapshot.messageId || snapshot.turnId === this.baselineTurnId) {
        if (!snapshot.isStreaming) this.baseline(snapshot);
        return;
      }
      const active = this.player.activeRun;
      if (active && active.mode !== "auto") {
        this.telemetry?.({ outcome: "auto.busy" });
        this.baselineTurnId = snapshot.turnId;
        return;
      }
      const generation = ++this.generation;
      this.turnId = snapshot.turnId;
      this.messageId = snapshot.messageId;
      this.lastRaw = "";
      this.committedSpeech = "";
      if (active && this.player.reopenAuto(active)) {
        this.run = active;
        active.messageId = snapshot.messageId;
        active.button = snapshot.button;
        this.telemetry?.({ outcome: "auto.turn_queued" });
      } else {
        try {
          this.run = await this.player.startAuto({
            messageId: snapshot.messageId, button: snapshot.button,
          });
        } catch (error) {
          if (generation === this.generation) {
            this.telemetry?.({ outcome: "auto.blocked" });
            this.enabled = false;
            this.onNotice("Auto-Read needs a tap on Enable / Resume before it can play audio.");
            this.cancel(true);
          }
          return;
        }
        if (generation !== this.generation) return;
      }
    }
    if (snapshot.turnId !== this.turnId) {
      // A PI steer/follow-up can introduce the next user turn without an
      // observable non-streaming gap. Keep the same audio run open rather than
      // baselining and silently skipping the new assistant continuation.
      if (!this.enqueueSnapshot(this.lastRaw, true)) return;
      this.turnId = snapshot.turnId;
      this.messageId = snapshot.messageId;
      this.lastRaw = "";
      this.committedSpeech = "";
      if (this.run) {
        this.run.messageId = snapshot.messageId;
        this.run.button = snapshot.button;
      }
      this.telemetry?.({ outcome: "auto.turn_queued" });
    }
    if (snapshot.messageId && snapshot.messageId !== this.messageId) {
      if (!this.enqueueSnapshot(this.lastRaw, true)) return;
      this.messageId = snapshot.messageId;
      this.lastRaw = "";
      this.committedSpeech = "";
      if (this.run) {
        this.run.messageId = snapshot.messageId;
        this.run.button = snapshot.button;
      }
    }
    if (!snapshot.messageId || snapshot.messageId !== this.messageId) return;
    if (!this.enqueueSnapshot(snapshot.text, !snapshot.isStreaming)) return;
    if (!snapshot.isStreaming) {
      this.player.finishAuto(this.run);
      this.baselineTurnId = this.turnId;
      this.turnId = undefined;
      this.messageId = undefined;
      this.run = undefined;
      this.lastRaw = "";
      this.committedSpeech = "";
    }
  }
}

async function reloadForPluginUpdate(player) {
  if (player.activeRun || document.visibilityState !== "visible") return;
  try {
    const response = await fetch(PLUGIN_MANIFEST_PATH, { cache: "no-store" });
    if (!response.ok) return;
    const manifest = await response.json();
    const entry = manifest?.plugins?.find?.((candidate) => candidate.id === "chatterbox-tts");
    if (!entry?.module) return;
    const latestUrl = new URL(entry.module, window.location.origin).href;
    if (latestUrl === import.meta.url) return;
    const guardKey = `pi-web.chatterbox-tts.reloaded:${latestUrl}`;
    if (window.sessionStorage.getItem(guardKey)) return;
    window.sessionStorage.setItem(guardKey, "1");
    console.info("Chatterbox TTS: reloading PI WEB for plugin update", { from: import.meta.url, to: latestUrl });
    window.location.reload();
  } catch (error) {
    console.debug?.("Chatterbox TTS update check failed", error);
  }
}

function createBrowserRuntime() {
  if (browserRuntime) return browserRuntime;
  let root;
  let observer;
  let timer;
  let updateTimer;
  let autoTimer;
  let autoPolling = false;
  let autoPollPending = false;
  let disposed = false;
  let warned = false;
  let liveRegion;

  const announce = (text) => setLiveRegionText(liveRegion, text);
  let autoRead;
  const player = new ChatterboxPlayer({
    onState: ({ run, state, message, chunkIndex, chunkCount }) => {
      setButtonState(run.button, state, message);
      if (run.mode === "auto" && state === "error") autoRead?.playbackFailed();
      const suffix = state === "playing" && chunkCount > 1 ? `, part ${chunkIndex + 1} of ${chunkCount}` : "";
      announce(state === "error" ? message : state === "playing" ? `Speech playing${suffix}` : state === "loading" ? "Generating speech" : "Speech stopped");
    },
  });
  autoRead = new AutoReadController(player, { onNotice: announce });

  const autoSnapshot = () => inspectAutoReadView(root);
  const scheduleAutoPoll = (delay) => {
    window.clearTimeout(autoTimer);
    if (disposed) return;
    autoTimer = window.setTimeout(() => {
      autoTimer = undefined;
      void pollAutoRead();
    }, delay);
  };
  const pollAutoRead = async () => {
    if (autoPolling) { autoPollPending = true; return; }
    autoPolling = true;
    const snapshot = autoSnapshot();
    try { await autoRead.poll(snapshot); }
    finally {
      autoPolling = false;
      const immediate = autoPollPending;
      autoPollPending = false;
      const fast = autoRead.enabled && snapshot.available && snapshot.isStreaming && !snapshot.hidden;
      scheduleAutoPoll(immediate ? 0 : fast ? AUTO_READ_POLL_MS : AUTO_READ_HIDDEN_POLL_MS);
    }
  };

  const setAutoRead = async (enabled) => {
    const current = loadSettings();
    try {
      if (enabled) {
        if (!current.autoRead) {
          const destination = new URL(current.endpoint).origin;
          if (!window.confirm(`Auto-Read will automatically send new assistant prose to:\n${destination}\n\nEnable it for this browser?`)) return;
        }
        if (!await autoRead.enable(autoSnapshot())) return;
      } else {
        autoRead.disable(autoSnapshot());
        player.releaseAutoplay();
      }
      saveSettings({ ...current, autoRead: enabled });
      announce(enabled ? "Auto-Read enabled" : "Auto-Read disabled");
      if (enabled) window.alert("Chatterbox Auto-Read is armed for the next assistant response.");
    } catch (error) {
      autoRead.playbackFailed();
      window.alert(`Chatterbox Auto-Read could not be armed: ${error?.message ?? "unknown error"}`);
    }
  };

  const showAutoReadStatus = () => {
    const snapshot = autoSnapshot();
    const settings = loadSettings();
    window.alert([
      `Saved preference: ${settings.autoRead ? "on" : "off"}`,
      `Controller: ${autoRead.enabled ? "armed" : "not armed"}`,
      `Audio context: ${player.context?.state ?? "not created"}`,
      `Audio keepalive: ${player.autoplayKeepalive ? "active" : "inactive"}`,
      `DOM adapter: ${snapshot.available ? "ready" : "unavailable"}`,
      `Session streaming: ${snapshot.available ? String(snapshot.isStreaming) : "unknown"}`,
      `Turn detected: ${snapshot.turnId ? "yes" : "no"}`,
      `Active speech run: ${player.activeRun?.mode ?? "none"}`,
    ].join("\n"));
  };

  const reconcile = (chatRoot) => {
    const messages = enumerateAssistantMessages(chatRoot);
    messages.forEach((message, index) => {
      const actions = locateActionContainer(message);
      if (!actions) return;
      const identity = deriveMessageIdentity(message, index);
      const existing = actions.querySelector?.(`[${DOM_CONTRACT.buttonMarker}]`);
      if (existing) {
        existing.dataset.messageIdentity = identity;
        if (player.activeRun?.messageId === identity) {
          player.activeRun.button = existing;
          setButtonState(existing, player.activeRun.source ? "playing" : "loading");
        }
        return;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "msg-action";
      button.setAttribute(DOM_CONTRACT.buttonMarker, "");
      button.dataset.messageIdentity = identity;
      setButtonState(button, "idle");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (autoRead.turnId) autoRead.suppressCurrent();
        void player.toggle({ messageId: button.dataset.messageIdentity, button, text: extractAssistantText(message) });
      });
      actions.prepend(button);
      if (player.activeRun?.messageId === identity) {
        player.activeRun.button = button;
        setButtonState(button, player.activeRun.source ? "playing" : "loading");
      }
    });
    if (shouldStopForDetachedButton(player.activeRun, chatRoot)) {
      player.stop();
    } else if (player.activeRun?.mode === "auto"
      && !chatRoot.contains?.(player.activeRun.button)) {
      // Follow-up queue rendering can temporarily remove the prior assistant
      // element. The Auto-Read controller owns run lifetime across that gap.
      player.activeRun.button = undefined;
    }
  };

  const discover = () => {
    const found = discoverChatRoot();
    if (!found) {
      if (!warned) { console.warn("Chatterbox TTS: compatible PI WEB chat DOM was not found."); warned = true; }
      return;
    }
    if (found !== root) {
      autoRead.cancel(false);
      observer?.disconnect();
      root = found;
      liveRegion = root.querySelector?.(`[${DOM_CONTRACT.liveMarker}]`);
      if (!liveRegion) {
        liveRegion = document.createElement("div");
        liveRegion.setAttribute(DOM_CONTRACT.liveMarker, "");
        liveRegion.setAttribute("aria-live", "polite");
        liveRegion.setAttribute("role", "status");
        Object.assign(liveRegion.style, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)" });
        root.append(liveRegion);
      }
      const scheduleReconcile = createCoalescedCallback(() => {
        reconcile(root);
        scheduleAutoPoll(0);
      });
      observer = new MutationObserver(scheduleReconcile);
      observer.observe(root, { childList: true, subtree: true });
    }
    reconcile(root);
  };
  discover();
  timer = window.setInterval(discover, 1000);
  scheduleAutoPoll(0);
  updateTimer = window.setInterval(() => void reloadForPluginUpdate(player), PLUGIN_UPDATE_INTERVAL_MS);
  window.setTimeout(() => void reloadForPluginUpdate(player), 5_000);
  let unlockPromise;
  const unlockPersistedAutoRead = () => {
    const needsUnlock = player.context?.state !== "running" || !player.autoplayKeepalive;
    if (!loadSettings().autoRead || (autoRead.enabled && !needsUnlock) || unlockPromise) return;
    unlockPromise = autoRead.enable(autoSnapshot())
      .catch((error) => console.warn("Chatterbox Auto-Read audio unlock failed", error))
      .finally(() => { unlockPromise = undefined; });
  };
  document.addEventListener("pointerdown", unlockPersistedAutoRead, { capture: true });
  document.addEventListener("keydown", unlockPersistedAutoRead, { capture: true });
  browserRuntime = { player, autoRead, setAutoRead, showAutoReadStatus, stop: () => {
    autoRead.suppressCurrent();
    player.stop();
  }, dispose: async () => {
    disposed = true;
    window.clearInterval(timer);
    window.clearInterval(updateTimer);
    window.clearTimeout(autoTimer);
    document.removeEventListener("pointerdown", unlockPersistedAutoRead, { capture: true });
    document.removeEventListener("keydown", unlockPersistedAutoRead, { capture: true });
    observer?.disconnect();
    autoRead.disable(autoSnapshot());
    await player.dispose();
    browserRuntime = undefined;
  } };
  return browserRuntime;
}

async function healthCheck(settings) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${settings.endpoint}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally { window.clearTimeout(timer); }
}

async function configureBrowser() {
  const current = loadSettings();
  const endpointInput = window.prompt("Chatterbox server URL", current.endpoint);
  if (endpointInput === null) return;
  const voice = window.prompt("Voice (alloy or narrator)", current.voice);
  if (voice === null) return;
  const speed = window.prompt("Speed (0.25–4)", String(current.speed));
  if (speed === null) return;
  let next;
  try { next = validateSettings({ endpoint: endpointInput, voice, speed, autoRead: current.autoRead }); }
  catch (error) { window.alert(error.message); return; }
  const oldOrigin = new URL(current.endpoint).origin;
  const newOrigin = new URL(next.endpoint).origin;
  if (oldOrigin !== newOrigin && !window.confirm(`Assistant message text will be sent to:\n${newOrigin}\n\nSave this destination?`)) return;
  try { await healthCheck(next); }
  catch (error) {
    console.error("Chatterbox TTS health check failed", error);
    if (!window.confirm("The server health check failed. Save these settings anyway?")) return;
  }
  saveSettings(next);
  window.alert("Chatterbox TTS settings saved in this browser.");
}

const plugin = {
  apiVersion: 1,
  name: "Chatterbox TTS",
  activate: () => {
    const runtime = typeof window !== "undefined" && typeof document !== "undefined" ? createBrowserRuntime() : undefined;
    return {
      contributions: {
        actions: [
          { id: "configure", title: "Configure Chatterbox TTS", description: "Set and check the browser-local speech server, voice, and speed", group: "Voice", run: configureBrowser },
          { id: "enable-auto-read", title: "Enable / Resume Chatterbox Auto-Read", description: "Unlock audio and read new assistant responses while they stream", group: "Voice", enabled: () => !runtime?.autoRead.enabled, run: () => runtime?.setAutoRead(true) },
          { id: "disable-auto-read", title: "Disable Chatterbox Auto-Read", description: "Stop speech and disable automatic reading", group: "Voice", enabled: () => Boolean(runtime?.autoRead.enabled || loadSettings().autoRead), run: () => runtime?.setAutoRead(false) },
          { id: "auto-read-status", title: "Check Chatterbox Auto-Read Status", description: "Show browser audio and streaming detector state", group: "Voice", run: () => runtime?.showAutoReadStatus() },
          { id: "stop", title: "Stop Chatterbox Speech", description: "Stop current synthesis or playback and suppress the rest of this turn", group: "Voice", enabled: () => Boolean(runtime?.player.activeRun), run: () => runtime?.stop() },
          { id: "reload", title: "Reload Chatterbox TTS", description: "Reload PI WEB to activate the latest local TTS plugin version", group: "Voice", run: () => window.location.reload() },
        ],
        workspacePanels: [],
        workspaceLabels: [],
      },
    };
  },
};

export default plugin;
