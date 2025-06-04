import express from 'express';
import {
  getSettings,
  registerEmployee,
  getEmployees,
  getEmployee,
  editEmployee,
  transferEmployee,
  uploadDocument,
  deleteEmployee,
  getLocations,
  getEmployeeAttendance,
  deactivateEmployee,
  rejoinEmployee,
  getEmployeeHistory,
} from '../../controllers/siteincharge/employeesController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
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
    const employeeId = req.params.id || 'unknown'; // Use req.params.id instead of req.body.employeeId
    cb(null, `${employeeId}_${timestamp}_${file.originalname}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, PDF, DOC, and DOCX files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

const router = express.Router();

router.use(protect);
router.use(restrictTo('siteincharge'));

router.get('/settings', getSettings);
router.get('/locations', getLocations);
router.post('/employees/register', upload.array('documents'), registerEmployee);
router.get('/employees', getEmployees);
router.get('/employees/:id', getEmployee);
router.get('/employees/:id/history', getEmployeeHistory);
router.get('/employees/:id/attendance', getEmployeeAttendance);
router.put('/employees/:id', editEmployee);
router.put('/employees/:id/transfer', transferEmployee);
router.post('/employees/:id/documents', upload.array('documents'), uploadDocument);
router.delete('/employees/:id', deleteEmployee);
router.put('/employees/:id/deactivate', deactivateEmployee);
router.put('/employees/:id/rejoin', rejoinEmployee);

export default router;