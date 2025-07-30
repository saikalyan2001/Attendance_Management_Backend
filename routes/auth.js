// src/backend/routes/auth.js
import express from 'express';
import { login, signup, createSiteIncharge, logout, getMe, getLocations } from '../controllers/authController.js';
import { protect, restrictTo } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/signup', protect, restrictTo('admin'), signup);
router.post('/create-siteincharge', protect, restrictTo('admin'), createSiteIncharge);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.get('/locations', getLocations);

export default router;