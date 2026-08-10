# PI WEB Chatterbox TTS plugin

This local plugin adds cancellable, gapless Chatterbox speech controls to assistant messages. Its optional sentence-safe Auto-Read mode starts generating speech from completed sentences while the assistant response is still streaming. Use **Enable / Resume Chatterbox Auto-Read** once per page to unlock mobile Web Audio; the preference remains browser-local. **Stop** suppresses the rest of the current turn, while **Disable** turns the mode off.

See [`../README.md`](../README.md) for installation, proxy, service, security, streaming, and observability guidance.

Run its dependency-free test suite with:

```sh
npm test
```
