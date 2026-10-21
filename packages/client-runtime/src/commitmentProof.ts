const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
const TOKEN = /(https?:\/\/[^\s)]+|\/[^\s)]+\.(?:png|jpe?g|webp|gif))/gi;

export type CommitmentProofPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "link"; readonly url: string }
  | { readonly type: "image"; readonly source: string; readonly local: boolean };

/**
 * Splits a commitment's proof into text, links and images, so clients can show
 * screenshots (local paths on the server, or URLs) as thumbnails.
 */
export function splitCommitmentProof(proof: string): ReadonlyArray<CommitmentProofPart> {
  const parts: CommitmentProofPart[] = [];
  let last = 0;
  for (const match of proof.matchAll(TOKEN)) {
    // Sentence punctuation after a path or URL is not part of it.
    const token = match[0].replace(/[.,;:!?]+$/, "");
    if (match.index > last) parts.push({ type: "text", text: proof.slice(last, match.index) });
    if (IMAGE_EXTENSION.test(token)) {
      parts.push({ type: "image", source: token, local: token.startsWith("/") });
    } else {
      parts.push({ type: "link", url: token });
    }
    last = match.index + token.length;
  }
  if (last < proof.length) parts.push({ type: "text", text: proof.slice(last) });
  return parts;
}
