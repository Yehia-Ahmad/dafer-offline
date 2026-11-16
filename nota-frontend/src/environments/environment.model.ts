export interface AppEnvironment {
    production: boolean;
    /** Base URL of the backend API, with a trailing slash. */
    api_base_url: string;
    baseHREF: string;
}
