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
  updateEmployeeAdvance,
  addEmployeesFromExcel,
  restoreEmployee,
} from '../../controllers/siteincharge/employeesController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
import upload from '../../utils/multer.js';

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
router.put('/employees/:id/advance', updateEmployeeAdvance);
router.post('/employees/importEmployees', upload.single('excelFile'), addEmployeesFromExcel); // Added multer middleware
router.delete('/employees/:id/delete', deleteEmployee); // Updated to use /delete
router.put('/employees/:id/restore', restoreEmployee); // Added restore route

export default router;