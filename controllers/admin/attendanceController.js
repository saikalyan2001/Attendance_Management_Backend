import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Settings from '../../models/Settings.js';
import { format } from 'date-fns';
import { getWorkingDaysForLocation } from './settingsController.js';
import { isWorkingDay, getWorkingDayPolicyInfo, shouldCountForSalary } from '../../utils/workingDayValidator.js'; // ✅ UPDATED import


// Utility to convert date to IST
function toIST(date) {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
}

function normalizeDate(dateInput) {
  let date;
  if (typeof dateInput === 'string') {
    date = new Date(dateInput);
  } else if (dateInput instanceof Date) {
    date = dateInput;
  } else {
    throw new Error('Invalid date input');
  }

  if (isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }

  // Return ISO 8601 string with IST (+05:30)
  const offset = 5.5 * 60 * 60 * 1000; // IST offset
  const istDate = new Date(date.getTime() + offset);
  return istDate.toISOString().replace('Z', '+05:30');
}

const validateAttendanceDate = async (employeeId, date, isException = false) => {
  try {
    const employee = await Employee.findById(employeeId).populate('location');
    if (!employee) {
      throw new Error('Employee not found');
    }
    
    const settings = await Settings.findOne()
      .populate('workingDayPolicies.locations')
      .lean();
    
    const isWorking = isWorkingDay(settings, employee.location._id, date);
    const policyInfo = getWorkingDayPolicyInfo(settings, employee.location._id);
    
    return {
      isWorkingDay: isWorking,
      policyInfo,
      canMarkAttendance: isWorking || isException,
      requiresException: !isWorking,
      locationName: employee.location.name,
      employee: employee
    };
  } catch (error) {
    
    return {
      isWorkingDay: true,
      canMarkAttendance: true,
      requiresException: false,
      error: error.message
    };
  }
};

function calculateProratedLeaves(joinDate, paidLeavesPerYear) {
  const join = new Date(joinDate);
  const joinYear = join.getFullYear();
  const joinMonth = join.getMonth();
  const currentYear = new Date().getFullYear();

  if (joinYear === currentYear) {
    const remainingMonths = 12 - joinMonth;
    return Math.round((paidLeavesPerYear * remainingMonths) / 12);
  }
  return paidLeavesPerYear;
}

// ✅ ENHANCED: Correct monthly leaves with capped calculation
async function correctMonthlyLeaves(employee, year, month, session) {
  let paidLeavesPerMonth = 2;
  let settings = null;
  
  try {
    settings = await Settings.findOne().lean().session(session);
    paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
  } catch (e) {
    
    settings = { paidLeavesPerYear: 24 };
    paidLeavesPerMonth = 2;
  }

  let totalTaken = 0;
  let lastAvailable = 0;

  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  // Remove duplicates
  const uniqueLeaves = [];
  const seen = new Set();
  for (const ml of employee.monthlyLeaves) {
    const key = `${ml.year}-${ml.month}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueLeaves.push(ml);
    }
  }
  employee.monthlyLeaves = uniqueLeaves;

  // Ensure all months from joinDate to current month exist
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  for (let y = joinYear; y <= currentYear; y++) {
    const startMonth = y === joinYear ? joinMonth : 1;
    const endMonth = y === currentYear ? currentMonth : 12;
    for (let m = startMonth; m <= endMonth; m++) {
      if (!employee.monthlyLeaves.find(ml => ml.year === y && ml.month === m)) {
        employee.monthlyLeaves.push({
          year: y,
          month: m,
          allocated: paidLeavesPerMonth,
          taken: 0,
          carriedForward: 0,
          available: paidLeavesPerMonth,
        });
      }
    }
  }

  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  // ✅ ENHANCED: Process carry forward with capped leave calculation
  for (let i = 0; i < employee.monthlyLeaves.length; i++) {
    const ml = employee.monthlyLeaves[i];
    
    if (ml.month === 1) {
      lastAvailable = 0;
    }
    
    if (ml.year < year || (ml.year === year && ml.month <= month)) {
      if (i > 0) {
        const prevMonth = employee.monthlyLeaves[i-1];
        const hasAttendance = await hasAttendanceInMonth(employee._id, prevMonth.year, prevMonth.month);
        
        ml.carriedForward = hasAttendance ? Math.max(lastAvailable, 0) : 0;
        
        if (prevMonth.month === 12 && ml.month === 1) {
          ml.carriedForward = 0;
        }
      } else {
        ml.carriedForward = 0;
      }

      // ✅ ENHANCED: Calculate actual leave usage and cap it
      const totalAllowedLeaves = ml.allocated + ml.carriedForward;
      
      // Calculate actual half-days and leaves taken this month
      const startDate = `${ml.year}-${ml.month.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endDate = `${ml.year}-${ml.month.toString().padStart(2, '0')}-31T23:59:59+05:30`;
      
      const monthAttendance = await Attendance.find({
        employee: employee._id,
        date: { $gte: startDate, $lte: endDate },
        status: { $in: ['leave', 'half-day'] },
        isDeleted: false
      }).session(session);

      let actualLeaveEquivalent = 0;
      monthAttendance.forEach(att => {
        if (att.status === 'leave') {
          actualLeaveEquivalent += 1;
        } else if (att.status === 'half-day') {
          actualLeaveEquivalent += 0.5;
        }
      });

      // ✅ NEW: Cap the taken leaves to the allowed limit
      ml.taken = Math.min(actualLeaveEquivalent, totalAllowedLeaves);
      ml.available = Math.max(0, totalAllowedLeaves - ml.taken);

      
    } else {
      ml.available = ml.allocated + ml.carriedForward - ml.taken;
    }
    
    totalTaken += ml.taken;
    lastAvailable = Math.max(ml.available, 0);
  }

  // Only update paidLeaves if not manually set
  if (!employee.isManualPaidLeavesUpdate) {
    const originalAllocated = employee.paidLeaves.available + employee.paidLeaves.used;
    
    employee.set('paidLeaves.used', totalTaken);
    employee.set('paidLeaves.available', Math.max(0, originalAllocated - totalTaken));
    
    
    
  } else {
    
  }
  
  employee._skipAutoCalculation = true;
  await employee.save({ session });
  employee._skipAutoCalculation = false;
}

const updateMonthlyPresence = async (employeeId, year, month, session) => {
  
  
  try {
    const employee = await Employee.findById(employeeId).populate('location').session(session);
    if (!employee) return;

    const settings = await Settings.findOne()
      .populate('workingDayPolicies.locations')
      .lean()
      .session(session);
    
    let workingDaysInMonth = 30;
    
    if (settings && employee.location) {
      workingDaysInMonth = getWorkingDaysForLocation(settings, employee.location._id, year, month);
    }

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01T00:00:00+05:30`;
    const endDate = `${year}-${month.toString().padStart(2, '0')}-31T23:59:59+05:30`;
    
    const monthlyAttendance = await Attendance.find({
      employee: employeeId,
      date: { $gte: startDate, $lte: endDate },
      isDeleted: false
    }).session(session);

    let totalPresence = 0;
    for (const att of monthlyAttendance) {
      if (shouldCountForSalary(att, settings, employee.location._id)) {
        totalPresence += (att.presenceDays || 0);
      }
    }

    let monthlyPresence = employee.monthlyPresence.find(
      mp => mp.year === year && mp.month === month
    );

    if (!monthlyPresence) {
      employee.monthlyPresence.push({
        year: year,
        month: month,
        totalPresenceDays: totalPresence,
        workingDaysInMonth: workingDaysInMonth,
        lastUpdated: new Date()
      });
    } else {
      monthlyPresence.totalPresenceDays = totalPresence;
      monthlyPresence.workingDaysInMonth = workingDaysInMonth;
      monthlyPresence.lastUpdated = new Date();
    }

    await employee.save({ session });
    
    
    return totalPresence;
    
  } catch (error) {
    
    throw error;
  }
};

async function initializeMonthlyLeaves(employee, year, month, session) {
  let paidLeavesPerMonth = 2;
  try {
    const settings = await Settings.findOne().lean().session(session);
    paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
  } catch (e) {
    // Fallback to default
  }

  let monthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === year && ml.month === month
  );

  if (!monthlyLeave) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonthlyLeave = employee.monthlyLeaves.find(
      (ml) => ml.year === prevYear && ml.month === prevMonth
    );
    const prevAvailable = prevMonthlyLeave
      ? Math.max(prevMonthlyLeave.available, 0)
      : 0;

    monthlyLeave = {
      year,
      month,
      allocated: paidLeavesPerMonth,
      taken: 0,
      carriedForward: prevAvailable,
      available: paidLeavesPerMonth + prevAvailable,
    };
    employee.monthlyLeaves.push(monthlyLeave);
    await employee.save({ session });
  } else {
    if (monthlyLeave.taken < 0) {
      monthlyLeave.taken = 0;
      monthlyLeave.available = monthlyLeave.allocated + monthlyLeave.carriedForward;
      await employee.save({ session });
    }
  }
  return monthlyLeave;
}

async function updateNextMonthCarryforward(employeeId, year, month, available, session) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  

  const employee = await Employee.findById(employeeId).session(session);
  if (!employee) {
    
    return;
  }

  let nextMonthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === nextYear && ml.month === nextMonth
  );

  let paidLeavesPerMonth = 2;
  try {
    const settings = await Settings.findOne().lean().session(session);
    paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
  } catch (e) {
    // Fallback to default
  }

  if (!nextMonthlyLeave) {
    const carriedForward = Math.max(available, 0);
    const finalCarriedForward = (month === 12) ? 0 : carriedForward;
    
    
    
    nextMonthlyLeave = {
      year: nextYear,
      month: nextMonth,
      allocated: paidLeavesPerMonth,
      taken: 0,
      carriedForward: finalCarriedForward,
      available: paidLeavesPerMonth + finalCarriedForward,
    };
    employee.monthlyLeaves.push(nextMonthlyLeave);
  } else {
    const carriedForward = Math.max(available, 0);
    const finalCarriedForward = (month === 12) ? 0 : carriedForward;
    
    
    
    nextMonthlyLeave.carriedForward = finalCarriedForward;
    nextMonthlyLeave.available = nextMonthlyLeave.allocated + finalCarriedForward - Math.max(nextMonthlyLeave.taken || 0, 0);
  }


  await employee.save({ session });
}

async function executeWithRetry(operation, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const result = await operation(session);
      await session.commitTransaction();
      session.endSession();
      return result;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      if (error.codeName === 'WriteConflict' && retries < maxRetries - 1) {
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, retries)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries reached for transaction');
}

export async function hasAttendanceInMonth(employeeId, year, month) {
  try {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);
    
    const startStr = `${year}-${month.toString().padStart(2, '0')}-01T00:00:00+05:30`;
    const endStr = `${year}-${month.toString().padStart(2, '0')}-${endDate.getDate()}T23:59:59+05:30`;
    
    
    
    
    const count = await Attendance.countDocuments({
      employee: employeeId,
      date: { $gte: startStr, $lte: endStr },
      status: { $in: ['present', 'leave', 'half-day'] },
      isDeleted: false,
    });
    
    
    return count > 0;
  } catch (error) {
    
    return false;
  }
}

// ✅ ENHANCED: bulkMarkAttendance with unlimited half-days and capped calculations
export const bulkMarkAttendance = async (req, res) => {
  try {
    const { attendance, overwrite = false } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(attendance) || !attendance.length) {
      return res.status(400).json({
        message: 'Attendance array is required and must not be empty',
      });
    }

    const settings = await Settings.findOne()
      .populate('workingDayPolicies.locations')
      .lean();
    const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

    const attendanceRecords = [];
    const errors = [];
    const existingRecords = [];
    const workingDayWarnings = [];

    // Enhanced validation phase with working day checks
    for (const record of attendance) {
      const { employeeId, date, status, location, isException, exceptionReason, exceptionDescription } = record;

      if (!employeeId || !date || !status || !location) {
        errors.push({ message: `Missing required fields for employee ${employeeId}` });
        continue;
      }

      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        errors.push({ message: `Invalid status '${status}' for employee '${employeeId}'` });
        continue;
      }

      let normalizedDate;
      try {
        normalizedDate = normalizeDate(date);
      } catch (err) {
        errors.push({ message: `Invalid date format for employee ${employeeId}: ${date}` });
        continue;
      }

      const targetDateTime = new Date(normalizedDate);
      const targetDate = new Date(targetDateTime.getFullYear(), targetDateTime.getMonth(), targetDateTime.getDate());
      if (targetDate > new Date()) {
        errors.push({ message: `Cannot mark attendance for future date ${date} for employee ${employeeId}` });
        continue;
      }

      const employee = await Employee.findById(employeeId);
      if (!employee) {
        errors.push({ message: `Employee ${employeeId} not found` });
        continue;
      }

      const locationExists = await Location.findById(location);
      if (!locationExists) {
        errors.push({ message: `Location ${location} not found` });
        continue;
      }

      const validation = await validateAttendanceDate(employeeId, normalizedDate, isException);
      
      if (!validation.canMarkAttendance) {
        errors.push({
          message: `Cannot mark attendance for ${employee.name} on ${normalizedDate.split('T')[0]} - ${validation.policyInfo.policyName} excludes this day. Use exception marking if needed.`
        });
        continue;
      }

      if (validation.requiresException && !isException) {
        workingDayWarnings.push({
          employeeId,
          employeeName: employee.name,
          date: normalizedDate.split('T')[0],
          policyInfo: validation.policyInfo,
          message: `${employee.name}: ${normalizedDate.split('T')[0]} is not a working day per ${validation.policyInfo.policyName}. Consider marking as exception.`
        });
      }

      if (isException) {
        if (!exceptionReason) {
          errors.push({ message: `Exception reason is required for ${employee.name} on non-working day` });
          continue;
        }
        if (exceptionReason === 'other' && !exceptionDescription) {
          errors.push({ message: `Exception description is required when reason is 'other' for ${employee.name}` });
          continue;
        }
      }

      const dateOnlyStr = normalizedDate.split('T')[0];
      const existingRecord = await Attendance.findOne({
        employee: employeeId,
        location,
        date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
        isDeleted: false,
      });

      if (existingRecord && !overwrite) {
        existingRecords.push({
          employeeId,
          date: existingRecord.date,
          status: existingRecord.status,
        });
        continue;
      }

      const year = targetDateTime.getFullYear();
      const month = targetDateTime.getMonth() + 1;
      
      // ✅ REMOVED: Half-day validation (allow unlimited half-days)
      // ✅ KEEP: Only validate full leaves
      if (status === 'leave') {
        const monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === year && ml.month === month
        );
        if (!monthlyLeave || monthlyLeave.available < 1) {
          errors.push({
            message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves (${monthlyLeave?.available || 0}) for full leave on ${month}/${year}`,
          });
          continue;
        }
      }

      // Calculate presence days for new record
      let presenceDays = 0;
      if (status === 'present') {
        presenceDays = 1.0;
      } else if (status === 'half-day') {
        presenceDays = 0.5;
      } else if (status === 'leave') {
        presenceDays = 1.0;
      }

      attendanceRecords.push({
        employee: employeeId,
        date: normalizedDate,
        status,
        location,
        markedBy: userId,
        presenceDays: presenceDays,
        isException: isException || false,
        exceptionReason: exceptionReason || undefined,
        exceptionDescription: exceptionDescription || undefined,
        approvedBy: isException ? userId : undefined,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({ 
        message: 'Validation errors', 
        errors,
        workingDayWarnings: workingDayWarnings.length > 0 ? workingDayWarnings : undefined
      });
    }

    if (existingRecords.length > 0 && !overwrite) {
      return res.status(409).json({
        message: `Attendance already marked for ${existingRecords.length} employee(s)`,
        existingRecords,
        workingDayWarnings: workingDayWarnings.length > 0 ? workingDayWarnings : undefined
      });
    }

    // Execute with retry
    const result = await executeWithRetry(async (session) => {
      const attendanceIds = [];
      const transactionErrors = [];

      for (const record of attendanceRecords) {
        try {
          const { employee: employeeId, date, status, location, presenceDays, isException, exceptionReason, exceptionDescription, approvedBy } = record;
          const targetDateTime = new Date(date);
          const month = targetDateTime.getMonth() + 1;
          const year = targetDateTime.getFullYear();
          const dateOnlyStr = date.split('T')[0];

          

          const employee = await Employee.findById(employeeId).session(session);
          if (!employee) {
            transactionErrors.push({ message: `Employee ${employeeId} not found in transaction` });
            continue;
          }

          await correctMonthlyLeaves(employee, year, month, session);
          let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, session);

          

          const existingRecord = await Attendance.findOne({
            employee: employeeId,
            location,
            date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
            isDeleted: false,
          }).session(session);

          let leaveAdjustment = 0;
          let monthlyLeaveAdjustment = 0;

          if (existingRecord) {
            const oldStatus = existingRecord.status;
            
            
            if (oldStatus !== status) {
              // Handle leave adjustments for old status
              if (oldStatus === 'leave') {
                leaveAdjustment -= 1;
                monthlyLeaveAdjustment -= 1;
              } else if (oldStatus === 'half-day') {
                leaveAdjustment -= 0.5;
                monthlyLeaveAdjustment -= 0.5;
              }
              
              // Handle leave adjustments for new status
              if (status === 'leave') {
                if (monthlyLeave.available + monthlyLeaveAdjustment < 1) {
                  transactionErrors.push({
                    message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for full leave on ${month}/${year}`,
                  });
                  continue;
                }
                leaveAdjustment += 1;
                monthlyLeaveAdjustment += 1;
              } else if (status === 'half-day') {
                // ✅ REMOVED: Half-day validation
                leaveAdjustment += 0.5;
                monthlyLeaveAdjustment += 0.5;
              }

              // Update existing record
              existingRecord.status = status;
              existingRecord.date = date;
              existingRecord.markedBy = userId;
              existingRecord.presenceDays = presenceDays;
              existingRecord.isException = isException || false;
              existingRecord.exceptionReason = exceptionReason;
              existingRecord.exceptionDescription = exceptionDescription;
              existingRecord.approvedBy = approvedBy;
              await existingRecord.save({ session });
              attendanceIds.push(existingRecord._id.toString());
            } else {
              attendanceIds.push(existingRecord._id.toString());
            }
          } else {
            
            
            // New record - handle leave adjustments
            if (status === 'leave') {
              if (monthlyLeave.available < 1) {
                transactionErrors.push({
                  message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for full leave on ${month}/${year}`,
                });
                continue;
              }
              leaveAdjustment = 1;
              monthlyLeaveAdjustment = 1;
            } else if (status === 'half-day') {
              // ✅ REMOVED: Half-day validation - allow unlimited half-days
              leaveAdjustment = 0.5;
              monthlyLeaveAdjustment = 0.5;
            }

            const newRecord = new Attendance({
              employee: employeeId,
              date,
              status,
              location,
              markedBy: userId,
              presenceDays: presenceDays,
              isException: isException || false,
              exceptionReason: exceptionReason,
              exceptionDescription: exceptionDescription,
              approvedBy: approvedBy,
            });
            await newRecord.save({ session });
            attendanceIds.push(newRecord._id.toString());
          }

          

          // ✅ ENHANCED: Update leave balances with capping logic
          if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
            // Calculate total leave equivalent taken this month
            const totalLeaveEquivalent = monthlyLeave.taken + monthlyLeaveAdjustment;
            
            // ✅ NEW: Cap the used leaves to monthly allocation
            const monthlyAllocation = monthlyLeave.allocated + monthlyLeave.carriedForward;
            const cappedUsed = Math.min(totalLeaveEquivalent, monthlyAllocation);
            
            // Update monthly leaves with capped values
            monthlyLeave.taken = cappedUsed;
            monthlyLeave.available = Math.max(0, monthlyAllocation - cappedUsed);

            

            const updateQuery = {
              $set: {
                'monthlyLeaves.$[elem].taken': cappedUsed,
                'monthlyLeaves.$[elem].available': monthlyLeave.available,
              },
            };

            // Only update paidLeaves if not manually set
            if (!employee.isManualPaidLeavesUpdate) {
              // ✅ ENHANCED: Use capped value for paidLeaves update
              const currentPaidUsed = employee.paidLeaves.used || 0;
              const maxAllowedIncrease = Math.max(0, monthlyAllocation - currentPaidUsed);
              const cappedPaidLeaveAdjustment = Math.min(leaveAdjustment, maxAllowedIncrease);
              
              updateQuery.$inc = {
                'paidLeaves.available': -cappedPaidLeaveAdjustment,
                'paidLeaves.used': cappedPaidLeaveAdjustment,
              };
              
            }

            await Employee.findByIdAndUpdate(
              employeeId,
              updateQuery,
              {
                arrayFilters: [{ 'elem.year': year, 'elem.month': month }],
                session,
                new: true,
              }
            );
          }

          // Always update monthly presence after any attendance change
          await updateMonthlyPresence(employeeId, year, month, session);
          await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available, session);

          
        } catch (recordError) {
          
          transactionErrors.push({ 
            message: `Error processing employee ${record.employee}: ${recordError.message}` 
          });
        }
      }

      return { attendanceIds, errors: transactionErrors };
    });

    if (result.errors && result.errors.length > 0) {
      
      return res.status(400).json({ 
        message: 'Validation errors during attendance processing', 
        errors: result.errors 
      });
    }

    res.status(201).json({
      message: 'Bulk attendance marked successfully',
      attendanceIds: result.attendanceIds,
      workingDayWarnings: workingDayWarnings.length > 0 ? workingDayWarnings : undefined
    });
  } catch (error) {
    
    if (error.code === 11000) {
      return res.status(409).json({
        message: 'Attendance already marked for some employees',
      });
    }
    res.status(500).json({
      message: `Server error while marking bulk attendance: ${error.message}`,
    });
  }
};

// Continue with existing functions but update markAttendance similarly
export const markAttendance = async (req, res) => {
  const result = await executeWithRetry(async (session) => {
    const attendanceRecords = Array.isArray(req.body) ? req.body : [req.body];
    const settings = await Settings.findOne().lean().session(session);
    const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
    const attendanceIds = [];
    const errors = [];

    for (const record of attendanceRecords) {
      const { employeeId, date, status, location, isException, exceptionReason, exceptionDescription } = record;
      if (!employeeId || !date || !status || !location) {
        errors.push({ message: `Missing required fields for employee ${employeeId}` });
        continue;
      }

      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        errors.push({ message: `Invalid status '${status}' for employee ${employeeId}` });
        continue;
      }

      let normalizedDate;
      try {
        normalizedDate = normalizeDate(date);
      } catch (err) {
        errors.push({ message: `Invalid date format for employee ${employeeId}: ${date}` });
        continue;
      }

      const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
      if (!dateRegex.test(normalizedDate)) {
        errors.push({ message: `Invalid date format for employee ${employeeId}: ${date}` });
        continue;
      }

      const targetDateTime = new Date(normalizedDate);
      if (isNaN(targetDateTime.getTime())) {
        errors.push({ message: `Invalid date for employee ${employeeId}: ${date}` });
        continue;
      }
      const targetDate = new Date(targetDateTime.getFullYear(), targetDateTime.getMonth(), targetDateTime.getDate());
      if (targetDate > new Date()) {
        errors.push({ message: `Cannot mark attendance for future date ${date} for employee ${employeeId}` });
        continue;
      }

      const employee = await Employee.findById(employeeId).session(session);
      if (!employee) {
        errors.push({ message: `Employee ${employeeId} not found` });
        continue;
      }

      const locationExists = await Location.findById(location).session(session);
      if (!locationExists) {
        errors.push({ message: `Location ${location} not found` });
        continue;
      }

      const validation = await validateAttendanceDate(employeeId, normalizedDate, isException);
      
      if (!validation.canMarkAttendance) {
        errors.push({
          message: `Cannot mark attendance for ${employee.name} on ${normalizedDate.split('T')[0]} - ${validation.policyInfo.policyName} excludes this day. Use exception marking if needed.`
        });
        continue;
      }

      const dateOnlyStr = normalizedDate.split('T')[0];
      const existingRecord = await Attendance.findOne({
        employee: employeeId,
        location,
        date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
        isDeleted: false,
      }).session(session);

      if (existingRecord) {
        errors.push({ message: `Attendance already marked for ${employeeId} on ${dateOnlyStr}` });
        continue;
      }

      const month = targetDateTime.getMonth() + 1;
      const year = targetDateTime.getFullYear();

      await correctMonthlyLeaves(employee, year, month, session);
      let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, session);

      // ✅ REMOVED: Half-day validation - only validate full leaves
      if (status === 'leave') {
        if (monthlyLeave.available < 1) {
          errors.push({
            message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves (${monthlyLeave.available}) for full leave on ${month}/${year}`,
          });
          continue;
        }
      }

      let leaveAdjustment = 0;
      let monthlyLeaveAdjustment = 0;
      let presenceDays = 0;

      // Handle leave adjustments and presence days
      if (status === 'leave') {
        leaveAdjustment = 1;
        monthlyLeaveAdjustment = 1;
        presenceDays = 1.0;
      } else if (status === 'half-day') {
        // ✅ ALLOW: Unlimited half-days
        leaveAdjustment = 0.5;
        monthlyLeaveAdjustment = 0.5;
        presenceDays = 0.5;
      } else if (status === 'present') {
        presenceDays = 1.0;
      } else {
        presenceDays = 0; // absent
      }

      const attendance = new Attendance({
        employee: employeeId,
        date: normalizedDate,
        status,
        location,
        markedBy: req.user?._id || null,
        presenceDays: presenceDays,
        isException: isException || false,
        exceptionReason: exceptionReason,
        exceptionDescription: exceptionDescription,
        approvedBy: isException ? req.user?._id : undefined,
      });
      await attendance.save({ session });
      attendanceIds.push(attendance._id.toString());

      // ✅ ENHANCED: Update leave balances with capping
      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        const totalLeaveEquivalent = monthlyLeave.taken + monthlyLeaveAdjustment;
        const monthlyAllocation = monthlyLeave.allocated + monthlyLeave.carriedForward;
        const cappedUsed = Math.min(totalLeaveEquivalent, monthlyAllocation);
        
        monthlyLeave.taken = cappedUsed;
        monthlyLeave.available = Math.max(0, monthlyAllocation - cappedUsed);
      }

      await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available, session);

      const updateQuery = {
        $set: {
          'monthlyLeaves.$[elem].taken': monthlyLeave.taken,
          'monthlyLeaves.$[elem].available': monthlyLeave.available,
        },
      };

      // Only update paidLeaves if not manually set
      if (!employee.isManualPaidLeavesUpdate && leaveAdjustment !== 0) {
        const cappedPaidLeaveAdjustment = Math.min(leaveAdjustment, monthlyLeave.allocated + monthlyLeave.carriedForward - (employee.paidLeaves.used || 0));
        updateQuery.$inc = {
          'paidLeaves.available': -cappedPaidLeaveAdjustment,
          'paidLeaves.used': cappedPaidLeaveAdjustment,
        };
      }

      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        await Employee.findByIdAndUpdate(
          employeeId,
          updateQuery,
          {
            arrayFilters: [{ 'elem.year': year, 'elem.month': month }],
            session,
            new: true,
          }
        );
      }

      await updateMonthlyPresence(employeeId, year, month, session);
    }

    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation errors', errors });
    }

    return { message: 'Attendance marked successfully', attendanceIds };
  });

  res.status(201).json(result);
};


export const getLocationWorkingDayPolicy = async (req, res) => {
  
  
  
  
  try {
    const { locationId, date } = req.query;
    

    if (!locationId) {
      
      return res.status(400).json({ message: 'Location ID is required' });
    }

    
    const settings = await Settings.findOne()
      .populate('workingDayPolicies.locations')
      .lean();
    
 
    const policy = getWorkingDayPolicyInfo(settings, locationId);
    const isWorking = date ? isWorkingDay(settings, locationId, date) : null;

    

    const response = {
      policy,
      isWorkingDay: isWorking,
      date: date || null
    };

    
    res.json(response);
  } catch (error) {
    
    res.status(500).json({ message: 'Server error while getting working day policy' });
  }
};

export const validateAttendanceDateEndpoint = async (req, res) => {
  try {
    const { employeeId, date, isException } = req.query;

    if (!employeeId || !date) {
      return res.status(400).json({ message: 'Employee ID and date are required' });
    }

    const validation = await validateAttendanceDate(employeeId, date, isException === 'true');
    
    res.json(validation);
  } catch (error) {
    
    res.status(500).json({ message: 'Server error while validating attendance date' });
  }
};

// Rest of the existing functions remain the same
export const undoMarkAttendance = async (req, res) => {
  const result = await executeWithRetry(async (session) => {
    const { attendanceIds } = req.body;

    if (!Array.isArray(attendanceIds) || !attendanceIds.length) {
      throw new Error('Attendance IDs array is required and must not be empty');
    }

    const validIds = attendanceIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!validIds.length) {
      throw new Error('No valid attendance IDs provided');
    }

    const records = await Attendance.find({ _id: { $in: validIds }, isDeleted: false }).session(session);
    if (!records.length) {
      throw new Error('No valid attendance records found to undo');
    }

    const leaveAdjustments = [];

    for (const record of records) {
      const employee = await Employee.findById(record.employee).session(session);
      if (!employee) continue;

      const targetDateTime = new Date(record.date);
      const month = targetDateTime.getMonth() + 1;
      const year = targetDateTime.getFullYear();

      await correctMonthlyLeaves(employee, year, month, session);
      let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, 0, session);

      let adjustment = 0;
      let monthlyAdjustment = 0;

      if (record.status === 'leave') {
        adjustment = 1;
        monthlyAdjustment = 1;
      } else if (record.status === 'half-day') {
        adjustment = 0.5;
        monthlyAdjustment = 0.5;
      }

      if (adjustment !== 0 || monthlyAdjustment !== 0) {
        monthlyLeave.taken -= monthlyAdjustment;
        monthlyLeave.available += monthlyAdjustment;
        await updateNextMonthCarryforward(employee._id, year, month, monthlyLeave.available, session);

        leaveAdjustments.push({
          employeeId: employee._id,
          adjustment,
          monthlyAdjustment,
          year,
          month,
          monthlyLeave,
        });
      }

      record.isDeleted = true;
      record.deletedAt = new Date();
      record.deletedBy = req.user?._id || null;
      await record.save({ session });
    }

    for (const { employeeId, adjustment, monthlyAdjustment, year, month, monthlyLeave } of leaveAdjustments) {
      await Employee.findByIdAndUpdate(
        employeeId,
        {
          $inc: {
            'paidLeaves.available': adjustment,
            'paidLeaves.used': -adjustment,
          },
          $set: {
            'monthlyLeaves.$[elem].taken': monthlyLeave.taken,
            'monthlyLeaves.$[elem].available': monthlyLeave.available,
          },
        },
        {
          arrayFilters: [{ 'elem.year': year, 'elem.month': month }],
          session,
          new: true,
        }
      );
    }

    return { message: 'Attendance undone successfully' };
  });

  res.status(200).json(result);
};

export const editAttendance = async (req, res) => {
  const result = await executeWithRetry(async (session) => {
    const { id } = req.params;
    const { status, date } = req.body;

    if (!status || !['present', 'absent', 'half-day', 'leave'].includes(status)) {
      throw new Error('Valid status is required (present, absent, half-day, leave)');
    }

    if (!date || isNaN(new Date(date).getTime())) {
      throw new Error('Valid date is required');
    }

    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
    if (!dateRegex.test(date)) {
      throw new Error(`Invalid date format: ${date}`);
    }

    const targetDateTime = new Date(date);
    if (targetDateTime > new Date()) {
      throw new Error('Cannot edit attendance for a future date');
    }

    const attendance = await Attendance.findById(id).populate('employee').session(session);
    if (!attendance || attendance.isDeleted) {
      throw new Error('Attendance record not found');
    }

    const employee = attendance.employee;
    const month = targetDateTime.getMonth() + 1;
    const year = targetDateTime.getFullYear();

    await correctMonthlyLeaves(employee, year, month, session);
    let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, 0, session);

    let leaveAdjustment = 0;
    let monthlyLeaveAdjustment = 0;
    const oldStatus = attendance.status;

    if (oldStatus !== status) {
      if (oldStatus === 'leave') {
        leaveAdjustment += 1;
        monthlyLeaveAdjustment += 1;
      } else if (oldStatus === 'half-day') {
        leaveAdjustment += 0.5;
        monthlyLeaveAdjustment += 0.5;
      }
      if (status === 'leave') {
        if (monthlyLeave.available < 1) {
          throw new Error(`Employee ${employee.name} has insufficient leaves`);
        }
        leaveAdjustment -= 1;
        monthlyLeaveAdjustment -= 1;
      } else if (status === 'half-day') {
        leaveAdjustment -= 0.5;
        monthlyLeaveAdjustment -= 0.5;
      }

      attendance.status = status;
      attendance.editedBy = req.user?._id || null;
      attendance.date = date;
      await attendance.save({ session });

      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        monthlyLeave.taken += -monthlyLeaveAdjustment;
        monthlyLeave.available += monthlyLeaveAdjustment;
        await updateNextMonthCarryforward(employee._id, year, month, monthlyLeave.available, session);

        await Employee.findByIdAndUpdate(
          employee._id,
          {
            $inc: {
              'paidLeaves.available': leaveAdjustment,
              'paidLeaves.used': -leaveAdjustment,
            },
            $set: {
              'monthlyLeaves.$[elem].taken': monthlyLeave.taken,
              'monthlyLeaves.$[elem].available': monthlyLeave.available,
            },
          },
          {
            arrayFilters: [{ 'elem.year': year, 'elem.month': month }],
            session,
            new: true,
          }
        );
      }
    }

    return { message: 'Attendance updated successfully', attendance };
  });

  res.json(result);
};

export const getAttendance = async (req, res) => {
  try {
    const { id: employeeId } = req.params;
    const { month, year, location, date, status, page = 1, limit = 5 } = req.query;

    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedPage) || parsedPage < 1) {
      return res.status(400).json({ message: 'Invalid page number' });
    }
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ message: 'Invalid limit value (must be between 1 and 100)' });
    }

    // ✅ UPDATED: For monthly attendance, paginate EMPLOYEES not attendance records
    if (month && year && !employeeId) {
      // Build employee query first
      const employeeMatch = { isDeleted: false };
      
      if (location && location !== 'all') {
        if (!mongoose.Types.ObjectId.isValid(location)) {
          return res.status(400).json({ message: 'Invalid location ID format' });
        }
        const locationExists = await Location.findById(location).lean();
        if (!locationExists) {
          return res.status(400).json({ message: 'Location not found' });
        }
        employeeMatch.location = new mongoose.Types.ObjectId(location);
      }

      // Get total employee count for pagination
      const totalEmployees = await Employee.countDocuments(employeeMatch);
      const totalPages = Math.ceil(totalEmployees / parsedLimit);
      const skip = (parsedPage - 1) * parsedLimit;

      // Get paginated employees
      const employees = await Employee.find(employeeMatch)
        .populate('location', 'name')
        .sort({ employeeId: 1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean();

      if (employees.length === 0) {
        return res.status(200).json({
          attendance: [],
          pagination: {
            currentPage: parsedPage,
            totalPages,
            totalItems: totalEmployees,
            itemsPerPage: parsedLimit,
          },
        });
      }

      const employeeIds = employees.map(emp => emp._id);

      // Get ALL attendance records for these employees for the entire month
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;
      
      let attendanceMatch = {
        employee: { $in: employeeIds },
        date: { $gte: startStr, $lte: endStr },
        isDeleted: false,
      };

      if (location && location !== 'all') {
        attendanceMatch.location = new mongoose.Types.ObjectId(location);
      }

      if (status && status !== 'all') {
        if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
          return res.status(400).json({ message: 'Invalid status' });
        }
        attendanceMatch.status = status;
      }

      const attendanceRecords = await Attendance.find(attendanceMatch)
        .populate('employee', 'employeeId name')
        .populate('location', 'name')
        .lean();

      // ✅ NEW: Structure the response as array of {employee, attendance[]}
      const employeeAttendanceData = employees.map(employee => ({
        employee: employee,
        attendance: attendanceRecords.filter(att => 
          att.employee._id.toString() === employee._id.toString()
        )
      }));

      // Correct monthly leaves for each employee
      for (const empData of employeeAttendanceData) {
        const employee = await Employee.findById(empData.employee._id);
        if (employee) {
          await correctMonthlyLeaves(employee, yearNum, monthNum, null);
        }
      }

      return res.status(200).json({
        attendance: employeeAttendanceData, // ✅ NEW: Array of {employee, attendance[]}
        pagination: {
          currentPage: parsedPage,
          totalPages,
          totalItems: totalEmployees,
          itemsPerPage: parsedLimit,
        },
      });
    }

    // ✅ EXISTING: Handle single employee or other cases (unchanged)
    const match = { isDeleted: false };

    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json({ message: 'Invalid employee ID format' });
      }
      const employeeExists = await Employee.findById(employeeId).lean();
      if (!employeeExists) {
        return res.status(400).json({ message: 'Employee not found' });
      }
      match.employee = new mongoose.Types.ObjectId(employeeId);
    }

    if (location && location !== 'all') {
      if (!mongoose.Types.ObjectId.isValid(location)) {
        return res.status(400).json({ message: 'Invalid location ID format' });
      }
      const locationExists = await Location.findById(location).lean();
      if (!locationExists) {
        return res.status(400).json({ message: 'Location not found' });
      }
      match.location = new mongoose.Types.ObjectId(location);
    }

    if (date) {
      const inputDate = new Date(date);
      if (isNaN(inputDate.getTime())) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      const dateStr = date.split('T')[0];
      match.date = { $regex: `^${dateStr}`, $options: 'i' };
    } else if (month && year) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;
      match.date = { $gte: startStr, $lte: endStr };
    }

    if (status) {
      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      match.status = status;
    }

    const totalItems = await Attendance.countDocuments(match);
    const totalPages = Math.ceil(totalItems / parsedLimit);
    const skip = (parsedPage - 1) * parsedLimit;

    const attendance = await Attendance.find(match)
      .populate({
        path: 'employee',
        select: 'employeeId name monthlyLeaves',
        match: { isDeleted: { $ne: true } },
        options: { lean: true },
      })
      .populate({
        path: 'location',
        select: 'name',
        options: { lean: true },
      })
      .sort({ date: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean();

    const formattedAttendance = attendance
      .filter((record) => record.employee && record.location)
      .map((record) => ({
        _id: record._id,
        employee: {
          _id: record.employee._id,
          name: record.employee.name || 'Unknown',
          employeeId: record.employee.employeeId || 'N/A',
        },
        location: {
          _id: record.location._id,
          name: record.location.name || 'N/A',
        },
        date: record.date,
        status: record.status,
        isException: record.isException || false,
        exceptionReason: record.exceptionReason,
        exceptionDescription: record.exceptionDescription,
        monthlyLeaves: record.employee.monthlyLeaves.filter(
          (ml) => month && year && ml.year === parseInt(year) && ml.month === parseInt(month)
        ),
      }));

    res.status(200).json({
      attendance: formattedAttendance,
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems,
        itemsPerPage: parsedLimit,
      },
    });
  } catch (error) {
    res.status(500).json({ message: `Server error while fetching attendance: ${error.message}` });
  }
};

// Continue with all remaining existing functions...
export const getAttendanceRequests = async (req, res) => {
  try {
    const { location, date, status, page = 1, limit = 5 } = req.query;

    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedPage) || parsedPage < 1) {
      return res.status(400).json({ message: 'Invalid page number' });
    }
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ message: 'Invalid limit value (must be between 1 and 100)' });
    }

    const match = { status: { $ne: 'deleted' } };

    if (location && location !== 'all') {
      if (!mongoose.Types.ObjectId.isValid(location)) {
        return res.status(400).json({ message: 'Invalid location ID format' });
      }
      const locationExists = await Location.findById(location).lean();
      if (!locationExists) {
        return res.status(400).json({ message: 'Location not found' });
      }
      match.location = new mongoose.Types.ObjectId(location);
    }

    if (date) {
      const inputDate = new Date(date);
      if (isNaN(inputDate.getTime())) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      const dateStr = date.split('T')[0];
      match.date = { $regex: `^${dateStr}`, $options: 'i' };
    }

    if (status && status !== 'all') {
      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      match.status = status;
    }

    const totalItems = await AttendanceRequest.countDocuments(match).exec();
    const totalPages = Math.ceil(totalItems / parsedLimit);
    const skip = (parsedPage - 1) * parsedLimit;

    const requests = await AttendanceRequest.find(match)
      .populate({
        path: 'employee',
        select: 'name employeeId',
        match: { isDeleted: { $ne: true } },
        options: { lean: true },
      })
      .populate({
        path: 'location',
        select: 'name',
        options: { lean: true },
      })
      .sort({ date: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean();

    const requestsWithCurrentStatus = await Promise.all(
      requests.map(async (request) => {
        if (!request.employee || !request.location) {
          return {
            ...request,
            currentStatus: 'N/A',
          };
        }

        const dateOnlyStr = request.date.split('T')[0];
        const attendance = await Attendance.findOne({
          employee: request.employee._id,
          location: request.location._id,
          date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
          isDeleted: { $ne: true },
        }).lean();

        return {
          ...request,
          currentStatus: attendance ? attendance.status : 'N/A',
        };
      })
    );

    res.status(200).json({
      attendanceRequests: requestsWithCurrentStatus,
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems,
        itemsPerPage: parsedLimit,
      },
    });
  } catch (error) {
    res.status(500).json({ message: `Server error while fetching attendance requests: ${error.message}` });
  }
};

export const handleAttendanceRequest = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { status, date } = req.body;

    if (!status || !['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Valid status is required (approved, rejected)' });
    }

    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
    if (!date || !dateRegex.test(date)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Valid ISO 8601 date string is required' });
    }

    const targetDateTime = new Date(date);
    if (targetDateTime > new Date()) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Cannot handle request for a future date' });
    }

    const request = await AttendanceRequest.findById(id).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Attendance request not found' });
    }

    request.status = status;
    request.reviewedAt = new Date();
    request.reviewedBy = req.user?._id || null;
    await request.save({ session });

    if (status === 'approved') {
      const dateOnlyStr = date.split('T')[0];
      const attendance = await Attendance.findOne({
        employee: request.employee,
        location: request.location,
        date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
        isDeleted: { $ne: true },
      }).populate('employee').session(session);

      if (attendance) {
        const employee = attendance.employee;
        const oldStatus = attendance.status;
        const newStatus = request.requestedStatus;
        const year = targetDateTime.getFullYear();
        const month = targetDateTime.getMonth() + 1;
        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const prevMonthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === prevYear && ml.month === prevMonth
        );
        const prevAvailable = prevMonthlyLeave?.available || 0;

        let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, prevAvailable);

        if (oldStatus !== newStatus) {
          let leaveAmount = 0;
          let monthlyLeaveAmount = 0;

          if (oldStatus === 'leave') {
            leaveAmount += 1;
            monthlyLeaveAmount += 1;
          }

          if (newStatus === 'leave') {
            if (monthlyLeave.available < 1) {
              await session.abortTransaction();
              return res.status(400).json({ message: `Employee ${employee.name} has insufficient leaves` });
            }
            leaveAmount -= 1;
            monthlyLeaveAmount -= 1;
          }

          attendance.status = newStatus;
          attendance.editedBy = req.user?._id || null;
          attendance.date = date;
          await attendance.save({ session });

          if (leaveAmount !== 0 || monthlyLeaveAmount !== 0) {
            monthlyLeave.taken += -monthlyLeaveAmount;
            monthlyLeave.available += monthlyLeaveAmount;
            await updateNextMonthCarryforward(employee._id, year, month, monthlyLeave.available);

            await Employee.findByIdAndUpdate(
              employee._id,
              {
                $inc: {
                  'paidLeaves.available': leaveAmount,
                  'paidLeaves.used': -leaveAmount,
                },
                $set: {
                  'monthlyLeaves.$[elem].taken': monthlyLeave.taken,
                  'monthlyLeaves.$[elem].available': monthlyLeave.available,
                },
              },
              {
                arrayFilters: [{ 'elem.year': year, 'elem.month': month }],
                session,
                new: true,
              }
            );
          }
        }
      }
    }

    await session.commitTransaction();
    res.json({ message: `Request ${status} successfully`, request });
  } catch (error) {
    await session.abortTransaction();
  
    res.status(500).json({ message: 'Server error while handling attendance request' });
  } finally {
    session.endSession();
  }
};

export const requestAttendanceEdit = async (req, res) => {
  try {
    const { attendanceId, requestedStatus, reason, date } = req.body;

    if (!attendanceId || !requestedStatus || !reason || !date) {
      return res.status(400).json({
        message: 'Attendance ID, requested status, reason, and date are required',
      });
    }

    if (!['present', 'absent', 'leave', 'half-day'].includes(requestedStatus)) {
      return res.status(400).json({
        message: 'Invalid requested status (present, absent, leave, half-day)',
      });
    }

    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ message: 'Invalid ISO 8601 date string' });
    }

    const targetDateTime = new Date(date);
    if (targetDateTime > new Date()) {
      return res.status(400).json({ message: 'Cannot request edit for a future date' });
    }

    const attendance = await Attendance.findById(attendanceId);
    if (!attendance || attendance.isDeleted) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const request = new AttendanceRequest({
      employee: attendance.employee,
      location: attendance.location,
      date,
      requestedStatus,
      reason,
      status: 'pending',
      requestedBy: req.user?._id || null,
      createdAt: new Date(),
    });

    await request.save();
    res.status(201).json(request);
  } catch (error) {
    res.status(500).json({ message: 'Server error while requesting attendance edit' });
  }
};

export const exportAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
    const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;

    const match = {
      date: { $gte: startStr, $lte: endStr },
      isDeleted: { $ne: true },
    };

    if (location) {
      const locationExists = await Location.findById(location);
      if (!locationExists) {
        return res.status(400).json({ message: 'Invalid location ID' });
      }
      match.location = location;
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .lean();

    const csvData = attendance.map((record) => ({
      Employee: `${record.employee?.name || 'Unknown'} (${record.employee?.employeeId || 'N/A'})`,
      Location: record.location?.name || 'N/A',
      Date: record.date,
      Status: record.status.charAt(0).toUpperCase() + record.status.slice(1),
      Exception: record.isException ? 'Yes' : 'No',
      ExceptionReason: record.exceptionReason || 'N/A',
    }));

    const csvHeaders = ['Employee', 'Location', 'Date', 'Status', 'Exception', 'ExceptionReason'];
    const csvRows = [csvHeaders.join(',')];
    csvData.forEach((row) => {
      const values = csvHeaders.map((header) => `"${row[header]}"`);
      csvRows.push(values.join(','));
    });

    const csvContent = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=attendance_${month}_${year}.csv`
    );
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ message: 'Server error while exporting attendance' });
  }
};
