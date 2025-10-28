import express from 'express';
import { 
  login, 
  signup, 
  createSuperAdmin, 
  logout, 
  getMe, 
  getLocations, 
  resetPassword 
} from '../controllers/authController.js';
import { protect, restrictTo } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/signup', protect, restrictTo('admin', 'super_admin'), signup);
router.post('/create-superadmin', createSuperAdmin);
router.post('/reset-password', protect, resetPassword);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.get('/locations', getLocations);

export default router;
