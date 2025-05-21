import express from 'express';
import {
  getAttendance,
  markAttendance,
  markBulkAttendance,
  getMonthlyAttendance,
  getEmployeeAttendance,
} from '../../controllers/siteincharge/attendanceController.js';

const router = express.Router();

router.get('/attendance', getAttendance);
router.post('/attendance', markAttendance);
router.post('/attendance/bulk', markBulkAttendance);
router.get('/attendance/monthly', getMonthlyAttendance);
router.get('/attendance/employee/:id', getEmployeeAttendance);

export default router;