// src/backend/routes/superAdmin.js
import express from 'express';
import { protect, restrictTo } from '../../middleware/authMiddleware.js';
import { getAllUsers, updateUser, deleteUser, fetchSuperAdminDashboard } from '../../controllers/superadmin/superAdminController.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('super_admin'));

router.get('/users', getAllUsers);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);
// router.post('/create-admin', createAdmin);
router.get('/dashboard', fetchSuperAdminDashboard);

export default router;
