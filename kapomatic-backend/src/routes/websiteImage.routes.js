const express = require("express");
const {
  createWebsiteImage,
  getWebsiteImages,
  getActiveWebsiteImages,
  getActiveWebsiteImagesWithProducts,
  getWebsiteImageSpecifications,
  getWebsiteImageAsset,
  getWebsiteImageById,
  getWebsiteImageProducts,
  updateWebsiteImage,
  deleteWebsiteImage,
} = require("../controllers/websiteImage.controller");

const router = express.Router();

router.route("/").get(getWebsiteImages).post(createWebsiteImage);
router.get("/active", getActiveWebsiteImages);
router.get("/active-with-products", getActiveWebsiteImagesWithProducts);
router.get("/specifications", getWebsiteImageSpecifications);
router.get("/:id/image", getWebsiteImageAsset);
router.get("/:id/products", getWebsiteImageProducts);
router
  .route("/:id")
  .get(getWebsiteImageById)
  .put(updateWebsiteImage)
  .delete(deleteWebsiteImage);

module.exports = router;
