import express from 'express';
import { getReports } from '../../controllers/siteincharge/reportsController.js';

const router = express.Router();

router.get('/reports', getReports);

export default router;