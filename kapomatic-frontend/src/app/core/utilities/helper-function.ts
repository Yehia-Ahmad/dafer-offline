
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


/**
 * Recursively builds a FormData object from a given object.
 *
 * @param formData The FormData instance to append the key-value pairs to.
 * @param data The object to extract the key-value pairs from.
 * @param parentKey The parent key to use when the key-value pairs are nested.
 */
function buildFormData(
    formData: FormData,
    data: Record<any, any>,
    parentKey = ''
) {
    if (
        data &&
        typeof data === 'object' &&
        !(data instanceof Date) &&
        !(data instanceof File) &&
        !(data instanceof Blob)
    ) {
        Object.keys(data).forEach((key) => {
            buildFormData(
                formData,
                data[key],
                parentKey ? `${parentKey}[${key}]` : key
            );
        });
    } else {
        let value: any = data;
        if (data && !(data instanceof String) && !(data instanceof Blob)) {
            value = data.toString();
        }
        formData.append(parentKey, value);
    }
}

/**
 * Creates a new FormData object and appends all the key-value pairs from the given
 * payload object to it. If the value is an object, it will be recursively processed
 * and the resulting key-value pairs will be appended to the FormData as well.
 *
 * @param {Record<string, any>} payload The payload object to be processed.
 * @returns {FormData} The resulting FormData object.
 */
export const createdFormData = (payload: Record<any, any>) => {
    const formdata = new FormData();

    buildFormData(formdata, payload);

    return formdata;
};


export const convertURLTOFile = async (url: string) => {
    let blob = await fetch(url).then((r) => r.blob());
    return blob;
};
/**
 * Recursively parses a JSON string into an object.
 *
 * If the parsed object is a string, it will attempt to parse it again.
 *
 * @param {string} txt The JSON string to parse.
 * @returns {any} The parsed object.
 * @throws Will throw an error if the given string is not valid JSON.
 */


/**
 * Recursively parses a JSON string into an object.
 *
 * If the parsed result is a string, it attempts to parse it again
 * until a non-string object is obtained.
 *
 * @param {string} txt The JSON string to parse.
 * @returns {any} The parsed object.
 * @throws Will throw an error if the given string is not valid JSON.
 */

export const jsonParser = (txt) => {
    let parsed = JSON.parse(txt);
    if (typeof parsed === 'string') parsed = jsonParser(parsed);
    return parsed;
};



/**
 * Filters out key-value pairs in the provided object where the value is null or undefined.
 *
 * @param {Record<string, any>} params The object containing key-value pairs to filter.
 * @returns {Record<string, any>} A new object with only the key-value pairs where the value is neither null nor undefined.
 */

export const filterParams = (params) => {
    return Object.entries(params)
        .filter(([key, val]) => val !== null && val !== undefined)
        .reduce((obj, [key, val]) => {
            obj[key] = val;
            return obj;
        }, {});
};

/**
 * Format a given date string into a human-readable format with AM/PM
 *
 * If the given date string is invalid, an empty string is returned.
 *
 * @param {string} date The date string to be formatted.
 * @returns {string} The formatted string.
 */
export const format_date = (date) => {
    const new_date = new Date(date) as unknown;
    if (new_date === 'Invalid Date') {
        return '';
    }
    const date_arr = new_date.toString().split(' ').splice(1, 4);
    const time = date_arr[3].split(':');
    let AM = true;
    if (parseInt(time[0]) > 12) {
        time[0] = (parseInt(time[0]) - 12).toString();
        date_arr[3] = time.join(':');
        AM = false;
    }

    return `${date_arr.join(' ')} ${AM ? 'AM' : 'PM'}`;
};
