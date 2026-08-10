import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FIRST_CHUNK_LENGTH, LATER_CHUNK_LENGTH, STREAM_IDLE_TIMEOUT_MS, MAX_AUDIO_BYTES,
  MAX_CHUNK_AUDIO_BYTES, DEFAULT_SETTINGS, DOM_CONTRACT,
  StreamProtocolParser, NDJSONRecordReader, ChatterboxPlayer, AutoReadController,
  chunkSpeech, markdownToSpeech, streamingSpeechSnapshot, audioPlaybackWindow, validateEndpoint, validateSettings,
  defaultEndpoint, loadSettings, enumerateAssistantMessages, deriveMessageIdentity,
  locateActionContainer, extractAssistantText, inspectAutoReadView, hasEnhancementMarker,
  setButtonState, setLiveRegionText, shouldStopForDetachedButton, createCoalescedCallback,
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

function fakeAudioContext({ autoEnd = false, keepalive = false } = {}) {
  const sources = [];
  const decoded = [];
  const context = {
    state: "suspended", destination: {},
    resume: async () => { context.state = "running"; },
    close: async () => { context.state = "closed"; },
    decodeAudioData: async (bytes) => { const value = { bytes: new Uint8Array(bytes), duration: 1 }; decoded.push(value); return value; },
    ...(keepalive ? { sampleRate: 24_000, createBuffer: () => ({ duration: 1 }) } : {}),
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
    endpoint: "https://samwise.ssiops.com/chatterbox-tts", voice: "alloy", speed: 1, autoRead: false,
  });
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, autoRead: true }).autoRead, true);
});

test("streaming speech commits only stable prose and excludes incomplete Markdown", () => {
  assert.equal(streamingSpeechSnapshot("Hello world").speech, "");
  assert.equal(streamingSpeechSnapshot("Hello world. Next").speech, "Hello world.");
  assert.equal(streamingSpeechSnapshot("Use `danger();` while waiting.").speech, "Use while waiting.");
  assert.equal(streamingSpeechSnapshot("Use ``code ` inside`` safely.").speech, "Use safely.");
  assert.equal(streamingSpeechSnapshot("Before.\n````js~ok\nhidden();\n```\nstill hidden\n````\nAfter.").speech, "Before. After.");
  assert.equal(streamingSpeechSnapshot("Before.\n~~~js`ok\nhidden();\n~~~not a close\nstill hidden\n~~~\nAfter.").speech, "Before. After.");
  assert.equal(streamingSpeechSnapshot("Math says x < y. Continue.").speech, "Math says x < y. Continue.");
  assert.equal(streamingSpeechSnapshot("Image ![unfinished. alt").speech, "");
  assert.equal(streamingSpeechSnapshot("Safe.\n```js\ndanger();\n```\nDone.").speech, "Safe. Done.");
  assert.equal(streamingSpeechSnapshot("Read [the guide](https://example.test). More").speech, "Read the guide.");
  assert.equal(streamingSpeechSnapshot("Do not read [unfinished. still").speech, "");
  assert.equal(streamingSpeechSnapshot("A final tail", true).speech, "A final tail");
  assert.equal(streamingSpeechSnapshot("Dr. Smith is ready. Next").speech, "Dr. Smith is ready.");
  assert.equal(streamingSpeechSnapshot("Unicode works。 More").speech, "Unicode works。");
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

test("autoplay keeps an unlocked mobile audio context alive until disabled", async () => {
  const audio = fakeAudioContext({ keepalive: true });
  const { player } = makePlayer({ audio });
  await player.primeForAutoplay();
  await player.primeForAutoplay();
  assert.equal(audio.sources.length, 1, "repeated gestures reuse one keepalive source");
  assert.equal(audio.sources[0].loop, true);
  assert.equal(player.autoplayKeepalive, audio.sources[0]);
  player.releaseAutoplay();
  assert.equal(audio.sources[0].stopped, true);
  assert.equal(audio.sources[0].disconnected, true);

  const replacement = fakeAudioContext({ keepalive: true });
  const contexts = [audio.context, replacement.context];
  let contextIndex = 0;
  const replacing = new ChatterboxPlayer({ createAudioContext: () => contexts[contextIndex++] });
  await replacing.primeForAutoplay();
  await contexts[0].close();
  await replacing.primeForAutoplay();
  assert.equal(audio.sources[1].stopped, true, "a stale keepalive is released with its closed context");
  assert.equal(replacing.context, replacement.context);
  assert.equal(replacing.autoplayKeepalive, replacement.sources[0]);
});

test("continuous auto playback starts successor synthesis before prior audio ends", async () => {
  const calls = [];
  const audio = fakeAudioContext();
  const { player } = makePlayer({
    audio,
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body).input);
      return streamResponse([audioRecord(0, wavBytes(calls.length - 1)), { type: "done", chunks: 1 }]);
    },
  });
  await player.primeForAutoplay();
  const run = await player.startAuto({ messageId: "turn", button: {} });
  assert.equal(player.enqueueAuto(run, "First sentence."), true);
  assert.equal(player.enqueueAuto(run, "Second sentence."), true);
  player.finishAuto(run);
  for (let index = 0; index < 20 && audio.sources.length < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls, ["First sentence.", "Second sentence."]);
  assert.equal(audio.sources.length, 2);
  assert.equal(audio.sources[0].stopped, undefined, "the first source remains active during successor synthesis");
  assert.ok(audio.sources[1].startArgs[0] >= 0.9, "the successor continues the shared audio timeline");
  audio.sources[0].onended();
  audio.sources[1].onended();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.activeRun, undefined);
});

test("a following turn reopens Auto-Read while prior audio is still playing", async () => {
  const calls = [];
  const audio = fakeAudioContext();
  const { player } = makePlayer({
    audio,
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body).input);
      return streamResponse([audioRecord(0), { type: "done", chunks: 1 }]);
    },
  });
  await player.primeForAutoplay();
  const run = await player.startAuto({ messageId: "first", button: {} });
  player.enqueueAuto(run, "First turn.");
  player.finishAuto(run);
  for (let index = 0; index < 20 && audio.sources.length < 1; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(player.reopenAuto(run), true);
  audio.sources[0].onended();
  await new Promise((resolve) => setImmediate(resolve));
  player.enqueueAuto(run, "Second turn.");
  player.finishAuto(run);
  for (let index = 0; index < 20 && audio.sources.length < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls, ["First turn.", "Second turn."]);
  assert.equal(audio.sources[0].stopped, undefined);
  audio.sources[0].onended?.();
  audio.sources[1].onended();
});

test("auto-read baselines history, emits each sentence once, and flushes the final tail", async () => {
  const enqueued = [];
  let finished = 0;
  const run = { queueChars: 0 };
  const player = {
    primeForAutoplay: async () => {},
    startAuto: async () => run,
    enqueueAuto: (_run, text) => { enqueued.push(text); return true; },
    finishAuto: () => { finished += 1; },
    stop: () => {},
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const snapshot = (turnId, text, isStreaming = true) => ({
    available: true, hidden: false, sessionId: "s", turnId,
    messageId: `${turnId}:assistant`, text, isStreaming, button: {},
  });
  await controller.enable(snapshot("s:old", "Historical response.", false));
  await controller.poll(snapshot("s:old", "Historical response.", false));
  assert.deepEqual(enqueued, []);
  await controller.poll(snapshot("s:new", "First sentence. Partial"));
  await controller.poll(snapshot("s:new", "First sentence. Partial becomes second sentence."));
  await controller.poll(snapshot("s:new", "First sentence. Partial becomes second sentence. Tail", false));
  assert.deepEqual(enqueued, ["First sentence.", "Partial becomes second sentence.", "Tail"]);
  assert.equal(finished, 1);
});

test("auto-read falls back to a newly completed turn when live status was missed", async () => {
  const enqueued = [];
  let finishes = 0;
  const player = {
    activeRun: undefined, primeForAutoplay: async () => {},
    startAuto: async () => ({ queueChars: 0 }),
    enqueueAuto: (_run, text) => { enqueued.push(text); return true; },
    finishAuto: () => { finishes += 1; }, stop: () => {},
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const old = {
    available: true, hidden: false, sessionId: "s", turnId: "old", messageId: "data-index:1",
    text: "Old.", isStreaming: false, button: {},
  };
  await controller.enable(old);
  await controller.poll({
    ...old, turnId: "new", messageId: "data-index:3",
    text: "A fast response completed before the live poll.",
  });
  assert.deepEqual(enqueued, ["A fast response completed before the live poll."]);
  assert.equal(finishes, 1);
});

test("controller queues a second completed turn onto an active auto run", async () => {
  const enqueued = [];
  let reopens = 0;
  const run = { mode: "auto", queueChars: 0 };
  const player = {
    activeRun: undefined, primeForAutoplay: async () => {},
    startAuto: async () => { player.activeRun = run; return run; },
    reopenAuto: () => { reopens += 1; return true; },
    enqueueAuto: (_run, text) => { enqueued.push(text); return true; },
    finishAuto: () => {}, stop: () => {},
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const snapshot = (turnId, messageId, text) => ({
    available: true, hidden: false, sessionId: "s", turnId, messageId,
    text, isStreaming: false, button: {},
  });
  await controller.enable(snapshot("old", "data-index:1", "Old."));
  await controller.poll(snapshot("first", "data-index:3", "First response."));
  await controller.poll(snapshot("second", "data-index:5", "Second response."));
  assert.deepEqual(enqueued, ["First response.", "Second response."]);
  assert.equal(reopens, 1);
});

test("Auto-Read defers a completed response until manual playback finishes", async () => {
  const enqueued = [];
  let starts = 0;
  let finishes = 0;
  const manual = { mode: "manual" };
  const auto = { mode: "auto", queueChars: 0 };
  const player = {
    activeRun: manual, primeForAutoplay: async () => {},
    startAuto: async () => { starts += 1; player.activeRun = auto; return auto; },
    reopenAuto: () => true,
    enqueueAuto: (_run, text) => { enqueued.push(text); return true; },
    finishAuto: () => { finishes += 1; }, stop: () => {},
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const snapshot = (turnId, messageId, text, isStreaming = false) => ({
    available: true, hidden: false, sessionId: "s", turnId, messageId,
    text, isStreaming, button: {},
  });
  await controller.enable(snapshot("old", "data-index:1", "Old."));
  const completed = snapshot("next", "data-index:3", "Read me after the manual passage.");
  await controller.poll(completed);
  assert.equal(starts, 0);
  assert.deepEqual(enqueued, []);
  assert.equal(controller.waitingForManual, true);
  player.activeRun = undefined;
  await controller.poll(completed);
  assert.equal(starts, 1);
  assert.deepEqual(enqueued, ["Read me after the manual passage."]);
  assert.equal(finishes, 1);
});

test("deferred resume is single-flight and cancellation cannot orphan its run", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  let starts = 0;
  let stops = 0;
  const manual = { mode: "manual" };
  const auto = { mode: "auto", queueChars: 0 };
  const player = {
    activeRun: manual, primeForAutoplay: async () => {},
    startAuto: async () => {
      starts += 1;
      player.activeRun = auto;
      await startGate;
      return auto;
    },
    reopenAuto: () => true, enqueueAuto: () => true, finishAuto: () => {},
    stop: () => { stops += 1; player.activeRun = undefined; },
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const completed = {
    available: true, hidden: false, sessionId: "s", turnId: "next",
    messageId: "data-index:3", text: "Deferred response.", isStreaming: false, button: {},
  };
  await controller.enable({ ...completed, turnId: "old", messageId: "data-index:1" });
  await controller.poll(completed);
  player.activeRun = undefined;
  const firstPoll = controller.poll(completed);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.poll(completed);
  assert.equal(starts, 1);
  controller.cancel(false);
  releaseStart();
  await firstPoll;
  assert.equal(stops, 1);
  assert.equal(player.activeRun, undefined);
});

test("steered turns remain on the active Auto-Read run without a streaming gap", async () => {
  const enqueued = [];
  let starts = 0;
  let finishes = 0;
  const run = { mode: "auto", queueChars: 0 };
  const player = {
    activeRun: undefined, primeForAutoplay: async () => {},
    startAuto: async () => { starts += 1; player.activeRun = run; return run; },
    reopenAuto: () => true,
    enqueueAuto: (_run, text) => { enqueued.push(text); return true; },
    finishAuto: () => { finishes += 1; }, stop: () => {},
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const snapshot = (turnId, messageId, text, isStreaming = true) => ({
    available: true, hidden: false, sessionId: "s", turnId, messageId,
    text, isStreaming, button: {},
  });
  await controller.enable(snapshot("old", "data-index:1", "Old.", false));
  await controller.poll(snapshot("first", "data-index:3", "First response."));
  await controller.poll(snapshot("steer", undefined, ""));
  await controller.poll(snapshot("steer", "data-index:5", "Steered continuation."));
  await controller.poll(snapshot("steer", "data-index:5", "Steered continuation.", false));
  assert.deepEqual(enqueued, ["First response.", "Steered continuation."]);
  assert.equal(starts, 1);
  assert.equal(finishes, 1);
});

test("auto-read fails closed on revisions, navigation, and queue backpressure", async () => {
  let stops = 0;
  let finishes = 0;
  const run = { queueChars: 2_000 };
  const player = {
    primeForAutoplay: async () => {}, startAuto: async () => run,
    enqueueAuto: () => false, finishAuto: () => { finishes += 1; }, stop: () => { stops += 1; },
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const base = {
    available: true, hidden: false, sessionId: "s", turnId: "s:new",
    messageId: "s:new:assistant", isStreaming: true, button: {},
  };
  await controller.enable({ ...base, turnId: "s:old", isStreaming: false, text: "" });
  await controller.poll({ ...base, text: "Queue overflow." });
  assert.equal(controller.suppressedTurnId, "s:new");
  assert.equal(finishes, 1, "already queued audio drains instead of being destroyed");
  await controller.poll({ ...base, isStreaming: false, text: "Queue overflow." });
  assert.equal(controller.suppressedTurnId, undefined);

  const revisionPlayer = { ...player, enqueueAuto: () => true };
  const revision = new AutoReadController(revisionPlayer, { telemetry: () => {} });
  await revision.enable({ ...base, turnId: "s:old", isStreaming: false, text: "" });
  await revision.poll({ ...base, text: "Original sentence." });
  await revision.poll({ ...base, text: "Changed sentence." });
  assert.equal(revision.suppressedTurnId, "s:new");
  assert.ok(stops >= 1, "a source revision cancels scheduled and queued audio");
  await revision.poll({ ...base, sessionId: "other", turnId: "other:new", text: "Other." });
  assert.equal(revision.turnId, undefined);
});

test("auto-read transitions cannot re-enable after disable and suppression is turn-scoped", async () => {
  const gate = deferred();
  let starts = 0;
  const player = {
    activeRun: undefined,
    primeForAutoplay: () => gate.promise,
    startAuto: async () => { starts += 1; return { queueChars: 0 }; },
    enqueueAuto: () => true, finishAuto: () => {}, stop: () => {},
  };
  const controller = new AutoReadController(player, { telemetry: () => {} });
  const old = {
    available: true, hidden: false, sessionId: "s", turnId: "turn-old",
    messageId: "message-old", text: "", isStreaming: false, button: {},
  };
  const enabling = controller.enable(old);
  controller.disable(old);
  gate.resolve();
  assert.equal(await enabling, false);
  assert.equal(controller.enabled, false);

  player.primeForAutoplay = async () => {};
  await controller.enable(old);
  await controller.poll({ ...old, turnId: "turn-one", messageId: "message-one", text: "One.", isStreaming: true });
  controller.suppressCurrent();
  await controller.poll({ ...old, turnId: "turn-two", messageId: "message-two", text: "Two.", isStreaming: true });
  assert.equal(starts, 2, "a distinct user turn is eligible even if a non-streaming transition was missed");
});

test("auto queue is bounded and stop cancels every cross-request source", async () => {
  const audio = fakeAudioContext();
  const { player } = makePlayer({
    audio,
    fetch: async () => streamResponse([audioRecord(0), { type: "done", chunks: 1 }]),
  });
  await player.primeForAutoplay();
  const run = await player.startAuto({ messageId: "turn", button: {} });
  for (let index = 0; index < 9; index += 1) {
    assert.equal(player.enqueueAuto(run, `${index}.`), true);
  }
  assert.equal(run.queue.length, 8, "segments above the cap coalesce into the last queue entry");
  assert.equal(run.queueChars, run.queue.reduce((total, value) => total + value.length, 0));
  assert.equal(player.enqueueAuto(run, "x".repeat(2_001)), false);
  for (let index = 0; index < 20 && audio.sources.length < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  player.stop();
  assert.ok(audio.sources.length >= 1);
  assert.ok(audio.sources.every((source) => source.stopped === true));
  assert.equal(player.activeRun, undefined);
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

test("detached message buttons stop manual playback but preserve Auto-Read", () => {
  const detachedRoot = { contains: () => false };
  assert.equal(shouldStopForDetachedButton({ mode: "manual", button: {} }, detachedRoot), true);
  assert.equal(shouldStopForDetachedButton({ mode: "auto", button: {} }, detachedRoot), false);
  assert.equal(shouldStopForDetachedButton(undefined, detachedRoot), false);
});

test("private DOM adapter remains narrow and package export follows PI WEB v1", async () => {
  assert.doesNotMatch(DOM_CONTRACT.assistantSelector, /user|thinking|tool/);
  const messages = [{ id: 1 }];
  assert.deepEqual(enumerateAssistantMessages({ querySelectorAll: () => messages }), messages);
  assert.equal(deriveMessageIdentity({ getAttribute: (name) => name === "id" ? "abc" : null }, 2), "id:abc");
  const action = {};
  assert.equal(locateActionContainer({ querySelector: () => action }), action);
  assert.equal(extractAssistantText({ querySelectorAll: () => [{ text: "Direct" }, { textContent: "only" }] }), "Direct\n\nonly");
  const message = {
    getAttribute: (name) => name === "data-index" ? "7" : null,
    querySelectorAll: () => [{ text: "Streaming." }], querySelector: () => undefined,
  };
  const user = {
    getAttribute: (name) => name === "data-index" ? "6" : null,
  };
  const root = {
    querySelectorAll: (selector) => selector === DOM_CONTRACT.userSelector ? [user] : [message],
  };
  const view = {
    shadowRoot: root, isConnected: true, sessionId: "s",
    status: { isStreaming: false, isBashRunning: false }, activity: { phase: "active" },
  };
  root.host = view;
  assert.deepEqual(inspectAutoReadView(root, { visibilityState: "visible" }), {
    available: true, view, sessionId: "s", isStreaming: true, hidden: false,
    turnId: "s:response:data-index:6", messageId: "data-index:7",
    message, button: undefined, text: "Streaming.",
  });
  assert.equal(inspectAutoReadView({ host: { isConnected: false } }).available, false);
  assert.equal(hasEnhancementMarker({ querySelector: () => ({}) }), true);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.piWeb.plugins, [{ id: "chatterbox-tts", module: "pi-web-plugin.js" }]);
  assert.equal(plugin.apiVersion, 1);
  assert.equal(typeof plugin.activate, "function");
});
