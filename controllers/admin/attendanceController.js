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

async function initializeMonthlyLeaves(employee, year, month, prevMonthAvailable = 0, session) {
  const monthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === year && ml.month === month
  );
  if (!monthlyLeave) {
    const allocated = 2; // Fixed allocation
    const carriedForward = month === 1 ? 0 : prevMonthAvailable; // Reset for January
    employee.monthlyLeaves.push({
      year,
      month,
      allocated,
      taken: 0,
      available: allocated + carriedForward,
      carriedForward,
    });
    await employee.save({ session });
    return employee.monthlyLeaves.find((ml) => ml.year === year && ml.month === month);
  }
  return monthlyLeave;
}

async function updateNextMonthCarryforward(employeeId, year, month, currentAvailable, session) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const employee = await Employee.findById(employeeId).session(session);
  let nextMonthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === nextYear && ml.month === nextMonth
  );
  if (!nextMonthlyLeave) {
    const allocated = 2;
    nextMonthlyLeave = {
      year: nextYear,
      month: nextMonth,
      allocated,
      taken: 0,
      available: allocated + currentAvailable,
      carriedForward: currentAvailable,
    };
    employee.monthlyLeaves.push(nextMonthlyLeave);
  } else {
    nextMonthlyLeave.carriedForward = currentAvailable;
    nextMonthlyLeave.available = nextMonthlyLeave.allocated + currentAvailable;
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

      if (status === 'leave') {
        let monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === targetDateTime.getFullYear() && ml.month === targetDateTime.getMonth() + 1
        );
        if (!monthlyLeave) {
          monthlyLeave = {
            month: targetDateTime.getMonth() + 1,
            year: targetDateTime.getFullYear(),
            allocated: 2,
            taken: 0,
            available: 2,
            carriedForward: 0,
          };
          employee.monthlyLeaves.push(monthlyLeave);
          await employee.save();
        }
        if (monthlyLeave.available < 1) {
          errors.push({
            message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${targetDateTime.getMonth() + 1}/${targetDateTime.getFullYear()}`,
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

    const leaveAdjustments = [];
    const attendanceIds = [];

    for (const record of attendanceRecords) {
      const { employee: employeeId, date, status } = record;
      const targetDateTime = new Date(date);
      const month = targetDateTime.getMonth() + 1;
      const year = targetDateTime.getFullYear();
      const dateOnlyStr = date.split('T')[0];
      const employee = await Employee.findById(employeeId);
      let leaveAdjustment = 0;
      let monthlyLeaveAdjustment = 0;

      let currentMonthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === year && ml.month === month
      );
      if (!currentMonthlyLeave) {
        currentMonthlyLeave = {
          month: month,
          year: year,
          allocated: 2,
          taken: 0,
          available: 2,
          carriedForward: 0,
        };
        employee.monthlyLeaves.push(currentMonthlyLeave);
      }

      const existingRecord = await Attendance.findOne({
        employee: employeeId,
        location: record.location,
        date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
        isDeleted: false,
      });

      if (existingRecord) {
        const oldStatus = existingRecord.status;
        if (oldStatus !== status) {
          if (oldStatus === 'leave') leaveAdjustment += 1;
          // No leave adjustment for old half-day

          if (status === 'leave') {
            if (currentMonthlyLeave.available < 1) {
              errors.push({
                message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
              });
              continue;
            }
            leaveAdjustment -= 1;
            monthlyLeaveAdjustment -= 1;
          }

          existingRecord.status = status;
          existingRecord.date = date;
          existingRecord.markedBy = userId;
          await existingRecord.save();
          attendanceIds.push(existingRecord._id.toString());

          if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
            leaveAdjustments.push({
              employeeId,
              adjustment: leaveAdjustment,
              monthlyAdjustment: monthlyLeaveAdjustment,
              year,
              month,
            });
          }
        } else {
          attendanceIds.push(existingRecord._id.toString());
        }
      } else {
        if (status === 'leave') {
          if (currentMonthlyLeave.available < 1) {
            errors.push({
              message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
            });
            continue;
          }
          leaveAdjustment = -1;
          monthlyLeaveAdjustment = -1;
        }

        const newRecord = new Attendance({
          employee: employeeId,
          date: date,
          status,
          location: record.location,
          markedBy: userId,
        });
        await newRecord.save();
        attendanceIds.push(newRecord._id.toString());

        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
          leaveAdjustments.push({
            employeeId,
            adjustment: leaveAdjustment,
            monthlyAdjustment: monthlyLeaveAdjustment,
            year,
            month,
          });
        }
      }

      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        currentMonthlyLeave.taken += -monthlyLeaveAdjustment;
        currentMonthlyLeave.available += monthlyLeaveAdjustment;
      }

      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      let nextMonthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === nextYear && ml.month === nextMonth
      );
      if (!nextMonthlyLeave) {
        nextMonthlyLeave = {
          month: nextMonth,
          year: nextYear,
          allocated: 2,
          taken: 0,
          available: 2 + currentMonthlyLeave.available,
          carriedForward: currentMonthlyLeave.available,
        };
        employee.monthlyLeaves.push(nextMonthlyLeave);
      } else {
        nextMonthlyLeave.carriedForward = currentMonthlyLeave.available;
        nextMonthlyLeave.available = nextMonthlyLeave.allocated + currentMonthlyLeave.available;
      }

      await Employee.findByIdAndUpdate(
        employeeId,
        {
          $inc: {
            'paidLeaves.available': leaveAdjustment,
            'paidLeaves.used': -leaveAdjustment,
          },
          $set: {
            monthlyLeaves: employee.monthlyLeaves,
          },
        },
        { new: true }
      );
    }

    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation errors', errors });
    }

    res.status(201).json({
      message: 'Bulk attendance marked successfully',
      attendanceIds,
    });
  } catch (error) {
    ('Bulk mark attendance error:', {
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

export const getAttendance = async (req, res) => {
  try {
    const { month, year, location, date, status, employeeId } = req.query;
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

    if (location) {
      if (!mongoose.Types.ObjectId.isValid(location)) {
        return res.status(400).json({ message: 'Invalid location ID format' });
      }
      const locationExists = await Location.findById(location).lean();
      if (!locationExists) {
        return res.status(400).json({ message: 'Location not found' });
      }
      match.location = new mongoose.Types.ObjectId(location);
    }

    if (month && year) {
      if (isNaN(month) || isNaN(year)) {
        return res.status(400).json({ message: 'Invalid month or year format' });
      }
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;
      match.date = { $gte: startStr, $lte: endStr };
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

    const attendance = await Attendance.find(match)
      .populate({
        path: 'employee',
        select: 'employeeId name monthlyLeaves',
        match: month && year ? {
          'monthlyLeaves.year': parseInt(year),
          'monthlyLeaves.month': parseInt(month),
        } : {},
        options: { lean: true },
      })
      .populate({
        path: 'location',
        select: 'name',
        options: { lean: true },
      })
      .lean();

    res.status(200).json(attendance);
  } catch (error) {
    ('getAttendance error:', {
      message: error.message,
      stack: error.stack,
      query: req.query,
    });
    res.status(500).json({ message: `Server error while fetching attendance: ${error.message}` });
  }
};

export const markAttendance = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { attendance } = req.body;

    if (!Array.isArray(attendance) || !attendance.length) {
      await session.abortTransaction();
      return res.status(400).json({
        message: 'Attendance array is required and must not be empty',
      });
    }

    const location = attendance[0]?.location;
    if (!location) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Location is required in attendance records' });
    }

    const locationExists = await Location.findById(location).session(session);
    if (!locationExists) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const employees = await Employee.find({ location }).session(session);
    if (!employees.length) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'No employees found for this location' });
    }

    const validStatuses = ['present', 'absent', 'half-day', 'leave'];
    const employeeIds = employees.map((emp) => emp._id.toString());
    const leaveAdjustments = [];
    const attendanceIds = [];

    for (const entry of attendance) {
      if (!entry.employeeId || !entry.status || !entry.date) {
        await session.abortTransaction();
        return res.status(400).json({
          message: 'Each attendance entry must have employeeId, status, and date',
        });
      }

      if (!employeeIds.includes(entry.employeeId)) {
        await session.abortTransaction();
        return res.status(400).json({ message: `Invalid employee ID: ${entry.employeeId}` });
      }

      if (!validStatuses.includes(entry.status)) {
        await session.abortTransaction();
        return res.status(400).json({
          message: `Invalid status: ${entry.status}. Must be one of ${validStatuses.join(', ')}`,
        });
      }

      const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
      if (!dateRegex.test(entry.date)) {
        await session.abortTransaction();
        return res.status(400).json({ message: `Invalid date format: ${entry.date}` });
      }

      const targetDateTime = new Date(entry.date);
      if (isNaN(targetDateTime.getTime())) {
        await session.abortTransaction();
        return res.status(400).json({ message: `Invalid date: ${entry.date}` });
      }

      const targetDate = new Date(targetDateTime.getFullYear(), targetDateTime.getMonth(), targetDateTime.getDate());
      if (targetDate > new Date()) {
        await session.abortTransaction();
        return res.status(400).json({ message: `Cannot mark attendance for future date: ${entry.date}` });
      }

      const empId = entry.employeeId;
      const newStatus = entry.status;
      let employee = employees.find((emp) => emp._id.toString() === empId);
      const month = targetDateTime.getMonth() + 1;
      const year = targetDateTime.getFullYear();
      const dateOnlyStr = entry.date.split('T')[0];

      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === prevYear && ml.month === prevMonth
      );
      const prevAvailable = prevMonthlyLeave?.available || 0;

      let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, prevAvailable);

      const existingRecord = await Attendance.findOne({
        employee: empId,
        location,
        date: { $regex: `^${dateOnlyStr}`, $options: 'i' },
        isDeleted: false,
      }).session(session);

      let leaveAdjustment = 0;
      let monthlyLeaveAdjustment = 0;

      if (existingRecord) {
        const oldStatus = existingRecord.status;
        if (oldStatus !== newStatus) {
          if (oldStatus === 'leave') {
            leaveAdjustment += 1;
            monthlyLeaveAdjustment += 1;
          }

          if (newStatus === 'leave') {
            if (monthlyLeave.available < 1) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
              });
            }
            leaveAdjustment -= 1;
            monthlyLeaveAdjustment -= 1;
          }

          existingRecord.status = newStatus;
          existingRecord.markedBy = req.user?._id || null;
          existingRecord.date = entry.date;
          await existingRecord.save({ session });
          attendanceIds.push(existingRecord._id.toString());

          if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
            leaveAdjustments.push({
              employeeId: empId,
              adjustment: leaveAdjustment,
              monthlyAdjustment: monthlyLeaveAdjustment,
              year,
              month,
            });
          }
        } else {
          attendanceIds.push(existingRecord._id.toString());
        }
      } else {
        if (newStatus === 'leave') {
          if (monthlyLeave.available < 1) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
            });
          }
          leaveAdjustment -= 1;
          monthlyLeaveAdjustment -= 1;
        }

        const newRecord = new Attendance({
          employee: empId,
          location,
          date: entry.date,
          status: newStatus,
          markedBy: req.user?._id || null,
        });
        await newRecord.save({ session });
        attendanceIds.push(newRecord._id.toString());

        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
          leaveAdjustments.push({
            employeeId: empId,
            adjustment: leaveAdjustment,
            monthlyAdjustment: monthlyLeaveAdjustment,
            year,
            month,
          });
        }
      }

      employee = await Employee.findById(empId).session(session);
    }

    for (const { employeeId, adjustment, monthlyAdjustment, year, month } of leaveAdjustments) {
      if (adjustment !== 0 || monthlyAdjustment !== 0) {
        const employee = await Employee.findById(employeeId).session(session);
        const monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === year && ml.month === month
        );
        if (monthlyLeave) {
          monthlyLeave.taken += -monthlyAdjustment;
          monthlyLeave.available += monthlyAdjustment;
          await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available);
        }

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
    }

    await session.commitTransaction();
    res.status(201).json({ message: 'Attendance marked successfully', attendanceIds });
  } catch (error) {
    await session.abortTransaction();
    ('Mark attendance error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });
    res.status(500).json({ message: 'Server error while marking attendance' });
  } finally {
    session.endSession();
  }
};

export const undoMarkAttendance = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { attendanceIds } = req.body;

    if (!Array.isArray(attendanceIds) || !attendanceIds.length) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Attendance IDs array is required and must not be empty' });
    }

    const validIds = attendanceIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!validIds.length) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'No valid attendance IDs provided' });
    }

    const records = await Attendance.find({ _id: { $in: validIds }, isDeleted: false }).session(session);
    if (!records.length) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'No valid attendance records found to undo' });
    }

    const leaveAdjustments = [];

    for (const record of records) {
      const employee = await Employee.findById(record.employee).session(session);
      if (!employee) continue;

      const targetDateTime = new Date(record.date);
      const month = targetDateTime.getMonth() + 1;
      const year = targetDateTime.getFullYear();
      let adjustment = 0;
      let monthlyAdjustment = 0;

      if (record.status === 'leave') {
        adjustment = 1;
        monthlyAdjustment = 1;
      }

      if (adjustment !== 0 || monthlyAdjustment !== 0) {
        leaveAdjustments.push({
          employeeId: employee._id,
          adjustment,
          monthlyAdjustment,
          year,
          month,
        });
      }

      record.isDeleted = true;
      record.deletedAt = new Date();
      record.deletedBy = req.user?._id || null;
      await record.save({ session });
    }

    for (const { employeeId, adjustment, monthlyAdjustment, year, month } of leaveAdjustments) {
      const employee = await Employee.findById(employeeId).session(session);
      const monthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === year && ml.month === month
      );
      if (monthlyLeave) {
        monthlyLeave.taken -= monthlyAdjustment;
        monthlyLeave.available += monthlyAdjustment;
        await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available);
      }

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

    await session.commitTransaction();
    res.status(200).json({ message: 'Attendance undone successfully' });
  } catch (error) {
    await session.abortTransaction();
    ('Undo mark attendance error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });
    res.status(500).json({ message: `Server error while undoing attendance: ${error.message}` });
  } finally {
    session.endSession();
  }
};

export const editAttendance = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { status, date } = req.body;

    if (!status || !['present', 'absent', 'half-day', 'leave'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({
        message: 'Valid status is required (present, absent, half-day, leave)',
      });
    }

    if (!date || isNaN(new Date(date).getTime())) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Valid date is required' });
    }

    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
    if (!dateRegex.test(date)) {
      await session.abortTransaction();
      return res.status(400).json({ message: `Invalid date format: ${date}` });
    }

    const targetDateTime = new Date(date);
    if (targetDateTime > new Date()) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Cannot edit attendance for a future date' });
    }

    const attendance = await Attendance.findById(id).populate('employee').session(session);
    if (!attendance || attendance.isDeleted) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const employee = attendance.employee;
    const month = targetDateTime.getMonth() + 1;
    const year = targetDateTime.getFullYear();
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonthlyLeave = employee.monthlyLeaves.find(
      (ml) => ml.year === prevYear && ml.month === prevMonth
    );
    const prevAvailable = prevMonthlyLeave?.available || 0;

    let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, prevAvailable);

    let leaveAdjustment = 0;
    let monthlyLeaveAdjustment = 0;
    const oldStatus = attendance.status;

    if (oldStatus !== status) {
      if (oldStatus === 'leave') {
        leaveAdjustment += 1;
        monthlyLeaveAdjustment += 1;
      }

      if (status === 'leave') {
        if (monthlyLeave.available < 1) {
          await session.abortTransaction();
          return res.status(400).json({ message: `Employee ${employee.name} has insufficient leaves` });
        }
        leaveAdjustment -= 1;
        monthlyLeaveAdjustment -= 1;
      }

      attendance.status = status;
      attendance.editedBy = req.user?._id || null;
      attendance.date = date;
      await attendance.save({ session });

      if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
        monthlyLeave.taken += -monthlyLeaveAdjustment;
        monthlyLeave.available += monthlyLeaveAdjustment;
        await updateNextMonthCarryforward(employee._id, year, month, monthlyLeave.available);

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

    await session.commitTransaction();
    res.json({ message: 'Attendance updated successfully', attendance });
  } catch (error) {
    await session.abortTransaction();
    ('Edit attendance error:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: 'Server error while editing attendance' });
  } finally {
    session.endSession();
  }
};

export const getAttendanceRequests = async (req, res) => {
  try {
    const requests = await AttendanceRequest.find()
      .populate({
        path: 'employee',
        select: 'name employeeId',
        options: { lean: true },
      })
      .populate({
        path: 'location',
        select: 'name',
        options: { lean: true },
      })
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

    res.json(requestsWithCurrentStatus);
  } catch (error) {
    ('Get attendance requests error:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: 'Server error while fetching attendance requests' });
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
