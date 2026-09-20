# Local dictation

The web composer has a microphone button for a locally hosted speech service.
Open T3 over HTTPS or localhost, allow microphone access, then click the button
again when finished. Pauses do not stop recording. The live draft is provisional;
the final recognizer receives the original audio and project context.

Dictation opens a larger workspace with a read-only live draft and refined text.
Stop recording, review the result, then choose **Use transcript** to append it to
existing composer text. If refinement fails, **Use draft** keeps the first pass.
Closing the workspace stops capture and keeps the recording; reopen it from the
microphone button. No close action deletes your work.

Recordings belong to their original composer. Changing threads finishes capture
without inserting text into the new thread. Reopen the original thread to recover
the result. Retry a failed upload or transcription; the download button saves a
reusable WAV from the current browser recording.

The host forwards authenticated `POST /api/dictation` requests to the loopback
coordinator at `http://127.0.0.1:8781/dictation`. Operators can override this with
`T3CODE_STT_URL`. Credentials are not forwarded; the verified subject identifies
recording ownership. This fork's deployment pairs a Nemotron Vulkan preview with
VibeVoice Q8 final recognition and bounded repository vocabulary extraction.
The speech service is packaged separately by the host's NixOS configuration.

`T3CODE_UNSAFE_NO_AUTH=1` retains this deployment's explicit trusted-network mode;
without that exact value, normal upstream authentication applies. The mode uses
a persisted administrative session so websocket tickets remain functional.
