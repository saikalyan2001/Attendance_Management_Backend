import express from 'express';
import { getEmployees, createEmployee, updateEmployee, uploadDocument, deleteDocument, deleteEmployee } from '../../controllers/admin/employeesController.js';
import multer from 'multer';
import path from 'path';

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /pdf|doc|docx|jpg|jpeg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only PDF, DOC, DOCX, JPG, JPEG, PNG files are allowed'));
  },
});

router.get('/employees', getEmployees);
router.post('/employees', createEmployee);
router.put('/employees/:id', updateEmployee);
router.post('/employees/:id/documents', upload.single('document'), uploadDocument);
router.delete('/employees/:id/documents/:documentId', deleteDocument);
router.delete('/employees/:id', deleteEmployee);

export default router;
