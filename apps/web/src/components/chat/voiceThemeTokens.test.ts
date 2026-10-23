// @effect-diagnostics nodeBuiltinImport:off -- A test that reads source files to check their colour classes.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Voice mode and read-aloud follow the app's theme: every colour they use is
 * a theme token, so dark mode is dark everywhere. A fixed colour (`text-white`,
 * `bg-red-600`, `#fff`) or a class naming no token fails here.
 */
const SURFACES = ["VoiceMode.tsx", "ReadAloud.tsx", "../speakReply/SpeakReplyWindow.tsx"];

const tokens = new Set(
  [
    ...NodeFs.readFileSync(NodePath.join(import.meta.dirname, "../../index.css"), "utf8").matchAll(
      /--color-([a-z0-9-]+)/g,
    ),
  ].map((match) => match[1]),
);

// Utilities that share a prefix with colours but set size, alignment, width or shadow size.
const NOT_A_COLOUR =
  /^(?:text-(?:xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify)|border(?:-[trblxy])?(?:-\d+)?|ring(?:-\d+)?|shadow(?:-(?:xs|sm|md|lg|xl|2xl|none))?)$/;

// The theme also defines Tailwind's raw palette; those colours do not follow dark mode.
const PALETTE =
  /^(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)$/;

function themeProblems(source: string): string[] {
  const problems: string[] = [];
  for (const [literal] of source.matchAll(/"[^"\n]*"|`[^`]*`/g)) {
    for (const [utility, , name] of literal.matchAll(
      /(?<![\w-])(bg|text|border|ring|shadow|fill|stroke|placeholder)-([a-z][a-z0-9-]*)(?:\/\d+)?(?![\w-])/g,
    )) {
      if (NOT_A_COLOUR.test(utility.replace(/\/\d+$/, ""))) continue;
      if (PALETTE.test(name!) || !tokens.has(name!)) {
        problems.push(`${utility}: not a theme colour`);
      }
    }
  }
  for (const [colour] of source.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)) {
    problems.push(`${colour}: fixed colour`);
  }
  return problems;
}

describe("voice and read-aloud surfaces follow the app theme", () => {
  it.each(SURFACES)("%s uses only theme colours", (file) => {
    const source = NodeFs.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");
    expect(themeProblems(source)).toEqual([]);
  });

  it("catches fixed colours", () => {
    expect(themeProblems(`className="bg-primary text-white" c="bg-red-600"`)).toEqual([
      "text-white: not a theme colour",
      "bg-red-600: not a theme colour",
    ]);
  });
});
