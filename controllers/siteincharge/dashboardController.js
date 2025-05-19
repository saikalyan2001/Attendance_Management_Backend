import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Attendance from '../../models/Attendance.js';

export const getDashboardData = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Mock location for testing without auth
    const mockLocation = req.user?.location || null;

    const totalEmployees = await Employee.countDocuments(mockLocation ? { location: mockLocation } : {});
    const totalLocations = await Location.countDocuments();
    const todayAttendance = await Attendance.aggregate([
      {
        $match: {
          ...(mockLocation && { location: mockLocation }),
          date: { $gte: today, $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const attendanceSummary = {
      present: todayAttendance.find((item) => item._id === 'present')?.count || 0,
      absent: todayAttendance.find((item) => item._id === 'absent')?.count || 0,
    };

    res.json({
      totalEmployees,
      totalLocations,
      todayAttendance: attendanceSummary,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};