import express from 'express';
import { getDashboard } from '../../controllers/admin/dashboardController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/dashboard', protect, restrictTo('admin'), getDashboard);

export default router;
