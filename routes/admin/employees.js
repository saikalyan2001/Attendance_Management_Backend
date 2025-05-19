import express from 'express';
import { getEmployees, createEmployee, updateEmployee } from '../../controllers/admin/employeesController.js';
const router = express.Router();

router.get('/employees', getEmployees);
router.post('/employees', createEmployee);
router.put('/employees/:id', updateEmployee);

export default router;