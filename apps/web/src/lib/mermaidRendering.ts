let nextDiagramId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/** Mermaid uses global configuration, so initialize and render each diagram together. */
export function renderMermaidDiagram(code: string, theme: "light" | "dark"): Promise<string> {
  const result = renderQueue.then(async () => {
    if (code.length > 50_000) throw new Error("Diagram exceeds the rendering limit");
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      htmlLabels: false,
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
      ],
      theme: theme === "dark" ? "dark" : "default",
    });
    const { svg } = await mermaid.render(`chat-mermaid-${++nextDiagramId}`, code);
    return svg;
  });
  renderQueue = result.catch(() => undefined);
  return result;
}
