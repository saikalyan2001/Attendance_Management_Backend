// routes/admin/advances.js
import express from 'express';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
import { getAdvances, deleteAdvance } from '../../controllers/admin/advancesController.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

router.get('/advances', getAdvances);
router.delete('/advances/:id', deleteAdvance);

export default router;