import Employee from '../models/Employee.js';
import Settings from '../models/Settings.js';
import mongoose from 'mongoose';

export async function ensureMonthlyLeaveCarryforward(employeeId, year, month, defaultAllocated = 2) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // Prevent creating entries for future months
    if (year > currentYear || (year === currentYear && month > currentMonth)) {
      (`Cannot create monthlyLeaves for future month ${year}-${month}`);
      await session.abortTransaction();
      return null;
    }

    const employee = await Employee.findById(employeeId).session(session);
    if (!employee) {
      (`Employee ${employeeId} not found`);
      await session.abortTransaction();
      return null;
    }

    const joinDate = new Date(employee.joinDate);
    const joinYear = joinDate.getFullYear();
    const joinMonth = joinDate.getMonth() + 1;

    // Don’t process months before joinDate
    if (year < joinYear || (year === joinYear && month < joinMonth)) {
      (`Requested month ${year}-${month} is before join date ${joinYear}-${joinMonth}`);
      await session.abortTransaction();
      return null;
    }

    let monthlyLeave = employee.monthlyLeaves.find(
      (ml) => ml.year === year && ml.month === month
    );
    if (!monthlyLeave) {
      const settings = await Settings.findOne().lean();
      defaultAllocated = settings?.paidLeavesPerMonth || defaultAllocated;

      let carriedForward = 0;
      if (year > joinYear || (year === joinYear && month > joinMonth)) {
        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const prevLeave = await ensureMonthlyLeaveCarryforward(employeeId, prevYear, prevMonth, defaultAllocated);
        carriedForward = prevLeave ? prevLeave.available : 0;
      }

      monthlyLeave = {
        month,
        year,
        allocated: defaultAllocated,
        taken: 0,
        carriedForward,
        available: defaultAllocated + carriedForward
      };
      employee.monthlyLeaves.push(monthlyLeave);
      (`Created monthlyLeaves for ${year}-${month}:`, monthlyLeave);
      await employee.save({ session });
    }

    await session.commitTransaction();
    return monthlyLeave;
  } catch (error) {
    (`Error in ensureMonthlyLeaveCarryforward: ${error.message}`);
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}