import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import mongoose from 'mongoose';

export const getDashboardData = async (req, res) => {
  try {
    let { location, date } = req.query;
    const user = req.user;

    // Debugging logs
    ('req.user:', JSON.stringify(req.user, null, 2));
    ('req.query.location:', location, 'req.query.date:', date);

    // Handle location as object
    if (typeof location === 'object' && location?._id) {
      location = location._id;
    }

    if (!user || !user.locations || !user.locations.some(loc => loc._id.toString() === location)) {
      return res.status(403).json({ 
        message: `Unauthorized: Location ${location} not assigned to user ${user.email}`,
        userLocations: user.locations?.map(loc => loc._id.toString()) || [],
        requestedLocation: location
      });
    }

    if (!location || !mongoose.Types.ObjectId.isValid(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

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

    const locationId = new mongoose.Types.ObjectId(location);

    // Total employees
    const totalEmployees = await Employee.countDocuments({ location: locationId, isDeleted: false });
    ('getDashboard: Total employees:', totalEmployees); // Debug

    // Today's attendance
    const todayAttendance = await Attendance.aggregate([
      {
        $match: {
          location: locationId,
          isDeleted: false,
          date: { $regex: `^${dateString}`, $options: 'i' }, // Match YYYY-MM-DD part
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
      location: locationId,
      isDeleted: false,
      date: { $regex: `^${dateString}`, $options: 'i' }, // Match YYYY-MM-DD part
    })
      .populate('employee', 'name employeeId')
      .sort({ date: -1 })
      .limit(10)
      .lean();

    ('getDashboard: recentAttendance for', dateString, ':', recentAttendance); // Debug

    // Prepare response
    const response = {
      totalEmployees,
      todayAttendance: attendanceSummary,
      recentAttendance,
    };

    ('getDashboard: Sending response:', response); // Debug
    res.json(response);
  } catch (error) {
    ('Dashboard error:', error.message);
    res.status(500).json({ message: 'Server error while fetching dashboard data' });
  }
};