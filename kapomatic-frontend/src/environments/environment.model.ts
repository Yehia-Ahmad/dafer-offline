export interface AppEnvironment {
    production: boolean;
    /** Base URL of the backend API, with a trailing slash. Set at runtime in the offline edition. */
    api_base_url: string;
    baseHREF: string;
    /** True only in the offline (LAN) desktop edition. */
    offline: boolean;
    features: {
        /** E-commerce settings, website images, website orders, SEO fields and WhatsApp links. */
        website: boolean;
    };
}
