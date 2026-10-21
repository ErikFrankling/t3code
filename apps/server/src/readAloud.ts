// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Plain Node calls to the local LLM and TTS servers, like dictationAudio.ts.
import * as NodeCrypto from "node:crypto";

import type { ReadAloudMode, ReadAloudRequest, ReadAloudState } from "@t3tools/contracts";

/**
 * Read-aloud: a local LLM rewrites an assistant message as a short spoken
 * briefing, and a TTS server speaks it sentence by sentence while the rest is
 * still being written. The summary call is a one-off request, so the thread's
 * own context is never touched.
 *
 * Two voices. The big one (Higgs TTS through llama-swap) is used only while
 * llama-swap already has it loaded: the host lends it the GPU when dictation
 * has been idle, and starting it on demand would take minutes. Otherwise the
 * small CPU voice (Kokoro) speaks.
 */
const env = (name: string, fallback: string) => process.env[name] || fallback;
const config = () => ({
  llmUrl: env("T3CODE_READ_ALOUD_LLM_URL", "http://127.0.0.1:8000/v1/chat/completions"),
  llmModel: env("T3CODE_READ_ALOUD_LLM_MODEL", "read-aloud-summary"),
  runningUrl: env("T3CODE_READ_ALOUD_RUNNING_URL", "http://127.0.0.1:8000/running"),
  big: {
    name: "big",
    model: env("T3CODE_READ_ALOUD_BIG_MODEL", "higgs-tts"),
    url: env(
      "T3CODE_READ_ALOUD_BIG_TTS_URL",
      "http://127.0.0.1:8000/upstream/higgs-tts/v1/audio/speech",
    ),
    voice: env("T3CODE_READ_ALOUD_BIG_VOICE", "erik"),
    speed: Number(env("T3CODE_READ_ALOUD_BIG_SPEED", "1")),
  },
  small: {
    name: "small",
    model: "kokoro",
    url: env("T3CODE_READ_ALOUD_SMALL_TTS_URL", "http://127.0.0.1:8880/v1/audio/speech"),
    voice: env("T3CODE_READ_ALOUD_SMALL_VOICE", "af_heart"),
    speed: Number(env("T3CODE_READ_ALOUD_SMALL_SPEED", "1.2")),
  },
});
type Voice = ReturnType<typeof config>["small"];

export const READ_ALOUD_PROMPT = `You turn one message from an AI coding assistant into a short spoken briefing. Text-to-speech will read your output aloud to the person who got the message. They are listening, not reading, so they hear every word once, in order, and cannot skim or scroll back.

Say what the message says, much more simply, like explaining it to a smart friend. Re-explain only: never answer questions, add advice, or invent facts that are not in the message.

What to include, in this order:
1. The point: what happened, what was found or what was decided.
2. Only the details that change what the listener understands or does.
3. What happens next, or what the message is asking the listener to decide. If it ends with a question, end with that question.

How it must sound:
- Plain spoken English. Short sentences. Casual and direct, but no jokes or filler.
- Start with the point itself. Never open a sentence with filler like "basically", "so", "ok so", "in short", "essentially" or "alright", and never say "basically" at all.
- No markdown, no headings, no bullet points, no lists, no tables, no emoji, no code.
- Never read out file paths, URLs, commands, code, IDs or version strings. Name the thing instead ("the llama-swap config", "your T3 Code fork").
- Write numbers the way you would say them: "about twenty gigabytes", "two to three seconds". Keep only the numbers that matter.
- Drop caveats, hedging and side notes unless they change the decision.
- Usually three to eight sentences. Go longer only if the message really contains more that matters, never more than about 150 words.

Output only the words to be spoken, nothing else.`;

/** Markdown read as prose: code blocks, links and formatting are dropped. */
export function speakableText(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, "")
      .replace(/[*_~|]+/g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line) => /[\p{L}\p{N}]/u.test(line))
      // Each line ends a sentence, so headings and list items are not run together.
      .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
      .join("\n")
  );
}

// Long sentences are cut at a comma so the first audio never waits on a run-on.
const MAX_SENTENCE = 260;

/** Splits off complete sentences; the unfinished tail stays in `rest`. */
export function takeSentences(
  buffer: string,
  final: boolean,
): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const boundary = /[.!?…]["')\]]?(?=\s)|\n+/;
  for (;;) {
    const match = boundary.exec(rest);
    if (!match) break;
    const end = match.index + match[0].length;
    sentences.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (final) {
    sentences.push(rest);
    rest = "";
  }
  const out: string[] = [];
  for (const raw of sentences) {
    let sentence = raw.replace(/\s+/g, " ").trim();
    while (sentence.length > MAX_SENTENCE) {
      const cut = sentence.lastIndexOf(", ", MAX_SENTENCE);
      if (cut < 40) break;
      out.push(sentence.slice(0, cut + 1));
      sentence = sentence.slice(cut + 2);
    }
    if (/[\p{L}\p{N}]/u.test(sentence)) out.push(sentence);
  }
  return { sentences: out, rest };
}

type Job = {
  id: string;
  status: ReadAloudState["status"];
  voice: string;
  // `audio` sits on the first sentence of a chunk and covers `span` sentences.
  sentences: { text: string; audio?: string; span?: number; covered?: boolean }[];
  error: string;
  touched: number;
};

const jobs = new Map<string, Job>();
const runs = new Map<string, Promise<void>>();
const JOB_TTL_MS = 60 * 60_000;
const MAX_JOBS = 100;

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "working" && now - job.touched > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

function view(job: Job, from: number): ReadAloudState {
  job.touched = Date.now();
  return {
    id: job.id,
    status: job.status,
    voice: job.voice,
    error: job.error,
    sentences: job.sentences.map((sentence, index) => ({
      text: sentence.text,
      ready: sentence.covered === true,
      ...(index >= from && sentence.audio !== undefined
        ? { audio: sentence.audio, span: sentence.span ?? 1 }
        : {}),
    })),
  };
}

async function bigVoiceLoaded(): Promise<boolean> {
  const { runningUrl, big } = config();
  try {
    const response = await fetch(runningUrl, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { running?: { model?: string; state?: string }[] };
    return (body.running ?? []).some(
      (entry) => entry.model === big.model && entry.state === "ready",
    );
  } catch {
    return false;
  }
}

/** Mono 16-bit PCM out of a WAV file (both voices answer `response_format: "wav"`). */
export function readWav(wav: Buffer): { sampleRate: number; samples: Int16Array } {
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
    } else if (id === "data") {
      // Streamed WAVs may carry a placeholder size; the data runs to the end.
      const end = size > 0 && offset + 8 + size <= wav.length ? offset + 8 + size : wav.length;
      const frames = Math.floor((end - offset - 8) / 2 / channels);
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = wav.readInt16LE(offset + 8 + i * 2 * channels);
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("The voice returned no audio.");
}

// Every clip gets the same seam: speech trimmed to the first and last audible
// sample, short fades so the cut never clicks, then one natural pause. The
// voices pad clips unevenly (up to ~0.2 s each side), which together with a
// clip switch made ~0.45 s gaps between sentences.
const SILENCE = 400;
const KEEP_MS = 30;
const FADE_MS = 10;
// Measured: the voice pauses 0.25-0.5 s between its own sentences.
const PAUSE_MS = 280;

export function polishClip({ sampleRate, samples }: { sampleRate: number; samples: Int16Array }) {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < SILENCE) start++;
  while (end > start && Math.abs(samples[end - 1]!) < SILENCE) end--;
  const keep = Math.round((sampleRate * KEEP_MS) / 1000);
  start = Math.max(0, start - keep);
  end = Math.min(samples.length, end + keep);
  const speech = samples.slice(start, end);
  const fade = Math.min(Math.round((sampleRate * FADE_MS) / 1000), Math.floor(speech.length / 2));
  for (let i = 0; i < fade; i++) {
    speech[i] = Math.round((speech[i]! * i) / fade);
    speech[speech.length - 1 - i] = Math.round((speech[speech.length - 1 - i]! * i) / fade);
  }
  const pause = Math.round((sampleRate * PAUSE_MS) / 1000);
  const data = Buffer.alloc((speech.length + pause) * 2);
  speech.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function synthesize(voice: Voice, text: string, speed: number): Promise<string> {
  const response = await fetch(voice.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: voice.model,
      input: text,
      voice: voice.voice,
      speed: voice.speed * speed,
      response_format: "wav",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${voice.name} voice: HTTP ${response.status}`);
  return polishClip(readWav(Buffer.from(await response.arrayBuffer()))).toString("base64");
}

// Openers the model keeps reaching for; dropped even when it ignores the prompt.
// Words that only count as filler with a comma after them ("Right now" stays),
// "so" unless it starts "so far" and the like, and openers that never carry meaning.
const FILLER_OPENER =
  /^(?:(?:(?:ok(?:ay)?|alright|all right|well|right|anyway|honestly|look)(?:\s*[,:;.!]|\s+(?=so\b|basically\b))|so\b(?!\s+(?:far|much|many|long|that|few|little)\b)[,:;.!]?|(?:basically|essentially|in short|in summary|to sum up|to summarize|long story short)\b[,:;.!]?)\s*)+/i;

/** A summary sentence without filler: no "basically", no "So,"-style opener. */
export function dropFiller(sentence: string): string {
  const trimmed = sentence
    .replace(/(,?)\s*\bbasically\b(,?)/gi, (_, before, after) => (before && after ? "," : ""))
    .replace(FILLER_OPENER, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Streams the summary, handing over each sentence as soon as it is complete. */
async function summarize(text: string, onSentence: (sentence: string) => void): Promise<void> {
  const { llmUrl, llmModel } = config();
  const response = await fetch(llmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmModel,
      stream: true,
      temperature: 0.3,
      top_p: 0.95,
      max_tokens: 600,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: READ_ALOUD_PROMPT },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) throw new Error(`summary model: HTTP ${response.status}`);
  const say = (sentence: string) => {
    const spoken = dropFiller(sentence);
    if (/[\p{L}\p{N}]/u.test(spoken)) onSentence(spoken);
  };
  const decoder = new TextDecoder();
  let pending = "";
  let buffer = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] })
        .choices?.[0]?.delta?.content;
      if (!delta) continue;
      buffer += delta;
      const { sentences, rest } = takeSentences(buffer, false);
      buffer = rest;
      sentences.forEach(say);
    }
  }
  takeSentences(buffer, true).sentences.forEach(say);
}

// The first chunk is one sentence, so audio starts as soon as it exists; later
// chunks take every sentence already written, up to about a paragraph. Fewer
// seams, and the voice phrases across sentences itself.
const CHUNK_CHARS = 320;

async function run(job: Job, text: string, mode: ReadAloudMode, speed: number) {
  const { big, small } = config();
  let voice = (await bigVoiceLoaded()) ? big : small;
  job.voice = voice.name;
  let next = 0;
  let running: Promise<void> | null = null;
  let failure: unknown = null;
  // After the first chunk, wait for a paragraph's worth of sentences (or the
  // end of the summary): the first chunk plays for seconds while the model
  // writes the rest in about two, so waiting costs nothing and saves seams.
  let writing = true;
  let wake: (() => void) | null = null;
  // Through a function: TypeScript narrows `wake` to null at direct call sites.
  const notify = () => wake?.();
  const pending = () =>
    job.sentences.slice(next).reduce((sum, sentence) => sum + sentence.text.length + 1, 0);
  const paragraph = async () => {
    for (;;) {
      if (next === 0 || !writing || pending() >= CHUNK_CHARS) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  const pump = async () => {
    while (next < job.sentences.length) {
      await paragraph();
      const first = next;
      let last = first + 1;
      let chars = job.sentences[first]!.text.length;
      const limit = first === 0 ? 0 : CHUNK_CHARS;
      while (last < job.sentences.length) {
        const length = job.sentences[last]!.text.length;
        if (chars + length > limit) break;
        chars += length + 1;
        last++;
      }
      const words = job.sentences
        .slice(first, last)
        .map((sentence) => sentence.text)
        .join(" ");
      let audio: string;
      try {
        audio = await synthesize(voice, words, speed);
      } catch (error) {
        // Dictation takes the GPU back by unloading the big voice; finish on the small one.
        if (voice === small) throw error;
        voice = small;
        job.voice = small.name;
        audio = await synthesize(voice, words, speed);
      }
      job.sentences[first]!.audio = audio;
      job.sentences[first]!.span = last - first;
      for (let index = first; index < last; index++) job.sentences[index]!.covered = true;
      next = last;
    }
  };
  // Sentences arrive while the summary streams; one pump synthesizes them in order.
  const kick = () => {
    running ??= pump()
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => {
        running = null;
        if (failure === null && next < job.sentences.length) kick();
      });
  };
  const add = (sentence: string) => {
    job.sentences.push({ text: sentence });
    notify();
    kick();
  };
  const settle = async () => {
    // `running` is replaced while we wait when more sentences arrive.
    for (let current = running; current; current = running) await current;
  };
  try {
    if (mode === "full") takeSentences(speakableText(text), true).sentences.forEach(add);
    else await summarize(text, add);
    writing = false;
    notify();
    await settle();
    if (failure !== null) throw failure;
    if (job.sentences.length === 0) throw new Error("There was nothing to read.");
    job.status = "complete";
  } catch (error) {
    writing = false;
    notify();
    await settle();
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
  }
}

/** Resolves when the job has finished (complete or error). */
export function whenSettled(id: string): Promise<void> {
  return runs.get(id) ?? Promise.resolve();
}

export function readAloud(request: ReadAloudRequest): ReadAloudState | null {
  prune();
  const from = request.from ?? 0;
  if (request.id) {
    const job = jobs.get(request.id);
    return job ? view(job, from) : null;
  }
  const text = request.text ?? "";
  const mode = request.mode ?? "summary";
  const speed = request.speed ?? 1;
  const id = NodeCrypto.createHash("sha256")
    .update(`${mode}\0${speed}\0${text}`)
    .digest("hex")
    .slice(0, 32);
  let job = jobs.get(id);
  if (!job || job.status === "error") {
    job = { id, status: "working", voice: "", sentences: [], error: "", touched: Date.now() };
    jobs.set(id, job);
    const done = run(job, text, mode, speed).finally(() => runs.delete(id));
    runs.set(id, done);
  }
  return view(job, from);
}
