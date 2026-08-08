---
"@jmfederico/pi-web": patch
---

Recover browser transports after network interruptions instead of requiring a page reload. Realtime and selected-session WebSockets can now be replaced safely when the browser comes back online or a prompt request hits a browser-level network failure; stale socket callbacks and reconnect timers cannot revive an old connection. Prompt requests are not retried automatically because delivery may already have reached the agent, and the UI now explains that ambiguous outcome instead of showing only the browser's raw `TypeError: Load failed` message.
