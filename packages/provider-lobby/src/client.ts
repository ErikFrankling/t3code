/**
 * Lobby's client definition: settings form, label, API key field and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-lobby/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { LobbySettings } from "./settings.ts";

export const LOBBY_API_KEY_ENV = "LOBBY_API_KEY";

export const lobbyClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("lobby"),
  label: "Lobby",
  featured: false,
  badgeLabel: "Early Access",
  settingsSchema: LobbySettings,
  environmentFields: [
    {
      name: LOBBY_API_KEY_ENV,
      label: "Lobby API key",
      description:
        "From `lobby api-keys create --scopes account:read,workspace:read,agent:write`, with the repositories chats may use.",
      placeholder: "lobby_…",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 3784 3574",
    fill: { light: "#6B1D24", dark: "#F3D27A" },
    paths: [
      {
        d: "M2733.15 1927.57C2458.95 1794.58 2175.9 1570.15 1910.55 1187.8L1201.65 23.9962C1187.58 0.91065 1157.72 -6.81898 1134.22 6.54535L884.639 148.505C860.292 162.354 852.069 193.5 866.408 217.563L1365.68 1055.38C1391.74 1099.11 1343.4 1149.27 1298.73 1124.84L422.125 645.433C398.727 632.637 369.404 640.457 355.484 663.205L204.395 910.132C189.449 934.559 198.032 966.524 223.204 980.179L1091.66 1451.27C1137.24 1476 1119.68 1545.22 1067.82 1545.22H50C22.3857 1545.22 0 1567.6 0 1595.22V1860.95C0 1888.56 22.3858 1910.95 50 1910.95H1057.92C1109.85 1910.95 1127.36 1980.31 1081.65 2004.96L224.473 2467.14C198.82 2480.97 190.386 2513.72 206.167 2538.23L355.293 2769.76C369.43 2791.71 398.077 2799.08 421.058 2786.69L1295.48 2315.21C1340.49 2290.94 1388.6 2341.89 1361.79 2385.43L868.482 3186.76C853.255 3211.5 862.238 3243.96 888.017 3257.35L1135.3 3385.77C1158.49 3397.81 1187.05 3389.97 1200.83 3367.77L1703.08 2558.65C1729.62 2515.9 1795.56 2534.71 1795.56 2585.02V3523.35C1795.56 3550.97 1817.95 3573.35 1845.56 3573.35H2134.75C2162.36 3573.35 2184.75 3550.97 2184.75 3523.35V2587.18C2184.75 2536.7 2251.05 2518.03 2277.4 2561.09L2770.53 3367.02C2784.32 3389.55 2813.26 3397.47 2836.6 3385.1L3092.43 3249.48C3118.12 3235.86 3126.82 3203.27 3111.32 3178.66L2610.11 2382.6C2582.95 2339.47 2630.2 2288.11 2675.45 2311.58L3576.07 2778.76C3599.46 2790.89 3628.26 2782.78 3641.89 2760.22L3776.03 2538.12C3790.89 2513.52 3782 2481.48 3756.58 2468.06L2733.15 1927.57Z",
      },
    ],
  },
});
