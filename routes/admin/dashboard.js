import express from 'express';
import { fetchSuperAdminDashboard } from '../../controllers/superadmin/superAdminController.js'; 
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/dashboard', protect, restrictTo('admin'), fetchSuperAdminDashboard);

export default router;
