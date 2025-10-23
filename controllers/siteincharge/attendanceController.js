import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Employee from "../../models/Employee.js";
import AttendanceRequest from "../../models/AttendanceRequest.js";
import Settings from "../../models/Settings.js";
import Location from "../../models/Location.js";
import { initializeMonthlyLeaves } from "../../utils/leaveUtils.js";
import { isWorkingDay, getWorkingDayPolicyInfo, shouldCountForSalary } from '../../utils/workingDayValidator.js';
import { getHolidaysForLocation } from '../../controllers/admin/settingsController.js';

// 🚀 ENHANCED: Global caches and configuration
const calculationCache = new Map();
const finalizationCache = new Map();
const documentLockCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const FINALIZATION_CACHE_DURATION = 20 * 60 * 1000; // 20 minutes
const LOCK_TIMEOUT = 60000; // 60 seconds

// 🚀 ENHANCED: Extended timeout configuration
const EXTENDED_TIMEOUTS = {
  transactionTimeout: 60000,       // 60 seconds for complex operations
  queryTimeout: 45000,             // 45 seconds per query
  connectionTimeout: 30000,        // 30 seconds connection timeout
  socketTimeout: 65000,            // 65 seconds socket timeout
  serverSelectionTimeout: 15000    // 15 seconds server selection
};


// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function userHasLocation(user, location) {
  const userLocationIds = user.locations.map((loc) =>
    typeof loc === "object" && loc._id ? loc._id.toString() : loc.toString()
  );
  return userLocationIds.includes(location.toString());
}

function getISTDateComponents(date) {
  const dateObj = new Date(date);
  const month = dateObj.getMonth() + 1;
  const year = dateObj.getFullYear();
  return { month, year };
}

const createCacheKey = (employeeId, year, month, type) => {
  return `${employeeId}_${year}_${month}_${type}`;
};

const createFinalizationKey = (employeeId, year, month, type) => {
  return `${employeeId}_${year}_${month}_${type}`;
};

const releaseDocumentLock = (docId) => {
  const lockKey = docId.toString();
  documentLockCache.delete(lockKey);
};

const normalizeDate = (date) => {
  const d = new Date(date);
  return d.toISOString().split('T')[0];
};

const isEmployeeProrated = (employee, settings) => {
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  
  const joinedMidYear = joinMonth > 1 && joinYear === currentYear;
  const fullYearAllocation = settings?.paidLeavesPerYear || 24;
  const currentAllocated = employee.paidLeaves?.allocated || 0;
  const hasReducedAllocation = currentAllocated > 0 && currentAllocated < fullYearAllocation;
  
  return joinedMidYear || hasReducedAllocation || employee.isProratedEmployee === true;
};

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
}

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
          setTimeout(checkLock, 200);
        }
      };
      setTimeout(checkLock, 100);
    });
  }
  
  documentLockCache.set(lockKey, { timestamp: now });
  return true;
};

async function processEmployeeAttendanceBatch(employee, records, settings, session) {
  const wasProrated = isEmployeeProrated(employee, settings);
  if (wasProrated) {
    employee.isManualPaidLeavesUpdate = true;
  }
  
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
  
  for (const [monthKey, { year, month, records: monthRecords }] of monthGroups) {
    let monthlyLeave = employee.monthlyLeaves.find(ml => 
      ml.year === year && ml.month === month
    );
    
    if (!monthlyLeave) {
      const joinDate = new Date(employee.joinDate);
      const recordDate = new Date(year, month - 1, 1);
      
      if (recordDate >= joinDate) {
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
          carriedForward: carriedForward,
          available: paidLeavesPerMonth + carriedForward,
          isFinalized: false,
          finalizedAt: null
        };
        employee.monthlyLeaves.push(monthlyLeave);
        
        employee.monthlyLeaves.sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          return a.month - b.month;
        });
      }
    }
    
    let netLeaveChange = 0;
    
    for (const record of monthRecords) {
      if (record.existingRecord) {
        const oldStatus = record.existingRecord.status;
        if (oldStatus === 'leave') {
          netLeaveChange -= 1;
        } else if (oldStatus === 'half-day') {
          netLeaveChange -= 0.5;
        }
      }
      
      if (record.status === 'leave') {
        netLeaveChange += 1;
      } else if (record.status === 'half-day') {
        netLeaveChange += 0.5;
      }
    }
    
    if (netLeaveChange !== 0) {
      const newTaken = Math.max(0, monthlyLeave.taken + netLeaveChange);
      const totalAvailableForMonth = (monthlyLeave.allocated || 0) + (monthlyLeave.carriedForward || 0);
      
      const cappedTaken = Math.min(newTaken, totalAvailableForMonth);
      const unpaidUsage = Math.max(0, newTaken - totalAvailableForMonth);
      
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
  
  const joinDate = new Date(employee.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const fullYearAllocation = settings?.paidLeavesPerYear || 24;
  
  const currentAllocated = employee.paidLeaves?.allocated || 0;
  
  const joinedMidYear = joinMonth > 1 && joinYear === year;
  const hasReducedAllocation = currentAllocated > 0 && currentAllocated < fullYearAllocation;
  const isProratedFlag = employee.isProratedEmployee === true;
  
  const isProrated = joinedMidYear || hasReducedAllocation || isProratedFlag;
  
  let totalTaken = 0;
  employee.monthlyLeaves.forEach(ml => {
    totalTaken += (ml.taken || 0);
  });
  
  if (isProrated && currentAllocated > 0) {
    if (!employee.isManualPaidLeavesUpdate) {
      employee.set('paidLeaves.allocated', currentAllocated);
      employee.set('paidLeaves.available', Math.max(0, currentAllocated - totalTaken));
      employee.set('paidLeaves.used', totalTaken);
    }
  } else {
    if (!employee.isManualPaidLeavesUpdate) {
      employee.set('paidLeaves.allocated', fullYearAllocation);
      employee.set('paidLeaves.available', Math.max(0, fullYearAllocation - totalTaken));
      employee.set('paidLeaves.used', totalTaken);
    }
  }
  
  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
  
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

const finalizeMonthIfNeeded = async (employeeId, year, month) => {
  try {
    const employee = await Employee.findById(employeeId);
    if (!employee) return false;

    const monthlyLeave = employee.monthlyLeaves?.find(ml => 
      ml.year === year && ml.month === month
    );

    if (monthlyLeave && !monthlyLeave.isFinalized) {
      monthlyLeave.isFinalized = true;
      monthlyLeave.finalizedAt = new Date();
      await employee.save();
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
};

const optimizedFinalizeMonth = async (employeeId, year, month) => {
  const cacheKey = createFinalizationKey(employeeId, year, month, 'finalize');
  
  const cached = finalizationCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < FINALIZATION_CACHE_DURATION) {
    return cached.result;
  }
  
  try {
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
    if (!error.message.includes('No matching document found') &&
        !error.message.includes('version')) {
      // Silent error handling
    }
    throw error;
  }
};


// Utility to execute operations with retry logic
const executeWithRetry = async (operation, maxRetries = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.name === "MongoServerError" && error.code === 112) {

        if (attempt === maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
};



// Update carryforward for the next month
async function updateNextMonthCarryforward(employee, year, month, session) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const settings = await Settings.findOne().lean().session(session);
  const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

  let nextMonthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === nextYear && ml.month === nextMonth
  );

  const currentMonthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === year && ml.month === month
  );

  if (currentMonthlyLeave) {
    const carryForward = Math.max(currentMonthlyLeave.available, 0);

    if (!nextMonthlyLeave) {
      nextMonthlyLeave = {
        year: nextYear,
        month: nextMonth,
        allocated: paidLeavesPerMonth,
        taken: 0,
        carriedForward: carryForward,
        available: carryForward + paidLeavesPerMonth,
      };
      employee.monthlyLeaves.push(nextMonthlyLeave);
    } else {
      nextMonthlyLeave.carriedForward = carryForward;
      nextMonthlyLeave.available = nextMonthlyLeave.allocated + carryForward;
    }

    await employee.save({ session });
  }
}


export const calculateSalaryImpact = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    if (!month || !year || !location) {
      return res
        .status(400)
        .json({ message: "Month, year, and location are required" });
    }

    const parsedMonth = parseInt(month) - 1;
    const parsedYear = parseInt(year);
    if (
      isNaN(parsedMonth) ||
      isNaN(parsedYear) ||
      parsedMonth < 0 ||
      parsedMonth > 11
    ) {
      return res.status(400).json({ message: "Invalid month or year" });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res
        .status(400)
        .json({ message: `Invalid location ID ${location}` });
    }
    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({ message: "Location not assigned to user" });
    }

    const settings = await Settings.findOne().lean();
    const halfDayDeduction = settings?.halfDayDeduction || 0.5;
    const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

    const startDate = new Date(parsedYear, parsedMonth, 1);
    const endDate = new Date(parsedYear, parsedMonth + 1, 1);
    const dateOnlyStr = startDate.toISOString().split("T")[0];
    const endDateOnlyStr = endDate.toISOString().split("T")[0];

    const attendance = await Attendance.find({
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lt: `${endDateOnlyStr}T00:00:00+05:30`,
      },
      location: new mongoose.Types.ObjectId(location),
      isDeleted: false,
    }).populate("employee", "employeeId name");

    const employeeAttendance = {};
    attendance.forEach((record) => {
      const empId = record.employee._id.toString();
      if (!employeeAttendance[empId]) {
        employeeAttendance[empId] = {
          leaves: 0,
          absents: 0,
          halfDays: 0,
          employee: record.employee,
        };
      }
      if (record.status === "leave") employeeAttendance[empId].leaves += 1;
      else if (record.status === "absent")
        employeeAttendance[empId].absents += 1;
      else if (record.status === "half-day")
        employeeAttendance[empId].halfDays += 1;
    });

    const salaryCalculations = Object.entries(employeeAttendance).map(
      ([empId, data]) => {
        const leavesUsed = Math.min(data.leaves, paidLeavesPerMonth);
        const remainingPaidLeaves = paidLeavesPerMonth - leavesUsed;
        const totalLossDays = data.absents + data.halfDays * halfDayDeduction;
        const coveredLossDays = Math.min(totalLossDays, remainingPaidLeaves);
        const unpaidDays = totalLossDays - coveredLossDays;

        return {
          employeeId: data.employee.employeeId,
          name: data.employee.name,
          leaves: data.leaves,
          absents: data.absents,
          halfDays: data.halfDays,
          paidLeaveUsed: leavesUsed + coveredLossDays,
          unpaidDays,
        };
      }
    );

    res.status(200).json({ salaryCalculations });
  } catch (error) {

    res.status(500).json({ message: "Server error" });
  }
};



// ✅ NEW: Get working day policy for a location endpoint
export const getLocationWorkingDayPolicy = async (req, res) => {
  
  
  
  
  try {
    const { locationId, date } = req.query;
    

    if (!locationId) {
      
      return res.status(400).json({ message: 'Location ID is required' });
    }

    // ✅ Check if user has access to this location
    if (!userHasLocation(req.user, locationId)) {
      return res.status(403).json({ message: 'Location not assigned to user' });
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

// ✅ NEW: Validate attendance date endpoint
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



// ✅ SITEINCHARGE-SPECIFIC: Working day validation
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

// ============================================================================
// MAIN BULK ATTENDANCE CONTROLLER
// ============================================================================

export const markBulkAttendance = async (req, res) => {
  const t0 = Date.now();
  
  // 🚀 ENHANCED: Extended session configuration
  const session = await mongoose.startSession({
    defaultTransactionOptions: {
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      writeConcern: { 
        w: 'majority', 
        wtimeout: EXTENDED_TIMEOUTS.connectionTimeout
      },
      maxTimeMS: EXTENDED_TIMEOUTS.transactionTimeout
    }
  });

  try {
    await session.startTransaction({
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      writeConcern: { 
        w: 'majority', 
        wtimeout: EXTENDED_TIMEOUTS.connectionTimeout 
      },
      maxTimeMS: EXTENDED_TIMEOUTS.transactionTimeout
    });

    const { attendance, overwrite = false } = req.body;
    const userId = req.user?._id;
    const t1 = Date.now();

    // Enhanced validation with early returns
    if (!userId || !mongoose.isValidObjectId(userId)) {
      await session.abortTransaction();
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }

    if (!attendance || !Array.isArray(attendance) || attendance.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'No attendance records provided' });
    }

    const firstRecord = attendance[0];
    if (!firstRecord.date) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Date is required for attendance records' });
    }

    const { month, year } = getISTDateComponents(firstRecord.date);
    const employeeIds = [...new Set(attendance.map(r => r.employeeId))];
    const dateStr = firstRecord.date.split('T')[0];

    const t2 = Date.now();

    // 🚀 ENHANCED: Extended read session
    const readSession = await mongoose.startSession();
    
    try {
      const queryTimeout = EXTENDED_TIMEOUTS.queryTimeout;
      
      const [employees, existingRecords, settings] = await Promise.all([
        Employee.find(
          { _id: { $in: employeeIds }, isDeleted: false },
          { 
            _id: 1, 
            employeeId: 1, 
            name: 1, 
            joinDate: 1, 
            location: 1,
            monthlyLeaves: 1,
            __v: 1
          }
        ).maxTimeMS(queryTimeout).session(readSession),
        
        Attendance.find({
          employee: { $in: employeeIds },
          date: { $regex: `^${dateStr}`, $options: 'i' },
          isDeleted: { $ne: true }
        }, { employee: 1, date: 1, location: 1, status: 1, _id: 1 }).maxTimeMS(queryTimeout).session(readSession),
        
        Settings.findOne({}, { 
          leaveSettings: 1, 
          attendanceSettings: 1,
          holidays: 1,
          workingDayPolicies: 1,
          paidLeavesPerYear: 1
        }).populate('workingDayPolicies.locations').maxTimeMS(queryTimeout).session(readSession)
      ]);

      const t3 = Date.now();

      if (employees.length === 0) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'No valid employees found' });
      }

      // 🔥 HOLIDAY VALIDATION
      const checkDate = new Date(firstRecord.date);
      const checkYear = checkDate.getFullYear();
      const checkMonth = checkDate.getMonth() + 1;
      const uniqueLocations = [...new Set(attendance.map(record => record.location).filter(Boolean))];

      const locationHolidays = {};
      for (const locationId of uniqueLocations) {
        const holidays = getHolidaysForLocation(settings, locationId, checkYear, checkMonth);
        const isHoliday = holidays.some(holiday => {
          const holidayDate = new Date(holiday.date);
          return holidayDate.toDateString() === checkDate.toDateString();
        });
        
        if (isHoliday) {
          const holidayInfo = holidays.find(h => new Date(h.date).toDateString() === checkDate.toDateString());
          locationHolidays[locationId] = holidayInfo;
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
      }

      // Enhanced validation with progress tracking
      const validationPromises = employees.map((employee, index) => {
        return new Promise((resolve) => {
          try {
            validateMonthlyLeaveConsistency(employee, year, month);
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

      const attendanceDate = new Date(firstRecord.date);
      const validEmployeesForMonth = employees.filter(e => {
        const joinDate = new Date(e.joinDate);
        return joinDate <= attendanceDate;
      });

      const t4 = Date.now();

      // 🚀 ENHANCED: Batch processing for leave initialization
      const EXTENDED_BATCH_SIZE = 20;
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

      // 🚀 OPTIMIZED: Pre-build location policy map for O(1) lookups
      const employeeMap = new Map(validEmployeesForMonth.map(e => [e._id.toString(), e]));
      const existingRecordsMap = new Map(
        existingRecords.map(r => [`${r.employee.toString()}_${r.date.split('T')[0]}_${r.location}`, r])
      );

      // 🚀 NEW: Create location-to-policy map ONCE (no DB queries in loop)
      const locationPolicyMap = new Map();
      if (settings?.workingDayPolicies) {
        for (const policy of settings.workingDayPolicies) {
          for (const loc of policy.locations) {
            locationPolicyMap.set(loc._id.toString(), {
              policyName: policy.policyName,
              policyType: policy.policyType,
              excludeDays: policy.excludeDays || []
            });
          }
        }
      }

      // 🚀 NEW: Fast working day validator (no DB queries)
      const fastIsWorkingDay = (locationId, date) => {
        const policy = locationPolicyMap.get(locationId.toString());
        if (!policy) return true; // Default: all days are working days
        
        const targetDate = new Date(date);
        const dayOfWeek = targetDate.getDay(); // 0=Sunday, 6=Saturday
        
        switch (policy.policyType) {
          case 'all_days':
            return true;
          case 'exclude_sundays':
            return dayOfWeek !== 0;
          case 'exclude_weekends':
            return dayOfWeek !== 0 && dayOfWeek !== 6;
          default:
            return !policy.excludeDays.includes(dayOfWeek);
        }
      };

      const processedRecords = [];
      const skippedRecords = [];
      const validationErrors = [];
      const workingDayWarnings = [];
      
      // 🚀 OPTIMIZED VALIDATION LOOP - No DB queries!
      for (const record of attendance) {
        const { employeeId, date, status, location, isException, exceptionReason, exceptionDescription } = record;
        const eid = employeeId.toString();
        
        if (!employeeMap.has(eid)) continue;
        
        const employee = employeeMap.get(eid);

        // ✅ SITEINCHARGE: Location access validation
        if (!userHasLocation(req.user, location)) {
          validationErrors.push({ message: `Location ${location} not assigned to user` });
          continue;
        }

        // ✅ SITEINCHARGE: Employee location validation
        if (employee.location.toString() !== location) {
          validationErrors.push({
            message: `Employee ${employee.name} does not belong to location ${location}`,
          });
          continue;
        }

        // 🚀 OPTIMIZED: Fast working day validation (no DB queries)
        const isWorking = fastIsWorkingDay(location, date);
        const policyInfo = locationPolicyMap.get(location.toString()) || { 
          policyName: 'All Calendar Days', 
          policyType: 'all_days' 
        };
        
        if (!isWorking && !isException) {
          validationErrors.push({
            message: `Cannot mark attendance for ${employee.name} on ${date.split('T')[0]} - ${policyInfo.policyName} excludes this day. Use exception marking if needed.`
          });
          continue;
        }

        if (!isWorking && !isException) {
          workingDayWarnings.push({
            employeeId,
            employeeName: employee.name,
            date: date.split('T')[0],
            policyInfo: policyInfo,
            message: `${employee.name}: ${date.split('T')[0]} is not a working day per ${policyInfo.policyName}. Consider marking as exception.`
          });
        }

        // ✅ SITEINCHARGE: Exception validation
        if (isException) {
          if (!exceptionReason) {
            validationErrors.push({ message: `Exception reason is required for ${employee.name} on non-working day` });
            continue;
          }
          if (exceptionReason === 'other' && !exceptionDescription) {
            validationErrors.push({ message: `Exception description is required when reason is 'other' for ${employee.name}` });
            continue;
          }
        }

        // Check existing records
        const recordKey = `${eid}_${record.date.split('T')[0]}_${location}`;
        const existingRecord = existingRecordsMap.get(recordKey);
        
        if (existingRecord && !overwrite) {
          skippedRecords.push(record);
          continue;
        }
        
        processedRecords.push({
          ...record,
          markedBy: userId,
          existingRecord,
          employeeDoc: employee
        });
      }

      const t6 = Date.now();

      // Return validation errors if any
      if (validationErrors.length > 0) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false,
          message: 'Validation errors', 
          errors: validationErrors,
          workingDayWarnings: workingDayWarnings.length > 0 ? workingDayWarnings : undefined
        });
      }

      if (processedRecords.length === 0) {
        await session.abortTransaction();
        const allSkipped = skippedRecords.length > 0;
        return res.status(allSkipped ? 409 : 400).json({
          success: false,
          message: allSkipped ? 'All records already exist' : 'No valid attendance records to process',
          workingDayWarnings: workingDayWarnings.length > 0 ? workingDayWarnings : undefined
        });
      }

      // 🚀 ENHANCED: Employee batch processing
      const EXTENDED_EMPLOYEE_BATCH_SIZE = 8;
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
                let presenceDays = 0;
                if (record.status === 'present') {
                  presenceDays = 1.0;
                } else if (record.status === 'half-day') {
                  presenceDays = 0.5;
                }

                if (record.existingRecord) {
                  bulkOps.push({
                    updateOne: {
                      filter: { _id: record.existingRecord._id },
                      update: {
                        $set: {
                          status: record.status,
                          isException: record.isException || false,
                          exceptionReason: record.exceptionReason,
                          exceptionDescription: record.exceptionDescription,
                          markedBy: userId,
                          presenceDays,
                          approvedBy: record.isException ? userId : undefined,
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
                        isException: record.isException || false,
                        exceptionReason: record.exceptionReason,
                        exceptionDescription: record.exceptionDescription,
                        markedBy: userId,
                        presenceDays,
                        approvedBy: record.isException ? userId : undefined,
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
          
          // Enhanced save with retry logic
          let saveAttempts = 0;
          const maxAttempts = 5;
          
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
                await new Promise(resolve => setTimeout(resolve, 100 + (saveAttempts * 50)));
              } else {
                throw error;
              }
            }
          }
        }
      }

      const t7 = Date.now();

      // 🚀 ENHANCED: Bulk operations
      let createdCount = 0, updatedCount = 0;
      
      if (allBulkOps.length > 0) {
        const EXTENDED_BULK_SIZE = 1000;
        for (let i = 0; i < allBulkOps.length; i += EXTENDED_BULK_SIZE) {
          const bulkChunk = allBulkOps.slice(i, i + EXTENDED_BULK_SIZE);
          
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

      // Background finalization
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
                await new Promise(resolve => setTimeout(resolve, 20));
                
                const freshEmployee = await Employee.findById(empId);
                if (freshEmployee) {
                  await correctMonthlyLeaves(freshEmployee, year, month, null);
                }
                
                await optimizedFinalizeMonth(empId, year, month);
              } catch (error) {
                // Silent error handling
              }
            }
          }

          // Cache cleanup
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
        } catch (error) {
          // Silent background error handling
        }
      });

      const t10 = Date.now();

      const someSkipped = skippedRecords.length > 0;


      return res.status(someSkipped ? 200 : 201).json({
        success: true,
        warning: someSkipped,
        message: someSkipped ? 
          `Processed ${createdCount + updatedCount} records, skipped ${skippedRecords.length} duplicates` :
          'Bulk attendance marked successfully',
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
          },
          timingBreakdown: {
            initialization: `${t2-t1}ms`,
            databaseQueries: `${t3-t2}ms`,
            employeeValidation: `${t4-t3}ms`,
            leaveInitialization: `${t5-t4}ms`,
            validationLoop: `${t6-t5}ms`,
            employeeProcessing: `${t7-t6}ms`,
            bulkWrite: `${t8-t7}ms`,
            commit: `${t9-t8}ms`
          }
        },
        workingDayWarnings: workingDayWarnings.length > 0 ? workingDayWarnings : undefined
      });

    } finally {
      await readSession.endSession();
    }

  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (abortError) {
      // Silent abort error handling
    }
    
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark bulk attendance',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    await session.endSession();
  }
};




// Mark single attendance
// Update the existing markAttendance function in your controller
export const markAttendance = async (req, res) => {
  return executeWithRetry(async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const attendanceRecords = Array.isArray(req.body) ? req.body : [req.body];
      const userId = req.user._id;
      const errors = [];
      const updatedRecords = [];

      const userLocationIds = req.user.location.map((loc) => loc.toString());

      for (const record of attendanceRecords) {
        const { employeeId, date, status, location } = record;

        if (!mongoose.isValidObjectId(employeeId)) {
          errors.push({ message: `Invalid employee ID: ${employeeId}` });
          continue;
        }

        if (!mongoose.isValidObjectId(location)) {
          errors.push({ message: `Invalid location ID: ${location}` });
          continue;
        }

        if (!userLocationIds.includes(location.toString())) {
          errors.push({ message: `Unauthorized location: ${location}` });
          continue;
        }

        const targetDateTime = new Date(date);
        if (isNaN(targetDateTime.getTime())) {
          errors.push({ message: `Invalid date: ${date}` });
          continue;
        }

        if (!["present", "absent", "leave", "half-day"].includes(status)) {
          errors.push({ message: `Invalid status for ${employeeId}: ${status}` });
          continue;
        }

        const employee = await Employee.findById(employeeId).session(session);
        if (!employee) {
          errors.push({ message: `Employee ${employeeId} not found` });
          continue;
        }

        const locationDoc = await Location.findById(location).session(session);
        if (!locationDoc) {
          errors.push({ message: `Location ${location} not found` });
          continue;
        }

        if (employee.location.toString() !== location.toString()) {
          errors.push({
            message: `Employee ${employeeId} does not belong to location ${location}`,
          });
          continue;
        }

        const month = targetDateTime.getMonth() + 1;
        const year = targetDateTime.getFullYear();
        const dateString = targetDateTime.toISOString().split("T")[0];

        let existingRecord = await Attendance.findOne({
          employee: employeeId,
          date: dateString,
        }).session(session);

        if (existingRecord) {
          errors.push({
            message: `Attendance already marked for ${employeeId} on ${dateString}`,
          });
          continue;
        }

        // ✅ ENHANCED: Initialize monthly leaves for both leave and half-day
        if (status === "leave" || status === "half-day") {
          await correctMonthlyLeaves(employee, year, month, session);
        }

        let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, session);

        // ✅ REMOVED: Half-day validation - allow negative balance
        // Only check for full leave
        if (status === "leave" && monthlyLeave.available < 1) {
          errors.push({
            message: `No leave balance available for ${employeeId}`,
          });
          continue;
        }

        let leaveDeduction = 0;
        let presenceDays = 0; // ✅ NEW: Calculate presence days

        if (status === "leave") {
          leaveDeduction = 1;
          presenceDays = 0;
        } else if (status === "half-day") {
          leaveDeduction = 0.5; // ✅ ENHANCED: Half-day deduction
          presenceDays = 0.5;
        } else if (status === "present") {
          presenceDays = 1.0;
        }
        // absent = 0 presence days

        if (leaveDeduction > 0) {
          monthlyLeave.taken += leaveDeduction;
          monthlyLeave.available = Math.max(
            monthlyLeave.allocated + monthlyLeave.carriedForward - monthlyLeave.taken,
            0
          );
          await employee.save({ session });
          await updateNextMonthCarryforward(employee, year, month, session);
        }

        const newAttendance = new Attendance({
          employee: employeeId,
          date: dateString,
          status,
          location,
          createdBy: userId,
          updatedBy: userId,
          presenceDays: presenceDays, // ✅ NEW: Store presence value
        });

        await newAttendance.save({ session });

        updatedRecords.push({
          employeeId,
          date: dateString,
          status,
          location,
        });
      }

      await session.commitTransaction();
      session.endSession();

      if (errors.length > 0 && updatedRecords.length === 0) {
        return res.status(400).json({ message: "No records updated", errors });
      }

      const message =
        updatedRecords.length > 0
          ? "Attendance marked successfully"
          : "No attendance records were updated";

      return res.status(200).json({
        message,
        updatedRecords,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }).catch((error) => {
    res.status(500).json({ message: "Server error", error: error.message });
  });
};


export const undoAttendance = async (req, res) => {
  return executeWithRetry(async (session) => {
    try {
      const { attendanceIds } = req.body;
      if (!Array.isArray(attendanceIds) || attendanceIds.length === 0) {
        return res.status(400).json({ message: "Invalid attendance IDs" });
      }

      const settings = await Settings.findOne().lean().session(session);
      const halfDayDeduction = settings?.halfDayDeduction || 0.5;
      const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

      const attendances = await Attendance.find({
        _id: { $in: attendanceIds },
        isDeleted: false,
      }).session(session);

      if (!attendances.length) {
        return res
          .status(404)
          .json({ message: "No valid attendance records found to undo" });
      }

      const leaveAdjustments = [];

      for (const attendance of attendances) {
        const employeeId = attendance.employee.toString();
        const month = new Date(attendance.date).getMonth() + 1;
        const year = new Date(attendance.date).getFullYear();

        const employee = await Employee.findById(employeeId).session(session);
        if (!employee) continue;

        await correctMonthlyLeaves(employee, year, month, session);

        let monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === year && ml.month === month
        );
        if (!monthlyLeave) {
          monthlyLeave = {
            month,
            year,
            allocated: paidLeavesPerMonth,
            taken: 0,
            carriedForward: 0,
            available: paidLeavesPerMonth,
          };
          employee.monthlyLeaves.push(monthlyLeave);
          await employee.save({ session });
        }

        let leaveAdjustment = 0;
        let monthlyLeaveAdjustment = 0;
        if (attendance.status === "leave") {
          leaveAdjustment = 1;
          monthlyLeaveAdjustment = 1;
        }

        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
          leaveAdjustments.push({
            employeeId,
            adjustment: leaveAdjustment,
            monthlyAdjustment: monthlyLeaveAdjustment,
            year,
            month,
          });
        }

        attendance.isDeleted = true;
        await attendance.save({ session });
      }

      for (const {
        employeeId,
        adjustment,
        monthlyAdjustment,
        year,
        month,
      } of leaveAdjustments) {
        const employee = await Employee.findById(employeeId).session(session);
        const monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === year && ml.month === month
        );
        if (monthlyLeave) {
          monthlyLeave.taken = Math.max(
            monthlyLeave.taken - monthlyLeaveAdjustment,
            0
          );
          monthlyLeave.available =
            monthlyLeave.allocated +
            monthlyLeave.carriedForward -
            monthlyLeave.taken;
          await updateNextMonthCarryforward(
            employeeId,
            year,
            month,
            monthlyLeave.available,
            session
          );

          await Employee.findByIdAndUpdate(
            employeeId,
            {
              $inc: {
                "paidLeaves.available": adjustment,
                "paidLeaves.used": -adjustment,
              },
              $set: {
                "monthlyLeaves.$[elem].taken": monthlyLeave.taken,
                "monthlyLeaves.$[elem].available": monthlyLeave.available,
              },
            },
            {
              arrayFilters: [{ "elem.year": year, "elem.month": month }],
              session,
              new: true,
            }
          );
        }
      }

      return res
        .status(200)
        .json({ message: "Attendance undone successfully" });
    } catch (error) {
      throw error;
    }
  }).catch((error) => {

    res.status(500).json({ message: "Server error" });
  });
};

export const requestAttendanceEdit = async (req, res) => {
  return executeWithRetry(async (session) => {
    try {
      const { employeeId, date, currentStatus, newStatus, reason, location } =
        req.body;
      if (
        !employeeId ||
        !date ||
        !currentStatus ||
        !newStatus ||
        !reason ||
        !location
      ) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const dateRegex =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
      if (!dateRegex.test(date)) {
        return res
          .status(400)
          .json({ message: `Invalid date format: ${date}` });
      }

      const targetDateTime = new Date(date);
      if (isNaN(targetDateTime.getTime())) {
        return res.status(400).json({ message: `Invalid date: ${date}` });
      }

      const employee = await Employee.findOne({
        _id: employeeId,
        location,
        isDeleted: false,
      }).session(session);
      if (!employee) {
        return res
          .status(400)
          .json({ message: "Invalid employee or location" });
      }

      await correctMonthlyLeaves(
        employee,
        targetDateTime.getFullYear(),
        targetDateTime.getMonth() + 1,
        session
      );

      const dateOnlyStr = date.split("T")[0];
      const attendance = await Attendance.findOne({
        employee: employeeId,
        date: { $regex: `^${dateOnlyStr}`, $options: "i" },
        location,
        isDeleted: false,
      }).session(session);

      if (!attendance) {
        return res.status(400).json({ message: "No attendance record found" });
      }

      if (attendance.status !== currentStatus) {
        return res
          .status(400)
          .json({ message: "Current status does not match record" });
      }

      if (!["present", "absent", "half-day", "leave"].includes(newStatus)) {
        return res.status(400).json({ message: "Invalid new status" });
      }

      const settings = await Settings.findOne().lean().session(session);
      const halfDayDeduction = settings?.halfDayDeduction || 0.5;
      const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

      const month = targetDateTime.getMonth() + 1;
      const year = targetDateTime.getFullYear();
      let monthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === year && ml.month === month
      );
      if (!monthlyLeave) {
        monthlyLeave = await initializeMonthlyLeaves(
          employee,
          year,
          month,
          session
        );
      }

      if (newStatus === "leave") {
        if (monthlyLeave.available < 1) {
          return res.status(400).json({
            message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves (${monthlyLeave.available}) for leave on ${month}/${year}`,
          });
        }
      }

      const editRequest = new AttendanceRequest({
        employee: employeeId,
        date,
        currentStatus,
        requestedStatus: newStatus,
        reason,
        location,
        requestedBy: req.user._id,
        status: "pending",
      });

      await editRequest.save({ session });
      return res
        .status(201)
        .json({ message: "Edit request submitted successfully" });
    } catch (error) {
      throw error;
    }
  }).catch((error) => {

    res.status(500).json({ message: "Server error" });
  });
};

export const getAttendance = async (req, res) => {
  try {
    const { date, location, status, page = 1, limit = 5, isDeleted = false } = req.query;

    if (!location) {
      return res.status(400).json({ message: "Location is required" });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: `Invalid location ID ${location}` });
    }
    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({ message: "Location not assigned to user" });
    }

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 10000);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid pagination parameters" });
    }

    const query = {
      location: new mongoose.Types.ObjectId(location),
      isDeleted: isDeleted === "false" ? false : true,
    };

    if (date) {
      // Validate date format (YYYY-MM-DD or full ISO)
      const dateRegex = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})?)?$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({ message: `Invalid date format: ${date}` });
      }

      // Extract YYYY-MM-DD and create a date range for the entire day
      const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!dateMatch) {
        return res.status(400).json({ message: `Invalid date format: ${date}` });
      }
      const [_, year, month, day] = dateMatch;
      // Use UTC to avoid timezone shifts; convert to IST (+05:30) explicitly
      const startDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
      startDate.setHours(startDate.getHours() + 5, startDate.getMinutes() + 30); // Adjust to IST
      const endDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
      endDate.setHours(endDate.getHours() + 5, endDate.getMinutes() + 30); // Adjust to IST

      query.date = {
        $gte: startDate.toISOString(),
        $lte: endDate.toISOString(),
      };
    }

    if (status && status !== "all") {
      if (!["present", "absent", "half-day", "leave"].includes(status)) {
        return res.status(400).json({ message: `Invalid status: ${status}` });
      }
      query.status = status;
    }

 // Debug query

    // Fetch total count for pagination
    const total = await Attendance.countDocuments(query);

    // Fetch paginated attendance
    const attendance = await Attendance.find(query)
      .populate("employee", "name employeeId")
      .sort({ date: -1, updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

 // Debug results

    res.status(200).json({
      attendance,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {

    res.status(500).json({ message: "Server error" });
  }
};

export const getMonthlyAttendance = async (req, res) => {
  try {
    const { month, year, location, isDeleted = false, page = 1, limit = 5 } = req.query;
    if (!month || !year || !location) {
      return res
        .status(400)
        .json({ message: "Month, year, and location are required" });
    }

    const parsedMonth = parseInt(month) - 1;
    const parsedYear = parseInt(year);
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 10000); // Cap limit to prevent abuse

    if (
      isNaN(parsedMonth) ||
      isNaN(parsedYear) ||
      parsedMonth < 0 ||
      parsedMonth > 11
    ) {
      return res.status(400).json({ message: "Invalid month or year" });
    }

    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid pagination parameters" });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res
        .status(400)
        .json({ message: `Invalid location ID ${location}` });
    }
    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({ message: "Location not assigned to user" });
    }

    const startDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
    const endDate = new Date(Date.UTC(parsedYear, parsedMonth + 1, 0, 23, 59, 59, 999));
    const dateOnlyStr = startDate.toISOString().split("T")[0];
    const endDateOnlyStr = endDate.toISOString().split("T")[0] + "T23:59:59.999+05:30";

  

    // Fetch total count of employees for pagination
    const totalEmployees = await Employee.countDocuments({
      location: new mongoose.Types.ObjectId(location),
      isDeleted: false,
    });

    // Fetch paginated employees
    const employees = await Employee.find({
      location: new mongoose.Types.ObjectId(location),
      isDeleted: false,
    })
      .select("name employeeId")
      .sort({ name: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    // Fetch all attendance records for these employees for the specified month
    const employeeIds = employees.map((emp) => emp._id);
    const attendance = await Attendance.find({
      employee: { $in: employeeIds },
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lte: endDateOnlyStr,
      },
      location: new mongoose.Types.ObjectId(location),
      isDeleted: isDeleted === "false" ? false : true,
    })
      .populate("employee", "name employeeId")
      .sort({ date: -1, updatedAt: -1 })
      .lean();



    // Structure response to include employees and their attendance
    const data = employees.map((employee) => ({
      employee,
      attendance: attendance.filter(
        (att) => att.employee._id.toString() === employee._id.toString()
      ),
    }));

    res.status(200).json({
      data,
      pagination: {
        total: totalEmployees,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalEmployees / limitNum),
      },
    });
  } catch (error) {

    res.status(500).json({ message: "Server error" });
  }
};

export const getEmployeeAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year, page = 1, limit = 10 } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid employee ID" });
    }

    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required" });
    }

    const parsedMonth = parseInt(month) - 1;
    const parsedYear = parseInt(year);
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);

    if (
      isNaN(parsedMonth) ||
      isNaN(parsedYear) ||
      parsedMonth < 0 ||
      parsedMonth > 11
    ) {
      return res.status(400).json({ message: "Invalid month or year" });
    }

    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid pagination parameters" });
    }

    const employee = await Employee.findById(id).lean();
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const userLocationIds = req.user.locations.map((loc) =>
      typeof loc === "object" && loc._id ? loc._id.toString() : loc.toString()
    );
    const employeeLocationId = typeof employee.location === "object" && employee.location._id
      ? employee.location._id.toString()
      : employee.location.toString();

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: "Employee not in assigned location" });
    }

    const startDate = new Date(Date.UTC(parsedYear, parsedMonth, 1));
    const endDate = new Date(Date.UTC(parsedYear, parsedMonth + 1, 1));
    const dateOnlyStr = startDate.toISOString().split("T")[0];
    const endDateOnlyStr = endDate.toISOString().split("T")[0];

    // Fetch total count for pagination
    const total = await Attendance.countDocuments({
      employee: new mongoose.Types.ObjectId(id),
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lt: `${endDateOnlyStr}T00:00:00+05:30`,
      },
      location: { $in: req.user.locations },
      isDeleted: false,
    });

    // Fetch paginated attendance
    const attendance = await Attendance.find({
      employee: new mongoose.Types.ObjectId(id),
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lt: `${endDateOnlyStr}T00:00:00+05:30`,
      },
      location: { $in: req.user.locations },
      isDeleted: false,
    })
      .sort({ date: -1, updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    res.json({
      attendance,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching employee attendance" });
  }
};

export const getAttendanceEditRequests = async (req, res) => {
  try {
    const { location, page = 1, limit = 3, status } = req.query;
  

    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: "Valid location ID is required" });
    }

    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({
        message: "Location not assigned to user",
        userLocations: req.user.locations.map((loc) =>
          typeof loc === "object" && loc._id ? loc._id.toString() : loc.toString()
        ),
        requestedLocation: location.toString(),
      });
    }

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid pagination parameters" });
    }

    const query = {
      location: new mongoose.Types.ObjectId(location),
      // Remove isDeleted filter temporarily to debug
      // isDeleted: false,
    };

    if (status && status !== "all") {
      if (!["pending", "approved", "rejected"].includes(status)) {
        return res.status(400).json({ message: `Invalid status: ${status}` });
      }
      query.status = status;
    }

    // Debug: Log all AttendanceRequest documents for the location
    const allRequests = await AttendanceRequest.find({ location: new mongoose.Types.ObjectId(location) }).lean();


    // Fetch total count for pagination
    const total = await AttendanceRequest.countDocuments(query);

    // Fetch paginated attendance edit requests
    const requests = await AttendanceRequest.find(query)
      .populate("employee", "name employeeId")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();



    const requestsWithStatus = await Promise.all(
      requests.map(async (request) => {
        if (!request.employee || !request.employee._id) {

          return {
            ...request,
            employee: { name: "Unknown", employeeId: "N/A" }, // Fallback for missing employee
            currentStatus: "N/A",
            error: "Employee data missing or invalid",
          };
        }

        const dateOnlyStr = request.date.split("T")[0];
        const attendance = await Attendance.findOne({
          employee: request.employee._id,
          location: request.location,
          date: { $regex: `^${dateOnlyStr}`, $options: "i" },
          isDeleted: false,
        }).lean();

        return {
          ...request,
          currentStatus: attendance ? attendance.status : "N/A",
        };
      })
    );

    res.json({
      requests: requestsWithStatus,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error while fetching attendance edit requests",
    });
  }
};
