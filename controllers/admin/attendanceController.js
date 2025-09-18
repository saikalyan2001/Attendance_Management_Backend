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

// ✅ COMPLETE: Working carry forward with finalization checks
async function updateCarryForwardsWithFinalization() {

  
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Get all active employees
    const employees = await Employee.find({ 
      status: 'active', 
      isDeleted: { $ne: true } 
    }).session(session);
    
    let processedEmployees = 0;
    let totalCarryForwards = 0;
    
    for (const employee of employees) {

      
      // Sort monthly leaves chronologically
      employee.monthlyLeaves.sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.month - b.month;
      });
      
      let hasChanges = false;
      
      // Process each month for carry forward
      for (let i = 1; i < employee.monthlyLeaves.length; i++) {
        const currentMonth = employee.monthlyLeaves[i];
        const previousMonth = employee.monthlyLeaves[i - 1];
        
        // ✅ CONDITION 1: Previous month must be finalized
        if (!previousMonth.isFinalized) {

          continue;
        }
        
        // ✅ CONDITION 2: Don't carry forward across years (January reset)
        if (previousMonth.month === 12 && currentMonth.month === 1) {
          if (currentMonth.carriedForward !== 0) {
            currentMonth.carriedForward = 0;
            currentMonth.available = currentMonth.allocated - currentMonth.taken;
            hasChanges = true;

          }
          continue;
        }
        
        // ✅ CONDITION 3: Check if employee had attendance in previous month
        const hasAttendance = await hasAttendanceInMonth(
          employee._id, 
          previousMonth.year, 
          previousMonth.month
        );
        
        if (!hasAttendance) {
          if (currentMonth.carriedForward !== 0) {
            currentMonth.carriedForward = 0;
            currentMonth.available = currentMonth.allocated - currentMonth.taken;
            hasChanges = true;

          }
          continue;
        }
        
        // ✅ CONDITION 4: Calculate carry forward amount (max 6 leaves)
        const carryForwardAmount = Math.min(Math.max(previousMonth.available, 0), 6);
        
        if (currentMonth.carriedForward !== carryForwardAmount) {
          currentMonth.carriedForward = carryForwardAmount;
          currentMonth.available = currentMonth.allocated + carryForwardAmount - currentMonth.taken;
          hasChanges = true;
          totalCarryForwards++;
          

        }
      }
      
      // Save employee if changes were made
      if (hasChanges) {
        await employee.save({ session });
        processedEmployees++;
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



// ✅ COMPLETE: Process carry forward for individual employee
async function processEmployeeCarryForward(employee, session) {

  
  // Sort monthly leaves chronologically
  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
  
  let carryForwardCount = 0;
  let hasChanges = false;
  
  for (let i = 1; i < employee.monthlyLeaves.length; i++) {
    const currentMonth = employee.monthlyLeaves[i];
    const previousMonth = employee.monthlyLeaves[i - 1];
    
    // ✅ CARRY FORWARD CONDITIONS
    const shouldCarryForward = await checkCarryForwardConditions(
      employee._id, 
      previousMonth, 
      currentMonth, 
      session
    );
    
    if (shouldCarryForward.eligible) {
      const carryForwardAmount = shouldCarryForward.amount;
      
      // Update current month with carry forward
      if (currentMonth.carriedForward !== carryForwardAmount) {
        currentMonth.carriedForward = carryForwardAmount;
        currentMonth.available = currentMonth.allocated + carryForwardAmount - currentMonth.taken;
        hasChanges = true;
        carryForwardCount++;
        

      }
    }
  }
  
  // Save employee if changes were made
  if (hasChanges) {
    await employee.save({ session });
  }
  
  return {
    processed: hasChanges,
    carryForwardCount
  };
}


// ✅ COMPLETE: Carry forward conditions and business rules
async function checkCarryForwardConditions(employeeId, previousMonth, currentMonth, session) {
  // ✅ RULE 1: Previous month must be finalized
  if (!previousMonth.isFinalized) {
    return { eligible: false, reason: 'Previous month not finalized' };
  }
  
  // ✅ RULE 2: Don't carry forward across years (reset in January)
  if (previousMonth.month === 12 && currentMonth.month === 1) {

    return { eligible: true, amount: 0, reason: 'Year reset' };
  }
  
  // ✅ RULE 3: Check if employee had attendance in previous month
  const hasAttendance = await hasAttendanceInMonth(employeeId, previousMonth.year, previousMonth.month);
  if (!hasAttendance) {
    return { eligible: false, reason: 'No attendance in previous month' };
  }
  
  // ✅ RULE 4: Calculate available leaves from previous month
  const previousAvailable = Math.max(0, previousMonth.available);
  
  // ✅ RULE 5: Only carry forward if there are unused leaves
  if (previousAvailable <= 0) {
    return { eligible: true, amount: 0, reason: 'No unused leaves to carry forward' };
  }
  
  // ✅ RULE 6: Apply carry forward limits (optional)
  const maxCarryForward = 6; // Maximum 6 leaves can be carried forward
  const carryForwardAmount = Math.min(previousAvailable, maxCarryForward);
  
  return {
    eligible: true,
    amount: carryForwardAmount,
    reason: `Carrying forward ${carryForwardAmount} leaves`
  };
}


// ✅ ADD: Debug function to track date processing
function debugAttendanceDate(originalDate, extractedMonth, extractedYear, context = '') {}

// ✅ UTILITY: Get next month
function getNextMonth(year, month) {
  if (month === 12) {
    return { year: year + 1, month: 1 };
  }
  return { year, month: month + 1 };
}

// ✅ UTILITY: Process carry forward for specific month
async function processCarryForwardForMonth(employee, year, month, session) {
  const currentMonth = employee.monthlyLeaves.find(ml => 
    ml.year === year && ml.month === month
  );
  
  const previousMonth = employee.monthlyLeaves.find(ml => {
    if (month === 1) {
      return ml.year === year - 1 && ml.month === 12;
    }
    return ml.year === year && ml.month === month - 1;
  });
  
  if (currentMonth && previousMonth) {
    const shouldCarryForward = await checkCarryForwardConditions(
      employee._id, 
      previousMonth, 
      currentMonth, 
      session
    );
    
    if (shouldCarryForward.eligible && shouldCarryForward.amount !== currentMonth.carriedForward) {
      currentMonth.carriedForward = shouldCarryForward.amount;
      currentMonth.available = currentMonth.allocated + shouldCarryForward.amount - currentMonth.taken;
      
      await employee.save({ session });
      

    }
  }
}

// ✅ FIXED: Automatic month finalization when attendance is marked
// ✅ UPDATED: finalizeMonthIfNeeded function (works with or without session)
async function finalizeMonthIfNeeded(employeeId, year, month, session = null) {
  try {

    
    // ✅ Use session if provided, otherwise work without session
    let employee;
    if (session) {
      employee = await Employee.findById(employeeId).session(session);
    } else {
      employee = await Employee.findById(employeeId);
    }
    
    if (!employee) {

      return false;
    }
    
    // Find the target monthly leave record
    const monthlyLeave = employee.monthlyLeaves.find(ml => 
      ml.year === year && ml.month === month
    );
    
    if (!monthlyLeave) {

      return false;
    }
    
    // Skip if already finalized
    if (monthlyLeave.isFinalized) {

      return true;
    }
    
    // ✅ CRITICAL: Check if attendance exists for this month (no session needed here)
    const hasAttendance = await hasAttendanceInMonth(employeeId, year, month);
    
    if (hasAttendance) {
      // ✅ FINALIZE THE MONTH
      monthlyLeave.isFinalized = true;
      monthlyLeave.finalizedAt = new Date();
      
      // ✅ Save with or without session
      if (session) {
        await employee.save({ session });
      } else {
        await employee.save();
      }
      

      return true;
    }
    

    return false;
    
  } catch (error) {
    return false;
  }
}




// ✅ SIMPLER: Process carry forwards after main transaction (outside session)
async function updateCarryForwardsSimple(carryForwardUpdates) {

  
  for (const update of carryForwardUpdates) {
    const { employeeId, year, month, newAvailable } = update;
    
    try {
      const employee = await Employee.findById(employeeId);
      if (!employee) continue;

      // ✅ CHECK: Only carry forward if current month is finalized
      const currentMonthLeave = employee.monthlyLeaves.find(
        ml => ml.year === year && ml.month === month
      );

      if (!currentMonthLeave || !currentMonthLeave.isFinalized) {

        continue;
      }

      // Calculate next month
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      
      // ✅ Carry forward logic (reset to 0 in January)
      const carriedForward = (month === 12) ? 0 : Math.max(newAvailable, 0);
      
      // Update next month's carry forward
      await Employee.updateOne(
        {
          _id: employeeId,
          'monthlyLeaves.year': nextYear,
          'monthlyLeaves.month': nextMonth
        },
        {
          $set: {
            'monthlyLeaves.$.carriedForward': carriedForward
          }
        }
      );

      // Recalculate available balance
      const nextMonthLeave = employee.monthlyLeaves.find(
        ml => ml.year === nextYear && ml.month === nextMonth
      );
      
      if (nextMonthLeave) {
        nextMonthLeave.available = nextMonthLeave.allocated + carriedForward - nextMonthLeave.taken;
        await employee.save();
      }


      
    } catch (error) {
    }
  }
}

// ✅ ADD: Validation function at the top of your controller file
function validateMonthlyLeaveConsistency(employee, targetYear, targetMonth) {

  
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  



  
  if (employee.monthlyLeaves) {
    employee.monthlyLeaves.forEach((ml, index) => {
      const isTarget = ml.year === targetYear && ml.month === targetMonth;

    });
  }
  
  const targetRecord = employee.monthlyLeaves?.find(ml => 
    ml.year === targetYear && ml.month === targetMonth
  );
  
  if (!targetRecord) {

  } else {

  }
}

// ✅ ENHANCED: Mark employees as prorated during initialization
async function initializeMonthlyLeavesForEmployee(employee, settings) {
  if (!employee.monthlyLeaves || employee.monthlyLeaves.length === 0) {

    
    const joinDate = new Date(employee.joinDate);
    const joinYear = joinDate.getFullYear();
    const joinMonth = joinDate.getMonth() + 1;
    
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;
    
    const endYear = currentYear;
    const endMonth = Math.max(currentMonth + 2, 12);

    // ✅ CALCULATE: Prorated allocation for mid-year joiners
    let totalAllocation;
    let monthlyAllocation;
    const fullYearLeaves = (settings?.paidLeavesPerYear || 24);
    
    if (joinMonth > 1) {
      // ✅ PRORATED: Calculate based on remaining months in join year
      const remainingMonths = 13 - joinMonth;
      totalAllocation = (fullYearLeaves / 12) * remainingMonths;
      monthlyAllocation = totalAllocation / remainingMonths;    } else {
      // ✅ FULL YEAR: January joiner gets full allocation
      totalAllocation = fullYearLeaves;
      monthlyAllocation = fullYearLeaves / 12;
    }

    employee.monthlyLeaves = [];
    
    // Create records for each month from join date
    for (let y = joinYear; y <= endYear; y++) {
      const startMonth = y === joinYear ? joinMonth : 1;
      const finalEndMonth = y === endYear ? endMonth : 12;
      
      for (let m = startMonth; m <= finalEndMonth; m++) {
        // ✅ Use calculated monthly allocation (prorated for join year)
        const allocation = (y === joinYear) ? monthlyAllocation : (fullYearLeaves / 12);
        
        const monthlyLeave = {
          year: y,
          month: m,
          allocated: allocation,
          taken: 0,
          carriedForward: 0,
          available: allocation,
          isFinalized: false,
          finalizedAt: null
        };
        
        employee.monthlyLeaves.push(monthlyLeave);
      }
    }
    
    // ✅ SET: Prorated paidLeaves allocation
    employee.set('paidLeaves.allocated', totalAllocation);
    employee.set('paidLeaves.available', totalAllocation);
    employee.set('paidLeaves.used', 0);
    


    
    return true;
  }
  return false;
}


// ✅ NEW: Function to detect and preserve prorated employees
function isEmployeeProrated(employee, settings) {
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  
  // Employee is prorated if they joined mid-year in their first year
  const isFirstYear = joinYear === currentYear || (currentYear - joinYear === 0);
  const joinedMidYear = joinMonth > 1;
  
  const fullYearAllocation = settings?.paidLeavesPerYear || 24;
  const currentAllocation = employee.paidLeaves?.allocated || 0;
  
  // Check if current allocation is less than full year (indicating prorated)
  const hasReducedAllocation = currentAllocation < fullYearAllocation;  return isFirstYear && joinedMidYear && hasReducedAllocation;
}


// ✅ FIXED: getISTDateComponents helper function
function getISTDateComponents(date) {
  const dateObj = new Date(date);
  const month = dateObj.getMonth() + 1;
  const year = dateObj.getFullYear();
  return { month, year };
}



// ✅ NEW FUNCTION: Batch validation
async function batchValidateAttendance(attendanceRecords, employeeMap, locationMap, settings) {
  const validRecords = [];
  const errors = [];
  const warnings = [];

  for (const record of attendanceRecords) {
    const { employeeId, date, status, location, isException, exceptionReason, exceptionDescription } = record;

    // Basic validation
    if (!employeeId || !date || !status || !location) {
      errors.push({ message: `Missing required fields for employee ${employeeId}` });
      continue;
    }

    if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
      errors.push({ message: `Invalid status '${status}' for employee '${employeeId}'` });
      continue;
    }

    const employee = employeeMap.get(employeeId);
    const locationObj = locationMap.get(location);

    if (!employee) {
      errors.push({ message: `Employee ${employeeId} not found` });
      continue;
    }

    if (!locationObj) {
      errors.push({ message: `Location ${location} not found` });
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
    if (targetDateTime > new Date()) {
      errors.push({ message: `Cannot mark attendance for future date ${date} for employee ${employeeId}` });
      continue;
    }

    // Working day validation
    const validation = await validateAttendanceDate(employeeId, normalizedDate, isException);
    
    if (!validation.canMarkAttendance) {
      errors.push({
        message: `Cannot mark attendance for ${employee.name} on ${normalizedDate.split('T')[0]} - ${validation.policyInfo.policyName} excludes this day. Use exception marking if needed.`
      });
      continue;
    }

    if (validation.requiresException && !isException) {
      warnings.push({
        employeeId,
        employeeName: employee.name,
        date: normalizedDate.split('T')[0],
        policyInfo: validation.policyInfo,
        message: `${employee.name}: ${normalizedDate.split('T')[0]} is not a working day per ${validation.policyInfo.policyName}. Consider marking as exception.`
      });
    }

    // Exception validation
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

    validRecords.push({
      ...record,
      normalizedDate,
      employee,
      locationObj,
      targetDateTime
    });
  }

  return { validRecords, errors, warnings };
}

// ✅ NEW FUNCTION: Bulk check existing records
async function checkExistingRecordsBulk(validRecords, overwrite) {
  // Create bulk query for all date checks
  const dateQueries = validRecords.map(record => {
    const dateOnlyStr = record.normalizedDate.split('T')[0];
    return {
      employee: record.employeeId,
      location: record.location,
      date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
      isDeleted: false,
    };
  });

  // Single query to get all existing records
  const existingAttendance = await Attendance.find({
    $or: dateQueries
  }).lean();

  // Create lookup map for fast access
  const existingMap = new Map();
  existingAttendance.forEach(att => {
    const key = `${att.employee}_${att.location}_${att.date.split('T')[0]}`;
    existingMap.set(key, att);
  });

  const conflicts = [];
  const processableRecords = [];

  for (const record of validRecords) {
    const key = `${record.employeeId}_${record.location}_${record.normalizedDate.split('T')[0]}`;
    const existing = existingMap.get(key);

    if (existing && !overwrite) {
      conflicts.push({
        employeeId: record.employeeId,
        date: existing.date,
        status: existing.status,
      });
    } else {
      processableRecords.push({ ...record, existingRecord: existing });
    }
  }

  return { conflicts, processableRecords };
}

// ✅ NEW FUNCTION: Optimized bulk processing
// ✅ FIXED: Proper transaction flow without duplicates
async function processAttendanceBulkOptimized(records, settings, userId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Group records by employee for batch processing
    const employeeGroups = new Map();
    for (const record of records) {
      if (!employeeGroups.has(record.employeeId)) {
        employeeGroups.set(record.employeeId, []);
      }
      employeeGroups.get(record.employeeId).push(record);
    }

    // Pre-load all employees with session
    const employeeIds = [...employeeGroups.keys()];
    const employeesData = await Employee.find({ _id: { $in: employeeIds } }).session(session);
    const employeesMap = new Map(employeesData.map(emp => [emp._id.toString(), emp]));

    // Batch process attendance records
    const attendanceOps = [];
    const employeeUpdates = new Map();
    const monthsToFinalize = new Set(); // ✅ NEW: Track months to finalize

    for (const [employeeId, employeeRecords] of employeeGroups) {
      const employee = employeesMap.get(employeeId);
      if (!employee) continue;

      const monthlyUpdates = await processEmployeeAttendanceBatch(
        employee, 
        employeeRecords, 
        settings, 
        session
      );

      employeeUpdates.set(employeeId, monthlyUpdates);

      // Prepare attendance operations
      for (const record of employeeRecords) {
        const attendanceDoc = createAttendanceDocument(record, userId);
        
        if (record.existingRecord) {
          attendanceOps.push({
            updateOne: {
              filter: { _id: record.existingRecord._id },
              update: { $set: attendanceDoc },
              session
            }
          });
        } else {
          attendanceOps.push({
            insertOne: { 
              document: {
                ...attendanceDoc,
                _id: new mongoose.Types.ObjectId()
              }
            }
          });
        }

        // ✅ NEW: Collect months to finalize
        const { month, year } = getISTDateComponents(record.normalizedDate);
        monthsToFinalize.add(`${employeeId}-${year}-${month}`);
      }
    }

    // Execute all attendance operations in bulk
    let attendanceResults = { insertedIds: [], modifiedCount: 0 };
    if (attendanceOps.length > 0) {
      attendanceResults = await Attendance.bulkWrite(attendanceOps, { 
        session, 
        ordered: false 
      });
    }

    // ✅ NEW: Finalize months after attendance is marked

    for (const monthKey of monthsToFinalize) {
      const [employeeId, year, month] = monthKey.split('-');
      await finalizeMonthIfNeeded(employeeId, parseInt(year), parseInt(month), session);
    }

    // Update employee leave balances
    const carryForwardUpdates = await bulkUpdateEmployees(employeeUpdates, session);

    // Update monthly presence for all affected employees
    await updateMonthlyPresenceBulk(employeeGroups, settings, session);

    // Commit transaction first
    await session.commitTransaction();


    // ✅ UPDATED: Process carry forwards (only for finalized months)
    if (carryForwardUpdates && carryForwardUpdates.length > 0) {
      try {
        await updateCarryForwardsBulk(carryForwardUpdates);

      } catch (carryForwardError) {
      }
    }

    // Collect all attendance IDs
    const attendanceIds = [
      ...Object.values(attendanceResults.insertedIds || {}),
      ...records
        .filter(r => r.existingRecord)
        .map(r => r.existingRecord._id.toString())
    ];

    return { attendanceIds };

  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}


// ✅ NEW FUNCTION: Process all attendance for one employee in batch
// ✅ FIXED: processEmployeeAttendanceBatch
async function processEmployeeAttendanceBatch(employee, records, settings, session) {
  // ✅ PROTECT: Mark as prorated to prevent override
  const wasProrated = isEmployeeProrated(employee, settings);
  if (wasProrated) {
    employee.isManualPaidLeavesUpdate = true; // Prevent automatic recalculation

  }

  const monthlyUpdates = new Map();
  const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;


  const monthGroups = new Map();
  for (const record of records) {
    // ✅ CRITICAL: Use IST date extraction consistently
    const { month, year } = getISTDateComponents(record.normalizedDate);
    const key = `${year}-${month}`;
    

    
    if (!monthGroups.has(key)) {
      monthGroups.set(key, { year, month, records: [] });
    }
    monthGroups.get(key).records.push(record);
  }

  // Process each month's attendance in batch
  for (const [monthKey, { year, month, records: monthRecords }] of monthGroups) {

    
    // ✅ CRITICAL FIX: Find monthly leave by EXACT year and month match
    let monthlyLeave = employee.monthlyLeaves.find(ml => 
      ml.year === year && ml.month === month
    );
    
    if (!monthlyLeave) {

      
      // ✅ ENHANCED: Proper monthly leave creation with join date validation
      const joinDate = new Date(employee.joinDate);
      const recordDate = new Date(year, month - 1, 1);
      
      // Only create if employee was active during this month
      if (recordDate >= joinDate) {
        monthlyLeave = {
          year,
          month,
          allocated: paidLeavesPerMonth,
          taken: 0,
          carriedForward: 0,
          available: paidLeavesPerMonth,
          isFinalized: false,
          finalizedAt: null
        };
        employee.monthlyLeaves.push(monthlyLeave);
        
        // Sort monthly leaves chronologically
        employee.monthlyLeaves.sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          return a.month - b.month;
        });
      } else {

        continue;
      }
    }

    // Calculate total leave adjustments for this month
    let totalLeaveAdjustment = 0;
    let totalMonthlyAdjustment = 0;

    for (const record of monthRecords) {

      
      // Handle existing record adjustments
      if (record.existingRecord) {
        const oldStatus = record.existingRecord.status;
        if (oldStatus === 'leave') {
          totalLeaveAdjustment += 1;
          totalMonthlyAdjustment += 1;
        } else if (oldStatus === 'half-day') {
          totalLeaveAdjustment += 0.5;
          totalMonthlyAdjustment += 0.5;
        }
      }

      // Handle new status adjustments
      if (record.status === 'leave') {
        const availableAfterAdjustment = monthlyLeave.available + totalMonthlyAdjustment;
        if (availableAfterAdjustment < 1) {
          throw new Error(`Employee ${employee.name} has insufficient leaves (${availableAfterAdjustment}) for month ${month}/${year}`);
        }
        totalLeaveAdjustment -= 1;
        totalMonthlyAdjustment -= 1;

      } else if (record.status === 'half-day') {
        totalLeaveAdjustment -= 0.5;
        totalMonthlyAdjustment -= 0.5;

      }
    }

   // ✅ FIXED: Add capping logic during leave deduction
if (totalMonthlyAdjustment !== 0) {
  const rawNewTaken = Math.max(0, monthlyLeave.taken - totalMonthlyAdjustment);
  const totalAvailableForMonth = (monthlyLeave.allocated || 0) + (monthlyLeave.carriedForward || 0);
  
  // ✅ Cap taken at available allocation
  const cappedTaken = Math.min(rawNewTaken, totalAvailableForMonth);
  const unpaidUsage = Math.max(0, rawNewTaken - totalAvailableForMonth);
  

  
  monthlyUpdates.set(monthKey, {
    year,
    month,
    leaveAdjustment: totalLeaveAdjustment,
    monthlyAdjustment: totalMonthlyAdjustment,
    newTaken: cappedTaken, // ✅ Capped at 4.0
    newAvailable: Math.max(0, totalAvailableForMonth - cappedTaken),
    unpaidUsage: unpaidUsage, // ✅ Track 0.5 as unpaid
    rawTaken: rawNewTaken // Keep for debugging
  });
  
  // ✅ Update the monthly leave record with capped values
  monthlyLeave.taken = cappedTaken;
  monthlyLeave.available = Math.max(0, totalAvailableForMonth - cappedTaken);
  
  // ✅ Store unpaid usage in a new field (optional)
  if (!monthlyLeave.unpaidUsage) monthlyLeave.unpaidUsage = 0;
  monthlyLeave.unpaidUsage = unpaidUsage;
}

  }

   if (wasProrated) {
    employee.isManualPaidLeavesUpdate = false;
  }

  return monthlyUpdates;
}


// ✅ NEW FUNCTION: Optimized monthly leave initialization
// ✅ FIXED: Proper carry forward initialization
function initializeMonthlyLeavesOptimized(employee, year, month, paidLeavesPerMonth) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  
  // Find previous month's available balance
  const prevMonthlyLeave = employee.monthlyLeaves.find(
    ml => ml.year === prevYear && ml.month === prevMonth
  );
  
  // ✅ FIXED: Only carry forward if previous month exists and has actual available balance
  const carriedForward = prevMonthlyLeave ? Math.max(prevMonthlyLeave.available, 0) : 0;
  
  // ✅ FIXED: Reset carry forward in January (year boundary)
  const finalCarriedForward = (prevMonth === 12) ? 0 : carriedForward;
  
  const monthlyLeave = {
    year,
    month,
    allocated: paidLeavesPerMonth,  // Always 2.0
    taken: 0,
    carriedForward: finalCarriedForward,  // ✅ Correct logic
    available: paidLeavesPerMonth + finalCarriedForward, // ✅ Correct total
  };

  employee.monthlyLeaves.push(monthlyLeave);
  return monthlyLeave;
}


// ✅ FIXED: Bulk update carry forwards for next months (no pipeline + arrayFilters mix)
async function updateCarryForwardsBulk(carryForwardUpdates, session) {
  const nextMonthUpdates = [];

  for (const update of carryForwardUpdates) {
    const { employeeId, year, month, newAvailable } = update;
    
    // Calculate next month
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    
    // ✅ Carry forward logic (reset to 0 in January)
    const carriedForward = (month === 12) ? 0 : Math.max(newAvailable, 0);
    

    
    // ✅ FIXED: Use traditional update syntax (no pipeline)
    nextMonthUpdates.push({
      updateOne: {
        filter: {
          _id: employeeId,
          'monthlyLeaves.year': nextYear,
          'monthlyLeaves.month': nextMonth
        },
        update: {
          $set: {
            'monthlyLeaves.$.carriedForward': carriedForward
          }
        }
      }
    });

    // ✅ FIXED: Separate operation to recalculate available balance
    nextMonthUpdates.push({
      updateOne: {
        filter: {
          _id: employeeId,
          'monthlyLeaves.year': nextYear,
          'monthlyLeaves.month': nextMonth
        },
        update: [{ // ✅ Pipeline style (no arrayFilters)
          $set: {
            'monthlyLeaves': {
              $map: {
                input: '$monthlyLeaves',
                as: 'ml',
                in: {
                  $cond: {
                    if: {
                      $and: [
                        { $eq: ['$$ml.year', nextYear] },
                        { $eq: ['$$ml.month', nextMonth] }
                      ]
                    },
                    then: {
                      $mergeObjects: [
                        '$$ml',
                        {
                          available: {
                            $subtract: [
                              { $add: ['$$ml.allocated', carriedForward] },
                              '$$ml.taken'
                            ]
                          }
                        }
                      ]
                    },
                    else: '$$ml'
                  }
                }
              }
            }
          }
        }]
      }
    });
  }

  // ✅ Execute carry forward updates
  if (nextMonthUpdates.length > 0) {
    try {
      await Employee.bulkWrite(nextMonthUpdates, { session, ordered: false });

    } catch (error) {
      // Don't throw - carry forwards can be fixed later
    }
  }
}



// ✅ UPDATED: Return carry forward updates instead of processing them in transaction
async function bulkUpdateEmployees(employeeUpdates, session) {
  const bulkOps = [];
  const carryForwardUpdates = [];

  for (const [employeeId, monthlyUpdates] of employeeUpdates) {
    let totalPaidLeaveAdjustment = 0;

    // Process monthly leave updates
    for (const [monthKey, update] of monthlyUpdates) {
      totalPaidLeaveAdjustment += update.leaveAdjustment;
      
      bulkOps.push({
        updateOne: {
          filter: { 
            _id: employeeId,
            'monthlyLeaves.year': update.year,
            'monthlyLeaves.month': update.month
          },
          update: {
            $set: {
              'monthlyLeaves.$.taken': update.newTaken,
              'monthlyLeaves.$.available': update.newAvailable
            }
          }
        }
      });

      // ✅ Collect carry forward updates for post-processing
      carryForwardUpdates.push({
        employeeId,
        year: update.year,
        month: update.month,
        newAvailable: update.newAvailable
      });
    }

    // Update paid leaves if not manually managed
    if (totalPaidLeaveAdjustment !== 0) {
      bulkOps.push({
        updateOne: {
          filter: { 
            _id: employeeId, 
            isManualPaidLeavesUpdate: { $ne: true } 
          },
          update: {
            $inc: {
              'paidLeaves.available': totalPaidLeaveAdjustment,
              'paidLeaves.used': -totalPaidLeaveAdjustment
            }
          }
        }
      });
    }
  }

  // ✅ Execute initial updates
  if (bulkOps.length > 0) {
    await Employee.bulkWrite(bulkOps, { session, ordered: false });
  }

  // ✅ Return carry forward updates for post-processing
  return carryForwardUpdates;
}


// ✅ NEW FUNCTION: Streamlined attendance document creation
function createAttendanceDocument(record, userId) {
  let presenceDays = 0;
  if (record.status === 'present') presenceDays = 1.0;
  else if (record.status === 'half-day') presenceDays = 0.5;
  else if (record.status === 'leave') presenceDays = 1.0;

  return {
    employee: record.employeeId,
    date: record.normalizedDate,
    status: record.status,
    location: record.location,
    markedBy: userId,
    presenceDays,
    isException: record.isException || false,
    exceptionReason: record.exceptionReason,
    exceptionDescription: record.exceptionDescription,
    approvedBy: record.isException ? userId : undefined,
  };
}

// ✅ NEW FUNCTION: Bulk update monthly presence
// ✅ FIXED: updateMonthlyPresenceBulk
async function updateMonthlyPresenceBulk(employeeGroups, settings, session) {
  const presenceUpdates = [];

  for (const [employeeId, records] of employeeGroups) {
    const monthGroups = new Map();
    
    // Group by month using IST date extraction
    for (const record of records) {
      // ✅ FIXED: Use IST date extraction instead of UTC
      const { month, year } = getISTDateComponents(record.normalizedDate);
      const key = `${year}-${month}`;
      

      
      if (!monthGroups.has(key)) {
        monthGroups.set(key, { year, month });
      }
    }

    // Create update operations for each affected month
    for (const [monthKey, { year, month }] of monthGroups) {
      presenceUpdates.push({
        updateOne: {
          filter: { 
            _id: employeeId,
            'monthlyPresence.year': year,
            'monthlyPresence.month': month
          },
          update: {
            $set: {
              'monthlyPresence.$.lastUpdated': new Date()
            }
          },
          upsert: false
        }
      });
    }
  }

  if (presenceUpdates.length > 0) {
    await Employee.bulkWrite(presenceUpdates, { session, ordered: false });
  }
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


// ✅ FIXED: correctMonthlyLeaves function with prorated leave preservation
async function correctMonthlyLeaves(employee, year, month, session) {

    
    let paidLeavesPerMonth = 2;
    let settings = null;
    
    try {
        settings = await Settings.findOne().lean().session(session);
        paidLeavesPerMonth = settings?.paidLeavesPerYear / 12 || 2;
    } catch (e) {

        settings = { paidLeavesPerYear: 24 };
        paidLeavesPerMonth = 2;
    }

    // CRITICAL FIX: Enhanced prorated detection
    const joinDate = new Date(employee.joinDate);
    const joinYear = joinDate.getFullYear();
    const joinMonth = joinDate.getMonth() + 1;
    const fullYearAllocation = settings?.paidLeavesPerYear || 24;
    
    // Get current stored allocation
    const currentAllocated = employee.paidLeaves?.allocated || 0;
    
    // ENHANCED: Multiple indicators for prorated employees
    const joinedMidYear = joinMonth > 1 && joinYear === year; // Fixed: Use parameter year
    const hasReducedAllocation = currentAllocated > 0 && currentAllocated < fullYearAllocation;
    const isProratedFlag = employee.isProratedEmployee === true;
    
    // Comprehensive prorated detection
    const isProrated = joinedMidYear || hasReducedAllocation || isProratedFlag;    // Calculate total taken from monthly leaves
    let totalTaken = 0;
    employee.monthlyLeaves.forEach(ml => {
        totalTaken += (ml.taken || 0);
    });

    // CRITICAL FIX: Use correct allocation base for available calculation
    if (isProrated && currentAllocated > 0) {
        // PRORATED EMPLOYEE: Use their prorated allocation

        
        if (!employee.isManualPaidLeavesUpdate) {
            employee.set('paidLeaves.allocated', currentAllocated); // Keep prorated allocation
            employee.set('paidLeaves.available', Math.max(0, currentAllocated - totalTaken)); // Use prorated base
            employee.set('paidLeaves.used', totalTaken);
        }    } else {
        // FULL YEAR EMPLOYEE: Use full year allocation

        
        if (!employee.isManualPaidLeavesUpdate) {
            employee.set('paidLeaves.allocated', fullYearAllocation);
            employee.set('paidLeaves.available', Math.max(0, fullYearAllocation - totalTaken));
            employee.set('paidLeaves.used', totalTaken);
        }    }

    // Continue with monthly leaves processing...
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

    // Ensure all months exist from join date
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

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
                    isFinalized: false,
                    finalizedAt: null
                });
            }
        }
    }

    await employee.save({ session });

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

// ✅ ENHANCED: Check if employee has any attendance in specified month
// ✅ FIXED: Handles string dates correctly
const hasAttendanceInMonth = async (employeeId, year, month) => {
  try {

    
    // ✅ CRITICAL FIX: Create string-based date range for comparison
    const startOfMonth = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endOfMonth = `${year}-${month.toString().padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    

    
    // ✅ FIX: Use regex to match date strings that start with YYYY-MM
    const datePattern = new RegExp(`^${year}-${month.toString().padStart(2, '0')}`);
    
    const count = await mongoose.model('Attendance').countDocuments({
      employee: employeeId,
      date: {
        $regex: datePattern  // ✅ Compare string dates with regex pattern
      },
      status: { $in: ['present', 'absent', 'leave', 'half-day'] },
      isDeleted: { $ne: true }
    });
    
    const hasAttendance = count > 0;

    
    return hasAttendance;
    
  } catch (error) {
    return false;
  }
};



// ✅ ENHANCED: bulkMarkAttendance with unlimited half-days and capped calculations
// ✅ OPTIMIZED: Replace your existing bulkMarkAttendance function
// ✅ FIXED: Complete bulkMarkAttendance function with leave correction fix
export const bulkMarkAttendance = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {

    
    const { attendance, overwrite = false } = req.body;

    // ✅ VALIDATION: Check if attendance data exists
    if (!attendance || !Array.isArray(attendance) || attendance.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'No attendance records provided'
      });
    }

    // ✅ VALIDATION: Check if user is authenticated
    if (!req.user || !req.user._id) {
      await session.abortTransaction();
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }



    // ✅ EXTRACT: Date information from first record
    const firstRecord = attendance[0];
    if (!firstRecord.date) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Date is required for attendance records'
      });
    }

    const { month, year } = getISTDateComponents(firstRecord.date);
    const targetDate = new Date(year, month - 1, 1);


    // ✅ GET: All unique employee IDs from attendance records
    const employeeIds = [...new Set(attendance.map(record => record.employeeId))];


    // ✅ FETCH: Employee data with monthly leaves
    const employees = await Employee.find({
      _id: { $in: employeeIds },
      isDeleted: false
    }).session(session);

    if (employees.length === 0) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'No valid employees found'
      });
    }



    // ✅ VALIDATE: Monthly leave consistency for each employee

    for (const employee of employees) {
      validateMonthlyLeaveConsistency(employee, year, month);
    }

    // ✅ FILTER: Only process employees who should have attendance for target month
    const validEmployeesForMonth = employees.filter(employee => {
      const joinDate = new Date(employee.joinDate);
      const isActiveInTargetMonth = joinDate <= targetDate;
      
      if (!isActiveInTargetMonth) {

      }
      
      return isActiveInTargetMonth;
    });

    if (validEmployeesForMonth.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `No employees were active during ${year}-${month}`
      });
    }



    // ✅ PREPARE: Attendance records by valid employees only
    const attendanceByEmployee = new Map();
    const validEmployeeIds = new Set(validEmployeesForMonth.map(emp => emp._id.toString()));

    for (const record of attendance) {
      const employeeId = record.employeeId.toString();
      
      // Skip employees who shouldn't have attendance for this month
      if (!validEmployeeIds.has(employeeId)) {

        continue;
      }

      if (!attendanceByEmployee.has(employeeId)) {
        attendanceByEmployee.set(employeeId, []);
      }
      
      // ✅ FIXED: Normalize the attendance record with required markedBy field
      const normalizedRecord = {
        employeeId: record.employeeId,
        date: record.date,
        normalizedDate: record.date,
        status: record.status,
        location: record.location,
        isException: record.isException || false,
        exceptionReason: record.exceptionReason || null,
        exceptionDescription: record.exceptionDescription || null,
        markedBy: req.user._id, // ✅ CRITICAL: Add required markedBy field
        existingRecord: null
      };
      
      attendanceByEmployee.get(employeeId).push(normalizedRecord);
    }

    if (attendanceByEmployee.size === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'No valid attendance records to process'
      });
    }

    // ✅ CHECK: For existing records

    const dateStr = firstRecord.date.split('T')[0]; // Get YYYY-MM-DD
    
    // ✅ FIXED: Use string-based regex matching instead of UTC ranges
    const existingRecords = await Attendance.find({
      employee: { $in: [...attendanceByEmployee.keys()] },
      date: { 
        $regex: `^${dateStr}`,  // ✅ Match any time on this date
        $options: 'i' 
      },
      isDeleted: { $ne: true }
    }).session(session);



    // ✅ EARLY DUPLICATE CHECK: If not overwriting and all employees have records
    if (!overwrite && existingRecords.length > 0) {
      const allEmployeesHaveRecords = [...attendanceByEmployee.keys()].every(employeeId => 
        existingRecords.some(existing => existing.employee.toString() === employeeId)
      );
      
      if (allEmployeesHaveRecords) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: 'Attendance already marked for all employees on this date',
          details: 'All selected employees already have attendance records for this date. Use overwrite option to update existing records.',
          duplicatesFound: existingRecords.length,
          affectedEmployees: [...attendanceByEmployee.keys()].length
        });
      }
    }

    // Map existing records to employee attendance
    for (const existing of existingRecords) {
      const employeeId = existing.employee.toString();
      const employeeRecords = attendanceByEmployee.get(employeeId);
      
      if (employeeRecords) {
        // ✅ FIXED: Compare only the date part (YYYY-MM-DD)
        const matchingRecord = employeeRecords.find(record => {
          const recordDateStr = record.date.split('T')[0];
          const existingDateStr = existing.date.split('T')[0];
          return recordDateStr === existingDateStr;
        });
        
        if (matchingRecord) {
          matchingRecord.existingRecord = existing;

        }
      }
    }

    // ✅ FETCH: Settings for leave calculations
    const settings = await Settings.findOne().session(session);

    // ✅ PROCESS: Each valid employee's attendance

    const processedEmployees = [];
    const attendanceIds = [];

    // ✅ CRITICAL FIX: Declare statistics variables at function level
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    // ✅ CRITICAL FIX: Move skip logic BEFORE processing
    for (const employee of validEmployeesForMonth) {
      const employeeRecords = attendanceByEmployee.get(employee._id.toString());
      if (!employeeRecords || employeeRecords.length === 0) {

        continue;
      }



      try {
        // ✅ CRITICAL FIX: Check for skips BEFORE processing monthly leaves
        let hasRecordsToProcess = false;
        let recordsToProcess = [];
        
        for (const record of employeeRecords) {
          // ✅ Skip if existing record found and not overwriting
          if (record.existingRecord && !overwrite) {
            skippedCount++;

            continue; // ✅ Skip this record entirely
          } else {
            hasRecordsToProcess = true;
            recordsToProcess.push(record);
          }
        }

        // ✅ ONLY process monthly leaves if we have records to actually create/update
        if (hasRecordsToProcess) {
          // ✅ PROCESS: Employee attendance batch ONLY for records we'll actually use
          const monthlyUpdates = await processEmployeeAttendanceBatch(
            employee, 
            recordsToProcess, // ✅ Only process non-skipped records
            settings, 
            session
          );

          // ✅ SAVE: Employee with updated monthly leaves
          await employee.save({ session });

          // ✅ CREATE/UPDATE: Attendance records
          for (const record of recordsToProcess) {
            let attendanceRecord;
            
            if (record.existingRecord && overwrite) {
              // Update existing record
              record.existingRecord.status = record.status;
              record.existingRecord.isException = record.isException;
              record.existingRecord.exceptionReason = record.exceptionReason;
              record.existingRecord.exceptionDescription = record.exceptionDescription;
              record.existingRecord.markedBy = req.user._id;
              
              attendanceRecord = await record.existingRecord.save({ session });
              updatedCount++;

            } else if (!record.existingRecord) {
              // ✅ Create new record
              attendanceRecord = new Attendance({
                employee: record.employeeId,
                date: record.date,
                status: record.status,
                location: record.location,
                isException: record.isException,
                exceptionReason: record.exceptionReason,
                exceptionDescription: record.exceptionDescription,
                markedBy: req.user._id,
                presenceDays: record.status === 'present' ? 1.0 : 
                             record.status === 'half-day' ? 0.5 : 
                             record.status === 'leave' ? 1.0 : 0,
                approvedBy: record.isException ? req.user._id : undefined
              });
              
              await attendanceRecord.save({ session });
              createdCount++;

            }
            
            if (attendanceRecord) {
              attendanceIds.push(attendanceRecord._id);
            }
          }

          processedEmployees.push({
            id: employee._id,
            employeeId: employee.employeeId,
            name: employee.name,
            year: year,
            month: month
          });
        }

      } catch (error) {
        throw new Error(`Failed to process attendance for ${employee.employeeId}: ${error.message}`);
      }
    }

    // ✅ ENHANCED RESPONSE LOGIC: Different responses based on what was actually processed
    const totalProcessed = createdCount + updatedCount;
    const allSkipped = skippedCount > 0 && totalProcessed === 0;
    const someSkipped = skippedCount > 0 && totalProcessed > 0;

    // ✅ CASE 1: All records were duplicates/skipped - Return conflict error
    if (allSkipped) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: 'Attendance already marked for selected date',
        details: 'All employees already have attendance records for this date. Use overwrite option to update existing records.',
        statistics: {
          totalRequested: attendance.length,
          created: createdCount,
          updated: updatedCount,
          skipped: skippedCount,
          processedEmployees: processedEmployees.length,
          validEmployees: validEmployeesForMonth.length
        }
      });
    }

    // ✅ COMMIT: Transaction (only if we have records to process)
    await session.commitTransaction();


    // ✅ CRITICAL FIX: Do finalization AFTER transaction commit

    
    for (const employee of processedEmployees) {
      try {
        // Fetch fresh employee data (no session after transaction commit)
        const freshEmployee = await Employee.findById(employee.id);
        if (freshEmployee) {

          await correctMonthlyLeaves(freshEmployee, employee.year, employee.month, null);
        }
      } catch (error) {
      }
    }


    // ✅ CRITICAL FIX: Do finalization AFTER transaction commit (when records are visible)

    for (const employee of processedEmployees) {
      try {
        // ✅ Call without session (after transaction commit)
        await finalizeMonthIfNeeded(employee.id, employee.year, employee.month);
      } catch (error) {
      }
    }


    // ✅ PROCESS: Carry forwards (after finalization, outside transaction)
    try {

      await updateCarryForwardsWithFinalization();

    } catch (carryForwardError) {
    }

    // ✅ CASE 2: Some records processed, some skipped - Return partial success warning
    if (someSkipped) {
      return res.status(200).json({
        success: true,
        warning: true,
        message: `Processed ${totalProcessed} records, skipped ${skippedCount} duplicates`,
        details: `${createdCount} created, ${updatedCount} updated, ${skippedCount} already existed`,
        attendanceIds,
        statistics: {
          totalRequested: attendance.length,
          created: createdCount,
          updated: updatedCount,
          skipped: skippedCount,
          processedEmployees: processedEmployees.length,
          validEmployees: validEmployeesForMonth.length
        }
      });
    }

    // ✅ CASE 3: All records processed successfully - Return full success
    return res.status(201).json({
      success: true,
      message: 'Bulk attendance processed successfully',
      attendanceIds,
      statistics: {
        totalRequested: attendance.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        processedEmployees: processedEmployees.length,
        validEmployees: validEmployeesForMonth.length
      }
    });

  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark bulk attendance',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    await session.endSession();
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

      const { month, year } = getISTDateComponents(record.normalizedDate || normalizedDate);

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

      // ✅ FIRST: Correct monthly leaves for each employee
      for (const employee of employees) {
        const fullEmployee = await Employee.findById(employee._id);
        if (fullEmployee) {
          await correctMonthlyLeaves(fullEmployee, yearNum, monthNum, null);
        }
      }

      // ✅ CRITICAL FIX: Fetch FRESH corrected data after corrections
      const correctedEmployees = await Employee.find({
        _id: { $in: employeeIds }
      })
        .populate('location', 'name')
        .sort({ employeeId: 1 })
        .lean();

      // ✅ Structure response with CORRECTED data
      const employeeAttendanceData = correctedEmployees.map(employee => ({
        employee: employee,  // ✅ Fresh data with correct paidLeaves
        attendance: attendanceRecords.filter(att => 
          att.employee._id.toString() === employee._id.toString()
        )
      }));

      return res.status(200).json({
        attendance: employeeAttendanceData, // ✅ Contains corrected prorated values
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
    
    // ✅ STEP 1: Basic validation with detailed logging
    if (!id) {

      await session.abortTransaction();
      return res.status(400).json({ message: 'Request ID is required' });
    }
    
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
    

    
    // ✅ STEP 2: Find attendance request with detailed logging

    const request = await AttendanceRequest.findById(id).session(session);
    if (!request) {

      await session.abortTransaction();
      return res.status(404).json({ message: 'Attendance request not found' });
    }    // ✅ STEP 3: Update request status

    request.status = status;
    request.reviewedAt = new Date();
    request.reviewedBy = req.user?._id || null;
    await request.save({ session });

    
    // ✅ STEP 4: Process approval (only if approved)
    if (status === 'approved') {

      
      try {
        const dateOnlyStr = date.split('T')[0];

        
        // Find attendance record
        const attendance = await Attendance.findOne({
          employee: request.employee,
          location: request.location,
          date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
          isDeleted: { $ne: true },
        }).populate('employee').session(session);
        
        if (!attendance) {          await session.abortTransaction();
          return res.status(404).json({ message: 'No attendance record found for the specified date' });
        }        const employee = attendance.employee;
        if (!employee) {

          await session.abortTransaction();
          return res.status(404).json({ message: 'Employee data not found' });
        }        const oldStatus = attendance.status;
        const newStatus = request.requestedStatus;
        

        
        // Skip if no change needed
        if (oldStatus === newStatus) {

          await session.commitTransaction();
          return res.json({ message: 'Request approved successfully (no status change)', request });
        }
        
        // ✅ STEP 5: Get date components safely
        let month, year;
        try {
          const dateComponents = getISTDateComponents(date);
          month = dateComponents.month;
          year = dateComponents.year;

        } catch (dateError) {

          await session.abortTransaction();
          return res.status(400).json({ message: 'Error processing date components' });
        }
        
        // ✅ STEP 6: Correct monthly leaves safely

        try {
          await correctMonthlyLeaves(employee, year, month, session);

        } catch (correctError) {

          await session.abortTransaction();
          return res.status(500).json({ message: `Error correcting monthly leaves: ${correctError.message}` });
        }
        
        // ✅ STEP 7: Find/initialize monthly leave record

        let monthlyLeave = employee.monthlyLeaves.find(ml => ml.year === year && ml.month === month);
        
        if (!monthlyLeave) {

          try {
            const settings = await Settings.findOne().session(session);
            const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
            
            monthlyLeave = {
              year,
              month,
              allocated: paidLeavesPerMonth,
              taken: 0,
              carriedForward: 0,
              available: paidLeavesPerMonth,
              isFinalized: false,
              finalizedAt: null
            };
            employee.monthlyLeaves.push(monthlyLeave);

          } catch (initError) {

            await session.abortTransaction();
            return res.status(500).json({ message: `Error initializing monthly leave: ${initError.message}` });
          }
        }        // ✅ STEP 8: Calculate leave adjustments
        let leaveAdjustment = 0;
        let monthlyLeaveAdjustment = 0;
        
        // Reverse old status impact
        if (oldStatus === 'leave') {
          leaveAdjustment += 1;
          monthlyLeaveAdjustment += 1;
        } else if (oldStatus === 'half-day') {
          leaveAdjustment += 0.5;
          monthlyLeaveAdjustment += 0.5;
        }
        
        // Apply new status impact
        if (newStatus === 'leave') {
          const availableAfterAdjustment = monthlyLeave.available + monthlyLeaveAdjustment;
          if (availableAfterAdjustment < 1) {            await session.abortTransaction();
            return res.status(400).json({ 
              message: `Employee ${employee.name} has insufficient leaves (${availableAfterAdjustment}) for full leave on ${month}/${year}` 
            });
          }
          leaveAdjustment -= 1;
          monthlyLeaveAdjustment -= 1;
        } else if (newStatus === 'half-day') {
          leaveAdjustment -= 0.5;
          monthlyLeaveAdjustment -= 0.5;
        }
        

        
        // ✅ STEP 9: Update attendance record

        attendance.status = newStatus;
        attendance.editedBy = req.user?._id || null;
        attendance.date = date;
        
        // Update presence days
        if (newStatus === 'present') {
          attendance.presenceDays = 1.0;
        } else if (newStatus === 'half-day') {
          attendance.presenceDays = 0.5;
        } else if (newStatus === 'leave') {
          attendance.presenceDays = 1.0;
        } else {
          attendance.presenceDays = 0;
        }
        
        await attendance.save({ session });

        
        // ✅ STEP 10: Update leave balances if needed
        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {

          
          try {
            // Update monthly leave
            monthlyLeave.taken = Math.max(0, monthlyLeave.taken - monthlyLeaveAdjustment);
            monthlyLeave.available = Math.max(0, (monthlyLeave.allocated + monthlyLeave.carriedForward) - monthlyLeave.taken);            // Update employee record
            if (!employee.isManualPaidLeavesUpdate && leaveAdjustment !== 0) {
              const updateQuery = {
                $inc: {
                  'paidLeaves.available': leaveAdjustment,
                  'paidLeaves.used': -leaveAdjustment,
                },
                $set: {
                  'monthlyLeaves.$[elem].taken': monthlyLeave.taken,
                  'monthlyLeaves.$[elem].available': monthlyLeave.available,
                }
              };
              
              await Employee.findByIdAndUpdate(
                employee._id,
                updateQuery,
                {
                  arrayFilters: [{ 'elem.year': year, 'elem.month': month }],
                  session,
                  new: true,
                }
              );

            } else {
              // Save employee with updated monthly leaves
              await employee.save({ session });

            }
            
            // Update next month carry forward
            await updateNextMonthCarryforward(employee._id, year, month, monthlyLeave.available, session);

            
          } catch (leaveUpdateError) {

            await session.abortTransaction();
            return res.status(500).json({ 
              message: `Error updating leave balances: ${leaveUpdateError.message}` 
            });
          }
        }
        
      } catch (approvalError) {

        await session.abortTransaction();
        return res.status(500).json({ 
          message: 'Error processing attendance request approval',
          error: process.env.NODE_ENV === 'development' ? approvalError.message : undefined
        });
      }
    }
    
    // ✅ STEP 11: Commit transaction

    await session.commitTransaction();

    
    res.json({ message: `Request ${status} successfully`, request });
    
  } catch (error) {


    await session.abortTransaction();
    res.status(500).json({ 
      message: 'Server error while handling attendance request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    await session.endSession();

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




