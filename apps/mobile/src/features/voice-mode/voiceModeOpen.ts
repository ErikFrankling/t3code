// Whether voice mode is on, without voiceMode's native and audio imports, so
// state code (and its unit tests) can ask without loading them.
let open = false;

export const voiceModeOpen = {
  get: (): boolean => open,
  set: (next: boolean): void => {
    open = next;
  },
};
