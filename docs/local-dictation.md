# Local dictation

This fork's web composer has a microphone button next to **Attach files**, for a
locally hosted speech service. Open T3 over HTTPS or localhost, allow microphone
access, and press the button. Silence does not stop recording. The live draft is
provisional; the final recognizer receives the original audio and project context.

Recording starts as soon as the microphone is granted. **Voice input is never
lost.** Every second of audio is saved on the device (IndexedDB) before it is
uploaded, and a separate loop uploads the saved audio in order, retrying for as
long as the page is open and again on the next visit. A slow, restarting or
unreachable speech service delays the live draft, never the recording; the view
then says "Saved on this device; uploads when the speech service is back". A
reload, a closed tab, an error or leaving the chat never ends or discards a
recording: it comes back paused, with all of its audio.

Dictation opens full screen: the refined text, followed by the newer live draft
in a muted colour. **Pause** (Space) stops the microphone and keeps the
recording open; **Resume** continues the same recording, also after a reload.
**Send** (Enter) sends the message once the full-quality transcript exists.
**Edit** waits for that transcript and puts it into the message box instead.
**Delete** asks for confirmation first. Minimize (Esc) keeps recording; the
microphone button shows a recording in red and paused recordings in amber, and
reopens the view. The audio leaves the device only after the message was sent
or the transcript went into the message box.

After Send the server waits for the transcript for as long as it takes: the
speech service retries through GPU contention and restarts by itself. The live
draft is sent instead only when the recording no longer exists or the
recogniser heard no speech. Existing typed text and attachments travel with the
dictated message. You can switch chats after sending; delivery belongs to the
original chat and continues independently of the browser.

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

## Voice mode

**Voice** next to **Read latest** opens the thread full screen as speech: the
live transcript while you talk, the subtitles while a reply is read, one big
button. With **Loop** on it reads each finished reply (not the messages in
between), says "Recording started", dictates until you end the turn, sends,
and waits for the next reply. The big button, or Space on web and desktop,
ends your turn, skips the reading, or starts talking again while it waits.
`packages/client-runtime/src/voiceLoop.ts` is the loop; each client supplies
dictation (`VoiceMode.tsx` on web, `features/voice-mode/` on Android).

On Android the loop is a "call" that keeps going with the screen off
(`apps/mobile/modules/t3-voice-call`): a foreground service of type microphone
and media playback, started from the open app and kept until you hang up (the
notification's **Hang up**, or Loop off), so each turn may record and play from
the background. It records with its own MediaRecorder (from a Bluetooth
headset's microphone when one is connected), keeps React Native's timers
running with a headless JS task, and holds a wake lock. Its media session takes
the hardware buttons: while you talk or wait, a volume key ends the turn
(a remote volume provider, so the volume does not change), and an earbud tap
does the same and also skips a reading. It plays an inaudible loop, because
Android gives the earbud button only to an app that is playing audio. Tested on
the emulator with the screen off, with key events sent to the kernel input
device (`adb root; adb shell sendevent /dev/input/event13 1 114 1 ...`; `adb
shell input keyevent` is injected and never reaches a media session while the
screen is off).

## Speak reply

When the personal agent speaks a message on the PC, the desktop app can open a
small always-on-top window, titled exactly `T3 Code — Speak reply`, that shows
the spoken line and the chat message it is about, and records the answer at
once without taking keyboard focus:

```sh
t3 app speak-reply --thread <threadId> --text "…" [--queued-at <epoch ms>]   # or --text-file <path|->
t3 app speak-reply --send     # send what was said (Enter in the window)
t3 app speak-reply --cancel   # close it (Esc); the recording waits, paused, in the thread's composer
t3 app speak-reply --status   # {"open","threadId","phase","recording","heard"}
```

There is only one window: a new message for the thread you are answering
keeps the recording going and swaps the text; one for another thread pauses
the recording (kept in that thread) and starts a new one. Send delivers the
transcript like a dictated composer send, steering the thread when a run is in
progress. If nothing is said in the first 30 seconds the empty recording is
dropped and **Record** starts again. **Open details** raises the main window
on the thread.

On Android, a push sent with `path: "/threads/<environment>/<thread>/dictate"`
opens the thread and starts dictating in its composer (unless voice mode is
running, which carries on).

## How it works

The host forwards authenticated `POST /api/dictation` speech actions to the
loopback coordinator at `http://127.0.0.1:8781/dictation`. Operators can override
this with `T3CODE_STT_URL`. Credentials are not forwarded; the verified subject
identifies recording ownership. This fork's deployment pairs a Nemotron Vulkan
preview with VibeVoice Q8 final recognition and bounded repository vocabulary
extraction. The speech service is packaged separately by the host's NixOS
configuration.

On the web, `apps/web/src/components/chat/dictationRecorder.ts` owns recordings
for the whole page, so they outlive the composer, and a Web Lock per recording
keeps two tabs from driving the same one. A paused recording needs nothing from
the speech service: it marks a recording inactive after 120 s without audio but
keeps accepting appends, also across its own restarts. When it no longer knows
the recording (404) or has closed it (409 and a status other than `recording`),
the client starts a continuation: a new server recording id that receives all
of the device's audio again from sequence 0. A 409 for a still-open recording
is resolved by matching the server's byte count against the stored chunk sizes.

Send prepares the same orchestration request a typed send makes, with
`[dictation:<id>]` where the transcript goes, and hands it to the
`dictation.deliver` websocket method instead of sending it. The server
checkpoints it privately under `userdata/dictation-deliveries`, replaces the
marker once the final transcript exists, and dispatches it through the normal
message intake. It resumes pending deliveries after a restart and reuses the
recording ID as the command ID, so a delivery is never repeated. A delivery the
chat keeps rejecting is retried, with backoff, until it lands; it is never
dropped. Clients keep their copy of the audio until `status` reports the
delivery `sent`, which the server answers even when the speech service has
forgotten the recording. Structured `dictation.*` events carry the recording ID and thread ID without
logging transcript text.

`T3CODE_UNSAFE_NO_AUTH=1` retains this deployment's explicit trusted-network mode;
without that exact value, normal upstream authentication applies. The mode uses
a persisted administrative session so websocket tickets remain functional, and
accepts any pairing code so the mobile app can connect.
