import jwt from 'jsonwebtoken';
import sgMail from '@sendgrid/mail';
import crypto from 'crypto';
import User from '../models/User.js';
import Location from '../models/Location.js';
import dotenv from 'dotenv';

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export const login = async (req, res) => {
  const { email, password, role } = req.body;

  try {
    if (!['admin', 'siteincharge', 'super_admin'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be admin, siteincharge, or super_admin.' });
    }

    const user = await User.findOne({ email, role }).populate('locations');
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or role.' });
    }

    if (!user.password) {
      return res.status(400).json({ message: 'Please set your password using the link sent to your email.' });
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
    console.error('Login error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during login.' });
  }
};

export const signup = async (req, res) => {
  const { email, name, phone, role, locations } = req.body;

  try {
    if (!['admin', 'siteincharge', 'super_admin'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be admin, siteincharge, or super_admin.' });
    }
    if (role === 'siteincharge' && (!locations || !Array.isArray(locations) || locations.length === 0)) {
      return res.status(400).json({ message: 'At least one location is required for Site Incharge.' });
    }
    if (['admin', 'super_admin'].includes(role) && locations && locations.length > 0) {
      return res.status(400).json({ message: `${role.charAt(0).toUpperCase() + role.slice(1)}s cannot be assigned locations.` });
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

    const resetPasswordToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const user = new User({
      email,
      name,
      phone,
      role,
      locations: role === 'siteincharge' ? locations : [],
      resetPasswordToken,
      resetPasswordExpires,
    });

    await user.save();

    const populatedUser = await User.findById(user._id).populate('locations');

    const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: 'Set Up Your Account',
      html: `
        <h1>Welcome, ${name}!</h1>
        <p>Your account has been created successfully.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Role:</strong> ${role === 'siteincharge' ? 'Site Incharge' : role.charAt(0).toUpperCase() + role.slice(1)}</p>
        <p>Please click the link below to set your password:</p>
        <a href="${loginLink}">Set Your Password</a>
        <p>This link will expire in 24 hours.</p>
        <p><strong>Important:</strong> Do not share this link with anyone.</p>
      `,
    };

    try {
      await sgMail.send(msg);
      console.log(`Password setup link sent to ${email}`);
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      // Log error but don't fail the request
    }

    res.status(201).json({
      token: null,
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
    console.error('Signup error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during signup.' });
  }
};

export const createUserBySuperAdmin = async (req, res) => {
  const { email, name, phone, role, locations } = req.body;

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

    const resetPasswordToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const user = new User({
      email,
      name,
      phone,
      role,
      locations: role === 'siteincharge' ? locations : [],
      resetPasswordToken,
      resetPasswordExpires,
    });

    await user.save();

    const populatedUser = await User.findById(user._id).populate('locations');

    const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: 'Set Up Your Account',
      html: `
        <h1>Welcome, ${name}!</h1>
        <p>Your account has been created successfully.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Role:</strong> ${role === 'siteincharge' ? 'Site Incharge' : 'Admin'}</p>
        <p>Please click the link below to set your password:</p>
        <a href="${loginLink}">Set Your Password</a>
        <p>This link will expire in 24 hours.</p>
        <p><strong>Important:</strong> Do not share this link with anyone.</p>
      `,
    };

    try {
      await sgMail.send(msg);
      console.log(`Password setup link sent to ${email}`);
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      // Log error but don't fail the request
    }

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
    console.error('createUserBySuperAdmin error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during user creation.' });
  }
};

export const createSiteIncharge = async (req, res) => {
  const { email, name, phone, locations } = req.body;

  try {
    if (!email || !name || !locations || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ message: 'Email, name, and at least one location are required.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists.' });
    }

    const validLocations = await Location.find({ _id: { $in: locations } });
    if (validLocations.length !== locations.length) {
      return res.status(400).json({ message: 'One or more locations are invalid.' });
    }

    const resetPasswordToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const user = new User({
      email,
      name,
      phone,
      role: 'siteincharge',
      locations,
      resetPasswordToken,
      resetPasswordExpires,
    });

    await user.save();

    const populatedUser = await User.findById(user._id).populate('locations');

    const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: 'Set Up Your Account',
      html: `
        <h1>Welcome, ${name}!</h1>
        <p>Your account has been created successfully.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Role:</strong> Site Incharge</p>
        <p>Please click the link below to set your password:</p>
        <a href="${loginLink}">Set Your Password</a>
        <p>This link will expire in 24 hours.</p>
        <p><strong>Important:</strong> Do not share this link with anyone.</p>
      `,
    };

    try {
      await sgMail.send(msg);
      console.log(`Password setup link sent to ${email}`);
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      // Log error but don't fail the request
    }

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
    console.error('createSiteIncharge error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during site incharge creation.' });
  }
};

export const createSuperAdmin = async (req, res) => {
  const { email, name, phone, locations } = req.body;

  try {
    if (!email || !name) {
      return res.status(400).json({ message: 'Email and name are required.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists.' });
    }

    if (locations && locations.length > 0) {
      const validLocations = await Location.find({ _id: { $in: locations } });
      if (validLocations.length !== locations.length) {
        return res.status(400).json({ message: 'One or more locations are invalid.' });
      }
    }

    const resetPasswordToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const user = new User({
      email,
      name,
      phone,
      role: 'super_admin',
      locations: locations || [],
      resetPasswordToken,
      resetPasswordExpires,
    });

    await user.save();

    const populatedUser = await User.findById(user._id).populate('locations');

    const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: 'Set Up Your Super Admin Account',
      html: `
        <h1>Welcome, ${name}!</h1>
        <p>Your super admin account has been created successfully.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Role:</strong> Super Admin</p>
        <p>Please click the link below to set your password:</p>
        <a href="${loginLink}">Set Your Password</a>
        <p>This link will expire in 24 hours.</p>
        <p><strong>Important:</strong> Do not share this link with anyone.</p>
      `,
    };

    try {
      await sgMail.send(msg);
      console.log(`Password setup link sent to ${email}`);
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      // Log error but don't fail the request
    }

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
    console.error('createSuperAdmin error:', { error: error.message, body: req.body });
    res.status(500).json({ message: 'Server error during super admin creation.' });
  }
};

export const setPassword = async (req, res) => {
  const { token, newPassword } = req.body;

  try {
    if (!token || !newPassword) {
      return res.status(400).json({ message: 'Token and new password are required.' });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password set successfully. Please log in.' });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ message: 'Server error during password setup.' });
  }
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      // Return generic message to prevent email enumeration
      return res.status(200).json({ message: 'If the email exists, a password reset link has been sent.' });
    }

    const resetPasswordToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    user.resetPasswordToken = resetPasswordToken;
    user.resetPasswordExpires = resetPasswordExpires;
    await user.save();

    const resetLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: 'Reset Your Password',
      html: `
        <h1>Hello, ${user.name}!</h1>
        <p>You requested to reset your password.</p>
        <p>Please click the link below to set a new password:</p>
        <a href="${resetLink}">Reset Password</a>
        <p>This link will expire in 24 hours.</p>
        <p>If you didn’t request this, please ignore this email.</p>
      `,
    };

    try {
      await sgMail.send(msg);
      console.log(`Password reset link sent to ${email}`);
      res.status(200).json({ message: 'If the email exists, a password reset link has been sent.' });
    } catch (emailError) {
      console.error('Error sending password reset email:', emailError);
      res.status(200).json({ message: 'If the email exists, a password reset link has been sent.' });
    }
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Server error during password reset request.' });
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