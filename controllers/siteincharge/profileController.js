import User from '../../models/User.js';
import Attendance from '../../models/Attendance.js';

export const getProfile = async (req, res) => {
  try {
    console.log('getProfile:', { user: req.user.email, location: req.user.locations?.[0]?._id });

    const user = await User.findById(req.user._id)
      .populate('locations', 'name')
      .lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const locationId = req.user.locations?.[0]?._id;
    if (!locationId) {
      return res.status(400).json({ message: 'No location assigned to user' });
    }

    const recentAttendance = await Attendance.find({
      location: locationId,
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
