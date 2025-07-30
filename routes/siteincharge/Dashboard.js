import express from 'express';
import { getDashboardData } from '../../controllers/siteincharge/dashboardController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('siteincharge'));

router.get('/dashboard', getDashboardData);

export default router;
