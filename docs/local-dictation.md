# Local dictation

The web composer has a microphone button for a locally hosted speech service.
Open T3 over HTTPS or localhost, allow microphone access, then click the button
again when finished. Pauses do not stop recording. The live draft is provisional;
the final recognizer receives the original audio and project context.

Recording starts as soon as the microphone is granted. Audio is kept in the
browser and uploaded behind the microphone, so a slow, restarting or busy speech
service delays the live draft but never the recording; uploads are retried until
they land. A new recording can start while an earlier one is still being
transcribed.

Dictation opens a larger workspace with a read-only live draft and refined text.
**Stop sends the message automatically**, once the full-quality transcript
exists. The server waits for it for as long as it takes: the speech service
retries through GPU contention and restarts by itself. The live draft is sent
instead only when the recording no longer exists or the recogniser heard no
speech. Existing typed text and attachments travel with the dictated message.

You can switch chats after stopping. Delivery belongs to the original chat and
continues independently of the browser. Closing the recording workspace stops
and sends too; it does not discard your recording. Do not close the browser
while audio is still uploading; a refused upload keeps the audio available for
retry and WAV download.

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
