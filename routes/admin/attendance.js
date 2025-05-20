import express from 'express';
import { getAttendance, markAttendance, editAttendance, getAttendanceRequests, handleAttendanceRequest, requestAttendanceEdit } from '../../controllers/admin/attendanceController.js';

const router = express.Router();

router.get('/attendance', getAttendance);
router.post('/attendance', markAttendance);
router.put('/attendance/:id', editAttendance);
router.get('/attendance/requests', getAttendanceRequests);
router.post('/attendance/requests', requestAttendanceEdit);
router.put('/attendance/requests/:id', handleAttendanceRequest);

export default router;