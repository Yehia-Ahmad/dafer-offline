const XLSX = require("xlsx");

const WORKSHEET_NAME = "Categories";
const PRODUCTS_WORKSHEET_NAME = "Products";
const REQUIRED_HEADERS = ["Name"];
const EXPORT_HEADERS = ["Name", "ImageBase64", "Specifications"];
const PRODUCT_EXPORT_HEADERS = [
  "ProductId",
  "CategoryId",
  "CategoryName",
  "Name",
  "Code",
  "InventoryCount",
  "ImageBase64",
  "WholesalePrice",
  "PurchasePrice",
  "RetailPrice",
  "SoldItemCount",
  "Specifications",
  "CreatedAt",
  "UpdatedAt",
];
const MAX_IMPORT_ROWS = 10_000;
// Excel limits text cells to 32,767 characters. A lower chunk size leaves
// headroom while preserving large Base64 images and specification JSON.
const MAX_TEXT_CELL_LENGTH = 30_000;

class CategoryWorkbookValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CategoryWorkbookValidationError";
  }
}

// Build the workbook in memory so the controller can send it directly without
// creating temporary files on the server.
const splitCellText = (value) => {
  const text = String(value ?? "");
  if (!text) return [""];

  const chunks = [];
  for (let offset = 0; offset < text.length; offset += MAX_TEXT_CELL_LENGTH) {
    chunks.push(text.slice(offset, offset + MAX_TEXT_CELL_LENGTH));
  }

  return chunks;
};

const continuationHeader = (baseHeader, chunkIndex) =>
  chunkIndex === 0 ? baseHeader : `${baseHeader}_${chunkIndex + 1}`;

const createCategoriesWorksheet = (categories) => {
  let maxImageChunks = 1;
  let maxSpecificationChunks = 1;

  const chunkedRows = categories.map((category) => {
    // The database field is named `image`; ImageBase64 is the public Excel column.
    const imageChunks = splitCellText(category.image || "");
    const specificationChunks = splitCellText(
      JSON.stringify(category.specifications || [])
    );

    maxImageChunks = Math.max(maxImageChunks, imageChunks.length);
    maxSpecificationChunks = Math.max(
      maxSpecificationChunks,
      specificationChunks.length
    );

    return {
      name: category.name,
      imageChunks,
      specificationChunks,
    };
  });

  // Keep the required public columns first. Numbered columns are only added
  // when a value exceeds Excel's per-cell limit.
  const headers = [...EXPORT_HEADERS];
  for (let index = 1; index < maxImageChunks; index += 1) {
    headers.push(continuationHeader("ImageBase64", index));
  }
  for (let index = 1; index < maxSpecificationChunks; index += 1) {
    headers.push(continuationHeader("Specifications", index));
  }

  const rows = chunkedRows.map(({ name, imageChunks, specificationChunks }) => {
      const row = {
        Name: name,
        ImageBase64: imageChunks[0],
        Specifications: specificationChunks[0],
      };

      imageChunks.slice(1).forEach((chunk, index) => {
        row[continuationHeader("ImageBase64", index + 1)] = chunk;
      });
      specificationChunks.slice(1).forEach((chunk, index) => {
        row[continuationHeader("Specifications", index + 1)] = chunk;
      });
      return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: headers,
  });

  worksheet["!cols"] = headers.map((header) => ({
    wch: header === "Name" ? 30 : 60,
  }));

  return { headers, worksheet };
};

const createProductsWorksheet = (products) => {
  let maxImageChunks = 1;
  let maxSpecificationChunks = 1;

  const chunkedRows = products.map((product) => {
    const imageChunks = splitCellText(product.imageBase64 || "");
    const specificationChunks = splitCellText(
      JSON.stringify(product.specifications || [])
    );

    maxImageChunks = Math.max(maxImageChunks, imageChunks.length);
    maxSpecificationChunks = Math.max(
      maxSpecificationChunks,
      specificationChunks.length
    );

    return { product, imageChunks, specificationChunks };
  });

  const headers = [...PRODUCT_EXPORT_HEADERS];
  for (let index = 1; index < maxImageChunks; index += 1) {
    headers.push(continuationHeader("ImageBase64", index));
  }
  for (let index = 1; index < maxSpecificationChunks; index += 1) {
    headers.push(continuationHeader("Specifications", index));
  }

  const rows = chunkedRows.map(({ product, imageChunks, specificationChunks }) => {
    const row = {
      ProductId: product.productId,
      CategoryId: product.categoryId,
      CategoryName: product.categoryName,
      Name: product.name,
      Code: product.code,
      InventoryCount: product.inventoryCount,
      ImageBase64: imageChunks[0],
      WholesalePrice: product.wholesalePrice,
      PurchasePrice: product.purchasePrice,
      RetailPrice: product.retailPrice,
      SoldItemCount: product.soldItemCount,
      Specifications: specificationChunks[0],
      CreatedAt: product.createdAt,
      UpdatedAt: product.updatedAt,
    };

    imageChunks.slice(1).forEach((chunk, index) => {
      row[continuationHeader("ImageBase64", index + 1)] = chunk;
    });
    specificationChunks.slice(1).forEach((chunk, index) => {
      row[continuationHeader("Specifications", index + 1)] = chunk;
    });

    return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  worksheet["!cols"] = headers.map((header) => ({
    wch: ["ImageBase64", "Specifications"].some((prefix) =>
      header.startsWith(prefix)
    )
      ? 60
      : 20,
  }));

  return worksheet;
};

const createCategoryWorkbookWithProducts = (categories, products = []) => {
  const categorySheet = createCategoriesWorksheet(categories);
  const productsWorksheet = createProductsWorksheet(products);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, categorySheet.worksheet, WORKSHEET_NAME);
  XLSX.utils.book_append_sheet(
    workbook,
    productsWorksheet,
    PRODUCTS_WORKSHEET_NAME
  );

  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
  });
};

const parseWorkbook = (buffer) => {
  // .xlsx files are ZIP containers. Checking the signature prevents renamed
  // CSV/text files from being accepted by XLSX's permissive parser.
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    throw new CategoryWorkbookValidationError("The uploaded file is not a valid .xlsx workbook");
  }

  let workbook;

  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (_error) {
    throw new CategoryWorkbookValidationError("The uploaded file is not a valid Excel workbook");
  }

  return workbook;
};

const readWorksheetRows = (
  workbook,
  sheetName,
  requiredHeaders,
  { optional = false } = {}
) => {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    if (optional) return [];
    throw new CategoryWorkbookValidationError(
      `The uploaded workbook does not contain the ${sheetName} worksheet`
    );
  }

  const table = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false,
  });

  if (table.length === 0) {
    if (optional) return [];
    throw new CategoryWorkbookValidationError(`${sheetName} worksheet is empty`);
  }

  const headers = table[0].map((header) => String(header).trim());
  const missingHeaders = requiredHeaders.filter(
    (header) => !headers.includes(header)
  );

  if (missingHeaders.length > 0) {
    throw new CategoryWorkbookValidationError(
      `${sheetName} worksheet is missing required column(s): ${missingHeaders.join(", ")}`
    );
  }

  const dataRows = table.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new CategoryWorkbookValidationError(
      `${sheetName} worksheet exceeds the maximum of ${MAX_IMPORT_ROWS} data rows`
    );
  }

  // Preserve the physical Excel row number for actionable import errors.
  return dataRows.map((cells, index) => {
    const row = {};
    headers.forEach((header, columnIndex) => {
      if (header) row[header] = cells[columnIndex] ?? "";
    });

    return { rowNumber: index + 2, values: row };
  });
};

const readCategoryWorkbook = (buffer) => {
  const workbook = parseWorkbook(buffer);

  if (!workbook.SheetNames[0]) {
    throw new CategoryWorkbookValidationError(
      "The uploaded workbook does not contain a worksheet"
    );
  }

  const categorySheetName = workbook.Sheets[WORKSHEET_NAME]
    ? WORKSHEET_NAME
    : workbook.SheetNames[0];
  return readWorksheetRows(workbook, categorySheetName, REQUIRED_HEADERS);
};

const readCategoryAndProductWorkbook = (buffer) => {
  const workbook = parseWorkbook(buffer);
  const categorySheetName = workbook.Sheets[WORKSHEET_NAME]
    ? WORKSHEET_NAME
    : workbook.SheetNames[0];

  return {
    categoryRows: readWorksheetRows(
      workbook,
      categorySheetName,
      REQUIRED_HEADERS
    ),
    productRows: readWorksheetRows(
      workbook,
      PRODUCTS_WORKSHEET_NAME,
      PRODUCT_EXPORT_HEADERS,
      { optional: true }
    ),
  };
};

module.exports = {
  CategoryWorkbookValidationError,
  createCategoryWorkbook: createCategoryWorkbookWithProducts,
  readCategoryAndProductWorkbook,
  readCategoryWorkbook,
};
