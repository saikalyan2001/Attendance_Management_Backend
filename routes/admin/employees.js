import express from 'express';
import { getEmployees, getEmployeeById, addEmployee, editEmployee, updateEmployeeAdvance, deactivateEmployee, transferEmployee, rejoinEmployee, getEmployeeHistory, addEmployeeDocuments, getSettings, checkEmployeeExists } from '../../controllers/admin/employeesController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
import upload from '../../utils/multer.js';
import { getAttendance } from '../../controllers/admin/attendanceController.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ message: err.message });
  if (err) return res.status(400).json({ message: err.message });
  next();
};

router.get('/settings', getSettings);
router.get('/employees', getEmployees);
router.get('/employees/check', checkEmployeeExists);
router.get('/employees/:id', getEmployeeById);
router.post('/employees', upload.array('documents'), multerErrorHandler, addEmployee);
router.put('/employees/:id', editEmployee);
router.put('/employees/:id/advance', updateEmployeeAdvance);
router.put('/employees/:id/deactivate', deactivateEmployee);
router.get('/employees/:id/attendance', getAttendance);
router.put('/employees/:id/transfer', transferEmployee);
router.put('/employees/:id/rejoin', rejoinEmployee);
router.get('/employees/:id/history', getEmployeeHistory);
router.post('/employees/:id/documents', upload.array('documents'), multerErrorHandler, addEmployeeDocuments);

export default router;