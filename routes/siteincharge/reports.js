import express from 'express';
import { getAttendanceReports, getLeaveReports } from '../../controllers/siteincharge/reportsController.js';

const router = express.Router();

router.get('/reports/attendance', getAttendanceReports);
router.get('/reports/leaves', getLeaveReports);

export default router;