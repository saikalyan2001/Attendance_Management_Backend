// src/features/admin/routes/router.js
import express from 'express';
import {
  getAttendance,
  markAttendance,
  bulkMarkAttendance,
  editAttendance,
  getAttendanceRequests,
  handleAttendanceRequest,
  requestAttendanceEdit,
  exportAttendance,
  undoMarkAttendance,
} from '../../controllers/admin/attendanceController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
("route");
const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

router.get('/attendance', getAttendance);
router.post('/attendance', markAttendance);
router.post('/attendance/bulk', bulkMarkAttendance);
router.put('/attendance/:id', editAttendance);
router.get('/attendance/requests', getAttendanceRequests);
router.post('/attendance/requests', requestAttendanceEdit);
router.put('/attendance/requests/:id', handleAttendanceRequest);
router.get('/attendance/export', exportAttendance);
router.post('/attendance/undo', undoMarkAttendance); 

export default router;