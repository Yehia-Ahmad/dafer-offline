
/**
 * Removes any nullish (null, undefined, or empty string) properties from the given
 * object, and returns the resulting object. This is useful for cleaning up
 * objects before sending them as parameters to API endpoints.
 * @param {Record<string, any>} [params={}] The object to clean up.
 * @returns {Record<string, any>} The cleaned up object.
 */
export const removeNullishFieldsParams = (params: Record<any, any> = {}) => {
    Object.entries(params).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') {
            delete params[key];
        }
    });

    return params;
};
