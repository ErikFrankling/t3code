import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));

import { splitTranscript } from "./dictationText";

describe("splitTranscript", () => {
  it("shows the live draft while nothing is refined yet", () => {
    expect(splitTranscript("", "so I think we")).toEqual({ refined: "", tail: "so I think we" });
  });

  it("continues the refined words with the part of the draft beyond them", () => {
    expect(splitTranscript("So I think", "so I think we should ship it")).toEqual({
      refined: "So I think",
      tail: "we should ship it",
    });
  });

  it("has no tail once the refined text covers the draft", () => {
    expect(splitTranscript("So I think we should.", "so I think we should")).toEqual({
      refined: "So I think we should.",
      tail: "",
    });
  });
});
