import express from 'express';
// Use same controller as admin/superadmin for consistency:
import { fetchSuperAdminDashboard } from '../../controllers/superadmin/superAdminController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();
router.get('/dashboard', protect, restrictTo('siteincharge'), fetchSuperAdminDashboard);

export default router;
