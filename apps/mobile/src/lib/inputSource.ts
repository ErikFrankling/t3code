import { describeInputDevice, type InputSource, type InputSourceMethod } from "@t3tools/contracts";
import * as Device from "expo-device";

export function mobileInputSource(method: InputSourceMethod): InputSource {
  return {
    device: describeInputDevice({
      surface: "mobile",
      handheld: Device.deviceType === Device.DeviceType.TABLET ? "tablet" : "phone",
    }),
    method,
  };
}
