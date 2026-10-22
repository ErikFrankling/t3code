import { describe, expect, it } from "vite-plus/test";

import { pillBottomAbove } from "./floatingClearance";

describe("pillBottomAbove", () => {
  it("keeps the pill clear of a New thread button raised by the tab bar", () => {
    // 1080x2400 at 2.625: window 914dp tall. The button starts at 795dp because
    // the tab bar sits below it; the old fixed offset (100dp) put the pill on it.
    expect(pillBottomAbove(795, 914, 100)).toBe(914 - 795 + 12);
  });

  it("uses the fixed offset when there is no button", () => {
    expect(pillBottomAbove(null, 914, 100)).toBe(100);
  });

  it("never sits lower than the fixed offset", () => {
    expect(pillBottomAbove(900, 914, 100)).toBe(100);
  });
});
