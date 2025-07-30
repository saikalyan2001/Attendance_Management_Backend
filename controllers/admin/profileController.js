import User from '../../models/User.js';
import { uploadFile, deleteFile } from '../../utils/fileUtils.js';

export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('locations', 'name address city state');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      locations: user.locations,
      profilePicture: user.profilePicture,
    });
  } catch (error) {
    console.error('Get profile error:', error.message);
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

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    if (phone && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ message: 'Phone number must be 10 digits' });
    }

    user.name = name;
    user.phone = phone || undefined;

    await user.save();
    const updatedUser = await User.findById(req.user._id).populate('locations', 'name address city state');
    res.json({
      email: updatedUser.email,
      name: updatedUser.name,
      phone: updatedUser.phone,
      role: updatedUser.role,
      locations: updatedUser.locations,
      profilePicture: updatedUser.profilePicture,
    });
  } catch (error) {
    console.error('Update profile error:', error.message);
    res.status(500).json({ message: 'Failed to update profile' });
  }
};

export const updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new passwords are required' });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update password error:', error.message);
    res.status(500).json({ message: 'Failed to update password' });
  }
};

export const uploadProfilePicture = async (req, res) => {
  try {
    const file = req.file;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Delete existing profile picture
    if (user.profilePicture?.path) {
      await deleteFile(user.profilePicture.path);
    }

    const { path, filename } = await uploadFile(file);
    user.profilePicture = { name: filename, path, uploadedAt: new Date() };
    await user.save();

    const updatedUser = await User.findById(req.user._id).populate('locations', 'name address city state');
    res.json({
      email: updatedUser.email,
      name: updatedUser.name,
      phone: updatedUser.phone,
      role: updatedUser.role,
      locations: updatedUser.locations,
      profilePicture: user.profilePicture,
    });
  } catch (error) {
    console.error('Upload profile picture error:', error.message);
    res.status(500).json({ message: 'Failed to upload profile picture' });
  }
};

export const deleteProfilePicture = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.profilePicture?.path) {
      return res.status(400).json({ message: 'No profile picture to delete' });
    }

    await deleteFile(user.profilePicture.path);
    user.profilePicture = undefined;
    await user.save();

    const updatedUser = await User.findById(req.user._id).populate('locations', 'name address city state');
    res.json({
      email: updatedUser.email,
      name: updatedUser.name,
      phone: updatedUser.phone,
      role: updatedUser.role,
      locations: updatedUser.locations,
      profilePicture: user.profilePicture,
    });
  } catch (error) {
    console.error('Delete profile picture error:', error.message);
    res.status(500).json({ message: 'Failed to delete profile picture' });
  }
};