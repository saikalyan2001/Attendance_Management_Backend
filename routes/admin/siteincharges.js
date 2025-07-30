import express from 'express';
import { createSiteIncharge } from '../../controllers/admin/siteInchargeController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

// Only admins can create siteincharge accounts
router.post('/', protect, restrictTo('admin'), createSiteIncharge);

export default router;