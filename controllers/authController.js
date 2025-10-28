import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Location from '../models/Location.js';
import dotenv from 'dotenv';

dotenv.config();

export const login = async (req, res) => {
  const { email, password, role } = req.body;
  
  try {
    const genericError = "The email or password you entered is incorrect. Please try again.";
    
    if (!['admin', 'siteincharge', 'super_admin'].includes(role)) {
      return res.status(401).json({ message: genericError });
    }

    const user = await User.findOne({ email, role }).populate('locations');
    if (!user) {
      return res.status(401).json({ message: genericError });
    }

    if (!user.password) {
      return res.status(401).json({ 
        message: "Your account setup is incomplete. Please contact your administrator.",
        code: "SETUP_INCOMPLETE"
      });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: genericError });
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
    console.error('Login error:', error);
    res.status(500).json({ message: 'Unable to process your login request. Please try again in a few minutes.' });
  }
};

export const signup = async (req, res) => {
  const { email, name, phone, role, locations, password } = req.body;
  
  try {
    if (!['admin', 'siteincharge', 'super_admin'].includes(role)) {
      return res.status(400).json({ message: 'Please select a valid role.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    if (role === 'siteincharge' && (!locations || !Array.isArray(locations) || locations.length === 0)) {
      return res.status(400).json({ message: 'Please select at least one location for Site Incharge accounts.' });
    }

    if (['admin', 'super_admin'].includes(role) && locations && locations.length > 0) {
      return res.status(400).json({ message: `Locations cannot be assigned to ${role === 'admin' ? 'Admin' : 'Super Admin'} accounts.` });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'An account with this email already exists. Please use a different email or try logging in.' });
    }

    if (role === 'siteincharge' && locations) {
      const validLocations = await Location.find({ _id: { $in: locations } });
      if (validLocations.length !== locations.length) {
        return res.status(400).json({ message: 'One or more selected locations are invalid. Please refresh and try again.' });
      }
    }

    const user = new User({
      email,
      name,
      phone,
      password,
      role,
      locations: role === 'siteincharge' ? locations : [],
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
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Unable to create account at this time. Please try again in a few minutes.' });
  }
};

export const createSuperAdmin = async (req, res) => {
  const { email, name, phone, password } = req.body;
  
  try {
    if (!email || !name || !password) {
      return res.status(400).json({ message: 'Email, name, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'An account with this email already exists.' });
    }

    const user = new User({
      email,
      name,
      phone,
      password,
      role: 'super_admin',
      locations: [],
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
    console.error('Create super admin error:', error);
    res.status(500).json({ message: 'Unable to create super admin account at this time.' });
  }
};

export const resetPassword = async (req, res) => {
  const { userId, newPassword } = req.body;
  
  try {
    if (!userId || !newPassword) {
      return res.status(400).json({ message: 'User ID and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if the requesting user has permission to reset this password
    const requestingUser = req.user;
    
    // Super admin can reset anyone's password
    // Admin can reset siteincharge passwords
    // Users can only reset their own password
    if (requestingUser.role === 'super_admin') {
      // Super admin can reset any password
    } else if (requestingUser.role === 'admin') {
      // Admin can only reset siteincharge passwords or their own
      if (user.role !== 'siteincharge' && user._id.toString() !== requestingUser.id) {
        return res.status(403).json({ message: 'You do not have permission to reset this password.' });
      }
    } else {
      // Regular users can only reset their own password
      if (user._id.toString() !== requestingUser.id) {
        return res.status(403).json({ message: 'You can only reset your own password.' });
      }
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password reset successfully!' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Unable to reset password at this time. Please try again or contact support.' });
  }
};

export const logout = async (req, res) => {
  try {
    res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error during logout.' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const locations = await Location.find().lean();
    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', error);
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
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error fetching user data.' });
  }
};
