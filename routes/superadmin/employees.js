import express from "express";
import {
  getEmployees,
  getEmployeeById,
  addEmployee,
  editEmployee,
  updateEmployeeAdvance,
  deactivateEmployee,
  transferEmployee,
  rejoinEmployee,
  getEmployeeHistory,
  addEmployeeDocuments,
  checkEmployeeExists,
  getEmployeeCount,
  getEmployeeAdvances,
  addEmployeesFromExcel,
  getDepartments,
  getSettings,
  deleteEmployee,
  restoreEmployee,
  getEmployeeAttendance,
  getEmployeeDocuments,
} from "../../controllers/admin/employeesController.js"; // Reuse admin controller
import { protect, restrictTo } from "../../middleware/authMiddleware.js";
import upload from "../../utils/multer.js";
import multer from "multer";
import { getAttendance } from "../../controllers/admin/attendanceController.js";

const router = express.Router();

// Apply superadmin restriction
router.use(protect);
router.use(restrictTo("super_admin"));

const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error("Multer error:", err.message, err.field);
    return res.status(400).json({ message: `Multer error: ${err.message}`, field: err.field });
  }
  if (err) {
    console.error("File upload error:", err.message);
    return res.status(400).json({ message: err.message });
  }
  next();
};

const uploadFields = upload.fields([
  { name: "excelFile", maxCount: 1 },
  { name: "documents", maxCount: 10 },
]);

// Superadmin routes
router.get("/settings", getSettings);
router.get("/employees/count", getEmployeeCount);
router.get("/employees", getEmployees);
router.get("/employees/check", checkEmployeeExists);
router.get("/employees/departments", getDepartments);
router.get("/employees/:id", getEmployeeById);
router.post("/employees", upload.array("documents"), multerErrorHandler, addEmployee);
router.post("/employees/excel", uploadFields, multerErrorHandler, addEmployeesFromExcel);
router.put("/employees/:id", editEmployee);
router.put("/employees/:id/advance", updateEmployeeAdvance);
router.get("/employees/:id/advances", getEmployeeAdvances);
router.put("/employees/:id/deactivate", deactivateEmployee);
router.delete("/employees/:id", deleteEmployee);
router.get("/employees/:id/attendance", getAttendance);
router.get("/employees/:id/attendance", getEmployeeAttendance);
router.put("/employees/:id/transfer", transferEmployee);
router.put("/employees/:id/rejoin", rejoinEmployee);
router.get("/employees/:id/history", getEmployeeHistory);
router.post("/employees/:id/documents", upload.array("documents"), multerErrorHandler, addEmployeeDocuments);
router.get('/employees/:id/documents', getEmployeeDocuments);
router.put("/employees/:id/restore", restoreEmployee);

export default router;
