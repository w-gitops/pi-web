---
"@jmfederico/pi-web": patch
---

Allow subscription (OAuth) login and logout for federated remote machines from the gateway web UI. Provider discovery, login flows, and credential removal stay bound to the machine where the operation began, even if the selected machine changes while a request is pending. Older pending provider lookups cannot replace or close a newer login/logout dialog or flow. The dialog explains that the provider's redirect page will not load in your browser so you can paste the full redirect URL back to complete the login.
