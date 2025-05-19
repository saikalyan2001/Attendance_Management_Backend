import express from 'express';
import {
  registerEmployee,
  getEmployees,
  editEmployee,
  transferEmployee,
  uploadDocument,
  deleteEmployee,
} from '../../controllers/siteincharge/employeesController.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', '..', 'Uploads');
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const employeeId = req.body.employeeId || 'unknown';
    cb(null, `${employeeId}_${timestamp}_${file.originalname}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, and PDF files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

const router = express.Router();

router.post('/employees/register', upload.array('documents'), registerEmployee);
router.get('/employees', getEmployees);
router.put('/employees/:id', editEmployee);
router.put('/employees/:id/transfer', transferEmployee);
router.post('/employees/:id/documents', upload.array('documents'), uploadDocument);
router.delete('/employees/:id', deleteEmployee);

export default router;