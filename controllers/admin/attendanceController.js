import Attendance from '../../models/Attendance.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';

export const getAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const match = {
      date: { $gte: startDate, $lte: endDate },
    };
    if (location) {
      const locationExists = await Location.findById(location);
      if (!locationExists) {
        return res.status(400).json({ message: 'Invalid location ID' });
      }
      match.location = location;
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .lean();

    if (!attendance.length) {
      return res.status(200).json([]);
    }

    res.json(attendance);
  } catch (error) {
    console.error('Get attendance error:', error.message);
    res.status(500).json({ message: 'Server error while fetching attendance' });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const { date, location, absentEmployees } = req.body;
    if (!date || !location || !Array.isArray(absentEmployees)) {
      return res.status(400).json({ message: 'Date, location, and absentEmployees (array) are required' });
    }

    const locationExists = await Location.findById(location);
    if (!locationExists) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const employees = await Employee.find({ location }).lean();
    if (!employees.length) {
      return res.status(400).json({ message: 'No employees found for this location' });
    }

    const invalidEmployees = absentEmployees.filter((id) => !employees.some((emp) => emp._id.toString() === id));
    if (invalidEmployees.length) {
      return res.status(400).json({ message: `Invalid employee IDs: ${invalidEmployees.join(', ')}` });
    }

    const attendanceRecords = employees.map((emp) => ({
      employee: emp._id,
      location,
      date: new Date(date),
      status: absentEmployees.includes(emp._id.toString()) ? 'absent' : 'present',
      markedBy: null, // Explicitly null since no auth
    }));

    await Attendance.insertMany(attendanceRecords);
    res.status(201).json({ message: 'Attendance marked successfully' });
  } catch (error) {
    console.error('Mark attendance error:', error.message);
    res.status(500).json({ message: 'Server error while marking attendance' });
  }
};

export const editAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || !['present', 'absent', 'leave'].includes(status)) {
      return res.status(400).json({ message: 'Valid status is required (present, absent, leave)' });
    }

    const attendance = await Attendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    attendance.status = status;
    attendance.editedBy = null; // Explicitly null since no auth
    await attendance.save();

    res.json({ message: 'Attendance updated successfully' });
  } catch (error) {
    console.error('Edit attendance error:', error.message);
    res.status(500).json({ message: 'Server error while editing attendance' });
  }
};

export const getAttendanceRequests = async (req, res) => {
  try {
    const requests = await AttendanceRequest.find()
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .lean();

    res.json(requests);
  } catch (error) {
    console.error('Get attendance requests error:', error.message);
    res.status(500).json({ message: 'Server error while fetching attendance requests' });
  }
};

export const handleAttendanceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Valid status is required (approved, rejected)' });
    }

    const request = await AttendanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Attendance request not found' });
    }

    request.status = status;
    request.reviewedAt = new Date();
    request.reviewedBy = null; // Explicitly null since no auth
    await request.save();

    if (status === 'approved') {
      const attendance = await Attendance.findOne({
        employee: request.employee,
        location: request.location,
        date: request.date,
      });
      if (attendance) {
        attendance.status = request.requestedStatus;
        attendance.editedBy = null; // Explicitly null
        await attendance.save();
      }
    }

    res.json({ message: `Request ${status} successfully` });
  } catch (error) {
    console.error('Handle attendance request error:', error.message);
    res.status(500).json({ message: 'Server error while handling attendance request' });
  }
};

export const requestAttendanceEdit = async (req, res) => {
  try {
    const { attendanceId, requestedStatus, reason } = req.body;
    if (!attendanceId || !requestedStatus || !reason) {
      return res.status(400).json({ message: 'Attendance ID, requested status, and reason are required' });
    }
    if (!['present', 'absent', 'leave'].includes(requestedStatus)) {
      return res.status(400).json({ message: 'Invalid requested status (present, absent, leave)' });
    }

    const attendance = await Attendance.findById(attendanceId);
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const request = new AttendanceRequest({
      employee: attendance.employee,
      location: attendance.location,
      date: attendance.date,
      requestedStatus,
      reason,
      status: 'pending',
      requestedBy: null, // Explicitly null since no auth
    });

    await request.save();
    res.status(201).json(request);
  } catch (error) {
    console.error('Request attendance edit error:', error.message);
    res.status(500).json({ message: 'Server error while requesting attendance edit' });
  }
};