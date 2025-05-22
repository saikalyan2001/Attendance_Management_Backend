import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Attendance from '../../models/Attendance.js';

export const getDashboard = async (req, res) => {
  try {
    // Get counts
    const totalLocations = await Location.countDocuments();
    const totalEmployees = await Employee.countDocuments();

    // Get today's attendance summary
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const attendanceSummary = await Attendance.aggregate([
      { $match: { date: { $gte: today } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const present = attendanceSummary.find((s) => s._id === 'present')?.count || 0;
    const absent = attendanceSummary.find((s) => s._id === 'absent')?.count || 0;
    const leave = attendanceSummary.find((s) => s._id === 'leave')?.count || 0;
    const halfDay = attendanceSummary.find((s) => s._id === 'half-day')?.count || 0;

    // Get recent attendance (last 5 records)
    const recentAttendance = await Attendance.find()
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .sort({ date: -1 })
      .limit(5)
      .lean();

    res.json({
      totalLocations,
      totalEmployees,
      present,
      absent,
      leave,
      halfDay,
      recentAttendance,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
