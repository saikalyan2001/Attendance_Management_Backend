import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';

export const getAttendanceReport = async (req, res) => {
  try {
    const { startDate, endDate, location } = req.query;
    const match = {};

    if (startDate && endDate) {
      match.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }
    if (location) {
      match.location = location;
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .sort({ date: -1 })
      .lean();

    const summary = await Attendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const totalPresent = summary.find((s) => s._id === 'present')?.count || 0;
    const totalAbsent = summary.find((s) => s._id === 'absent')?.count || 0;
    const totalLeave = summary.find((s) => s._id === 'leave')?.count || 0;

    res.json({
      attendance,
      summary: { totalPresent, totalAbsent, totalLeave },
    });
  } catch (error) {
    console.error('Attendance report error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLeaveReport = async (req, res) => {
  try {
    const { location } = req.query;
    const match = {};

    if (location) {
      match.location = location;
    }

    const employees = await Employee.find(match)
      .select('name employeeId paidLeaves location')
      .populate('location', 'name')
      .lean();

    const summary = await Employee.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalAvailable: { $sum: '$paidLeaves.available' },
          totalUsed: { $sum: '$paidLeaves.used' },
          totalCarriedForward: { $sum: '$paidLeaves.carriedForward' },
        },
      },
    ]);

    res.json({
      employees,
      summary: summary[0] || { totalAvailable: 0, totalUsed: 0, totalCarriedForward: 0 },
    });
  } catch (error) {
    console.error('Leave report error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};