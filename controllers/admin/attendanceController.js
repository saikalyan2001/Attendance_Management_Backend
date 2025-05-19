import Attendance from '../../models/Attendance.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';

export const getAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const match = {
      date: { $gte: startDate, $lte: endDate },
    };
    if (location) {
      match.location = location;
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .populate('markedBy', 'email')
      .populate('editedBy', 'email')
      .lean();

    res.json(attendance);
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const { date, location, absentEmployees } = req.body;
    const userId = req.user._id; // From auth middleware

    const employees = await Employee.find({ location }).lean();
    const attendanceRecords = employees.map((emp) => ({
      employee: emp._id,
      location,
      date: new Date(date),
      status: absentEmployees.includes(emp._id.toString()) ? 'absent' : 'present',
      markedBy: userId,
    }));

    await Attendance.insertMany(attendanceRecords);
    res.json({ message: 'Attendance marked successfully' });
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const editAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user._id;

    const attendance = await Attendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance not found' });
    }

    attendance.status = status;
    attendance.editedBy = userId;
    await attendance.save();

    res.json({ message: 'Attendance updated successfully' });
  } catch (error) {
    console.error('Edit attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getAttendanceRequests = async (req, res) => {
  try {
    const requests = await AttendanceRequest.find()
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .populate('requestedBy', 'email')
      .populate('reviewedBy', 'email')
      .lean();

    res.json(requests);
  } catch (error) {
    console.error('Get attendance requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const handleAttendanceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'approved' or 'rejected'
    const userId = req.user._id;

    const request = await AttendanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    request.status = status;
    request.reviewedBy = userId;
    request.reviewedAt = new Date();
    await request.save();

    if (status === 'approved') {
      const attendance = await Attendance.findOne({
        employee: request.employee,
        location: request.location,
        date: request.date,
      });
      if (attendance) {
        attendance.status = request.requestedStatus;
        attendance.editedBy = userId;
        await attendance.save();
      }
    }

    res.json({ message: `Request ${status} successfully` });
  } catch (error) {
    console.error('Handle attendance request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};