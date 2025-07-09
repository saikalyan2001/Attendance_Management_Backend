import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import Location from '../../models/Location.js';

export const getDashboard = async (req, res) => {
  try {
    const { date } = req.query;
    ('getDashboard: Requested date:', date); // Debug

    // Parse the date, default to today
    let targetDate = new Date();
    if (date) {
      targetDate = new Date(date);
      if (isNaN(targetDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
    }
    // Format date as YYYY-MM-DD for string comparison
    const dateString = targetDate.toISOString().split('T')[0];
    ('getDashboard: Querying attendance for date string:', dateString); // Debug

    // Total locations
    const totalLocations = await Location.countDocuments({ isDeleted: false });
    ('getDashboard: Total locations:', totalLocations); // Debug

    // Total employees
    const totalEmployees = await Employee.countDocuments({ isDeleted: false });

    // Today's attendance
    const todayAttendance = await Attendance.aggregate([
      {
        $match: {
          isDeleted: false,
          date: { $regex: `^${dateString}`, $options: 'i' }, // Match YYYY-MM-DD part of ISO string
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    ('getDashboard: Attendance summary:', todayAttendance); // Debug

    const attendanceSummary = {
      present: todayAttendance.find((item) => item._id === 'present')?.count || 0,
      absent: todayAttendance.find((item) => item._id === 'absent')?.count || 0,
      leave: todayAttendance.find((item) => item._id === 'leave')?.count || 0,
      halfDay: todayAttendance.find((item) => item._id === 'half-day')?.count || 0,
    };

    // Recent attendance (last 10 records)
    const recentAttendance = await Attendance.find({
      isDeleted: false,
      date: { $regex: `^${dateString}`, $options: 'i' }, // Match YYYY-MM-DD part
    })
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .sort({ date: -1 })
      .limit(10)
      .lean();

    ('getDashboard: recentAttendance for', dateString, ':', recentAttendance); // Debug

    res.json({
      totalLocations,
      totalEmployees,
      present: attendanceSummary.present,
      absent: attendanceSummary.absent,
      leave: attendanceSummary.leave,
      halfDay: attendanceSummary.halfDay,
      recentAttendance,
    });
  } catch (error) {
    ('getDashboard: Error:', error.message);
    res.status(500).json({ message: 'Server error while fetching dashboard data' });
  }
};
