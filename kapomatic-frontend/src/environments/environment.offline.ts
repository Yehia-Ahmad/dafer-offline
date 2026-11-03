import { AppEnvironment } from './environment.model';

// Offline (LAN) desktop edition. Used only by the "offline" build configuration.
export const environment: AppEnvironment = {
    production: true,
    // Filled in at startup from the desktop app (main PC or LAN address), see main.ts.
    api_base_url: "",
    baseHREF: "./",
    offline: true,
    features: {
        website: false,
    },
};
