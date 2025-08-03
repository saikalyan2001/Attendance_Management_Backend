import express from 'express';
import { getAttendanceReport, getLeaveReport, getSalaryReport } from '../../controllers/admin/reportsController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('super_admin'));

router.get('/reports/attendance', getAttendanceReport);
router.get('/reports/leaves', getLeaveReport);
router.get('/reports/salary', getSalaryReport);

export default router;