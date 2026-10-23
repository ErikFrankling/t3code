import * as Schema from "effect/Schema";

// Brackets and newlines would break out of the one-line header the agent reads.
const HEADER_PART_PATTERN = /^[^[\]\r\n·]+$/;
const HeaderPart = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(48),
  Schema.isPattern(HEADER_PART_PATTERN),
);

export const InputSourceMethod = Schema.Literals(["typed", "dictation", "voice mode"]);
export type InputSourceMethod = typeof InputSourceMethod.Type;

/**
 * Where a user's message came from, machine-added by the client that sent it.
 * `via` names a special entry point such as the speak reply window.
 */
export const InputSource = Schema.Struct({
  device: HeaderPart,
  via: Schema.optional(HeaderPart),
  method: InputSourceMethod,
});
export type InputSource = typeof InputSource.Type;

export function describeInputSource(source: InputSource): string {
  return [source.device, ...(source.via === undefined ? [] : [source.via]), source.method].join(
    " · ",
  );
}

export function formatInputSourceHeader(source: InputSource): string {
  return `[${describeInputSource(source)}]`;
}

/**
 * The agent sees the header; the stored message and the user's own view do not carry it.
 * A slash command stays first, because providers only run it when the message starts with it.
 */
export function withInputSourceHeader(text: string, source: InputSource | undefined): string {
  if (source === undefined || text.trimStart().startsWith("/")) return text;
  return `${formatInputSourceHeader(source)}\n${text}`;
}

// Hostnames Erik's machines answer to, in the words he uses for them.
const HOST_ALIASES: Readonly<Record<string, string>> = { framework: "laptop" };

function hostWord(hostLabel: string | undefined): string | undefined {
  const cleaned = hostLabel
    ?.toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return HOST_ALIASES[cleaned] ?? cleaned.slice(0, 24);
}

/**
 * The words an agent reads for the client: "phone", "pc desktop", "pc web".
 * `hostLabel` is the machine the client runs on, when the client can know it.
 */
export function describeInputDevice(input: {
  readonly surface: "mobile" | "desktop" | "web";
  readonly handheld?: "phone" | "tablet";
  readonly hostLabel?: string | undefined;
}): string {
  const host = hostWord(input.hostLabel);
  if (input.surface === "mobile") return input.handheld ?? "phone";
  if (input.handheld !== undefined) return `${input.handheld} web`;
  return host === undefined ? input.surface : `${host} ${input.surface}`;
}
