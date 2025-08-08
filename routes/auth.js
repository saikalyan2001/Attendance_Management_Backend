import express from 'express';
import { login, signup, createSiteIncharge, createSuperAdmin, logout, getMe, getLocations, setPassword, forgotPassword } from '../controllers/authController.js';
import { protect, restrictTo } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/signup', protect, restrictTo('admin', 'super_admin'), signup);
router.post('/create-siteincharge', protect, restrictTo('admin'), createSiteIncharge);
router.post('/create-superadmin', protect, restrictTo('super_admin'), createSuperAdmin);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.get('/locations', getLocations);
router.post('/set-password', setPassword);
router.post('/forgot-password', forgotPassword);

export default router;