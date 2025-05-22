import express from 'express';
import { getProfile, updateProfile, updatePassword, uploadProfilePicture } from '../../controllers/admin/profileController.js';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
import upload from '../../utils/multer.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin'));

router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.put('/profile/password', updatePassword);
router.post('/profile/picture', upload.single('profilePicture'), uploadProfilePicture);

export default router;
