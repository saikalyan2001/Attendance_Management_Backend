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
    // Generic error message for security (prevents email enumeration)
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
        message: "Your account setup is incomplete. Please check your email for setup instructions.",
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

    res.status(500).json({ message: 'Unable to process your login request. Please try again in a few minutes.' });
  }
};

export const signup = async (req, res) => {
  const { email, name, phone, role, locations } = req.body;
  try {
    if (!['admin', 'siteincharge', 'super_admin'].includes(role)) {
      return res.status(400).json({ message: 'Please select a valid role.' });
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
      subject: 'Set Up Your Account - Welcome!',
      html: `
        <h1>Welcome to our platform, ${name}!</h1>
        <p>Your account has been created successfully.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Role:</strong> ${role === 'siteincharge' ? 'Site Incharge' : role.charAt(0).toUpperCase() + role.slice(1)}</p>
        <p>To get started, please click the link below to set your password:</p>
        <a href="${loginLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Set Your Password</a>
        <p>This link will expire in 24 hours for security reasons.</p>
        <p><strong>Important:</strong> Please do not share this link with anyone.</p>
        <p>If you have any questions, please contact your administrator.</p>
      `,
    };

    try {
      await sgMail.send(msg);

    } catch (emailError) {

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

    res.status(500).json({ message: 'Unable to create account at this time. Please try again in a few minutes.' });
  }
};

export const setPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    if (!token || !newPassword) {
      return res.status(400).json({ message: 'Security token and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    // Debug logging


);

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ 
        message: 'The password setup link has expired or is invalid. Please request a new setup link.' 
      });
    }



    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();



    res.json({ message: 'Password set successfully! You can now log in with your credentials.' });
  } catch (error) {

    res.status(500).json({ message: 'Unable to set password at this time. Please try again or contact support.' });
  }
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      // Return generic message to prevent email enumeration
      return res.status(200).json({ 
        message: 'If an account with this email exists, a password reset link has been sent.' 
      });
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
        <h1>Password Reset Request</h1>
        <p>Hello ${user.name},</p>
        <p>We received a request to reset your password.</p>
        <p>Click the link below to set a new password:</p>
        <a href="${resetLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a>
        <p>This link will expire in 24 hours for security reasons.</p>
        <p>If you didn't request this password reset, please ignore this email and your password will remain unchanged.</p>
        <p>For security reasons, please do not share this link with anyone.</p>
      `,
    };

    try {
      await sgMail.send(msg);

      res.status(200).json({ 
        message: 'If an account with this email exists, a password reset link has been sent.' 
      });
    } catch (emailError) {

      res.status(200).json({ 
        message: 'If an account with this email exists, a password reset link has been sent.' 
      });
    }
  } catch (error) {

    res.status(500).json({ message: 'Unable to process password reset request. Please try again in a few minutes.' });
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

    } catch (emailError) {

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

    } catch (emailError) {

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

    } catch (emailError) {

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

    res.status(500).json({ message: 'Server error during super admin creation.' });
  }
};

export const logout = async (req, res) => {
  try {
    res.json({ message: 'Logged out successfully.' });
  } catch (error) {

    res.status(500).json({ message: 'Server error during logout.' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const locations = await Location.find().lean();
    res.json(locations);
  } catch (error) {

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

    res.status(500).json({ message: 'Server error fetching user data.' });
  }
};
