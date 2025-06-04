import express from 'express';
import { login, signup, logout, getMe } from '../controllers/authController.js';
import { getLocations } from '../controllers/authController.js'; // Updated import
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/signup', signup);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.get('/locations', getLocations); // New public endpoint

export default router;