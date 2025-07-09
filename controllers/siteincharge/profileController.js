import User from '../../models/User.js';

export const getProfile = async (req, res) => {
  try {
    ('getProfile:', { user: req.user.email, location: req.user.locations?.[0]?._id });

    const user = await User.findById(req.user._id)
      .populate('locations', 'name')
      .lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    ('Get profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};