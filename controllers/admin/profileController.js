import User from '../../models/User.js';

export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('locations', 'name');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      locations: user.locations,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { name, phone } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (name) user.name = name;
    if (phone) user.phone = phone;

    await user.save();
    const updatedUser = await User.findById(req.user._id).populate('locations', 'name');
    res.json({
      email: updatedUser.email,
      name: updatedUser.name,
      phone: updatedUser.phone,
      role: updatedUser.role,
      locations: updatedUser.locations,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update profile' });
  }
};