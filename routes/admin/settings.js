import express from 'express';
import { getSettings, updateSettings } from '../../controllers/admin/settingsController.js';

const router = express.Router();

router.get('/settings', getSettings);
router.put('/settings', updateSettings);

export default router;