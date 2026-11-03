import { AppEnvironment } from './environment.model';

export const environment: AppEnvironment = {
    production: false,
    api_base_url: "http://localhost:5000/api/",
    // api_base_url: "https://api.kapomatic.com/api/",
    baseHREF: "/",
    offline: false,
    features: {
        website: true,
    },
};
