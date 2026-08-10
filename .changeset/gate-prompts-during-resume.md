---
"@jmfederico/pi-web": patch
---

Keep prompt sending disabled after browser suspension until an idempotent health probe succeeds, then replace sockets again and refresh session state without retrying any prompt request.
