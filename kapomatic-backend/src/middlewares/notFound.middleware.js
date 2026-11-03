const notFound = (req, res) => {
  res.status(404).json({ message: `المسار غير موجود: ${req.originalUrl}` });
};

module.exports = notFound;
