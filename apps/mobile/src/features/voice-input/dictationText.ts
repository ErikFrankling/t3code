import * as Dialog from "../../components/ui/Dialog";

/**
 * The words of a dictation as one text: what the refining recognizer has
 * finished, then the part of the live draft it does not cover yet (as in the
 * web composer's dictation).
 */
export function splitTranscript(
  final: string,
  draft: string,
): { readonly refined: string; readonly tail: string } {
  const refined = final.trim();
  const live = draft.trim();
  if (!refined) return { refined: "", tail: live };
  const covered = refined.split(/\s+/).length;
  return { refined, tail: live.split(/\s+/).slice(covered).join(" ") };
}

/** Asks before deleting what was said so far. */
export function confirmCancelDictation(voiceInput: { readonly cancelAndDelete: () => void }) {
  Dialog.alert("Discard this recording?", "What you said so far will be deleted.", [
    { text: "Keep recording", style: "cancel" },
    { text: "Discard", style: "destructive", onPress: voiceInput.cancelAndDelete },
  ]);
}
