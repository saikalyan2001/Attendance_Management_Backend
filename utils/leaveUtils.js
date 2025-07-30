import mongoose from "mongoose";
import Employee from "../models/Employee.js";
import Settings from "../models/Settings.js";

// Initialize monthly leaves for all months from joinDate to the specified year and month
export async function initializeMonthlyLeaves(employee, year, month, session) {
  const settings = await Settings.findOne().lean().session(session);
  const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

  // Get employee's join date
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;

  // Calculate the range of months to initialize
  const startYear = joinYear;
  const endYear = year;
  const startMonth = joinYear === year ? joinMonth : 1;
  const endMonth = month;

  // Initialize monthlyLeaves for each month in the range
  for (let y = startYear; y <= endYear; y++) {
    const mStart = y === startYear ? startMonth : 1;
    const mEnd = y === endYear ? endMonth : 12;

    for (let m = mStart; m <= mEnd; m++) {
      let monthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === y && ml.month === m
      );

      if (!monthlyLeave) {
        // Create a new monthlyLeaves entry with carriedForward = 0
        monthlyLeave = {
          year: y,
          month: m,
          allocated: paidLeavesPerMonth,
          taken: 0,
          carriedForward: 0, // Set to 0 during initialization
          available: paidLeavesPerMonth, // available = allocated + carriedForward
        };
        employee.monthlyLeaves.push(monthlyLeave);
      } else {
        // Correct negative taken values
        if (monthlyLeave.taken < 0) {
          monthlyLeave.taken = 0;
          monthlyLeave.available =
            monthlyLeave.allocated + monthlyLeave.carriedForward;
        }
      }
    }
  }

  // Save the employee with updated monthlyLeaves
  await employee.save({ session });

  // Return the monthlyLeave for the requested month and year
  return employee.monthlyLeaves.find(
    (ml) => ml.year === year && ml.month === month
  );
}