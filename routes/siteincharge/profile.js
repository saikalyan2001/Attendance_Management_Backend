import express from 'express';
import { getProfile } from '../../controllers/siteincharge/profileController.js';

const router = express.Router();

router.get('/profile', getProfile);

export default router;