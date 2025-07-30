import express from 'express';
import {
  getAttendance,
  markAttendance,
  markBulkAttendance,
  getMonthlyAttendance,
  getEmployeeAttendance,
  requestAttendanceEdit,
  getAttendanceEditRequests,
  undoAttendance,
  calculateSalaryImpact, // Add the import for the new controller
} from '../../controllers/siteincharge/attendanceController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('siteincharge'));

router.get('/attendance', getAttendance);
router.post('/attendance', markAttendance);
router.post('/attendance/bulk', markBulkAttendance);
router.get('/attendance/monthly', getMonthlyAttendance);
router.get('/attendance/employee/:id', getEmployeeAttendance);
router.post('/attendance/request-edit', requestAttendanceEdit);
router.get('/attendance/requests', getAttendanceEditRequests); 
router.delete('/attendance', undoAttendance);
router.get('/attendance/salary-calculation', calculateSalaryImpact);

export default router;
