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
(`apps/mobile/src/native/voiceTranscription.android.ts`): the recording (AAC)
goes to `POST /api/dictation/audio?id=<uuid>&project=<path>`, the server decodes
it with ffmpeg (`T3CODE_FFMPEG`, default `ffmpeg` on `PATH`) to 16 kHz PCM,
feeds it to the speech service as ordinary `start`/`append`/`finish` actions
(`apps/server/src/dictationAudio.ts`), and the app polls `status` until the final
transcript is inserted into the composer. Composers pass their environment as
`dictation` to `useVoiceInputController`. Assistant messages also get a read-aloud
button (`ReadAloudButton.tsx`, `expo-speech`, the device's own voice).

The fork's Android build is published by `.github/workflows/erik-android.yml`
as `android-v*` GitHub releases (the newest is marked latest), which the phone
follows with Obtainium. Signing key: repo secrets `ANDROID_KEYSTORE_*`, backed up
in the dotfiles sops secrets as `t3code-android-keystore`.

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
