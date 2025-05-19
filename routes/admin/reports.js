import express from 'express';
import { getAttendanceReport, getLeaveReport } from '../../controllers/admin/reportsController.js';

const router = express.Router();

router.get('/reports/attendance', getAttendanceReport);
router.get('/reports/leaves', getLeaveReport);

export default router;