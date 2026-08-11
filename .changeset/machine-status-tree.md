---
"@jmfederico/pi-web": patch
---

Make the working, terminal, and unread indicators in the machine, project, and workspace lists reliable. Each machine's session daemon now decides which projects and workspaces a running session or terminal belongs to and publishes one status snapshot for the whole machine, so the browser shows the same state everywhere instead of matching directories on its own. Indicators for a machine appear once that machine runs a PI WEB version with this change and its session daemon has been restarted.
