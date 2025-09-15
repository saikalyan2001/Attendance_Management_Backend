import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define upload directories
const documentUploadDir = path.join(__dirname, "../Uploads/documents");
const excelUploadDir = path.join(__dirname, "../Uploads/excel");

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Determine directory based on fieldname
      const uploadDir =
        file.fieldname === "excelFile" ? excelUploadDir : documentUploadDir;
      await fs.mkdir(uploadDir, { recursive: true });
      
      cb(null, uploadDir);
    } catch (err) {
      
      cb(new Error(`Failed to create upload directory: ${err.message}`));
    }
  },
  filename: (req, file, cb) => {
    if (!file || !file.originalname) {
      
      return cb(new Error("Invalid file object: missing originalname"));
    }
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const prefix = file.fieldname === "excelFile" ? "excel" : "documents";
    const filename = `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`;
    
    cb(null, filename);
  },
});

const fileFilter = (req, file, cb) => {
  // Define allowed MIME types and extensions
  const documentMimeTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ];
  const excelMimeTypes = [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ];
  const documentExtensions = /\.(pdf|doc|docx|jpg|jpeg|png|xlsx|xls|csv)$/i;
  const excelExtensions = /\.(xlsx|xls|csv)$/i;

  const allowedMimeTypes = file.fieldname === "excelFile" ? excelMimeTypes : documentMimeTypes;
  const allowedExtensions = file.fieldname === "excelFile" ? excelExtensions : documentExtensions;

  const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedMimeTypes.includes(file.mimetype.toLowerCase());

  if (extname && mimetype) {
    
    return cb(null, true);
  }

  
  cb(
    new Error(
      `File type not supported. Allowed types: ${
        file.fieldname === "excelFile" ? "XLSX, XLS, CSV" : "PDF, DOC, DOCX, JPG, JPEG, PNG, XLSX, XLS, CSV"
      }`
    )
  );
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter,
});

export default upload;