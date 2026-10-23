import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type AttentionItem,
  type AttentionItemError,
  type PersonalAgentHomeState,
  type SpokenEntry,
  type SpokenStatus,
  type TodaySummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as AttentionItemService from "./AttentionItemService.ts";

/**
 * What the personal agent home shows besides the to-do list: what the agent
 * said out loud (the speak tool's log) and today so far from the Time tracker.
 * All three arrive in one live stream.
 */

/** The speak tool's event log, one JSON object per line. */
const SPEAK_DIR = [".local", "state", "speak"] as const;
const SPOKEN_LIMIT = 300;
/** Only the end of a long log is read; older entries are history nobody scrolls to. */
const SPOKEN_TAIL_BYTES = 1_000_000;
const TIME_URL = process.env.T3CODE_TIME_URL ?? "https://time.erikfrankling.duckdns.org";
const TIME_REFRESH = Duration.minutes(5);

export class PersonalAgentHome extends Context.Service<
  PersonalAgentHome,
  {
    readonly subscribe: () => Stream.Stream<PersonalAgentHomeState, AttentionItemError>;
  }
>()("t3/attention/PersonalAgentHome") {}

/** "2026-10-23T04:19:34+0200" -> "2026-10-23T04:19:34+02:00". */
const isoTime = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const STATUS_EVENTS: ReadonlyArray<SpokenStatus> = [
  "queued",
  "waiting",
  "generated",
  "speaking",
  "spoken",
  "dropped",
  "interrupted",
];
/** A later event never moves an utterance back to an earlier stage. */
const FINAL: ReadonlySet<SpokenStatus> = new Set(["spoken", "dropped", "interrupted"]);

/** Folds the speak log into one entry per utterance, newest first. */
export function foldSpokenLog(
  lines: ReadonlyArray<string>,
  audioIds: ReadonlySet<string>,
  audioDir: string,
): ReadonlyArray<SpokenEntry> {
  const entries = new Map<string, { -readonly [K in keyof SpokenEntry]: SpokenEntry[K] }>();
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = text(event.id);
    const at = isoTime(event.time);
    const kind = text(event.event);
    if (id === null || at === null || kind === null) continue;
    let entry = entries.get(id);
    if (entry === undefined) {
      entry = {
        id,
        text: "",
        source: null,
        queuedAt: null,
        status: "queued",
        statusAt: at,
        reason: null,
        sink: null,
        audioPath: audioIds.has(id) ? `${audioDir}/${id}.wav` : null,
        seconds: null,
      };
      entries.set(id, entry);
    }
    if (kind === "queued") {
      entry.text = text(event.text) ?? entry.text;
      entry.source = text(event.source);
      entry.queuedAt = at;
    }
    if (kind === "generated") {
      entry.text = text(event.spoken_text) ?? entry.text;
      if (typeof event.seconds === "number") entry.seconds = event.seconds;
    }
    if (kind === "speaking" && entry.text.length === 0) entry.text = text(event.text) ?? "";
    entry.sink = text(event.sink) ?? entry.sink;
    const status = STATUS_EVENTS.find((candidate) => candidate === kind);
    if (status !== undefined && !(FINAL.has(entry.status) && !FINAL.has(status))) {
      entry.status = status;
      entry.statusAt = at;
      entry.reason = text(event.reason);
    }
  }
  return [...entries.values()]
    .filter((entry) => entry.text.length > 0)
    .toSorted((left, right) =>
      (right.queuedAt ?? right.statusAt).localeCompare(left.queuedAt ?? left.statusAt),
    )
    .slice(0, SPOKEN_LIMIT);
}

/** Sums Time's per-minute day into minutes per activity. */
export function summarizeDay(date: string, body: unknown): TodaySummary | null {
  if (body === null || typeof body !== "object") return null;
  const minutes = (body as { readonly minutes?: unknown }).minutes;
  if (!Array.isArray(minutes)) return null;
  const totals = new Map<string, number>();
  let current: string | null = null;
  for (const minute of minutes as ReadonlyArray<Record<string, unknown>>) {
    const activity = text(minute.activity);
    if (activity === null) continue;
    totals.set(activity, (totals.get(activity) ?? 0) + 1);
    const project = text(minute.project);
    current = project === null ? activity : `${activity} · ${project}`;
  }
  const activities = [...totals.entries()]
    .map(([activity, count]) => ({ activity, minutes: count }))
    .toSorted((left, right) => right.minutes - left.minutes);
  return {
    date,
    totalMinutes: activities.reduce((sum, entry) => sum + entry.minutes, 0),
    activities,
    current,
  };
}

const sameToday = (left: TodaySummary | null, right: TodaySummary | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.date === right.date &&
    left.totalMinutes === right.totalMinutes &&
    left.current === right.current &&
    left.activities.length === right.activities.length &&
    left.activities.every(
      (entry, index) =>
        entry.activity === right.activities[index]?.activity &&
        entry.minutes === right.activities[index]?.minutes,
    ));

export const layer = Layer.effect(
  PersonalAgentHome,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attention = yield* AttentionItemService.AttentionItemService;
    const http = yield* HttpClient.HttpClient;
    const home = yield* HostProcess.HomeDirectory;

    const speakDir = path.join(home, ...SPEAK_DIR);
    const logFile = path.join(speakDir, "utterances.jsonl");
    const audioDir = path.join(speakDir, "audio");

    const changes = yield* PubSub.sliding<void>(1);
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    const today = yield* Ref.make<TodaySummary | null>(null);

    const readSpoken = Effect.fn("PersonalAgentHome.readSpoken")(
      function* () {
        if (!(yield* fs.exists(logFile))) return [] as ReadonlyArray<SpokenEntry>;
        const content = yield* fs.readFileString(logFile);
        const tail =
          content.length > SPOKEN_TAIL_BYTES ? content.slice(-SPOKEN_TAIL_BYTES) : content;
        const audio = yield* fs.readDirectory(audioDir).pipe(Effect.orElseSucceed(() => []));
        const ids = new Set(
          audio.filter((name) => name.endsWith(".wav")).map((name) => name.slice(0, -4)),
        );
        return foldSpokenLog(tail.split("\n"), ids, audioDir);
      },
      (effect) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not read the speak log.", { cause }).pipe(
              Effect.as([] as ReadonlyArray<SpokenEntry>),
            ),
          ),
        ),
    );

    const refreshToday = Effect.fn("PersonalAgentHome.refreshToday")(
      function* () {
        const now = yield* Clock.currentTimeMillis;
        // The tracker's days are local days.
        const date = new Intl.DateTimeFormat("en-CA").format(now);
        const response = yield* http.execute(HttpClientRequest.get(`${TIME_URL}/api/day/${date}`));
        if (response.status !== 200) return;
        const summary = summarizeDay(date, yield* response.json);
        const previous = yield* Ref.getAndSet(today, summary);
        if (!sameToday(previous, summary)) yield* notify;
      },
      (effect) =>
        effect.pipe(
          Effect.timeout(Duration.seconds(20)),
          Effect.catchCause((cause) =>
            Effect.logDebug("Could not read today from Time.", { cause }),
          ),
        ),
    );

    const watcherScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
    yield* fs.makeDirectory(speakDir, { recursive: true }).pipe(Effect.ignoreCause({ log: true }));
    yield* fs.watch(speakDir).pipe(
      Stream.debounce(Duration.millis(200)),
      Stream.runForEach(() => notify),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
    );
    yield* refreshToday().pipe(
      Effect.repeat(Schedule.spaced(TIME_REFRESH)),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
    );

    const subscribe: PersonalAgentHome["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the first snapshot so no change is lost.
          const subscription = yield* PubSub.subscribe(changes);
          const latestItems = yield* Ref.make<ReadonlyArray<AttentionItem>>([]);
          const snapshot = Effect.gen(function* () {
            return {
              items: yield* Ref.get(latestItems),
              spoken: yield* readSpoken(),
              today: yield* Ref.get(today),
            } satisfies PersonalAgentHomeState;
          });
          const itemChanges = attention
            .subscribeList()
            .pipe(Stream.mapEffect(({ items }) => Ref.set(latestItems, items)));
          const otherChanges = Stream.fromSubscription(subscription);
          return Stream.merge(itemChanges, otherChanges).pipe(
            Stream.debounce(Duration.millis(50)),
            Stream.mapEffect(() => snapshot),
          );
        }),
      );

    return { subscribe } satisfies PersonalAgentHome["Service"];
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
