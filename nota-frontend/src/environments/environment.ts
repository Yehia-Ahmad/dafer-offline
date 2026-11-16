import { AppEnvironment } from './environment.model';

// Development (ng serve): the backend runs on port 5000. Add the dev origin to CORS_ORIGINS.
export const environment: AppEnvironment = {
    production: false,
    api_base_url: "http://localhost:5000/api/",
    baseHREF: "/",
};
