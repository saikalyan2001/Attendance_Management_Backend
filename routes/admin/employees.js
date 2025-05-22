import express from 'express';
import {
  getEmployees,
  addEmployee,
  editEmployee,
  deleteEmployee,
  uploadDocument,
  deleteDocument,
} from '../../controllers/admin/employeesController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
import upload from '../../utils/multer.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

router.get('/employees', getEmployees);
router.post('/employees', upload.array('documents'), addEmployee);
router.put('/employees/:id', editEmployee);
router.delete('/employees/:id', deleteEmployee);
router.post('/employees/:id/documents', upload.single('document'), uploadDocument);
router.delete('/employees/:id/documents/:documentId', deleteDocument);

export default router;
