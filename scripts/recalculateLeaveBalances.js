import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Settings from '../models/Settings.js';
import { hasAttendanceInMonth } from '../controllers/admin/attendanceController.js';

// Connect to your MongoDB database
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/Attendance_Management');
    
  } catch (error) {
    
    process.exit(1);
  }
};

// Recalculate monthly leaves with attendance-based carry forward
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

// Main recalculation function
async function recalculateAllEmployeeLeaveBalances() {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    
    
    // Get all active employees
    const employees = await Employee.find({ 
      status: 'active', 
      isDeleted: { $ne: true } 
    }).session(session);
    
    
    
    for (let i = 0; i < employees.length; i++) {
      const employee = employees[i];
      
      
      try {
        await recalculateMonthlyLeavesForEmployee(employee, session);
      } catch (error) {
        
        // Continue with next employee
      }
    }
    
    await session.commitTransaction();
    
    
  } catch (error) {
    await session.abortTransaction();
    
    throw error;
  } finally {
    session.endSession();
  }
}

// Run the script
const runScript = async () => {
  try {
    await connectDB();
    await recalculateAllEmployeeLeaveBalances();
    
    process.exit(0);
  } catch (error) {
    
    process.exit(1);
  }
};

runScript();
