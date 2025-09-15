import User from '../../models/User.js';
import Location from '../../models/Location.js';

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

export const fetchSuperAdminDashboard = async (req, res) => {
  try {
    const { date } = req.query;


    let targetDate = new Date();
    if (date) {
      targetDate = new Date(date);
      if (isNaN(targetDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
    }
    const dateString = targetDate.toISOString().split('T')[0];


    const totalUsers = await User.countDocuments({ role: { $in: ['admin', 'siteincharge'] } });
    const totalLocations = await Location.countDocuments({ isDeleted: false });
    const totalAdmins = await User.countDocuments({ role: 'admin' });
    const totalSiteIncharges = await User.countDocuments({ role: 'siteincharge' });
    const activeUsers = await User.countDocuments({
      role: { $in: ['admin', 'siteincharge'] },
      lastLogin: { $gte: new Date(`${dateString}T00:00:00Z`), $lte: new Date(`${dateString}T23:59:59Z`) },
    });
    const inactiveUsers = totalUsers - activeUsers;

    const recentActivity = await User.aggregate([
      {
        $match: {
          role: { $in: ['admin', 'siteincharge'] },
          lastLogin: { $exists: true, $gte: new Date(`${dateString}T00:00:00Z`), $lte: new Date(`${dateString}T23:59:59Z`) },
        },
      },
      {
        $project: {
          user: {
            name: '$name',
            email: '$email',
            role: '$role',
          },
          action: 'login',
          timestamp: '$lastLogin',
        },
      },
      { $sort: { timestamp: -1 } },
      { $limit: 10 },
    ]);



    res.json({
      totalUsers,
      totalLocations,
      totalAdmins,
      totalSiteIncharges,
      activeUsers,
      inactiveUsers,
      recentActivity,
    });
  } catch (error) {

    res.status(500).json({ message: 'Server error fetching dashboard data.' });
  }
};
