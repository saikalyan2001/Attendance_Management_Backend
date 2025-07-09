// src/backend/controllers/authController.js
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Location from '../models/Location.js';

export const login = async (req, res) => {
  const { email, password, role } = req.body;

  try {
    if (!['admin', 'siteincharge'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be admin or siteincharge.' });
    }

    const user = await User.findOne({ email, role }).populate('locations');
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or role.' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Incorrect password.' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, userName: user.name, locations: user.locations.map(loc => loc._id.toString()) },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      token,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        locations: user.locations,
      },
    });
  } catch (error) {
    ('Login error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during login.' });
  }
};

export const signup = async (req, res) => {
  const { email, password, name, phone, role, locations } = req.body;

  try {
    if (!['admin', 'siteincharge'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be admin or siteincharge.' });
    }
    if (role === 'siteincharge' && (!locations || !Array.isArray(locations) || locations.length === 0)) {
      return res.status(400).json({ message: 'At least one location is required for Site Incharge.' });
    }
    if (role === 'admin' && locations && locations.length > 0) {
      return res.status(400).json({ message: 'Admins cannot be assigned locations.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists.' });
    }

    if (role === 'siteincharge' && locations) {
      const validLocations = await Location.find({ _id: { $in: locations } });
      if (validLocations.length !== locations.length) {
        return res.status(400).json({ message: 'One or more locations are invalid.' });
      }
    }

    const user = new User({
      email,
      password,
      name,
      phone,
      role,
      locations: role === 'siteincharge' ? locations : [],
    });

    await user.save();

    const populatedUser = await User.findById(user._id).populate('locations');

    const token = jwt.sign(
      { id: user._id, role: user.role, locations: user.locations.map(id => id.toString()) },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.status(201).json({
      token,
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
    ('Signup error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during signup.' });
  }
};

export const createSiteIncharge = async (req, res) => {
  const { email, password, name, phone, locations } = req.body;

  try {
    if (!email || !password || !name || !locations || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ message: 'Email, password, name, and at least one location are required.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists.' });
    }

    const validLocations = await Location.find({ _id: { $in: locations } });
    if (validLocations.length !== locations.length) {
      return res.status(400).json({ message: 'One or more locations are invalid.' });
    }

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
    ('createSiteIncharge error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during site incharge creation.' });
  }
};

export const logout = async (req, res) => {
  try {
    res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    ('Logout error:', error);
    res.status(500).json({ message: 'Server error during logout.' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const locations = await Location.find().lean();
    res.json(locations);
  } catch (error) {
    ('Get locations error:', error);
    res.status(500).json({ message: 'Server error fetching locations.' });
  }
};

export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('locations').select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    res.json({
      _id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      locations: user.locations,
      profilePicture: user.profilePicture || null,
    });
  } catch (error) {
    ('Get me error:', error);
    res.status(500).json({ message: 'Server error fetching user data.' });
  }
};