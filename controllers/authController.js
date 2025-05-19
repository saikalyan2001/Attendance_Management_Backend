import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import Location from '../models/Location.js';

export const login = async (req, res) => {
  const { email, password, location, role } = req.body;

  try {
    if (!['admin', 'siteincharge'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const user = await User.findOne({ email, role });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Optional location validation for siteincharge
    if (role === 'siteincharge' && location && user.location?.toString() !== location) {
      return res.status(400).json({ message: 'Invalid location for Site Incharge' });
    }

    if (role === 'admin' && location) {
      return res.status(400).json({ message: 'Location is not required for Admin' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, location: user.location || null },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        location: user.location || null,
      },
    });
  } catch (error) {
    console.error('Login error:', { error, body: req.body });
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const locations = await Location.find();
    console.log('Fetched locations:', locations);
    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};