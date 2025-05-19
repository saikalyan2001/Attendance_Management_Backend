import express from 'express';
import { markAttendance, getMonthlyAttendance } from '../../controllers/siteincharge/attendanceController.js';

const router = express.Router();

router.post('/attendance', markAttendance);
router.get('/attendance/monthly', getMonthlyAttendance);

export default router;