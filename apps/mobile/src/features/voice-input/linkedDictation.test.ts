import { describe, expect, it } from "vite-plus/test";

import {
  requestLinkedDictation,
  subscribeLinkedDictation,
  takeLinkedDictation,
} from "./linkedDictation";

describe("linked dictation", () => {
  it("is taken once, only by the composer it was for", () => {
    let calls = 0;
    const unsubscribe = subscribeLinkedDictation(() => calls++);
    requestLinkedDictation("env:thread-1");
    expect(calls).toBe(1);
    expect(takeLinkedDictation("env:thread-2")).toBe(false);
    expect(takeLinkedDictation("env:thread-1")).toBe(true);
    expect(takeLinkedDictation("env:thread-1")).toBe(false);
    unsubscribe();
  });
});
