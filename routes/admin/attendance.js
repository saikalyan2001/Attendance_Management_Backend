import express from 'express';
import {
  getAttendance,
  markAttendance,
  editAttendance,
  getAttendanceRequests,
  handleAttendanceRequest,
  requestAttendanceEdit,
  exportAttendance,
} from '../../controllers/admin/attendanceController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

router.get('/attendance', getAttendance);
router.post('/attendance', markAttendance);
router.put('/attendance/:id', editAttendance);
router.get('/attendance/requests', getAttendanceRequests);
router.post('/attendance/requests', requestAttendanceEdit);
router.put('/attendance/requests/:id', handleAttendanceRequest);
router.get('/attendance/export', exportAttendance);

export default router;