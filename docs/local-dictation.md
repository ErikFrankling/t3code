# Local dictation

This fork's web composer has a microphone button next to **Attach files**, for a
locally hosted speech service. Open T3 over HTTPS or localhost, allow microphone
access, and press the button. Pauses do not stop recording. The live draft is
provisional; the final recognizer receives the original audio and project context.

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

## Android app

Upstream's mobile voice input transcribes on the device and exists only on iOS.
This fork gives Android the same microphone button
(`apps/mobile/src/native/voiceTranscription.android.ts`). It records AAC in
ADTS, which can be read while it grows, and uploads the new bytes every second
to `POST /api/dictation/audio?id=<uuid>&project=<path>&offset=<n>&final=0`. The
server (`apps/server/src/dictationAudio.ts`) decodes the whole stream with ffmpeg
(`T3CODE_FFMPEG`, default `ffmpeg` on `PATH`) to 16 kHz PCM and feeds the new
part to the speech service as ordinary `append` actions, holding back the last
quarter second because the newest AAC frame may be incomplete. A 409 carries the
offset the server expects. Stop uploads the rest with `final=1`, which asks for
the final transcript. While recording, the live draft and the refined text show
above the composer (`DictationLivePreview.tsx`), as in the web workspace.

In a chat, stop sends the message as on the web: the composer queues it in the
outbox with `[dictation:<id>]` after any typed text and `dictation` set, the
drain hands it to `dictation.deliver`, and the server sends it once the final
transcript exists. The app can be left or closed after that (only the last
second of audio has to upload first). The preview keeps following the
refinement while the composer stays open. Where nothing can be sent (new task,
scheduled task prompt) or the composer refuses the send, the final transcript is
inserted into the draft instead. Composers pass their environment, and the chat
composer its `send`, as `dictation` to `useVoiceInputController`; the shared
controller calls the transcriber's optional `deliver` instead of `transcribe`.

The fork's Android build is published by `.github/workflows/erik-android.yml`
as `android-v*` GitHub releases (the newest is marked latest), which the phone
follows with Obtainium. Signing key: repo secrets `ANDROID_KEYSTORE_*`, backed up
in the dotfiles sops secrets as `t3code-android-keystore`.

## Read aloud

Every client (web, desktop, Android) has a speaker button on assistant messages,
a pinned **Read latest** button above the composer, and a subtitle panel with
pause, skip, speed and _full message_. A local LLM rewrites the message as a
short spoken briefing and a local TTS server speaks it sentence by sentence,
so audio starts before the summary is finished. It never enters the thread.

`POST /api/read-aloud` (`apps/server/src/readAloud.ts`) starts or polls a job;
`packages/client-runtime/src/readAloud.ts` is the shared player. Endpoints are
environment variables: `T3CODE_READ_ALOUD_LLM_URL` and `_LLM_MODEL` (an
OpenAI-compatible chat endpoint, default llama-swap `read-aloud-summary`),
`_SMALL_TTS_URL`, `_SMALL_VOICE`, `_SMALL_SPEED` (an OpenAI-style
`/v1/audio/speech`, default Kokoro-FastAPI on `127.0.0.1:8880`, voice
`af_heart`, speed 1.2) and `_BIG_TTS_URL`, `_BIG_VOICE`, `_BIG_SPEED`,
`_BIG_MODEL` (default Higgs TTS through llama-swap, voice `erik`). The big voice
is used only while llama-swap reports `_BIG_MODEL` loaded; the host decides when
to lend it the GPU. The client's speed multiplies the voice's own speed.

## How it works

The host forwards authenticated `POST /api/dictation` speech actions to the
loopback coordinator at `http://127.0.0.1:8781/dictation`. Operators can override
this with `T3CODE_STT_URL`. Credentials are not forwarded; the verified subject
identifies recording ownership. This fork's deployment pairs a Nemotron Vulkan
preview with VibeVoice Q8 final recognition and bounded repository vocabulary
extraction. The speech service is packaged separately by the host's NixOS
configuration.

Stop prepares the same orchestration request a typed send makes, with
`[dictation:<id>]` where the transcript goes, and hands it to the
`dictation.deliver` websocket method instead of sending it. The server
checkpoints it privately under `userdata/dictation-deliveries`, replaces the
marker once the final transcript exists, and dispatches it through the normal
message intake. It resumes pending deliveries after a restart and reuses the
recording ID as the command ID, so a delivery is never repeated. A delivery the
chat kept rejecting is abandoned after 24 hours instead of arriving late.
Structured `dictation.*` events carry the recording ID and thread ID without
logging transcript text.

`T3CODE_UNSAFE_NO_AUTH=1` retains this deployment's explicit trusted-network mode;
without that exact value, normal upstream authentication applies. The mode uses
a persisted administrative session so websocket tickets remain functional, and
accepts any pairing code so the mobile app can connect.
