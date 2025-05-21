import express from 'express';
import { getAttendanceReport, getLeaveReport, getSalaryReport } from '../../controllers/admin/reportsController.js';

const router = express.Router();

router.get('/reports/attendance', getAttendanceReport);
router.get('/reports/leaves', getLeaveReport);
router.get('/reports/salary', getSalaryReport);

export default router;
