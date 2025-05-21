import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import mongoose from 'mongoose';
import { startOfDay, subDays } from 'date-fns';

export const getDashboardData = async (req, res) => {
  try {
    const { location } = req.query;
    if (!location || !mongoose.Types.ObjectId.isValid(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

    const today = startOfDay(new Date());
    const locationId = new mongoose.Types.ObjectId(location);

    // Total employees
    const totalEmployees = await Employee.countDocuments({ location: locationId });

    // Today's attendance
    const todayAttendance = await Attendance.aggregate([
      {
        $match: {
          location: locationId,
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
      leave: todayAttendance.find((item) => item._id === 'leave')?.count || 0,
    };

    // Recent attendance (last 5 records)
    const recentAttendance = await Attendance.find({ location: locationId })
      .populate('employee', 'name employeeId')
      .sort({ date: -1 })
      .limit(5)
      .lean();

    // Leave usage summary
    const leaveSummary = await Employee.aggregate([
      { $match: { location: locationId } },
      {
        $group: {
          _id: null,
          totalLeaves: { $sum: '$paidLeaves.used' },
          totalEmployees: { $sum: 1 },
        },
      },
      {
        $project: {
          totalLeaves: 1,
          averageLeaves: { $cond: [{ $eq: ['$totalEmployees', 0] }, 0, { $divide: ['$totalLeaves', '$totalEmployees'] }] },
          _id: 0,
        },
      },
    ]);

    // Attendance trends (last 7 days)
    const sevenDaysAgo = subDays(today, 7);
    const attendanceTrends = await Attendance.aggregate([
      {
        $match: {
          location: locationId,
          date: { $gte: sevenDaysAgo, $lte: today },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$date' },
          },
          present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          date: '$_id',
          present: 1,
          absent: 1,
          _id: 0,
        },
      },
    ]);

    res.json({
      totalEmployees,
      todayAttendance: attendanceSummary,
      recentAttendance,
      leaveSummary: leaveSummary[0] || { totalLeaves: 0, averageLeaves: 0 },
      attendanceTrends,
    });
  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).json({ message: 'Server error while fetching dashboard data' });
  }
};