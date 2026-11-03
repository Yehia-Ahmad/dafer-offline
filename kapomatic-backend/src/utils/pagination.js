const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_LIMIT);

const parsePaginationInteger = (value, defaultValue, maxValue = Infinity) => {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return defaultValue;
  }

  const parsedValue = Number(value);
  if (
    !Number.isSafeInteger(parsedValue) ||
    parsedValue < 1 ||
    parsedValue > maxValue
  ) {
    return defaultValue;
  }

  return parsedValue;
};

const getPaginationParams = (query = {}) => {
  const limit = parsePaginationInteger(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const page = parsePaginationInteger(query.page, DEFAULT_PAGE, MAX_PAGE);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const buildPaginationMetadata = ({ page, limit, totalItems }) => {
  const totalPages = Math.ceil(totalItems / limit);

  return {
    page,
    limit,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};

const buildPaginatedResponse = ({ data, page, limit, totalItems }) => ({
  success: true,
  data,
  pagination: buildPaginationMetadata({ page, limit, totalItems }),
});

module.exports = {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PAGE,
  parsePaginationInteger,
  getPaginationParams,
  buildPaginationMetadata,
  buildPaginatedResponse,
};
