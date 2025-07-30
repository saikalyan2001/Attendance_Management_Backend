import express from 'express';
import { getAttendanceReports, getLeaveReports } from '../../controllers/siteincharge/reportsController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('siteincharge'));

router.get('/reports/attendance', getAttendanceReports);
router.get('/reports/leaves', getLeaveReports);

export default router;
