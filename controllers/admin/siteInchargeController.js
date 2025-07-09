import User from '../../models/User.js';
import Location from '../../models/Location.js';

export const createSiteIncharge = async (req, res) => {
  const { email, password, name, phone, locations } = req.body;

  try {
    // Validate input
    if (!email || !password || !name || !locations || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ message: 'Email, password, name, and at least one location are required' });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Validate locations
    const validLocations = await Location.find({ _id: { $in: locations } });
    if (validLocations.length !== locations.length) {
      return res.status(400).json({ message: 'One or more locations are invalid' });
    }

    // Create siteincharge user
    const user = new User({
      email,
      password,
      name,
      phone,
      role: 'siteincharge',
      locations,
    });

    await user.save();

    const populatedUser = await User.findById(user._id).populate('locations');

    // Return user data without a token
    res.status(201).json({
      user: {
        _id: populatedUser._id,
        email: populatedUser.email,
        name: populatedUser.name,
        role: populatedUser.role,
        locations: populatedUser.locations,
        profilePicture: populatedUser.profilePicture || null,
      },
    });
  } catch (error) {
    ('Create siteincharge error:', { error, body: req.body });
    res.status(500).json({ message: 'Server error' });
  }
};