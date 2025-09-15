import express from 'express';
import { 
  getSettings, 
  updateSettings, 
  updateEmployeeLeaves, 
  getLocationsForSettings 
} from '../../controllers/admin/settingsController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.post('/settings/update-leaves', updateEmployeeLeaves);
router.get('/locations', getLocationsForSettings); // Added locations endpoint

export default router;
