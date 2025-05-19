import express from 'express';
import { getDashboardData } from '../../controllers/siteincharge/dashboardController.js';

const router = express.Router();

router.get('/dashboard', getDashboardData);

export default router;