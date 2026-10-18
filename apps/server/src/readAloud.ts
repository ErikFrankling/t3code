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
- Plain spoken English. Short sentences. Casual and direct, a light "ok so" or "basically" is fine, but no jokes or filler.
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
  sentences: { text: string; audio?: string }[];
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
      ready: sentence.audio !== undefined,
      ...(index >= from && sentence.audio !== undefined ? { audio: sentence.audio } : {}),
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

async function synthesize(voice: Voice, text: string, speed: number): Promise<string> {
  const response = await fetch(voice.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: voice.model,
      input: text,
      voice: voice.voice,
      speed: voice.speed * speed,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${voice.name} voice: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer()).toString("base64");
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
      sentences.forEach(onSentence);
    }
  }
  takeSentences(buffer, true).sentences.forEach(onSentence);
}

async function run(job: Job, text: string, mode: ReadAloudMode, speed: number) {
  const { big, small } = config();
  let voice = (await bigVoiceLoaded()) ? big : small;
  job.voice = voice.name;
  // Sentences are synthesized in order, one at a time, while the summary is
  // still streaming in; the client plays each clip as it lands.
  let queue = Promise.resolve();
  const speak = (index: number) => {
    queue = queue.then(async () => {
      const sentence = job.sentences[index];
      if (!sentence) return;
      try {
        sentence.audio = await synthesize(voice, sentence.text, speed);
      } catch (error) {
        // Dictation takes the GPU back by unloading the big voice; finish on the small one.
        if (voice === small) throw error;
        voice = small;
        job.voice = small.name;
        sentence.audio = await synthesize(voice, sentence.text, speed);
      }
    });
  };
  const add = (sentence: string) => {
    job.sentences.push({ text: sentence });
    speak(job.sentences.length - 1);
  };
  try {
    if (mode === "full") takeSentences(speakableText(text), true).sentences.forEach(add);
    else await summarize(text, add);
    await queue;
    if (job.sentences.length === 0) throw new Error("There was nothing to read.");
    job.status = "complete";
  } catch (error) {
    await queue.catch(() => undefined);
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
