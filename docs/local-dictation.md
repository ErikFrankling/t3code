# Local dictation

The web composer has a microphone button for a locally hosted speech service.
Open T3 over HTTPS or localhost, allow microphone access, then click the button
again when finished. Pauses do not stop recording. The live draft is provisional;
the final recognizer receives the original audio and project context.

Existing composer text is preserved. If you edit while recognition is running,
T3 stops replacing text and offers **Insert transcript (keep my edits)** instead.
Recordings belong to their original composer: changing threads stops capture and
finalizes that recording without inserting it into the new thread. Reopen the
original draft to recover a saved result. Retry a failed upload or final pass;
**Save WAV** also keeps a reusable browser-side recording.

The host forwards authenticated `POST /api/dictation` requests to the loopback
coordinator at `http://127.0.0.1:8781/dictation`. Operators can override this with
`T3CODE_STT_URL`. Credentials are not forwarded; the verified subject identifies
recording ownership. This fork's deployment pairs a Nemotron Vulkan preview with
VibeVoice Q8 final recognition and bounded repository vocabulary extraction.
The speech service is packaged separately by the host's NixOS configuration.

`T3CODE_UNSAFE_NO_AUTH=1` retains this deployment's explicit trusted-network mode;
without that exact value, normal upstream authentication applies. The mode uses
a persisted administrative session so websocket tickets remain functional.
