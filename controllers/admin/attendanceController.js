import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Settings from '../../models/Settings.js';
import { format } from 'date-fns';
import { getHolidaysForLocation, getWorkingDaysForLocation } from './settingsController.js';
import { isWorkingDay, getWorkingDayPolicyInfo, shouldCountForSalary } from '../../utils/workingDayValidator.js'; // ✅ UPDATED import


// 🚀 ENHANCED: Global caches and configuration
const calculationCache = new Map();
const finalizationCache = new Map();
const documentLockCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // Extended to 10 minutes for longer operations
const FINALIZATION_CACHE_DURATION = 20 * 60 * 1000; // 20 minutes for batch operations
const LOCK_TIMEOUT = 60000; // 60 seconds to match transaction timeout

// 🚀 NEW: Extended timeout configuration
const EXTENDED_TIMEOUTS = {
  transactionTimeout: 60000,        // 60 seconds for complex operations
  queryTimeout: 45000,              // 45 seconds per query
  connectionTimeout: 30000,         // 30 seconds connection timeout
  socketTimeout: 65000,             // 65 seconds socket timeout (slightly higher than transaction)
  serverSelectionTimeout: 15000     // 15 seconds server selection
};

// Helper functions (keeping existing ones)
const createCacheKey = (employeeId, year, month, operation) => {
  return `${employeeId}_${year}_${month}_${operation}`;
};

const createFinalizationKey = (employeeId, year, month, operation) => {
  return `fin_${employeeId}_${year}_${month}_${operation}`;
};

// 🚀 ENHANCED: Document lock management with extended timeout
const acquireDocumentLock = async (docId) => {
  const lockKey = docId.toString();
  const now = Date.now();
  
  const existingLock = documentLockCache.get(lockKey);
  if (existingLock && (now - existingLock.timestamp) < LOCK_TIMEOUT) {
    return new Promise((resolve) => {
      const checkLock = () => {
        const currentLock = documentLockCache.get(lockKey);
        if (!currentLock || (Date.now() - currentLock.timestamp) >= LOCK_TIMEOUT) {
          documentLockCache.set(lockKey, { timestamp: Date.now() });
          resolve(true);
        } else {
          setTimeout(checkLock, 200); // Check every 200ms for longer operations
        }
      };
      setTimeout(checkLock, 100);
    });
  }
  
  documentLockCache.set(lockKey, { timestamp: now });
  return true;
};

const releaseDocumentLock = (docId) => {
  const lockKey = docId.toString();
  documentLockCache.delete(lockKey);
};

// Keep existing helper functions...
const calculateProratedLeaveWithCache = (employee, year, month) => {
  const cacheKey = createCacheKey(employee._id, year, month, 'prorated');
  
  const cached = calculationCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
    return cached.result;
  }
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  
  const proratedData = {
    joinMonth,
    joinYear,
    processYear: year,
    joinedMidYear: joinYear === year && joinMonth > 1,
    hasReducedAllocation: false,
    isProratedFlag: false,
    currentAllocated: 24,
    fullYearAllocation: 24,
    finalIsProrated: false
  };

  if (joinYear === year && joinMonth > 1) {
    const monthsWorked = 13 - joinMonth;
    proratedData.currentAllocated = Math.floor((monthsWorked / 12) * 24);
    proratedData.finalIsProrated = true;
    proratedData.isProratedFlag = true;
  }

  const result = {
    allocated: proratedData.currentAllocated,
    available: proratedData.currentAllocated,
    used: 0,
    status: proratedData.finalIsProrated ? 'PRORATED CALCULATED' : 'FULL YEAR CALCULATED'
  };

  calculationCache.set(cacheKey, {
    result,
    timestamp: Date.now()
  });

  return result;
};



// 🚀 ENHANCED: Batch leave processing with version conflict prevention
const batchProcessEmployeeLeaves = async (employees, year, month, session) => {
  const processedEmployees = new Map();
  const batchSize = 5; // Smaller batches to reduce conflicts
  
  const uniqueEmployees = employees.filter(emp => {
    const key = `${emp._id}_${year}_${month}`;
    if (processedEmployees.has(key)) {
      return false;
    }
    processedEmployees.set(key, emp);
    return true;
  });
  for (let i = 0; i < uniqueEmployees.length; i += batchSize) {
    const batch = uniqueEmployees.slice(i, i + batchSize);
    
    // Process batch with document locking
    await Promise.all(batch.map(async (employee) => {
      try {
        // Acquire document lock
        await acquireDocumentLock(employee._id);
        
        try {
          const existingLeave = employee.monthlyLeaves?.find(ml => 
            ml.year === year && ml.month === month
          );

          if (!existingLeave) {
            const leaveData = calculateProratedLeaveWithCache(employee, year, month);
            
            if (!employee.monthlyLeaves) employee.monthlyLeaves = [];
            
            employee.monthlyLeaves.push({
              year,
              month,
              allocated: leaveData.allocated,
              used: 0,
              available: leaveData.allocated,
              carryForward: 0,
              isProrated: leaveData.status.includes('PRORATED')
            });
          }
        } finally {
          // Always release lock
          releaseDocumentLock(employee._id);
        }
      } catch (error) {
        releaseDocumentLock(employee._id); // Ensure lock is released on error
      }
    }));
  }

  return uniqueEmployees;
};

// 🚀 ENHANCED: Version-safe finalization function
const optimizedFinalizeMonth = async (employeeId, year, month) => {
  const cacheKey = createFinalizationKey(employeeId, year, month, 'finalize');
  
  const cached = finalizationCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < FINALIZATION_CACHE_DURATION) {
    return cached.result;
  }

  try {
    // Acquire lock before finalization
    await acquireDocumentLock(employeeId);
    
    try {
      const result = await finalizeMonthIfNeeded(employeeId, year, month);
      
      finalizationCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      return result;
    } finally {
      releaseDocumentLock(employeeId);
    }
  } catch (error) {
    releaseDocumentLock(employeeId);
    // Don't log version conflict errors as they're normal in concurrent operations
    if (!error.message.includes('No matching document found') && 
        !error.message.includes('version')) {
    }
    throw error;
  }
};

// 🚀 NEW: Enhanced pre-save hook with version conflict handling
const optimizedPreSaveHook = function(next) {
  const modifiedPaths = this.modifiedPaths();
  const relevantPaths = ['monthlyLeaves', 'joinDate', 'isDeleted'];
  const hasRelevantChanges = modifiedPaths.some(path => 
    relevantPaths.some(relevant => path.startsWith(relevant))
  );

  if (!hasRelevantChanges && !this.isNew) {
    return next();
  }

  // Prevent multiple pre-save executions on the same document
  if (this._isInPreSave) {
    return next();
  }
  
  this._isInPreSave = true;

 
  
  // Your existing pre-save logic here (if any)
  
  this._isInPreSave = false;
  next();
};

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

export const processCarryForwardUpdates = async () => {
  try {
    await updateCarryForwardsWithFinalization();
  } catch (error) {
    throw error;
  }
};



// ✅ COMPLETE: Working carry forward with finalization checks
export const updateCarryForwardsWithFinalization = async () => {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const session = await mongoose.startSession();
    
    try {
      await session.withTransaction(async () => {
        // Fetch all active employees with pagination to reduce memory usage
        const batchSize = 50; // Process 50 employees at a time
        let skip = 0;
        let processedCount = 0;
        let updatedCount = 0;

        while (true) {
          const employees = await Employee.find({ 
            isDeleted: { $ne: true } 
          })
          .sort({ _id: 1 }) // Consistent sorting for pagination
          .skip(skip)
          .limit(batchSize)
          .session(session);

          if (employees.length === 0) break;
          // Process employees sequentially to avoid write conflicts
          for (const employee of employees) {
            try {
              const updated = await processEmployeeCarryForward(employee, session);
              if (updated) {
                updatedCount++;
              }
              processedCount++;
            } catch (employeeError) {
              // Continue with other employees instead of failing the entire batch
            }
          }

          skip += batchSize;
          
          // Add a small delay between batches to reduce database load
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }, {
        // Transaction options
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority', j: true },
        readPreference: 'primary',
        maxCommitTimeMS: 60000 // 60 seconds timeout
      });

      // If we reach here, transaction was successful
      return;

    } catch (error) {
      // Check if it's a transient error that can be retried
      const isRetriableError = 
        error.errorLabels?.includes('TransientTransactionError') ||
        error.code === 112 || // WriteConflict
        error.code === 11000 || // DuplicateKey
        error.message?.includes('Write conflict') ||
        error.message?.includes('WriteConflict');

      if (isRetriableError && retryCount < maxRetries - 1) {
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 5000); // Exponential backoff, max 5s
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      } else {
        // Non-retriable error or max retries reached
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  throw new Error('Max retry attempts reached for carry forward update');
};



// ✅ COMPLETE: Process carry forward for individual employee
const processEmployeeCarryForward = async (employee, session) => {
  let hasUpdates = false;
  
  const sortedMonthlyLeaves = employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });



  for (let i = 0; i < sortedMonthlyLeaves.length; i++) {
    const currentMonth = sortedMonthlyLeaves[i];
    const previousMonth = i > 0 ? sortedMonthlyLeaves[i - 1] : null;

    // ✅ CHANGED: Allow carry forward to ANY month if previous month is finalized
    // Don't require current month to be finalized
    
    let newCarriedForward = 0;

    if (previousMonth && previousMonth.isFinalized) {
      // Calculate carry forward from previous month
      const carryForwardAmount = Math.min(Math.max(previousMonth.available, 0), 6);
      newCarriedForward = carryForwardAmount;
    } else if (previousMonth) {
    } else {
    }

    // Check if carry forward needs to be updated
    if (currentMonth.carriedForward !== newCarriedForward) {
      currentMonth.carriedForward = newCarriedForward;
      currentMonth.available = currentMonth.allocated - currentMonth.taken + newCarriedForward;
      hasUpdates = true;
    } else {
    }

    // Reset carry forward at start of new year
    if (previousMonth && currentMonth.year > previousMonth.year) {
      if (currentMonth.carriedForward !== 0) {
        currentMonth.carriedForward = 0;
        currentMonth.available = currentMonth.allocated - currentMonth.taken;
        hasUpdates = true;
      }
    }
  }
  if (hasUpdates) {
    await employee.save({ session });
    return true;
  }

  return false;
};




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
function debugAttendanceDate(originalDate, extractedMonth, extractedYear, context = '') {
  
}

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
      monthlyAllocation = totalAllocation / remainingMonths;
      
     
    } else {
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
  const hasReducedAllocation = currentAllocation < fullYearAllocation;
  

  
  return isFirstYear && joinedMidYear && hasReducedAllocation;
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
    employee.isManualPaidLeavesUpdate = true;
  }

  // ✅ NORMALIZE DATES FIRST
  for (const record of records) {
    record.normalizedDate = normalizeDate(record.date);
  }

  const monthlyUpdates = new Map();
  const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

  const monthGroups = new Map();
  for (const record of records) {
    const { month, year } = getISTDateComponents(record.normalizedDate);
    const key = `${year}-${month}`;
    
    if (!monthGroups.has(key)) {
      monthGroups.set(key, { year, month, records: [] });
    }
    monthGroups.get(key).records.push(record);
  }

  // Process each month's attendance in batch
  for (const [monthKey, { year, month, records: monthRecords }] of monthGroups) {
    
    let monthlyLeave = employee.monthlyLeaves.find(ml => 
      ml.year === year && ml.month === month
    );
    
    if (!monthlyLeave) {
  // ✅ ENHANCED: Auto-apply carry forward when creating monthly leave
  const joinDate = new Date(employee.joinDate);
  const recordDate = new Date(year, month - 1, 1);
  
  if (recordDate >= joinDate) {
    // Calculate carry forward from previous month
    let carriedForward = 0;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    
    const previousMonthLeave = employee.monthlyLeaves.find(ml => 
      ml.year === prevYear && ml.month === prevMonth && ml.isFinalized
    );
    
    if (previousMonthLeave) {
      carriedForward = Math.min(Math.max(previousMonthLeave.available, 0), 6);
    }
    
    monthlyLeave = {
      year,
      month,
      allocated: paidLeavesPerMonth,
      taken: 0,
      carriedForward: carriedForward,  // ✅ Applied immediately
      available: paidLeavesPerMonth + carriedForward,  // ✅ Total from day 1
      isFinalized: false,
      finalizedAt: null
    };
    employee.monthlyLeaves.push(monthlyLeave);
    
    // Sort monthly leaves chronologically
    employee.monthlyLeaves.sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });
  }
}


    // ✅ SIMPLIFIED: Calculate net leave change
    let netLeaveChange = 0;

    for (const record of monthRecords) {
      // Remove old leave usage
      if (record.existingRecord) {
        const oldStatus = record.existingRecord.status;
        if (oldStatus === 'leave') {
          netLeaveChange -= 1; // Remove old leave
        } else if (oldStatus === 'half-day') {
          netLeaveChange -= 0.5;
        }
      }

      // Add new leave usage
      if (record.status === 'leave') {
        netLeaveChange += 1; // Add new leave
      } else if (record.status === 'half-day') {
        netLeaveChange += 0.5;
      }
    }

    // ✅ APPLY THE CHANGE
    if (netLeaveChange !== 0) {
      const newTaken = Math.max(0, monthlyLeave.taken + netLeaveChange);
      const totalAvailableForMonth = (monthlyLeave.allocated || 0) + (monthlyLeave.carriedForward || 0);
      
      const cappedTaken = Math.min(newTaken, totalAvailableForMonth);
      const unpaidUsage = Math.max(0, newTaken - totalAvailableForMonth);
      
      // Validate sufficient leaves
      if (netLeaveChange > 0 && monthlyLeave.available < netLeaveChange) {
        throw new Error(`Employee ${employee.name} has insufficient leaves (${monthlyLeave.available}) for month ${month}/${year}`);
      }
      
      monthlyUpdates.set(monthKey, {
        year,
        month,
        netLeaveChange,
        newTaken: cappedTaken,
        newAvailable: Math.max(0, totalAvailableForMonth - cappedTaken),
        unpaidUsage
      });
      
      // ✅ UPDATE THE MONTHLY LEAVE
      monthlyLeave.taken = cappedTaken;
      monthlyLeave.available = Math.max(0, totalAvailableForMonth - cappedTaken);
      
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
    const isProrated = joinedMidYear || hasReducedAllocation || isProratedFlag;
    
  

    // Calculate total taken from monthly leaves
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
        }
        
      
    } else {
        // FULL YEAR EMPLOYEE: Use full year allocation

        
        if (!employee.isManualPaidLeavesUpdate) {
            employee.set('paidLeaves.allocated', fullYearAllocation);
            employee.set('paidLeaves.available', Math.max(0, fullYearAllocation - totalTaken));
            employee.set('paidLeaves.used', totalTaken);
        }
        
      
    }

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


// 🚀 MAIN FUNCTION: Extended timeout bulk attendance processing
export const bulkMarkAttendance = async (req, res) => {
  const t0 = Date.now();
  
  // 🚀 ENHANCED: Extended session configuration
  const session = await mongoose.startSession({
    defaultTransactionOptions: {
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      writeConcern: { 
        w: 'majority', 
        wtimeout: EXTENDED_TIMEOUTS.connectionTimeout // 30s write timeout
      },
      maxTimeMS: EXTENDED_TIMEOUTS.transactionTimeout // 60s max execution time
    }
  });

  try {
    // 🚀 ENHANCED: Start transaction with extended timeout
    await session.startTransaction({
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      writeConcern: { 
        w: 'majority', 
        wtimeout: EXTENDED_TIMEOUTS.connectionTimeout 
      },
      maxTimeMS: EXTENDED_TIMEOUTS.transactionTimeout // 60 seconds total
    });

    const { attendance, overwrite = false } = req.body;
    const t1 = Date.now();

    // Existing validation logic...
    if (!attendance || !Array.isArray(attendance) || attendance.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'No attendance records provided' });
    }

    if (!req.user || !req.user._id) {
      await session.abortTransaction();
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }

    const firstRecord = attendance[0];
    if (!firstRecord.date) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Date is required for attendance records' });
    }

    const { month, year } = getISTDateComponents(firstRecord.date);
    const targetDate = new Date(year, month - 1, 1);
    const employeeIds = [...new Set(attendance.map(r => r.employeeId))];
    const dateStr = firstRecord.date.split('T')[0];

    const t2 = Date.now();

    // 🚀 ENHANCED: Extended read session with longer timeouts
    const readSession = await mongoose.startSession();
    
    try {
      // 🚀 ENHANCED: Extended query timeout for larger datasets
      const queryTimeout = EXTENDED_TIMEOUTS.queryTimeout; // 45 seconds per query
      
      const [employees, existingRecords, settings] = await Promise.all([
        Employee.find(
          { _id: { $in: employeeIds }, isDeleted: false },
          { 
            _id: 1, 
            employeeId: 1, 
            name: 1, 
            joinDate: 1, 
            monthlyLeaves: 1,
            __v: 1
          }
        ).maxTimeMS(queryTimeout).session(readSession),
        
        Attendance.find({
          employee: { $in: employeeIds },
          date: { $regex: `^${dateStr}`, $options: 'i' },
          isDeleted: { $ne: true }
        }, { employee: 1, date: 1, _id: 1 }).maxTimeMS(queryTimeout).session(readSession),
        
        Settings.findOne({}, { 
          leaveSettings: 1, 
          attendanceSettings: 1,
          holidays: 1 
        }).maxTimeMS(queryTimeout).session(readSession)
      ]);

      const t3 = Date.now();

      if (employees.length === 0) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'No valid employees found' });
      }

      
// 🔥 ADD HOLIDAY VALIDATION HERE - RIGHT AFTER t3 and employee validation
// ===================================================================
// Get attendance date info (using different variable name to avoid conflict)
const checkDate = new Date(firstRecord.date);
const checkYear = checkDate.getFullYear();
const checkMonth = checkDate.getMonth() + 1;

// Get all unique locations from the attendance records
const uniqueLocations = [...new Set(attendance.map(record => record.location).filter(Boolean))];

// Check holidays for each location
const locationHolidays = {};
for (const locationId of uniqueLocations) {
  const holidays = getHolidaysForLocation(settings, locationId, checkYear, checkMonth);
  const isHoliday = holidays.some(holiday => {
    const holidayDate = new Date(holiday.date);
    const matches = holidayDate.toDateString() === checkDate.toDateString();
    return matches;
  });
  
  if (isHoliday) {
    const holidayInfo = holidays.find(h => new Date(h.date).toDateString() === checkDate.toDateString());
    locationHolidays[locationId] = holidayInfo;
  } else {
  }
}
const hasHolidays = Object.keys(locationHolidays).length > 0;


if (hasHolidays && !overwrite) {
  const holidayNames = Object.values(locationHolidays).map(h => h.name).join(', ');
  await session.abortTransaction();
  return res.status(400).json({
    success: false,
    isHoliday: true,
    message: `Cannot mark attendance on holiday: ${holidayNames}`,
    holidayInfo: locationHolidays,
    suggestion: 'Use overwrite flag or mark as exception attendance if required'
  });
}else if (hasHolidays && overwrite) {
} else {
}

if (hasHolidays) {
}

// In the holiday validation code, add debug logs:


// ===================================================================
// END OF HOLIDAY VALIDATION
      // Enhanced validation with progress tracking
      const validationPromises = employees.map((employee, index) => {
        return new Promise((resolve) => {
          try {
            validateMonthlyLeaveConsistency(employee, year, month);
            if (index % 10 === 0) {
            }
            resolve({ success: true, employeeId: employee._id });
          } catch (error) {
            resolve({ success: false, employeeId: employee._id, error: error.message });
          }
        });
      });

      const validationResults = await Promise.all(validationPromises);
      const failedValidations = validationResults.filter(r => !r.success);
      
      if (failedValidations.length > 0) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false, 
          message: 'Employee validation failed',
          failures: failedValidations.slice(0, 3)
        });
      }

    // ✅ BEST: Check against the actual attendance date being marked
const attendanceDate = new Date(firstRecord.date);

const validEmployeesForMonth = employees.filter(e => {
  const joinDate = new Date(e.joinDate);
  // Employee is valid if they joined before or on the attendance date being marked
  return joinDate <= attendanceDate;
});


      const t4 = Date.now();

      // 🚀 ENHANCED: Larger batch processing for extended timeout
      const EXTENDED_BATCH_SIZE = 20; // Increased batch size for 60-second timeout
      const batches = [];
      for (let i = 0; i < validEmployeesForMonth.length; i += EXTENDED_BATCH_SIZE) {
        batches.push(validEmployeesForMonth.slice(i, i + EXTENDED_BATCH_SIZE));
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        await Promise.all(batch.map(async (employee) => {
          try {
            await acquireDocumentLock(employee._id);
            
            try {
              const existingLeave = employee.monthlyLeaves?.find(ml => 
                ml.year === year && ml.month === month
              );

              if (!existingLeave) {
                const leaveData = calculateProratedLeaveWithCache(employee, year, month);
                
                if (!employee.monthlyLeaves) employee.monthlyLeaves = [];
                
                employee.monthlyLeaves.push({
                  year,
                  month,
                  allocated: leaveData.allocated,
                  used: 0,
                  available: leaveData.allocated,
                  carryForward: 0,
                  isProrated: leaveData.status.includes('PRORATED')
                });
              }
            } finally {
              releaseDocumentLock(employee._id);
            }
          } catch (error) {
            releaseDocumentLock(employee._id);
          }
        }));
      }
      
      const t5 = Date.now();

      // Process attendance data (existing logic)
      const employeeMap = new Map(validEmployeesForMonth.map(e => [e._id.toString(), e]));
      const existingRecordsMap = new Map(
        existingRecords.map(r => [`${r.employee.toString()}_${r.date.split('T')[0]}`, r])
      );

      const processedRecords = [];
      const skippedRecords = [];
      
      for (const record of attendance) {
        const eid = record.employeeId.toString();
        if (!employeeMap.has(eid)) continue;
        
        const recordKey = `${eid}_${record.date.split('T')[0]}`;
        const existingRecord = existingRecordsMap.get(recordKey);
        
        if (existingRecord && !overwrite) {
          skippedRecords.push(record);
          continue;
        }
        
        processedRecords.push({
          ...record,
          markedBy: req.user._id,
          existingRecord,
          employeeDoc: employeeMap.get(eid)
        });
      }

      if (processedRecords.length === 0) {
        await session.abortTransaction();
        const allSkipped = skippedRecords.length > 0;
        return res.status(allSkipped ? 409 : 400).json({
          success: false,
          message: allSkipped ? 'All records already exist' : 'No valid attendance records to process'
        });
      }

      const t6 = Date.now();

      // 🚀 ENHANCED: Larger employee batches for extended processing
      const EXTENDED_EMPLOYEE_BATCH_SIZE = 8; // Increased from 2 to 8 for 60-second timeout
      const allBulkOps = [];
      const processedEmployees = [];
      const employeeRecords = new Map();
      
      for (const record of processedRecords) {
        const eid = record.employeeDoc._id.toString();
        if (!employeeRecords.has(eid)) {
          employeeRecords.set(eid, []);
        }
        employeeRecords.get(eid).push(record);
      }

      const employeeEntries = Array.from(employeeRecords.entries());
      for (let i = 0; i < employeeEntries.length; i += EXTENDED_EMPLOYEE_BATCH_SIZE) {
        const batch = employeeEntries.slice(i, i + EXTENDED_EMPLOYEE_BATCH_SIZE);
        const batchNumber = Math.floor(i / EXTENDED_EMPLOYEE_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(employeeEntries.length / EXTENDED_EMPLOYEE_BATCH_SIZE);
        const batchPromises = batch.map(async ([employeeId, records]) => {
          const employee = employeeMap.get(employeeId);
          
          try {
            await acquireDocumentLock(employee._id);
            
            try {
              const hasLeaveRecords = records.some(r => r.status === 'leave' || r.status === 'half-day');
              
              if (hasLeaveRecords) {
                await processEmployeeAttendanceBatch(employee, records, settings, session);
              }
              
              const bulkOps = [];
              for (const record of records) {
                if (record.existingRecord) {
                  bulkOps.push({
                    updateOne: {
                      filter: { _id: record.existingRecord._id },
                      update: {
                        $set: {
                          status: record.status,
                          isException: record.isException,
                          exceptionReason: record.exceptionReason,
                          exceptionDescription: record.exceptionDescription,
                          markedBy: req.user._id,
                          presenceDays: record.status === 'present' ? 1 : 
                                       record.status === 'half-day' ? 0.5 : 
                                       record.status === 'leave' ? 1 : 0,
                          approvedBy: record.isException ? req.user._id : undefined,
                        }
                      }
                    }
                  });
                } else {
                  bulkOps.push({
                    insertOne: {
                      document: {
                        employee: record.employeeId,
                        date: record.date,
                        status: record.status,
                        location: record.location,
                        isException: record.isException,
                        exceptionReason: record.exceptionReason,
                        exceptionDescription: record.exceptionDescription,
                        markedBy: req.user._id,
                        presenceDays: record.status === 'present' ? 1 : 
                                     record.status === 'half-day' ? 0.5 : 
                                     record.status === 'leave' ? 1 : 0,
                        approvedBy: record.isException ? req.user._id : undefined,
                        isDeleted: false
                      }
                    }
                  });
                }
              }
              
              return {
                employeeId,
                employee,
                bulkOps,
                employeeInfo: {
                  id: employee._id,
                  employeeId: employee.employeeId,
                  name: employee.name,
                  year,
                  month
                }
              };
            } finally {
              releaseDocumentLock(employee._id);
            }
          } catch (error) {
            releaseDocumentLock(employee._id);
            throw error;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        
        for (const result of batchResults) {
          allBulkOps.push(...result.bulkOps);
          processedEmployees.push(result.employeeInfo);
          
          // Enhanced save with progress tracking
          let saveAttempts = 0;
          const maxAttempts = 5; // Increased attempts for extended operations
          
          while (saveAttempts < maxAttempts) {
            try {
              await result.employee.save({ session });
              break;
            } catch (error) {
              if (error.name === 'VersionError' && saveAttempts < maxAttempts - 1) {
                const freshEmployee = await Employee.findById(result.employee._id).session(session);
                if (freshEmployee) {
                  freshEmployee.monthlyLeaves = result.employee.monthlyLeaves;
                  result.employee = freshEmployee;
                }
                saveAttempts++;
                await new Promise(resolve => setTimeout(resolve, 100 + (saveAttempts * 50))); // Progressive backoff
              } else {
                throw error;
              }
            }
          }
        }
        
        // Progress update for long operations
        const progressPercent = Math.round((i + batch.length) / employeeEntries.length * 100);
      }

      const t7 = Date.now();

      // 🚀 ENHANCED: Larger bulk operations for extended timeout
      let createdCount = 0, updatedCount = 0;
      
      if (allBulkOps.length > 0) {
        const EXTENDED_BULK_SIZE = 1000; // Increased bulk size for 60-second timeout
        for (let i = 0; i < allBulkOps.length; i += EXTENDED_BULK_SIZE) {
          const bulkChunk = allBulkOps.slice(i, i + EXTENDED_BULK_SIZE);
          const chunkNumber = Math.floor(i / EXTENDED_BULK_SIZE) + 1;
          const totalChunks = Math.ceil(allBulkOps.length / EXTENDED_BULK_SIZE);
          try {
            const result = await Attendance.bulkWrite(bulkChunk, { 
              session,
              ordered: false,
              writeConcern: { w: 'majority', wtimeout: 30000 }
            });
            
            createdCount += result.insertedCount || 0;
            updatedCount += result.modifiedCount || 0;
          } catch (error) {
            if (error.writeErrors && error.writeErrors.length > 0) {
           
              createdCount += error.result?.insertedCount || 0;
              updatedCount += error.result?.modifiedCount || 0;
            } else {
              throw error;
            }
          }
        }
      }

      const t8 = Date.now();

      try {
        await session.commitTransaction();
      } catch (commitError) {
        await session.abortTransaction();
        throw new Error('Failed to commit attendance transaction');
      }

      const t9 = Date.now();

      // Background finalization (same as before but with progress tracking)
      setImmediate(async () => {
        try {
          const monthlyGroups = new Map();
          
          processedEmployees.forEach(empInfo => {
            const monthKey = `${empInfo.year}_${empInfo.month}`;
            if (!monthlyGroups.has(monthKey)) {
              monthlyGroups.set(monthKey, new Set());
            }
            monthlyGroups.get(monthKey).add(empInfo.id.toString());
            
            const prevMonth = empInfo.month === 1 ? 12 : empInfo.month - 1;
            const prevYear = empInfo.month === 1 ? empInfo.year - 1 : empInfo.year;
            const prevMonthKey = `${prevYear}_${prevMonth}`;
            if (!monthlyGroups.has(prevMonthKey)) {
              monthlyGroups.set(prevMonthKey, new Set());
            }
            monthlyGroups.get(prevMonthKey).add(empInfo.id.toString());
          });
          for (const [monthKey, employeeIds] of monthlyGroups.entries()) {
            const [year, month] = monthKey.split('_').map(Number);
            const uniqueEmployeeIds = Array.from(employeeIds);
            for (let i = 0; i < uniqueEmployeeIds.length; i++) {
              const empId = uniqueEmployeeIds[i];
              try {
                if (i % 10 === 0) {
                }
                
                await new Promise(resolve => setTimeout(resolve, 20)); // Small delay
                
                const freshEmployee = await Employee.findById(empId);
                if (freshEmployee) {
                  await correctMonthlyLeaves(freshEmployee, year, month, null);
                }
                
                await optimizedFinalizeMonth(empId, year, month);
              } catch (error) {
                if (!error.message.includes('No matching document found') && 
                    !error.message.includes('version')) {
                }
              }
            }
          }

          // Enhanced cache cleanup
          const now = Date.now();
          let cleanedCount = 0;
          
          for (const [key, cached] of calculationCache.entries()) {
            if (now - cached.timestamp > CACHE_DURATION) {
              calculationCache.delete(key);
              cleanedCount++;
            }
          }
          for (const [key, cached] of finalizationCache.entries()) {
            if (now - cached.timestamp > FINALIZATION_CACHE_DURATION) {
              finalizationCache.delete(key);
              cleanedCount++;
            }
          }
          for (const [key, lock] of documentLockCache.entries()) {
            if (now - lock.timestamp > LOCK_TIMEOUT) {
              documentLockCache.delete(key);
              cleanedCount++;
            }
          }
          
          if (cleanedCount > 0) {
          }
        } catch (error) {
        }
      });

      const t10 = Date.now();

   
      const someSkipped = skippedRecords.length > 0;

      return res.status(someSkipped ? 200 : 201).json({
        success: true,
        warning: someSkipped,
        message: someSkipped ? 
          `Processed ${createdCount + updatedCount} records, skipped ${skippedRecords.length} duplicates` :
          'Extended bulk attendance processed successfully',
        elapsedTimeMs: t10 - t0,
        capacityUtilization: `${Math.round((t10 - t0) / EXTENDED_TIMEOUTS.transactionTimeout * 100)}%`,
        statistics: {
          totalRequested: attendance.length,
          created: createdCount,
          updated: updatedCount,
          skipped: skippedRecords.length,
          processedEmployees: processedEmployees.length,
          validEmployees: validEmployeesForMonth.length,
          timeoutLimit: `${EXTENDED_TIMEOUTS.transactionTimeout / 1000}s`,
          batchSizes: {
            employeeBatch: EXTENDED_EMPLOYEE_BATCH_SIZE,
            bulkOperations: 1000,
            leaveProcessing: EXTENDED_BATCH_SIZE
          }
        }
      });

    } finally {
      await readSession.endSession();
    }

  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (abortError) {
    }
    
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark bulk attendance with extended timeout',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    await session.endSession();
  }
};

// 🚀 BONUS: Enhanced utilities
const performanceMonitor = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path || req.url;
    
    if (route.includes('bulk-attendance')) {
     
    }
  });
  
  next();
};


const cleanupCaches = () => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [key, cached] of calculationCache.entries()) {
    if (now - cached.timestamp > CACHE_DURATION) {
      calculationCache.delete(key);
      cleanedCount++;
    }
  }
  
  for (const [key, cached] of finalizationCache.entries()) {
    if (now - cached.timestamp > FINALIZATION_CACHE_DURATION) {
      finalizationCache.delete(key);
      cleanedCount++;
    }
  }
  
  for (const [key, lock] of documentLockCache.entries()) {
    if (now - lock.timestamp > LOCK_TIMEOUT) {
      documentLockCache.delete(key);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
  }
};

// 🚀 BONUS: Database server configuration (run once)
const configureExtendedTimeouts = async () => {
  try {
    const adminDb = mongoose.connection.db.admin();
    
    // Set MongoDB server transaction timeout to 90 seconds (higher than our client timeout)
    await adminDb.command({ 
      setParameter: 1, 
      transactionLifetimeLimitSeconds: 90 
    });
  } catch (error) {
  }
};

// Export utilities
export {
  performanceMonitor,
  cleanupCaches,
  optimizedPreSaveHook,
  calculateProratedLeaveWithCache,
  batchProcessEmployeeLeaves,
  optimizedFinalizeMonth,
  acquireDocumentLock,
  releaseDocumentLock,
  configureExtendedTimeouts,
  EXTENDED_TIMEOUTS
};

// Auto cleanup every 10 minutes for extended operations
setInterval(cleanupCaches, 10 * 60 * 1000);


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
    
    // ✅ UPDATED: Allow larger limits for downloads (up to 10000)
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
      return res.status(400).json({ message: 'Invalid limit value (must be between 1 and 10000)' });
    }

    // ✅ FIXED: For monthly attendance, fetch employees based on ATTENDANCE location, not current employee location
    if (month && year && !employeeId) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;
      
      // ✅ STEP 1: Build attendance query based on location filter
      let attendanceMatchForEmployees = {
        date: { $gte: startStr, $lte: endStr },
        isDeleted: false,
      };

      // ✅ CRITICAL: Filter by attendance.location (where attendance was marked), not employee.location (current location)
      if (location && location !== 'all') {
        if (!mongoose.Types.ObjectId.isValid(location)) {
          return res.status(400).json({ message: 'Invalid location ID format' });
        }
        const locationExists = await Location.findById(location).lean();
        if (!locationExists) {
          return res.status(400).json({ message: 'Location not found' });
        }
        attendanceMatchForEmployees.location = new mongoose.Types.ObjectId(location);
      }

      if (status && status !== 'all') {
        if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
          return res.status(400).json({ message: 'Invalid status' });
        }
        attendanceMatchForEmployees.status = status;
      }

      // ✅ STEP 2: Get unique employee IDs from attendance records (this includes transferred employees)
      const uniqueEmployeeIds = await Attendance.distinct('employee', attendanceMatchForEmployees);

      if (uniqueEmployeeIds.length === 0) {
        return res.status(200).json({
          attendance: [],
          pagination: {
            currentPage: parsedPage,
            totalPages: 0,
            totalItems: 0,
            itemsPerPage: parsedLimit,
          },
        });
      }

      // ✅ STEP 3: Build employee query (no location filter on employees - we get them based on attendance)
      const employeeMatch = { 
        _id: { $in: uniqueEmployeeIds },
        isDeleted: false 
      };

      // Get total employee count for pagination
      const totalEmployees = await Employee.countDocuments(employeeMatch);
      const totalPages = Math.ceil(totalEmployees / parsedLimit);
      const skip = (parsedPage - 1) * parsedLimit;

      // ✅ STEP 4: Get paginated employees (sorted by employeeId)
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

      // ✅ STEP 5: Get ALL attendance records for these employees for the entire month
      let attendanceMatch = {
        employee: { $in: employeeIds },
        date: { $gte: startStr, $lte: endStr },
        isDeleted: false,
      };

      // ✅ Apply location and status filters to attendance records
      if (location && location !== 'all') {
        attendanceMatch.location = new mongoose.Types.ObjectId(location);
      }

      if (status && status !== 'all') {
        attendanceMatch.status = status;
      }

      const attendanceRecords = await Attendance.find(attendanceMatch)
        .populate('employee', 'employeeId name')
        .populate('location', 'name')
        .lean();

      // ✅ OPTIMIZATION: Skip corrections for large downloads (limit > 100)
      // Corrections are expensive and not critical for export data
      if (parsedLimit <= 100) {
        // ✅ STEP 6: Correct monthly leaves for each employee (only for small requests)
        for (const employee of employees) {
          const fullEmployee = await Employee.findById(employee._id);
          if (fullEmployee) {
            await correctMonthlyLeaves(fullEmployee, yearNum, monthNum, null);
          }
        }

        // ✅ STEP 7: Fetch FRESH corrected data after corrections
        const correctedEmployees = await Employee.find({
          _id: { $in: employeeIds }
        })
          .populate('location', 'name')
          .sort({ employeeId: 1 })
          .lean();

        // ✅ STEP 8: Structure response with CORRECTED data
        const employeeAttendanceData = correctedEmployees.map(employee => ({
          employee: employee,
          attendance: attendanceRecords.filter(att => 
            att.employee._id.toString() === employee._id.toString()
          )
        }));

        return res.status(200).json({
          attendance: employeeAttendanceData,
          pagination: {
            currentPage: parsedPage,
            totalPages,
            totalItems: totalEmployees,
            itemsPerPage: parsedLimit,
          },
        });
      } else {
        // ✅ FAST PATH: For large downloads, skip corrections and use existing data
        const employeeAttendanceData = employees.map(employee => ({
          employee: employee,
          attendance: attendanceRecords.filter(att => 
            att.employee._id.toString() === employee._id.toString()
          )
        }));

        return res.status(200).json({
          attendance: employeeAttendanceData,
          pagination: {
            currentPage: parsedPage,
            totalPages,
            totalItems: totalEmployees,
            itemsPerPage: parsedLimit,
          },
        });
      }
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
    }
    
  
    
    // ✅ STEP 3: Update request status

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
        
        if (!attendance) {
       
          await session.abortTransaction();
          return res.status(404).json({ message: 'No attendance record found for the specified date' });
        }
        
   
        
        const employee = attendance.employee;
        if (!employee) {

          await session.abortTransaction();
          return res.status(404).json({ message: 'Employee data not found' });
        }
        
    
        const oldStatus = attendance.status;
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
        }
        
    
        
        // ✅ STEP 8: Calculate leave adjustments
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
          if (availableAfterAdjustment < 1) {
         
            await session.abortTransaction();
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
            monthlyLeave.available = Math.max(0, (monthlyLeave.allocated + monthlyLeave.carriedForward) - monthlyLeave.taken);
            
            // Update employee record
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




