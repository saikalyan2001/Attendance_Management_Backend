import express from 'express';
import { getLocations, addLocation, editLocation, deleteLocation } from '../../controllers/admin/locationsController.js';

const router = express.Router();

router.get('/locations', getLocations);
router.post('/locations', addLocation);
router.put('/locations/:id', editLocation);
router.delete('/locations/:id', deleteLocation);

export default router;