import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Voice mode, dictation and read-aloud follow the app's theme: every colour
 * they use is a theme token, so dark mode is dark everywhere. A class that
 * names no token (voice mode once used `bg-background`, which the mobile
 * theme does not have, and showed Android's white window behind it) or a
 * fixed colour (`bg-red-600`, `text-white`, `#ffffff`) fails here.
 */
const src = NodePath.join(import.meta.dirname, "../..");
const SURFACES = [
  "features/voice-mode/VoiceModeView.tsx",
  "features/threads/ReadAloudButton.tsx",
  "features/voice-input/ComposerDictationControl.tsx",
  "features/voice-input/DictationLivePreview.tsx",
  "features/voice-input/DictationScreen.tsx",
  "features/voice-input/GlobalVoiceInputControl.tsx",
];

const tokens = new Set(
  [
    ...NodeFs.readFileSync(NodePath.join(src, "../generated-uniwind-themes.css"), "utf8").matchAll(
      /--color-([a-z0-9-]+)/g,
    ),
  ].map((match) => match[1]),
);

// Utilities that share a prefix with colours but set size, alignment or width.
const NOT_A_COLOUR =
  /^(?:text-(?:3xs|2xs|xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify)|border(?:-[trblxy])?(?:-\d+)?|border-(?:solid|dashed|dotted|none))$/;

/** Colour problems in one source file: classes naming no theme token, and fixed colours. */
function themeProblems(source: string): string[] {
  const problems: string[] = [];
  for (const [literal] of source.matchAll(/"[^"\n]*"|`[^`]*`/g)) {
    for (const [utility, , name] of literal.matchAll(
      /(?<![\w-])(bg|text|border|accent|ring|fill|stroke|placeholder)-([a-z][a-z0-9-]*)(?:\/\d+)?(?![\w-])/g,
    )) {
      if (NOT_A_COLOUR.test(utility.replace(/\/\d+$/, ""))) continue;
      if (!tokens.has(name!)) problems.push(`${utility}: not a theme colour`);
    }
  }
  for (const [colour] of source.matchAll(
    /#[0-9a-fA-F]{3,8}\b|\brgba?\(|["'](?:white|black)["']/g,
  )) {
    problems.push(`${colour}: fixed colour`);
  }
  return problems;
}

describe("voice and read-aloud surfaces follow the app theme", () => {
  it.each(SURFACES)("%s uses only theme colours", (file) => {
    expect(themeProblems(NodeFs.readFileSync(NodePath.join(src, file), "utf8"))).toEqual([]);
  });

  it("catches what made voice mode white", () => {
    expect(themeProblems(`<View className="flex-1 bg-background" />`)).toEqual([
      "bg-background: not a theme colour",
    ]);
    expect(
      themeProblems(`className="rounded-full bg-red-600" tintColor="#ffffff" c="text-white"`),
    ).toEqual([
      "bg-red-600: not a theme colour",
      "text-white: not a theme colour",
      "#ffffff: fixed colour",
    ]);
    expect(themeProblems(`className="text-2xl border-2 bg-screen text-foreground"`)).toEqual([]);
  });
});

describe("full-screen surfaces in their own window", () => {
  // A Modal is a separate Android window: the status bar style set in App.tsx
  // does not reach it, and on the light theme its icons were white on white.
  it("the dictation screen sets the status bar from the theme", () => {
    const source = NodeFs.readFileSync(
      NodePath.join(src, "features/voice-input/DictationScreen.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /<StatusBar barStyle=\{themeAppearance === "dark" \? "light-content" : "dark-content"\} \/>/,
    );
  });
});

describe("the Voice and Read latest dock", () => {
  // It floats above its anchor; anchored below the notices, it covered them.
  it("is anchored above every notice over the composer", () => {
    const source = NodeFs.readFileSync(
      NodePath.join(src, "features/threads/ThreadDetailScreen.tsx"),
      "utf8",
    );
    const dock = source.indexOf("<ReadAloudDock");
    expect(dock).toBeGreaterThan(0);
    for (const notice of [
      "<ComposerErrorNotice",
      "<ComposerFeedback",
      "<ComposerQueuedEditBanner",
    ]) {
      expect(source.indexOf(notice)).toBeGreaterThan(dock);
    }
  });
});
