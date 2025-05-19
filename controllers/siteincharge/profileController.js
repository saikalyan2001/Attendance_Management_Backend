import User from '../../models/User.js';
import Attendance from '../../models/Attendance.js';

export const getProfile = async (req, res) => {
  try {
    // Assuming user ID is stored in req.user from authMiddleware
    // For unprotected routes, use a query param or session; here we simulate with email
    const user = await User.findOne({ email: req.query.email }).populate('location', 'name').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const recentAttendance = await Attendance.find({
      date: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
    })
      .sort({ date: -1 })
      .limit(5)
      .populate('employee', 'name')
      .lean();

    res.json({ user, recentAttendance });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};