import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

/** Whether dictation opens on the whole screen (chosen, and remembered) or as the card. */
export function useDictationFullScreen(): [boolean, (fullScreen: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const fullScreen =
    AsyncResult.isSuccess(preferences) && preferences.value.dictationFullScreen === true;
  return [fullScreen, (next) => void save({ dictationFullScreen: next })];
}
