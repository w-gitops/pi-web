import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FIRST_CHUNK_LENGTH, LATER_CHUNK_LENGTH, STREAM_IDLE_TIMEOUT_MS, MAX_AUDIO_BYTES,
  MAX_CHUNK_AUDIO_BYTES, DEFAULT_SETTINGS, DOM_CONTRACT,
  StreamProtocolParser, NDJSONRecordReader, ChatterboxPlayer,
  chunkSpeech, markdownToSpeech, audioPlaybackWindow, validateEndpoint, validateSettings,
  defaultEndpoint, loadSettings, enumerateAssistantMessages, deriveMessageIdentity,
  locateActionContainer, extractAssistantText, hasEnhancementMarker,
  setButtonState, setLiveRegionText, createCoalescedCallback,
  default as plugin,
} from "../pi-web-plugin.js";

const encoder = new TextEncoder();

function headers(values = {}) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (key) => map.get(key.toLowerCase()) ?? null };
}

function wavBytes(marker = 0) {
  return new Uint8Array([82, 73, 70, 70, marker, 0, 0, 0, 87, 65, 86, 69, marker]);
}

function audioRecord(index, bytes = wavBytes(index)) {
  return { type: "audio", index, audio: Buffer.from(bytes).toString("base64"), mime_type: "audio/wav" };
}

function lines(...records) {
  return encoder.encode(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function splitBytes(bytes, sizes = [bytes.length]) {
  const chunks = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
}

function streamBody(initialChunks, options = {}) {
  const chunks = [...initialChunks];
  const body = {
    reads: 0,
    cancelled: false,
    getReader() {
      return {
        async read() {
          body.reads += 1;
          if (chunks.length) return { done: false, value: chunks.shift() };
          if (options.gate) return options.gate.promise;
          return { done: true };
        },
        async cancel() {
          body.cancelled = true;
          options.gate?.resolve({ done: true });
        },
        releaseLock() { body.released = true; },
      };
    },
    async cancel() { body.cancelled = true; },
  };
  return body;
}

function streamResponse(records, options = {}) {
  const bytes = options.raw ?? lines(...records);
  const body = options.body ?? streamBody(splitBytes(bytes, options.sizes));
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: headers({
      "content-type": options.mime ?? "application/x-ndjson; charset=utf-8",
      "x-chatterbox-stream-version": options.version ?? "1",
    }),
    body,
    text: async () => options.text ?? "",
  };
}

function legacyResponse(bytes = wavBytes()) {
  return {
    ok: true, status: 200, headers: headers({ "content-type": "audio/wav" }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeAudioContext({ autoEnd = false } = {}) {
  const sources = [];
  const decoded = [];
  const context = {
    state: "suspended", destination: {},
    resume: async () => { context.state = "running"; },
    close: async () => { context.state = "closed"; },
    decodeAudioData: async (bytes) => { const value = { bytes: new Uint8Array(bytes), duration: 1 }; decoded.push(value); return value; },
    createBufferSource: () => {
      const source = {
        connect() {}, disconnect() { source.disconnected = true; },
        stop() { source.stopped = true; },
        start(...args) { source.started = true; source.startArgs = args; if (autoEnd) queueMicrotask(() => source.onended?.()); },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources, decoded };
}

function makePlayer(overrides = {}) {
  const audio = overrides.audio ?? fakeAudioContext({ autoEnd: true });
  const states = [];
  const player = new ChatterboxPlayer({
    fetch: overrides.fetch,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    createAudioContext: () => audio.context,
    pageProtocol: () => "http:",
    logger: { error() {} },
    onState: (state) => states.push(state),
    ...overrides.dependencies,
  });
  return { player, audio, states };
}

test("text cleanup and fallback chunk boundaries remain deterministic", () => {
  const text = `Quick first sentence. ${"Later material stays in order. ".repeat(30)}`.trim();
  const chunks = chunkSpeech(text);
  assert.equal(chunks[0], "Quick first sentence.");
  assert.ok(chunks[0].length <= FIRST_CHUNK_LENGTH);
  assert.ok(chunks.slice(1).every((part) => part.length <= LATER_CHUNK_LENGTH));
  assert.equal(chunks.join(" "), text);
  assert.deepEqual(chunkSpeech("alpha beta gamma", 7, 7), ["alpha", "beta", "gamma"]);
  assert.deepEqual(chunkSpeech("Short one. Short two."), ["Short one.", "Short two."]);
  assert.equal(markdownToSpeech("# Hi [there](https://x)\n```js\nsecret()\n```"), "Hi there");
});

test("settings reject unsafe endpoints and migrate HTTPS access to the same-origin proxy", () => {
  assert.equal(validateEndpoint("http://host:9004///"), "http://host:9004");
  for (const endpoint of ["ftp://host", "http://u:p@host", "http://host/?x=1"]) assert.throws(() => validateEndpoint(endpoint));
  assert.throws(() => validateEndpoint("http://host", "https:"), (error) => error.code === "mixed-content");
  assert.throws(() => validateSettings({ endpoint: "http://host", voice: "", speed: 1 }));
  assert.deepEqual(loadSettings({ getItem: () => "{bad" }), { ...DEFAULT_SETTINGS });

  const httpsLocation = { protocol: "https:", origin: "https://samwise.ssiops.com" };
  assert.equal(defaultEndpoint(httpsLocation), "https://samwise.ssiops.com/chatterbox-tts");
  const legacyStorage = { getItem: () => JSON.stringify({
    endpoint: "http://192.168.200.42:9004", voice: "alloy", speed: 1,
  }) };
  assert.deepEqual(loadSettings(legacyStorage, httpsLocation), {
    endpoint: "https://samwise.ssiops.com/chatterbox-tts", voice: "alloy", speed: 1,
  });
});

test("NDJSON reader accepts every byte boundary including split UTF-8", async () => {
  const payload = lines(audioRecord(0), { type: "error", error: "échec" });
  const body = streamBody(Array.from(payload, (byte) => new Uint8Array([byte])));
  const reader = new NDJSONRecordReader(body);
  const audio = await reader.next();
  assert.equal(audio.index, 0);
  assert.deepEqual(audio.audio, wavBytes(0));
  const terminal = await reader.next();
  assert.deepEqual(terminal, { type: "error", error: "échec" });
});

test("protocol rejects premature EOF, missing newline, and records after terminal", async () => {
  await assert.rejects(new NDJSONRecordReader(streamBody([])).next(), /terminal record/);
  await assert.rejects(new NDJSONRecordReader(streamBody([encoder.encode(JSON.stringify(audioRecord(0)))])).next(), /missing its newline/);
  const extra = new NDJSONRecordReader(streamBody([lines({ type: "done", chunks: 0 }, audioRecord(0))]));
  await assert.rejects(extra.next(), /after its terminal/);
});

test("protocol rejects malformed indexes, base64, fields, and terminal counts", () => {
  const malformed = [
    audioRecord(1),
    { ...audioRecord(0), audio: "!!!!" },
    { ...audioRecord(0), extra: true },
    { type: "done", chunks: 1 },
    { type: "error", error: "", extra: true },
  ];
  for (const record of malformed) {
    const parser = new StreamProtocolParser();
    assert.throws(() => parser.parseLine(encoder.encode(JSON.stringify(record))), (error) => error.code === "protocol");
  }
});

test("protocol enforces per-chunk, cumulative, count, line, and wire bounds", async () => {
  const tooSmall = new StreamProtocolParser({ maximumChunkBytes: 12 });
  assert.throws(() => tooSmall.parseLine(encoder.encode(JSON.stringify(audioRecord(0)))), (error) => error.code === "size");
  const cumulative = new StreamProtocolParser({ maximumTotalBytes: wavBytes().length });
  cumulative.parseLine(encoder.encode(JSON.stringify(audioRecord(0))));
  assert.throws(() => cumulative.parseLine(encoder.encode(JSON.stringify(audioRecord(1)))), (error) => error.code === "size");
  const count = new StreamProtocolParser({ maximumChunks: 1 });
  count.parseLine(encoder.encode(JSON.stringify(audioRecord(0))));
  assert.throws(() => count.parseLine(encoder.encode(JSON.stringify(audioRecord(1)))), (error) => error.code === "size");
  await assert.rejects(new NDJSONRecordReader(streamBody([encoder.encode("123456\n")]), { maximumRecordBytes: 5 }).next(), (error) => error.code === "size");
  await assert.rejects(new NDJSONRecordReader(streamBody([encoder.encode("123456")]), { maximumWireBytes: 5 }).next(), (error) => error.code === "size");
  assert.ok(MAX_CHUNK_AUDIO_BYTES < MAX_AUDIO_BYTES);
});

test("audio playback windows conservatively trim generated boundary silence", () => {
  const samples = new Float32Array(1_000);
  samples.fill(0.25, 200, 800);
  const window = audioPlaybackWindow({
    duration: 1, sampleRate: 1_000, numberOfChannels: 1, length: samples.length,
    getChannelData: () => samples,
  });
  assert.ok(window.offset >= 0.15 && window.offset <= 0.17);
  assert.ok(window.duration >= 0.67 && window.duration <= 0.69);
});

test("one stream request schedules exactly one decoded successor ahead", async () => {
  const audio = fakeAudioContext();
  const body = streamBody([
    lines(audioRecord(0)), lines(audioRecord(1)), lines({ type: "done", chunks: 2 }),
  ]);
  const calls = [];
  const { player } = makePlayer({ audio, fetch: async (url) => { calls.push(url); return streamResponse([], { body }); } });
  const result = player.toggle({ messageId: "m", button: {}, text: "First. Second." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/v1\/audio\/speech\/stream$/);
  assert.equal(audio.sources.length, 2, "the successor is scheduled before the current source ends");
  assert.equal(audio.decoded.length, 2, "exactly one successor may be decoded");
  assert.equal(body.reads, 2, "done is not read until the current playback ends");
  assert.equal(audio.sources[0].buffer.bytes.at(-1), 0);
  assert.equal(audio.sources[1].buffer.bytes.at(-1), 1);
  assert.ok(audio.sources[1].startArgs[0] < 1, "successor overlaps the trimmed current boundary");
  audio.sources[0].onended();
  await new Promise((resolve) => setImmediate(resolve));
  audio.sources[1].onended();
  assert.equal((await result).status, "complete");
});

test("stop cancels stream reading/playback and suppresses stale outcomes", async () => {
  const gate = deferred();
  const audio = fakeAudioContext();
  const body = streamBody([lines(audioRecord(0))], { gate });
  const { player, states } = makePlayer({ audio, fetch: async () => streamResponse([], { body }) });
  const result = player.toggle({ messageId: "old", button: {}, text: "Old speech." });
  await new Promise((resolve) => setImmediate(resolve));
  player.stop();
  assert.equal(body.cancelled, true);
  assert.equal(audio.sources[0].stopped, true);
  assert.equal((await result).status, "stale");
  assert.equal(states.at(-1).state, "idle");
});

test("legacy fallback occurs only for 404/405 and before stream records", async () => {
  const calls = [];
  const missingBody = streamBody([]);
  const { player } = makePlayer({
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/stream")) return streamResponse([], { ok: false, status: 404, body: missingBody });
      return legacyResponse();
    },
  });
  const result = await player.toggle({ messageId: "m", button: {}, text: "Fallback sentence." });
  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/v1\/audio\/speech$/);
  assert.equal(missingBody.cancelled, true);

  for (const response of [
    streamResponse([], { ok: false, status: 500 }),
    streamResponse([], { mime: "text/html" }),
    streamResponse([], { version: "2" }),
    streamResponse([], { raw: lines(audioRecord(0)) }),
  ]) {
    let requests = 0;
    const candidate = makePlayer({ fetch: async () => { requests += 1; return response; } }).player;
    const outcome = await candidate.toggle({ messageId: "x", button: {}, text: "No fallback." });
    assert.equal(outcome.status, "error");
    assert.equal(requests, 1);
  }
});

test("first-record and idle deadlines fail independently without a whole-stream timer", async () => {
  const timers = [];
  const firstDependencies = {
    setTimeout: (callback, milliseconds) => { timers.push(milliseconds); queueMicrotask(callback); return timers.length; },
    clearTimeout: () => {},
  };
  const first = makePlayer({ fetch: () => new Promise(() => {}), dependencies: firstDependencies }).player;
  const firstResult = await first.toggle({ messageId: "first", button: {}, text: "Wait." });
  assert.equal(firstResult.error.code, "timeout");

  const gate = deferred();
  const body = streamBody([lines(audioRecord(0))], { gate });
  const idleDependencies = {
    setTimeout: (callback, milliseconds) => {
      timers.push(milliseconds);
      if (milliseconds === STREAM_IDLE_TIMEOUT_MS) queueMicrotask(callback);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  const idle = makePlayer({ fetch: async () => streamResponse([], { body }), dependencies: idleDependencies }).player;
  const idleResult = await idle.toggle({ messageId: "idle", button: {}, text: "Wait again." });
  assert.equal(idleResult.error.code, "timeout");
  assert.ok(Math.max(...timers) > Math.min(...timers), "first-record and idle deadlines use distinct durations");
});

test("rapid run replacement keeps immutable ownership and stale suppression", async () => {
  const firstGate = deferred();
  const firstBody = streamBody([], { gate: firstGate });
  let calls = 0;
  const { player, states } = makePlayer({ fetch: async () => {
    calls += 1;
    return calls === 1 ? streamResponse([], { body: firstBody })
      : streamResponse([audioRecord(0), { type: "done", chunks: 1 }]);
  } });
  const oldRun = player.toggle({ messageId: "old", button: {}, text: "Old." });
  await new Promise((resolve) => setImmediate(resolve));
  const newRun = player.toggle({ messageId: "new", button: {}, text: "New." });
  assert.equal((await newRun).status, "complete");
  assert.equal((await oldRun).status, "stale");
  const newStart = states.findIndex((state) => state.run.messageId === "new");
  assert.ok(states.slice(newStart).every((state) => state.run.messageId === "new"));
});

test("observer-facing button/live updates are text-idempotent and callbacks coalesce", () => {
  const makeNode = () => {
    let text = "";
    const attributes = new Map();
    return {
      dataset: {}, title: "", textWrites: 0,
      get textContent() { return text; },
      set textContent(value) { text = value; this.textWrites += 1; },
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
    };
  };
  const button = makeNode();
  const live = makeNode();
  setButtonState(button, "loading");
  setLiveRegionText(live, "Generating speech");
  for (let index = 0; index < 20; index += 1) {
    setButtonState(button, "loading");
    setLiveRegionText(live, "Generating speech");
  }
  assert.equal(button.textWrites, 1);
  assert.equal(live.textWrites, 1);

  const scheduled = [];
  let reconciliations = 0;
  const callback = createCoalescedCallback(() => {
    reconciliations += 1;
    // This mirrors the plugin-owned writes reached from observer-driven
    // reconciliation/state callbacks. Repeating the callback must not create
    // another child-list mutation through textContent.
    setButtonState(button, "loading");
    setLiveRegionText(live, "Generating speech");
  }, (task) => scheduled.push(task));
  for (let index = 0; index < 20; index += 1) callback();
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(reconciliations, 1);
  assert.equal(button.textWrites, 1);
  assert.equal(live.textWrites, 1);

  callback();
  scheduled.shift()();
  assert.equal(reconciliations, 2);
  assert.equal(button.textWrites, 1, "a later observer callback must not rewrite button text");
  assert.equal(live.textWrites, 1, "a later observer callback must not rewrite live-region text");
});

test("private DOM adapter remains narrow and package export follows PI WEB v1", async () => {
  assert.doesNotMatch(DOM_CONTRACT.assistantSelector, /user|thinking|tool/);
  const messages = [{ id: 1 }];
  assert.deepEqual(enumerateAssistantMessages({ querySelectorAll: () => messages }), messages);
  assert.equal(deriveMessageIdentity({ getAttribute: (name) => name === "id" ? "abc" : null }, 2), "id:abc");
  const action = {};
  assert.equal(locateActionContainer({ querySelector: () => action }), action);
  assert.equal(extractAssistantText({ querySelectorAll: () => [{ text: "Direct" }, { textContent: "only" }] }), "Direct\n\nonly");
  assert.equal(hasEnhancementMarker({ querySelector: () => ({}) }), true);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.piWeb.plugins, [{ id: "chatterbox-tts", module: "pi-web-plugin.js" }]);
  assert.equal(plugin.apiVersion, 1);
  assert.equal(typeof plugin.activate, "function");
});
