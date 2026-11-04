const path = require("path");
const multer = require("multer");

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

const upload = multer({
  // Memory storage is appropriate because the service reads the workbook from
  // a buffer and avoids lifecycle/security issues around temporary files.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== ".xlsx") {
      return callback(new Error("Only .xlsx files are accepted"));
    }

    return callback(null, true);
  },
});

// Normalize all Multer errors to a client error instead of leaking them as 500s.
const uploadCategoryWorkbook = (req, res, next) => {
  upload.single("file")(req, res, (error) => {
    if (error) {
      res.status(400);
      return next(error);
    }

    return next();
  });
};

module.exports = uploadCategoryWorkbook;
