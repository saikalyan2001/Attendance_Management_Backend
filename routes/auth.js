import express from 'express';
import { login, signup, logout, getLocations, getMe } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/signup', signup);
router.post('/logout', logout);
router.get('/locations', getLocations);
router.get('/me', protect, getMe);

export default router;
