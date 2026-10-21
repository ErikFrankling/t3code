import { describe, expect, it } from "vite-plus/test";

import { splitCommitmentProof } from "./commitmentProof.ts";

describe("splitCommitmentProof", () => {
  it("finds local screenshots, image URLs and links in free text", () => {
    expect(
      splitCommitmentProof(
        "Dark: /home/erikf/shots/a.png, light https://x.test/b.JPG; run https://github.com/o/r/actions/runs/1",
      ),
    ).toEqual([
      { type: "text", text: "Dark: " },
      { type: "image", source: "/home/erikf/shots/a.png", local: true },
      { type: "text", text: ", light " },
      { type: "image", source: "https://x.test/b.JPG", local: false },
      { type: "text", text: "; run " },
      { type: "link", url: "https://github.com/o/r/actions/runs/1" },
    ]);
  });
});
