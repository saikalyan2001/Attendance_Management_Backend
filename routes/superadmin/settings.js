import express from 'express';
import { getSettings, updateSettings, updateEmployeeLeaves, getLocationsForSettings } from '../../controllers/admin/settingsController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('super_admin'));

router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.post('/settings/update-leaves', updateEmployeeLeaves);
// In your superadmin routes file
router.get('/locations', getLocationsForSettings);


export default router;