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
});

export const DOM_CONTRACT = Object.freeze({
  appSelector: "pi-web-app",
  chatSelector: "chat-view",
  assistantSelector: "article.msg.assistant, section.group-msg.assistant",
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
  if (!voice) throw errorWithCode("Voice cannot be empty.", "voice");
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw errorWithCode("Speed must be from 0.25 to 4.", "speed");
  }
  return { endpoint, voice, speed };
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
    this.activeRun = undefined;
    this.nextRunId = 0;
  }

  isActive(run) { return this.activeRun === run && !run.cancelled; }

  emit(run, state, detail = {}) {
    if (!this.isActive(run)) return;
    this.onState({ run, state, ...detail });
  }

  async prime(run) {
    if (!this.context || this.context.state === "closed") this.context = this.createAudioContext();
    await this.context.resume?.();
    if (!this.isActive(run)) throw errorWithCode("Playback was cancelled.", "stale");
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

  async playStream(run, speech, settings) {
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
    let current = await this.schedulePrepared(run, prepared, record.index, undefined);

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
        await current.ended;
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
    return "streamed";
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
  let warned = false;
  let liveRegion;

  const announce = (text) => setLiveRegionText(liveRegion, text);
  const player = new ChatterboxPlayer({
    onState: ({ run, state, message, chunkIndex, chunkCount }) => {
      setButtonState(run.button, state, message);
      const suffix = state === "playing" && chunkCount > 1 ? `, part ${chunkIndex + 1} of ${chunkCount}` : "";
      announce(state === "error" ? message : state === "playing" ? `Speech playing${suffix}` : state === "loading" ? "Generating speech" : "Speech stopped");
    },
  });

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
        void player.toggle({ messageId: button.dataset.messageIdentity, button, text: extractAssistantText(message) });
      });
      actions.prepend(button);
      if (player.activeRun?.messageId === identity) {
        player.activeRun.button = button;
        setButtonState(button, player.activeRun.source ? "playing" : "loading");
      }
    });
    if (player.activeRun && !chatRoot.contains?.(player.activeRun.button)) player.stop();
  };

  const discover = () => {
    const found = discoverChatRoot();
    if (!found) {
      if (!warned) { console.warn("Chatterbox TTS: compatible PI WEB chat DOM was not found."); warned = true; }
      return;
    }
    if (found !== root) {
      player.stop();
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
      const scheduleReconcile = createCoalescedCallback(() => reconcile(root));
      observer = new MutationObserver(scheduleReconcile);
      observer.observe(root, { childList: true, subtree: true });
    }
    reconcile(root);
  };
  discover();
  timer = window.setInterval(discover, 1000);
  updateTimer = window.setInterval(() => void reloadForPluginUpdate(player), PLUGIN_UPDATE_INTERVAL_MS);
  window.setTimeout(() => void reloadForPluginUpdate(player), 5_000);
  browserRuntime = { player, dispose: async () => {
    window.clearInterval(timer);
    window.clearInterval(updateTimer);
    observer?.disconnect();
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
  try { next = validateSettings({ endpoint: endpointInput, voice, speed }); }
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
          { id: "stop", title: "Stop Chatterbox Speech", description: "Stop current synthesis or playback", group: "Voice", enabled: () => Boolean(runtime?.player.activeRun), run: () => runtime?.player.stop() },
          { id: "reload", title: "Reload Chatterbox TTS", description: "Reload PI WEB to activate the latest local TTS plugin version", group: "Voice", run: () => window.location.reload() },
        ],
        workspacePanels: [],
        workspaceLabels: [],
      },
    };
  },
};

export default plugin;
