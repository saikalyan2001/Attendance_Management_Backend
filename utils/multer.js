import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, '../Uploads');

const ensureUploadsDir = async () => {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    ('Uploads directory created/verified:', uploadsDir);
  } catch (error) {
    ('Error creating uploads directory:', error.message);
    throw new Error('Failed to create uploads directory');
  }
};

// Sanitize filename to remove special characters
const sanitizeFilename = (filename) => {
  const ext = path.extname(filename);
  const name = path.basename(filename, ext).replace(/[^a-zA-Z0-9-_]/g, '-');
  return `${name}${ext}`;
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await ensureUploadsDir();
      cb(null, uploadsDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitizedName = sanitizeFilename(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(sanitizedName)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /pdf|doc|docx|jpg|jpeg|png/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype.split('/')[1].toLowerCase());

  if (extname && mimetype) {
    return cb(null, true);
  }
  cb(new Error('Only PDF, DOC, DOCX, JPG, JPEG, PNG files are allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

export default upload;