import Employee from '../models/Employee.js';
import Settings from '../models/Settings.js';
import mongoose from 'mongoose';

export async function updateCarryforward(employeeId, year, month, session) {
  try {
    const employee = await Employee.findById(employeeId).session(session);
    if (!employee) {
      (`Employee ${employeeId} not found`);
      return null;
    }

    const currentLeave = employee.monthlyLeaves.find(
      (ml) => ml.year === year && ml.month === month
    );
    if (!currentLeave) {
      (`No monthlyLeaves entry for ${year}-${month}`);
      return null;
    }

    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;

    // Prevent updating future months beyond current date
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (nextYear > currentYear || (nextYear === currentYear && nextMonth > currentMonth)) {
      (`Skipping carryforward for future month ${nextYear}-${nextMonth}`);
      return null;
    }

    let nextLeave = employee.monthlyLeaves.find(
      (ml) => ml.year === nextYear && ml.month === nextMonth
    );

    const settings = await Settings.findOne().lean();
    const defaultAllocated = settings?.paidLeavesPerMonth || 2;

    if (!nextLeave) {
      (`Creating new monthlyLeaves for ${nextYear}-${nextMonth}`);
      nextLeave = {
        month: nextMonth,
        year: nextYear,
        allocated: defaultAllocated,
        taken: 0,
        carriedForward: 0,
        available: defaultAllocated
      };
      employee.monthlyLeaves.push(nextLeave);
    }

    const carryforward = currentLeave.available || 0;
    (`Setting carriedForward to ${carryforward} for ${nextYear}-${nextMonth}`);
    nextLeave.carriedForward = carryforward;
    nextLeave.available = nextLeave.allocated + carryforward - (nextLeave.taken || 0);

    await employee.save({ session });
    (`Updated monthlyLeaves for ${nextYear}-${nextMonth}:`, nextLeave);
    return nextLeave;
  } catch (error) {
    (`Error in updateCarryforward: ${error.message}`);
    throw error;
  }
}