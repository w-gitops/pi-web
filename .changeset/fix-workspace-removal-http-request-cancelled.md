---
"@jmfederico/pi-web": patch
---

Fix workspace (worktree) removal failing immediately with "Failed to start workspace removal: HTTP request cancelled". A request carrying a body is no longer mistaken for a disconnected client after its body has been read.
