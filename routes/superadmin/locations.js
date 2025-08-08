import express from 'express';
import {
  getLocations,
  getPaginatedLocations,
  addLocation,
  editLocation,
  deleteLocation,
} from '../../controllers/admin/locationsController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('super_admin'));

router.get('/locations', getLocations);
router.get('/locations/paginated', getPaginatedLocations); // New endpoint for paginated locations
router.post('/locations', addLocation);
router.put('/locations/:id', editLocation);
router.delete('/locations/:id', deleteLocation);

export default router;