import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Whether dictation opens on the whole screen (chosen, and remembered) or as the card. */
export function useDictationFullScreen(): [boolean, (fullScreen: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const fullScreen =
    AsyncResult.isSuccess(preferences) && preferences.value.dictationFullScreen === true;
  return [fullScreen, (next) => save({ dictationFullScreen: next })];
}
