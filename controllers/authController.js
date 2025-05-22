import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import Location from '../models/Location.js';

export const login = async (req, res) => {
  const { email, password, role } = req.body;

  try {
    if (!['admin', 'siteincharge'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const user = await User.findOne({ email, role }).populate('locations');
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, locations: user.locations.map(loc => loc._id) },
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
    console.error('Login error:', { error, body: req.body });
    res.status(500).json({ message: 'Server error' });
  }
};

export const signup = async (req, res) => {
  const { email, password, name, phone, role, locations } = req.body;

  try {
    if (!['admin', 'siteincharge'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    if (role === 'siteincharge' && (!locations || !Array.isArray(locations) || locations.length === 0)) {
      return res.status(400).json({ message: 'At least one location is required for Site Incharge' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    if (locations && locations.length > 0) {
      const validLocations = await Location.find({ _id: { $in: locations } });
      if (validLocations.length !== locations.length) {
        return res.status(400).json({ message: 'One or more locations are invalid' });
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
      { id: user._id, role: user.role, locations: user.locations },
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
      },
    });
  } catch (error) {
    console.error('Signup error:', { error, body: req.body });
    res.status(500).json({ message: 'Server error' });
  }
};

export const logout = async (req, res) => {
  try {
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const locations = await Location.find();
    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('locations').select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({
      _id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      locations: user.locations,
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
