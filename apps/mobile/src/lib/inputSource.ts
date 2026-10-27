import { describeInputDevice, type InputSource, type InputSourceMethod } from "@t3tools/contracts";

// Loaded lazily so modules that queue messages (and their unit tests) never
// load the native module; until it answers, a device counts as a phone.
let handheld: "phone" | "tablet" = "phone";
void import("expo-device")
  .then((Device) => {
    if (Device.deviceType === Device.DeviceType.TABLET) handheld = "tablet";
  })
  .catch(() => {});

export function mobileInputSource(method: InputSourceMethod): InputSource {
  return { device: describeInputDevice({ surface: "mobile", handheld }), method };
}
