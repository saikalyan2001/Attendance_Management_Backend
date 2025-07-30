import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Settings from '../../models/Settings.js';
import { format } from 'date-fns';


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

// Correct all monthlyLeaves entries for an employee
async function correctMonthlyLeaves(employee, year, month, session) {
  let paidLeavesPerMonth = 2;
  try {
    const settings = await Settings.findOne().lean().session(session);
    paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
  } catch (e) {
    // Fallback to default
  }

  let totalTaken = 0;
  let lastAvailable = 0;

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
    } else {
      console.warn(`Duplicate leave entry for ${employee._id} in ${ml.month}/${ml.year}`);
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
          carriedForward: lastAvailable,
          available: paidLeavesPerMonth + lastAvailable,
        });
      }
    }
  }

  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  for (let i = 0; i < employee.monthlyLeaves.length; i++) {
    const ml = employee.monthlyLeaves[i];
    ml.taken = Math.max(ml.taken || 0, 0);
    if (ml.year < year || (ml.year === year && ml.month <= month)) {
      ml.carriedForward = lastAvailable;
      ml.available = ml.allocated + ml.carriedForward - ml.taken;
    } else {
      // For future months, only update available based on existing carriedForward
      ml.available = ml.allocated + ml.carriedForward - ml.taken;
    }
    totalTaken += ml.taken;
    lastAvailable = Math.max(ml.available, 0);
  }

  employee.paidLeaves.used = totalTaken;
  employee.paidLeaves.available = 24 - totalTaken;
  await employee.save({ session });
}


// Initialize monthly leaves for a given year and month
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
    // Find previous month's data
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
    // Correct negative taken values
    if (monthlyLeave.taken < 0) {
      monthlyLeave.taken = 0;
      monthlyLeave.available = monthlyLeave.allocated + monthlyLeave.carriedForward;
      await employee.save({ session });
    }
  }
  return monthlyLeave;
}

// Update carry-forward for the next month
async function updateNextMonthCarryforward(employeeId, year, month, available, session) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  // Fetch employee with session
  const employee = await Employee.findById(employeeId).session(session);
  if (!employee) return;

  // Find or initialize next month's leave record
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
    nextMonthlyLeave = {
      year: nextYear,
      month: nextMonth,
      allocated: paidLeavesPerMonth,
      taken: 0,
      carriedForward: available,
      available: paidLeavesPerMonth + available,
    };
    employee.monthlyLeaves.push(nextMonthlyLeave);
  } else {
    nextMonthlyLeave.carriedForward = available;
    nextMonthlyLeave.available = nextMonthlyLeave.allocated + available - Math.max(nextMonthlyLeave.taken, 0);
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
        console.warn(`Retrying transaction due to write conflict. Attempt ${retries + 1}/${maxRetries}`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, retries)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries reached for transaction');
}

export const bulkMarkAttendance = async (req, res) => {
  try {
    const { attendance, overwrite = false } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(attendance) || !attendance.length) {
      return res.status(400).json({
        message: 'Attendance array is required and must not be empty',
      });
    }

    const settings = await Settings.findOne().lean();
    const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;

    const attendanceRecords = [];
    const errors = [];
    const existingRecords = [];

    for (const record of attendance) {
      const { employeeId, date, status, location } = record;

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
      
      // Only check leave availability for 'leave' status
      if (status === 'leave') {
        const monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === year && ml.month === month
        );
        if (!monthlyLeave || monthlyLeave.available < 1) {
          errors.push({
            message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
          });
          continue;
        }
      }

      attendanceRecords.push({
        employee: employeeId,
        date: normalizedDate,
        status,
        location,
        markedBy: userId,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation errors', errors });
    }

    if (existingRecords.length > 0 && !overwrite) {
      return res.status(409).json({
        message: `Attendance already marked for ${existingRecords.length} employee(s)`,
        existingRecords,
      });
    }

    const result = await executeWithRetry(async (session) => {
      const attendanceIds = [];
      const errors = [];

      for (const record of attendanceRecords) {
        const { employee: employeeId, date, status, location } = record;
        const targetDateTime = new Date(date);
        const month = targetDateTime.getMonth() + 1;
        const year = targetDateTime.getFullYear();
        const dateOnlyStr = date.split('T')[0];

        const employee = await Employee.findById(employeeId).session(session);
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
            // Only adjust for leave status changes
            if (oldStatus === 'leave') {
              leaveAdjustment -= 1;
              monthlyLeaveAdjustment -= 1;
            }
            if (status === 'leave') {
              if (monthlyLeave.available < 1) {
                errors.push({
                  message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
                });
                continue;
              }
              leaveAdjustment += 1;
              monthlyLeaveAdjustment += 1;
            }

            existingRecord.status = status;
            existingRecord.date = date;
            existingRecord.markedBy = userId;
            await existingRecord.save({ session });
            attendanceIds.push(existingRecord._id.toString());
          } else {
            attendanceIds.push(existingRecord._id.toString());
            // Update carryforward regardless of status
            await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available, session);
            continue;
          }
        } else {
          // Only adjust for new leave records
          if (status === 'leave') {
            if (monthlyLeave.available < 1) {
              errors.push({
                message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
              });
              continue;
            }
            leaveAdjustment = 1;
            monthlyLeaveAdjustment = 1;
          }

          const newRecord = new Attendance({
            employee: employeeId,
            date,
            status,
            location,
            markedBy: userId,
          });
          await newRecord.save({ session });
          attendanceIds.push(newRecord._id.toString());
        }

        // Update leave balances if there are adjustments
        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
          monthlyLeave.taken = Math.max(monthlyLeave.taken + monthlyLeaveAdjustment, 0);
          monthlyLeave.available = monthlyLeave.allocated + monthlyLeave.carriedForward - monthlyLeave.taken;
        }

        // Always update carryforward regardless of status
        await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available, session);

        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
          await Employee.findByIdAndUpdate(
            employeeId,
            {
              $inc: {
                'paidLeaves.available': -leaveAdjustment,
                'paidLeaves.used': leaveAdjustment,
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

      if (errors.length > 0) {
        throw new Error('Validation errors during transaction');
      }

      return { attendanceIds, errors };
    });

    if (result.errors.length > 0) {
      return res.status(400).json({ message: 'Validation errors', errors: result.errors });
    }

    res.status(201).json({
      message: 'Bulk attendance marked successfully',
      attendanceIds: result.attendanceIds,
    });
  } catch (error) {
    console.error('Bulk mark attendance error:', {
      message: error.message,
      stack: error.stack,
      body: JSON.stringify(req.body, null, 2),
    });
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


export const markAttendance = async (req, res) => {
  const result = await executeWithRetry(async (session) => {
    const attendanceRecords = Array.isArray(req.body) ? req.body : [req.body];
    const settings = await Settings.findOne().lean().session(session);
    const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
    const attendanceIds = [];
    const errors = [];

    for (const record of attendanceRecords) {
      const { employeeId, date, status, location } = record;
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

      // Initialize monthly leaves for all status types
      await correctMonthlyLeaves(employee, year, month, session);
      let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, session);

      // Only check leave availability for 'leave' status
      if (status === 'leave') {
        if (monthlyLeave.available < 1) {
          errors.push({
            message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves (${monthlyLeave.available}) for ${status} on ${month}/${year}`,
          });
          continue;
        }
      }

      let leaveAdjustment = 0;
      let monthlyLeaveAdjustment = 0;
      
      // Only adjust for 'leave' status
      if (status === 'leave') {
        leaveAdjustment = 1;
        monthlyLeaveAdjustment = 1;
      }

      const attendance = new Attendance({
        employee: employeeId,
        date: normalizedDate,
        status,
        location,
        markedBy: req.user?._id || null,
      });
      await attendance.save({ session });
      attendanceIds.push(attendance._id.toString());

      // Update leave balances if there are adjustments
      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        monthlyLeave.taken = Math.max(monthlyLeave.taken + monthlyLeaveAdjustment, 0);
        monthlyLeave.available = monthlyLeave.allocated + monthlyLeave.carriedForward - monthlyLeave.taken;
      }

      // Always update carryforward regardless of status
      await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available, session);

      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        await Employee.findByIdAndUpdate(
          employeeId,
          {
            $inc: {
              'paidLeaves.available': -leaveAdjustment,
              'paidLeaves.used': leaveAdjustment,
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

    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation errors', errors });
    }

    return { message: 'Attendance marked successfully', attendanceIds };
  });

  res.status(201).json(result);
};


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
        if (monthlyLeave.available < 0.5) {
          throw new Error(`Employee ${employee.name} has insufficient leaves`);
        }
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
    const { employeeId, month, year, location, date, status, page = 1, limit = 5 } = req.query;

    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedPage) || parsedPage < 1) {
      return res.status(400).json({ message: 'Invalid page number' });
    }
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ message: 'Invalid limit value (must be between 1 and 100)' });
    }

    const match = { isDeleted: false };

    if (month && year) {
      if (isNaN(month) || isNaN(year) || month < 1 || month > 12) {
        return res.status(400).json({ message: 'Invalid month or year format' });
      }
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;
      match.date = { $gte: startStr, $lte: endStr };
    } else {
      return res.status(400).json({ message: 'Month and year are required for attendance filtering' });
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
    }

    if (status) {
      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      match.status = status;
    }

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

    const uniqueEmployees = await Attendance.distinct('employee', match).exec();
    for (const empId of uniqueEmployees) {
      const employee = await Employee.findById(empId);
      if (employee) {
        await correctMonthlyLeaves(employee, parseInt(year), parseInt(month), null);
      }
    }

    const totalItems = uniqueEmployees.length;
    const totalPages = Math.ceil(totalItems / parsedLimit);
    const skip = (parsedPage - 1) * parsedLimit;
    const paginatedEmployeeIds = uniqueEmployees.slice(skip, skip + parsedLimit);

    const attendance = await Attendance.find({
      ...match,
      employee: { $in: paginatedEmployeeIds },
    })
      .populate({
        path: 'employee',
        select: 'employeeId name monthlyLeaves',
        match: {
          _id: { $in: paginatedEmployeeIds },
          isDeleted: { $ne: true },
        },
        options: { lean: true },
      })
      .populate({
        path: 'location',
        select: 'name',
        options: { lean: true },
      })
      .sort({ date: 1 })
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
    console.error('getAttendance error:', {
      message: error.message,
      stack: error.stack,
      query: req.query,
    });
    res.status(500).json({ message: `Server error while fetching attendance: ${error.message}` });
  }
};

export const getAttendanceRequests = async (req, res) => {
  try {
    const { location, date, status, page = 1, limit = 5 } = req.query;

    // Parse pagination parameters
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedPage) || parsedPage < 1) {
      return res.status(400).json({ message: 'Invalid page number' });
    }
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ message: 'Invalid limit value (must be between 1 and 100)' });
    }

    const match = { status: { $ne: 'deleted' } }; // Assuming soft delete with status field

    // Validate and add location to match
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

    // Validate and add date to match
    if (date) {
      const inputDate = new Date(date);
      if (isNaN(inputDate.getTime())) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      const dateStr = date.split('T')[0];
      match.date = { $regex: `^${dateStr}`, $options: 'i' };
    }

    // Validate and add status to match
    if (status && status !== 'all') {
      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      match.status = status;
    }

    // Get total count for pagination
    const totalItems = await AttendanceRequest.countDocuments(match).exec();
    const totalPages = Math.ceil(totalItems / parsedLimit);
    const skip = (parsedPage - 1) * parsedLimit;

    // Fetch paginated attendance requests
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
      .sort({ date: -1 }) // Sort by date descending
      .skip(skip)
      .limit(parsedLimit)
      .lean();

    // Map over requests to add currentStatus from Attendance
    const requestsWithCurrentStatus = await Promise.all(
      requests.map(async (request) => {
        // Check if employee or location is null
        if (!request.employee || !request.location) {
          console.warn(`Skipping request with missing employee or location: ${request._id}`);
          return {
            ...request,
            currentStatus: 'N/A',
          };
        }

        const dateOnlyStr = request.date.split('T')[0]; // Extract YYYY-MM-DD
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
    console.error('Get attendance requests error:', {
      message: error.message,
      stack: error.stack,
      query: req.query,
    });
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
    ('Handle attendance request error:', {
      message: error.message,
      stack: error.stack,
    });
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
    ('Request attendance edit error:', {
      message: error.message,
      stack: error.stack,
    });
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
    }));

    const csvHeaders = ['Employee', 'Location', 'Date', 'Status'];
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
    ('Export attendance error:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: 'Server error while exporting attendance' });
  }
};




