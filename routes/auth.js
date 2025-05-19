import express from 'express';
import { login, getLocations } from '../controllers/authController.js';

const router = express.Router();

router.post('/login', login);
router.get('/locations', getLocations);

export default router;