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
  getEmployeeMonthlySalary,
  getPayrollSummary,
} from "../../controllers/admin/employeesController.js"; // Reuse admin controller
import { protect, restrictTo } from "../../middleware/authMiddleware.js";
import upload from "../../utils/multer.js";
import multer from "multer";
import { getAttendance } from "../../controllers/admin/attendanceController.js";

import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import Employee from "../../models/Employee.js";
import Settings from "../../models/Settings.js";
import { hasAttendanceInMonth } from "../../controllers/admin/attendanceController.js";

const router = express.Router();

// Apply superadmin restriction
router.use(protect);
router.use(restrictTo("super_admin"));

// ✅ ADD THIS HELPER FUNCTION:
async function recalculateMonthlyLeavesForEmployee(employee, session) {
  

  // Get settings
  const settings = await Settings.findOne().lean().session(session);
  const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

  // Sort existing monthly leaves
  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  let totalTaken = 0;
  let lastAvailable = 0;

  // Process each month with new attendance-based logic
  for (let i = 0; i < employee.monthlyLeaves.length; i++) {
    const ml = employee.monthlyLeaves[i];
    
    // Ensure taken is not negative
    ml.taken = Math.max(ml.taken || 0, 0);
    
    // ✅ Reset carry forward to 0 at the start of each year (January)
    if (ml.month === 1) {
      lastAvailable = 0;
    }
    
    // ✅ NEW: Only carry forward from previous month if attendance was marked
    if (i > 0) {
      const prevMonth = employee.monthlyLeaves[i-1];
      
      // Check if employee had attendance in previous month
      const hasAttendance = await hasAttendanceInMonth(employee._id, prevMonth.year, prevMonth.month);
      
      
      
      // Only carry forward if previous month had attendance
      ml.carriedForward = hasAttendance ? Math.max(lastAvailable, 0) : 0;
      
      // Don't carry forward across years
      if (prevMonth.month === 12 && ml.month === 1) {
        ml.carriedForward = 0;
      }
    } else {
      ml.carriedForward = 0; // First month has no carry forward
    }
    
    // Recalculate available
    ml.allocated = paidLeavesPerMonth;
    ml.available = ml.allocated + ml.carriedForward - ml.taken;
    
    totalTaken += ml.taken;
    lastAvailable = Math.max(ml.available, 0);
    
    
  }

  // Update total leave balances
  employee.paidLeaves.used = totalTaken;
  employee.paidLeaves.available = Math.max((settings?.paidLeavesPerYear || 24) - totalTaken, 0);
  
  await employee.save({ session });
  
}


const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {

    return res.status(400).json({ message: `Multer error: ${err.message}`, field: err.field });
  }
  if (err) {

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
// Add these routes to your existing superadmin routes file
router.get("/employees/:id/salary/:year/:month", getEmployeeMonthlySalary);
router.get("/payroll/:year/:month", getPayrollSummary);


// ✅ ADD THIS ROUTE:
router.post('/recalculate-leaves', asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    
    
    // Get all active employees
    const employees = await Employee.find({ 
      status: 'active', 
      isDeleted: { $ne: true } 
    }).session(session);
    
    
    
    let processedCount = 0;
    
    for (const employee of employees) {
      try {
        await recalculateMonthlyLeavesForEmployee(employee, session);
        processedCount++;
      } catch (error) {
        
        // Continue with next employee
      }
    }
    
    await session.commitTransaction();
    
    res.status(200).json({ 
      success: true,
      message: 'Leave balances recalculated successfully',
      employeesProcessed: processedCount,
      totalEmployees: employees.length
    });
    
  } catch (error) {
    await session.abortTransaction();
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  } finally {
    session.endSession();
  }
}));



export default router;
