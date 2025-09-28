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
  getLocationWorkingDayPolicy, // ✅ ADD
  validateAttendanceDateEndpoint,
  processCarryForwardUpdates, // ✅ ADD
} from '../../controllers/admin/attendanceController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

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
router.get('/attendance/working-day-policy', getLocationWorkingDayPolicy);
router.get('/attendance/validate-date', validateAttendanceDateEndpoint);
router.post('/attendance/carry-forward-update', async (req, res) => {
  try {
    await processCarryForwardUpdates();
    res.status(200).json({ success: true, message: 'Carry forward update completed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to update carry forwards' });
  }
});


export default router;
