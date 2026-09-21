# Local dictation

The web composer has a microphone button for a locally hosted speech service.
Open T3 over HTTPS or localhost, allow microphone access, then click the button
again when finished. Pauses do not stop recording. The live draft is provisional;
the final recognizer receives the original audio and project context.

Dictation opens a larger workspace with a read-only live draft and refined text.
**Stop sends the message automatically.** The server finishes transcription,
retries refinement up to three times, and uses the live draft if refinement fails.
Existing typed text and attachments travel with the dictated message.

You can switch chats after stopping. Delivery belongs to the original chat and
continues independently of the browser. Closing the recording workspace stops
and sends too; it does not discard your recording. Upload failures keep the audio
available for retry and WAV download. Do not close the browser before an
interrupted upload has been recovered.

Enter sends typed messages on desktop and mobile; Shift+Enter adds a newline.
The composer keeps its expanded layout when focused and unfocused.

The host forwards authenticated `POST /api/dictation` requests to the loopback
coordinator at `http://127.0.0.1:8781/dictation`. Operators can override this with
`T3CODE_STT_URL`. Credentials are not forwarded; the verified subject identifies
recording ownership. This fork's deployment pairs a Nemotron Vulkan preview with
VibeVoice Q8 final recognition and bounded repository vocabulary extraction.
The speech service is packaged separately by the host's NixOS configuration.

`T3CODE_UNSAFE_NO_AUTH=1` retains this deployment's explicit trusted-network mode;
without that exact value, normal upstream authentication applies. The mode uses
a persisted administrative session so websocket tickets remain functional.

Pending deliveries are checkpointed privately under `userdata/dictation-deliveries`.
The server resumes them after restart and reuses each command ID to prevent
repeated delivery. Structured `dictation.*` events carry the recording ID and
original thread ID without logging transcript text. Speech-worker logs use the
same recording ID and include refinement timing and memory-guard failures.
