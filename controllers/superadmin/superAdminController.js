import User from '../../models/User.js';
import Location from '../../models/Location.js';
import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import mongoose from 'mongoose';

export const fetchSuperAdminDashboard = async (req, res) => {
  try {
    const { date, range = 'month', locationId } = req.query;
    const user = req.user; // Assigned by protect middleware

    let targetDate = new Date();
    if (date) {
      targetDate = new Date(date);
      if (isNaN(targetDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
    }

    // Determine if this is a monthly aggregation (if date is end of month)
    const day = targetDate.getDate();
    const lastDayOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
    const isMonthly = day === lastDayOfMonth;

    let dateString = targetDate.toISOString().split('T')[0];

    // Determine location filter based on user role
    let locationFilter = {};
    if (user.role === 'siteincharge' && Array.isArray(user.locations) && user.locations.length > 0) {
      // FIX: Extract ObjectId whether locations is populated or not
      const locationObjectId = user.locations[0]._id || user.locations[0];
      locationFilter = { location: new mongoose.Types.ObjectId(locationObjectId) };
    } else if (locationId && locationId !== 'all') {
      locationFilter = { location: new mongoose.Types.ObjectId(locationId) };
    }

    // Calculate date range for trends and location chart
    const rangeDays = range === 'week' ? 7 : 30;
    const trendStartDate = new Date(targetDate);
    trendStartDate.setDate(targetDate.getDate() - rangeDays + 1);
    const trendStartDateString = trendStartDate.toISOString().split('T')[0];

    // User and location stats (not filtered by location)
    const totalUsers = await User.countDocuments({ role: { $in: ['admin', 'siteincharge'] } });
    const totalLocations = await Location.countDocuments({ isDeleted: false });
    const totalAdmins = await User.countDocuments({ role: 'admin' });
    const totalSiteIncharges = await User.countDocuments({ role: 'siteincharge' });

    const activeUsers = await User.countDocuments({
      role: { $in: ['admin', 'siteincharge'] },
      lastLogin: { $gte: new Date(`${dateString}T00:00:00Z`), $lte: new Date(`${dateString}T23:59:59Z`) },
    });
    const inactiveUsers = totalUsers - activeUsers;

    // Total employees - filter by location if applicable
    const totalEmployees = await Employee.countDocuments({
      isDeleted: false,
      status: 'active',
      ...locationFilter,
    });

    // Attendance summary: single day or entire month based on isMonthly
    let attendanceMatchFilter;
    if (isMonthly) {
      const startOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
      const endOfMonth = targetDate;
      const startDateString = startOfMonth.toISOString().split('T')[0];
      const endDateString = endOfMonth.toISOString().split('T')[0];
      attendanceMatchFilter = {
        date: { $gte: startDateString, $lte: endDateString },
        isDeleted: false,
        ...locationFilter,
      };
    } else {
      attendanceMatchFilter = {
        date: { $regex: `^${dateString}`, $options: 'i' },
        isDeleted: false,
        ...locationFilter,
      };
    }

    const attendanceAgg = await Attendance.aggregate([
      { $match: attendanceMatchFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const attendanceSummary = attendanceAgg.reduce((acc, obj) => {
      acc[obj._id] = obj.count;
      return acc;
    }, { present: 0, absent: 0, leave: 0, 'half-day': 0 });

    const totalMarked = Object.values(attendanceSummary).reduce((a, b) => a + b, 0);
    const attendancePercent = totalMarked > 0
      ? ((attendanceSummary.present + attendanceSummary.leave + attendanceSummary['half-day'] * 0.5) / totalMarked) * 100
      : 0;

    // Exception count: use same filter as attendance summary
    const exceptionCount = await Attendance.countDocuments({
      ...attendanceMatchFilter,
      isException: true,
    });

    // Attendance trends over the range (unchanged: always based on rangeDays)
    const trendMatchFilter = {
      date: { $gte: trendStartDateString, $lte: dateString },
      isDeleted: false,
      ...locationFilter,
    };

    const dailyTrend = await Attendance.aggregate([
      { $match: trendMatchFilter },
      {
        $group: {
          _id: { $substr: ['$date', 0, 10] },
          presentCount: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
          leaveCount: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
          halfDayCount: { $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] } },
          totalCount: { $sum: 1 },
        },
      },
      { $sort: { '_id': 1 } },
    ]);

    const trendData = dailyTrend.map(d => ({
      date: d._id,
      attendancePercent: d.totalCount > 0
        ? Number(((d.presentCount + d.leaveCount + d.halfDayCount * 0.5) / d.totalCount * 100).toFixed(2))
        : 0,
    }));

    // Location-wise attendance (unchanged: based on range)
    let locationAttendance = [];
    if (user.role === 'siteincharge') {
      // FIX: Extract ObjectId for siteincharge
      const locationObjectId = user.locations[0]._id || user.locations[0];
      
      locationAttendance = await Attendance.aggregate([
        {
          $match: {
            date: { $gte: trendStartDateString, $lte: dateString },
            location: new mongoose.Types.ObjectId(locationObjectId),
            isDeleted: false,
          },
        },
        {
          $lookup: {
            from: 'locations',
            localField: 'location',
            foreignField: '_id',
            as: 'locationDetails',
          },
        },
        { $unwind: '$locationDetails' },
        {
          $group: {
            _id: '$locationDetails.name',
            locationId: { $first: '$locationDetails._id' },
            present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            leave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
            halfDay: { $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);
    } else {
      // For super admin/admin, aggregate per selected filter or all
      locationAttendance = await Attendance.aggregate([
        {
          $match: {
            date: { $gte: trendStartDateString, $lte: dateString },
            isDeleted: false,
            ...((locationId && locationId !== 'all') ? { location: new mongoose.Types.ObjectId(locationId) } : {}),
          },
        },
        {
          $lookup: {
            from: 'locations',
            localField: 'location',
            foreignField: '_id',
            as: 'locationDetails',
          },
        },
        { $unwind: '$locationDetails' },
        {
          $group: {
            _id: '$locationDetails.name',
            locationId: { $first: '$locationDetails._id' },
            present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            leave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
            halfDay: { $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);
    }

    // Get all locations for filter dropdown; for siteincharge only their location(s)
    const allLocations = user.role === 'siteincharge'
      ? await Location.find({ _id: { $in: user.locations.map(loc => loc._id || loc) } }).select('_id name').lean()
      : await Location.find({ isDeleted: false }).select('_id name').sort('name').lean();

    res.json({
      totalUsers,
      totalLocations,
      totalAdmins,
      totalSiteIncharges,
      activeUsers,
      inactiveUsers,
      totalEmployees,
      attendanceSummary,
      attendancePercent: Number(attendancePercent.toFixed(2)),
      exceptionCount,
      attendanceTrend: trendData,
      locationAttendance,
      locations: allLocations,
      appliedLocationFilter: locationId || 'all',
      appliedRange: range,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching dashboard data.' });
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({ role: { $in: ['admin', 'siteincharge'] } })
      .select('-password')
      .populate('locations');
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching users.' });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { email, name, phone, role, locations } = req.body;

  try {
    if (role && !['admin', 'siteincharge'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be admin or siteincharge.' });
    }
    if (role === 'siteincharge' && (!locations || !Array.isArray(locations) || locations.length === 0)) {
      return res.status(400).json({ message: 'At least one location is required for Site Incharge.' });
    }
    if (role === 'admin' && locations && locations.length > 0) {
      return res.status(400).json({ message: 'Admins cannot be assigned locations.' });
    }

    const validLocations = locations ? await Location.find({ _id: { $in: locations } }) : [];
    if (locations && validLocations.length !== locations.length) {
      return res.status(400).json({ message: 'One or more locations are invalid.' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.email = email || user.email;
    user.name = name || user.name;
    user.phone = phone || user.phone;
    user.role = role || user.role;
    user.locations = role === 'siteincharge' ? locations || user.locations : [];

    await user.save();

    const populatedUser = await User.findById(id).populate('locations').select('-password');
    res.json(populatedUser);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating user.' });
  }
};

export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (user.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot delete Super Admin.' });
    }

    await user.deleteOne();
    res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting user.' });
  }
};
