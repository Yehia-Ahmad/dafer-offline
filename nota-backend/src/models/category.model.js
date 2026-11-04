const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم الفئة مطلوب"],
      trim: true,
      unique: true,
      maxlength: [120, "يجب ألا يزيد اسم الفئة عن 120 حرف"],
    },
    image: {
      type: String,
      trim: true,
      validate: {
        validator: isBase64Image,
        message:
          "يجب أن تكون صورة الفئة سلسلة base64 صالحة (خام أو بصيغة data URI)",
      },
    },
    specifications: {
      type: [
        {
          type: mongoose.Schema.Types.Mixed,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", categorySchema);
