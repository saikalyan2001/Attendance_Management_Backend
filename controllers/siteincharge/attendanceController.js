import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Employee from "../../models/Employee.js";
import AttendanceRequest from "../../models/AttendanceRequest.js";
import Settings from "../../models/Settings.js";
import Location from "../../models/Location.js";

function userHasLocation(user, location) {
  const userLocationIds = user.locations.map((loc) =>
    typeof loc === "object" && loc._id ? loc._id.toString() : loc.toString()
  );
  return userLocationIds.includes(location.toString());
}

// Correct all monthlyLeaves entries for an employee
async function correctMonthlyLeaves(employee, year, month, session) {
  const paidLeavesPerMonth = 2;
  let totalTaken = 0;
  let lastAvailable = 0;

  // Sort monthlyLeaves by year and month to ensure correct order
  employee.monthlyLeaves.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  for (let i = 0; i < employee.monthlyLeaves.length; i++) {
    const ml = employee.monthlyLeaves[i];
    // Correct negative taken values
    ml.taken = Math.max(ml.taken || 0, 0);
    // Only apply carriedForward for months before the target year/month
    if (ml.year < year || (ml.year === year && ml.month < month)) {
      ml.carriedForward = lastAvailable;
      ml.available = ml.allocated + ml.carriedForward - ml.taken;
    } else {
      // Reset carriedForward for current and future months
      ml.carriedForward = 0;
      ml.available = ml.allocated - ml.taken;
    }
    totalTaken += ml.taken;
    lastAvailable = Math.max(ml.available, 0);
  }

  // Update paidLeaves
  employee.paidLeaves.used = totalTaken;
  employee.paidLeaves.available = 24 - totalTaken; // Assuming annual allocation of 24
  await employee.save({ session });
}

// Initialize monthly leaves for a given year and month
async function initializeMonthlyLeaves(employee, year, month, session) {
  const paidLeavesPerMonth = 2;
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
      monthlyLeave.available =
        monthlyLeave.allocated + monthlyLeave.carriedForward;
      await employee.save({ session });
    }
  }
  return monthlyLeave;
}

// Update carry-forward for the next month
async function updateNextMonthCarryforward(
  employeeId,
  year,
  month,
  available,
  session
) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  // Fetch employee with session
  const employee = await Employee.findById(employeeId).session(session);
  if (!employee) return;

  // Find or initialize next month's leave record
  let nextMonthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === nextYear && ml.month === nextMonth
  );

  // Get paidLeavesPerMonth from settings if available, else default to 2
  let paidLeavesPerMonth = 2;
  try {
    const settings = await Settings.findOne().lean().session(session);
    paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
  } catch (e) {
    // fallback to default
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
    nextMonthlyLeave.available =
      nextMonthlyLeave.allocated +
      available -
      Math.max(nextMonthlyLeave.taken, 0);
  }

  await employee.save({ session });
}

// Retry transaction on write conflict
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
      if (error.codeName === "WriteConflict" && retries < maxRetries - 1) {
        retries++;
        console.warn(
          `Retrying transaction due to write conflict. Attempt ${retries + 1}/${maxRetries}`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * Math.pow(2, retries))
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error("Max retries reached for transaction");
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
    ("Error calculating salary impact:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const markBulkAttendance = async (req, res) => {
  return executeWithRetry(async (session) => {
    try {
      const { attendance, overwrite = false } = req.body;
      const userId = req.user._id;

      if (!Array.isArray(attendance) || !attendance.length) {
        return res.status(400).json({
          message: "Attendance array is required and must not be empty",
        });
      }

      // Validate attendance array elements
      for (const record of attendance) {
        if (
          typeof record !== "object" ||
          !record.employeeId ||
          !record.date ||
          !record.status ||
          !record.location
        ) {
          return res.status(400).json({
            message: `Invalid attendance record: ${JSON.stringify(record)}`,
          });
        }
      }

      const settings = await Settings.findOne().lean().session(session);
      const halfDayDeduction = settings?.halfDayDeduction || 0.5;
      const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
      const attendanceRecords = [];
      const errors = [];
      const existingRecords = [];

      for (const record of attendance) {
        const { employeeId, date, status, location } = record;

        if (!["present", "absent", "leave", "half-day"].includes(status)) {
          errors.push({
            message: `Invalid status '${status}' for employee ${employeeId}`,
          });
          continue;
        }

        if (
          !mongoose.isValidObjectId(employeeId) ||
          !mongoose.isValidObjectId(location)
        ) {
          errors.push({
            message: `Invalid ObjectId for employee ${employeeId} or location ${location}`,
          });
          continue;
        }

        const targetDateTime = new Date(date);
        if (isNaN(targetDateTime.getTime())) {
          errors.push({
            message: `Invalid date for employee ${employeeId}: ${date}`,
          });
          continue;
        }

        const targetDate = new Date(
          targetDateTime.getFullYear(),
          targetDateTime.getMonth(),
          targetDateTime.getDate()
        );
        if (targetDate > new Date()) {
          errors.push({
            message: `Cannot mark attendance for future date ${date} for employee ${employeeId}`,
          });
          continue;
        }

        const employee = await Employee.findById(employeeId).session(session);
        if (!employee) {
          errors.push({ message: `Employee ${employeeId} not found` });
          continue;
        }

        if (!userHasLocation(req.user, location)) {
          errors.push({
            message: `Location ${location} not assigned to user for employee ${employeeId}`,
          });
          continue;
        }

        const locationExists =
          await Location.findById(location).session(session);
        if (!locationExists) {
          errors.push({ message: `Location ${location} not found` });
          continue;
        }

        const dateOnlyStr = date.split("T")[0];
        const existingRecord = await Attendance.findOne({
          employee: employeeId,
          location,
          date: { $regex: `^${dateOnlyStr}`, $options: "i" },
          isDeleted: false,
        }).session(session);

        if (existingRecord && !overwrite) {
          existingRecords.push({
            employeeId,
            date: existingRecord.date,
            status: existingRecord.status,
          });
          continue;
        }

        const month = targetDateTime.getMonth() + 1;
        const year = targetDateTime.getFullYear();

        // Initialize or correct monthly leaves
        if (status === "leave" || status === "half-day" || existingRecord) {
          await correctMonthlyLeaves(employee, year, month, session);
        }

        let monthlyLeave = await initializeMonthlyLeaves(
          employee,
          year,
          month,
          session
        );

        if (status === "leave") {
          if (monthlyLeave.available < 1) {
            errors.push({
              message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves (${monthlyLeave.available}) for leave on ${month}/${year}`,
            });
            continue;
          }
        }

        attendanceRecords.push({
          employee: employeeId,
          date,
          status,
          location,
          markedBy: userId,
        });
      }

      if (errors.length > 0) {
        return res.status(400).json({ message: "Validation errors", errors });
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
        const { employee: employeeId, date, status, location } = record;
        const targetDateTime = new Date(date);
        const month = targetDateTime.getMonth() + 1;
        const year = targetDateTime.getFullYear();
        const dateOnlyStr = date.split("T")[0];

        const employee = await Employee.findById(employeeId).session(session);
        let monthlyLeave = employee.monthlyLeaves.find(
          (ml) => ml.year === year && ml.month === month
        );

        let leaveAdjustment = 0;
        let monthlyAdjustment = 0;

        const existingRecord = await Attendance.findOne({
          employee: employeeId,
          location,
          date: { $regex: `^${dateOnlyStr}`, $options: "i" },
          isDeleted: false,
        }).session(session);

        if (existingRecord) {
          const oldStatus = existingRecord.status;
          if (oldStatus !== status) {
            if (oldStatus === "leave") {
              leaveAdjustment -= 1;
              monthlyAdjustment -= 1;
            }

            if (status === "leave") {
              if (monthlyLeave.available < 1) {
                errors.push({
                  message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
                });
                continue;
              }
              leaveAdjustment += 1;
              monthlyAdjustment += 1;
            }

            existingRecord.status = status;
            existingRecord.date = date;
            existingRecord.markedBy = userId;
            await existingRecord.save({ session });
            attendanceIds.push(existingRecord._id.toString());
          } else {
            attendanceIds.push(existingRecord._id.toString());
            continue;
          }
        } else {
          if (status === "leave") {
            if (monthlyLeave.available < 1) {
              errors.push({
                message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves for ${month}/${year}`,
              });
              continue;
            }
            leaveAdjustment = 1;
            monthlyAdjustment = 1;
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

        if (leaveAdjustment !== 0 || monthlyAdjustment !== 0) {
          leaveAdjustments.push({
            employeeId,
            adjustment: leaveAdjustment,
            monthlyAdjustment,
            year,
            month,
          });
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({ message: "Validation errors", errors });
      }

      // Process leave adjustments
      for (const { employeeId, adjustment, monthlyAdjustment, year, month } of leaveAdjustments) {
  const employee = await Employee.findById(employeeId).session(session);
  if (!employee) {
    errors.push({ message: `Employee ${employeeId} not found during leave update` });
    continue;
  }

  let monthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === year && ml.month === month
  );
  if (!monthlyLeave) {
    errors.push({ message: `No monthly leave record for employee ${employeeId} in ${month}/${year}` });
    continue;
  }

  (`Before leave update for ${employeeId}:`, {
    taken: monthlyLeave.taken,
    available: monthlyLeave.available,
    paidLeaves: employee.paidLeaves,
  });

  monthlyLeave.taken = Math.max(monthlyLeave.taken + monthlyAdjustment, 0);
  monthlyLeave.available = monthlyLeave.allocated + monthlyLeave.carriedForward - monthlyLeave.taken;
  employee.paidLeaves.used = Math.max(employee.paidLeaves.used + adjustment, 0);
  employee.paidLeaves.available = Math.max(24 - employee.paidLeaves.used, 0);

  try {
    await employee.save({ session });
    (`After leave update for ${employeeId}:`, {
      taken: monthlyLeave.taken,
      available: monthlyLeave.available,
      paidLeaves: employee.paidLeaves,
    });
  } catch (saveError) {
    (`Failed to save employee ${employeeId}:`, saveError);
    errors.push({ message: `Failed to save leave updates for ${employeeId}` });
  }

  await updateNextMonthCarryforward(employeeId, year, month, monthlyLeave.available, session);
}

      if (errors.length > 0) {
        return res.status(400).json({ message: "Validation errors", errors });
      }

      return res.status(201).json({
        message: "Bulk attendance marked successfully",
        attendanceIds,
        attendance: attendanceRecords,
      });
    } catch (error) {
      throw error;
    }
  }).catch((error) => {
    ("Bulk mark attendance error:", {
      message: error.message,
      stack: error.stack,
      body: JSON.stringify(req.body, null, 2),
    });
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Attendance already marked for some employees",
        existingRecords: [],
      });
    }
    res.status(500).json({
      message: `Server error while marking bulk attendance: ${error.message}`,
      existingRecords: [],
      errors: [],
    });
  });
};

export const markAttendance = async (req, res) => {
  return executeWithRetry(async (session) => {
    try {
      const attendanceRecords = Array.isArray(req.body) ? req.body : [req.body];
      const settings = await Settings.findOne().lean().session(session);
      const halfDayDeduction = settings?.halfDayDeduction || 0.5;
      const paidLeavesPerMonth = (settings?.paidLeavesPerYear || 24) / 12;
      const attendanceIds = [];
      const errors = [];

      for (const record of attendanceRecords) {
        const { employeeId, date, status, location } = record;
        if (!employeeId || !date || !status || !location) {
          errors.push({
            message: `Missing required fields for employee ${employeeId}`,
          });
          continue;
        }

        if (
          !mongoose.isValidObjectId(employeeId) ||
          !mongoose.isValidObjectId(location)
        ) {
          errors.push({
            message: `Invalid employeeId ${employeeId} or location ${location}`,
          });
          continue;
        }

        if (!userHasLocation(req.user, location)) {
          errors.push({ message: `Location ${location} not assigned to user` });
          continue;
        }

        const dateRegex =
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
        if (!dateRegex.test(date)) {
          errors.push({ message: `Invalid date format: ${date}` });
          continue;
        }

        const targetDateTime = new Date(date);
        if (isNaN(targetDateTime.getTime())) {
          errors.push({ message: `Invalid date: ${date}` });
          continue;
        }
        const targetDate = new Date(
          targetDateTime.getFullYear(),
          targetDateTime.getMonth(),
          targetDateTime.getDate()
        );
        if (targetDate > new Date()) {
          errors.push({
            message: `Cannot mark attendance for future date: ${date}`,
          });
          continue;
        }

        const employee = await Employee.findOne({
          _id: employeeId,
          isDeleted: false,
        }).session(session);
        if (!employee) {
          errors.push({
            message: `Employee ${employeeId} does not exist or is deleted`,
          });
          continue;
        }

        const dateOnlyStr = date.split("T")[0];
        const existing = await Attendance.findOne({
          employee: employeeId,
          date: { $regex: `^${dateOnlyStr}`, $options: "i" },
          location,
          isDeleted: false,
        }).session(session);

        if (existing) {
          errors.push({
            message: `Attendance already marked for ${employeeId} on ${dateOnlyStr}`,
          });
          continue;
        }

        if (!["present", "absent", "half-day", "leave"].includes(status)) {
          errors.push({ message: `Invalid status ${status}` });
          continue;
        }

        const month = targetDateTime.getMonth() + 1;
        const year = targetDateTime.getFullYear();

        // Only correct leaves if status affects leave balance
        if (status === "leave" || status === "half-day") {
          await correctMonthlyLeaves(employee, year, month, session);
        }

        let monthlyLeave = await initializeMonthlyLeaves(
          employee,
          year,
          month,
          session
        );

        if (status === "leave" || status === "half-day") {
          const requiredLeaves = status === "leave" ? 1 : halfDayDeduction;
          if (monthlyLeave.available < requiredLeaves) {
            errors.push({
              message: `Employee ${employee.name} (${employee.employeeId}) has insufficient leaves (${monthlyLeave.available}) for ${status} on ${month}/${year}`,
            });
            continue;
          }
        }

        let leaveAdjustment = 0;
        let monthlyLeaveAdjustment = 0;
        if (status === "leave") {
          leaveAdjustment = 1;
          monthlyLeaveAdjustment = 1;
        }

        const attendance = new Attendance({
          employee: employeeId,
          date,
          status,
          location,
          markedBy: req.user._id,
        });
        await attendance.save({ session });
        attendanceIds.push(attendance._id.toString());

        if (leaveAdjustment !== 0 || monthlyLeaveAdjustment !== 0) {
          monthlyLeave.taken = Math.max(
            monthlyLeave.taken + monthlyLeaveAdjustment,
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
                "paidLeaves.available": -leaveAdjustment,
                "paidLeaves.used": leaveAdjustment,
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

      if (errors.length > 0) {
        return res.status(400).json({ message: "Validation errors", errors });
      }

      return res
        .status(201)
        .json({ message: "Attendance marked successfully", attendanceIds });
    } catch (error) {
      throw error;
    }
  }).catch((error) => {
    ("Error marking attendance:", error);
    res.status(500).json({ message: "Server error" });
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
            monthlyLeave.taken - monthlyAdjustment,
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
    ("Error undoing attendance:", error);
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
    ("Error requesting attendance edit:", error);
    res.status(500).json({ message: "Server error" });
  });
};

// Unchanged functions
export const getAttendance = async (req, res) => {
  try {
    const { date, location } = req.query;
    if (!date || !location) {
      return res
        .status(400)
        .json({ message: "Date and location are required" });
    }

    const dateRegex =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ message: `Invalid date format: ${date}` });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res
        .status(400)
        .json({ message: `Invalid location ID ${location}` });
    }
    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({ message: "Location not assigned to user" });
    }

    const dateOnlyStr = date.split("T")[0];
    const attendance = await Attendance.find({
      date: { $regex: `^${dateOnlyStr}`, $options: "i" },
      location: new mongoose.Types.ObjectId(location),
      isDeleted: false,
    }).populate("employee", "name employeeId");

    res.status(200).json({ attendance });
  } catch (error) {
    ("Error fetching attendance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getMonthlyAttendance = async (req, res) => {
  try {
    const { month, year, location, isDeleted } = req.query;
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

    const date = new Date(parsedYear, parsedMonth, 1);
    const dateOnlyStr = date.toISOString().split("T")[0];
    const endDate = new Date(parsedYear, parsedMonth + 1, 0, 23, 59, 59, 999); // Last day of the month, end of day
    const endDateOnlyStr = endDate.toISOString().split("T")[0] + "T23:59:59.999+05:30";

    console.log("Querying attendance with:", {
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lte: endDateOnlyStr,
      },
      location,
      isDeleted: isDeleted === "false" ? false : true,
    });

    const attendance = await Attendance.find({
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lte: endDateOnlyStr, // Changed from $lt to $lte and extended to end of day
      },
      location,
      isDeleted: isDeleted === "false" ? false : true,
    })
      .populate("employee", "name employeeId")
      .lean();

    console.log("Found attendance records:", attendance.length);

    res.status(200).json({ data: attendance });
  } catch (error) {
    console.error("Error fetching monthly attendance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getEmployeeAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    ("getEmployeeAttendance:", {
      email: req.user.email,
      role: req.user.role,
      employeeId: id,
      month,
      year,
    });
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid employee ID" });
    }

    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required" });
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

    const date = new Date(parsedYear, parsedMonth, 1);
    const dateOnlyStr = date.toISOString().split("T")[0];
    const endDate = new Date(parsedYear, parsedMonth + 1, 1);
    const endDateOnlyStr = endDate.toISOString().split("T")[0];

    const attendance = await Attendance.find({
      employee: new mongoose.Types.ObjectId(id),
      date: {
        $gte: `${dateOnlyStr}T00:00:00+05:30`,
        $lt: `${endDateOnlyStr}T00:00:00+05:30`,
      },
      location: { $in: req.user.locations },
    })
      .sort({ date: -1 })
      .lean();

    res.json({ attendance });
  } catch (error) {
    ("Get employee attendance error:", {
      message: error.message,
      stack: error.stack,
    });
    res
      .status(500)
      .json({ message: "Server error while fetching employee attendance" });
  }
};

export const getAttendanceEditRequests = async (req, res) => {
  try {
    const { location } = req.query;
    ("getAttendanceEditRequests:", {
      user: req.user.email,
      role: req.user.role,
      location,
    });

    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: "Valid location ID is required" });
    }

    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({
        message: "Location not assigned to user",
        userLocations: req.user.locations.map((loc) =>
          typeof loc === "object" && loc._id
            ? loc._id.toString()
            : loc.toString()
        ),
        requestedLocation: location.toString(),
      });
    }

    const requests = await AttendanceRequest.find({
      requestedBy: req.user._id,
      location: new mongoose.Types.ObjectId(location),
    })
      .populate("employee", "name employeeId")
      .sort({ createdAt: -1 })
      .lean();

    const requestsWithStatus = await Promise.all(
      requests.map(async (request) => {
        // Check if employee is populated and has a valid _id
        if (!request.employee || !request.employee._id) {
          console.warn(`Invalid employee reference in AttendanceRequest: ${request._id}`);
          return {
            ...request,
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

    res.json({ requests: requestsWithStatus });
  } catch (error) {
    ("Get attendance edit requests error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      message: "Server error while fetching attendance edit requests",
    });
  }
};
