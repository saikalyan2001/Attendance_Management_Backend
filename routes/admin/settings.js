import express from 'express';
import { getSettings, updateSettings, updateEmployeeLeaves } from '../../controllers/admin/settingsController.js';

const router = express.Router();

router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.post('/settings/update-leaves', updateEmployeeLeaves);

export default router;