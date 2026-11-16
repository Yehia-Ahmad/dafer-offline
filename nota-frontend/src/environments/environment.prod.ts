import { AppEnvironment } from './environment.model';

// Production: the web server (nginx) serves this app and proxies /api/ to the backend, same origin.
export const environment: AppEnvironment = {
    production: true,
    api_base_url: "/api/",
    baseHREF: "/",
};
