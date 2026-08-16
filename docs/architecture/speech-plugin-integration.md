# Speech plugin integration architecture

Status: accepted implementation plan for the w-gitops fork.

## Findings

PI WEB already projects Pi assistant lifecycle events onto the selected-session WebSocket after validation and sequence/watermark reconciliation: text `message_update` events become `assistant.delta`, final messages become `message.end`, and lifecycle events such as `turn_start` remain visible as `pi.event`. A browser plugin currently cannot subscribe to this stream, so the Chatterbox plugin discovers private shadow DOM and polls rendered messages.

Existing Pi speech packages such as `pi-simple-voice` validate the desired lifecycle: consume `message_start`/`message_update`/`message_end`, speak sentence-safe verbatim text, exclude reasoning, and interrupt on `turn_start`. Their local audio playback is not suitable for remote PI WEB sessions because it plays on the session-daemon host rather than in the user's browser. Pi's shared `pi.events` bus is process-local and is not a browser bridge.

A Pi package may declare both `pi.extensions` and `piWeb.plugins`. This is the eventual distribution mechanism, but browser speech remains a PI WEB plugin responsibility. An optional Pi extension may support terminal users and must not auto-play on the sessiond host in RPC mode.

## Accepted boundaries

1. PI WEB core owns validated assistant-output projection, reconnect reconciliation, stable host-rendered message actions, accessibility, machine/session scoping, and plugin cleanup.
2. The browser plugin owns text-to-speech projection, Chatterbox protocol validation, audio scheduling, autoplay recovery, settings, and playback state.
3. The Chatterbox service remains a separate process. The first package release uses the existing explicit/same-origin endpoint. A future global streamed server-plugin transport must be a separate security-reviewed change.
4. Browser resilience, prompt gating, error banners, OpenTelemetry bootstrap, and native upgrade guards remain core/fork behavior rather than plugin behavior.

## Delivery phases

### Current vertical slice

- Add backward-compatible browser API v2 assistant-output observers.
- Add host-rendered assistant-message actions.
- Add optional plugin disposal.
- Dispatch observer events only after transcript events pass the selected-session watermark and are applied.
- Give new registrations a selected-session snapshot.
- Refactor Chatterbox to consume these APIs without private selectors, mutation observers, or polling.
- Preserve bounded streaming, cancellation, sentence-safe Auto-Read, and browser-local settings.

### Follow-up

- Namespaced browser plugin storage and declarative settings fields.
- Independently published Pi package containing the browser plugin and optional terminal Pi extension.
- Versioned, bounded, abort-aware global binary streaming for paired server plugins and federated machines.

## Invariants

- Plugins never receive thinking deltas as speakable output.
- A reconnect snapshot must not cause already committed speech to replay.
- Switching sessions or starting a new turn interrupts old automatic speech.
- Message-action buttons are rendered by PI WEB and remain keyboard/accessibility compatible.
- Plugin failures are attributed and contained; plugin cleanup is idempotent.
- No speech integration depends on PI WEB shadow DOM or private component properties.
