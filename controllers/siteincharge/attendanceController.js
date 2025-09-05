import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Employee from "../../models/Employee.js";
import AttendanceRequest from "../../models/AttendanceRequest.js";
import Settings from "../../models/Settings.js";
import Location from "../../models/Location.js";
import { initializeMonthlyLeaves } from "../../utils/leaveUtils.js";

function userHasLocation(user, location) {
  const userLocationIds = user.locations.map((loc) =>
    typeof loc === "object" && loc._id ? loc._id.toString() : loc.toString()
  );
  return userLocationIds.includes(location.toString());
}


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

// Correct monthly leaves for negative values
async function correctMonthlyLeaves(employee, year, month, session) {
  const monthlyLeave = employee.monthlyLeaves.find(
    (ml) => ml.year === year && ml.month === month
  );
  if (monthlyLeave && monthlyLeave.taken < 0) {
    monthlyLeave.taken = 0;
    monthlyLeave.available = monthlyLeave.allocated + monthlyLeave.carriedForward;
    await employee.save({ session });
  }
}

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


export const markBulkAttendance = async (req, res) => {
  try {
    const { attendance, overwrite = false } = req.body;
    const userId = req.user?._id;

    // Validate user
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Validate attendance array
    if (!Array.isArray(attendance) || attendance.length === 0) {
      return res.status(400).json({ message: 'Invalid or empty attendance array' });
    }

    // Validate each attendance record
    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/;
    for (const record of attendance) {
      if (
        !record.employeeId ||
        !record.date ||
        !record.status ||
        !record.location ||
        !['present', 'absent', 'leave', 'half-day'].includes(record.status) ||
        !mongoose.isValidObjectId(record.employeeId) ||
        !mongoose.isValidObjectId(record.location) ||
        !dateRegex.test(record.date)
      ) {
        return res.status(400).json({ message: `Invalid attendance record: ${JSON.stringify(record)}` });
      }
    }

    // Start transaction
    const result = await executeWithRetry(async () => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();

        // Fetch existing attendance records
        const dateStr = attendance[0].date.split('T')[0]; // Extract YYYY-MM-DD
        const startOfDay = `${dateStr}T00:00:00.000+05:30`;
        const endOfDay = `${dateStr}T23:59:59.999+05:30`;
        const employeeIds = attendance.map((record) => record.employeeId);
        const existingRecords = await Attendance.find({
          employee: { $in: employeeIds },
          date: { $gte: startOfDay, $lte: endOfDay },
          isDeleted: false,
        })
          .session(session)
          .lean();

        // Check for existing records if overwrite is false
        if (!overwrite && Array.isArray(existingRecords) && existingRecords.length > 0) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Attendance already marked for ${existingRecords.length} employee(s) on ${dateStr}. Use overwrite option.`,
          });
        }

        // Fetch employees
        const employees = await Employee.find({
          _id: { $in: employeeIds },
          status: 'active',
        }).session(session);

        if (!Array.isArray(employees) || employees.length !== employeeIds.length) {
          await session.abortTransaction();
          return res.status(400).json({ message: 'One or more employees not found or inactive' });
        }

        // Initialize monthly leaves and process attendance
        const attendanceRecords = [];
        const year = new Date(attendance[0].date).getFullYear();
        const month = new Date(attendance[0].date).getMonth() + 1;

        for (const record of attendance) {
          const employee = employees.find(
            (emp) => emp._id.toString() === record.employeeId
          );
          if (!employee) {
            await session.abortTransaction();
            return res.status(400).json({ message: `Employee ${record.employeeId} not found` });
          }

          // Validate location
          if (employee.location.toString() !== record.location) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Employee ${employee.name} does not belong to location ${record.location}`,
            });
          }

          // Initialize monthly leaves for the current month
          await initializeMonthlyLeaves(employee, year, month, session);

          // Update monthly leaves based on status
          let monthlyLeave = employee.monthlyLeaves.find(
            (ml) => ml.year === year && ml.month === month
          );

          if (!monthlyLeave) {
            await session.abortTransaction();
            return res.status(500).json({ message: `Monthly leaves not initialized for ${employee.name}` });
          }

          // Update leave balance for leave only
          if (record.status === 'leave') {
            if (monthlyLeave.available < 1) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Insufficient leaves for ${employee.name} in ${month}/${year}`,
              });
            }
            monthlyLeave.taken += 1;
            monthlyLeave.available -= 1;
            await employee.save({ session }); // Save employee if leaves modified
          }

          // Update carryforward for the next month for all statuses
          await updateNextMonthCarryforward(employee, year, month, session);

          // Create attendance record
          attendanceRecords.push({
            employee: record.employeeId,
            date: record.date, // Use full ISO 8601 string
            status: record.status,
            location: record.location,
            markedBy: userId,
            isDeleted: false,
          });
        }

        // Insert attendance records
        const insertedRecords = await Attendance.insertMany(attendanceRecords, { session });

        // Commit transaction
        await session.commitTransaction();

        return res.status(200).json({
          message: 'Attendance marked successfully',
          attendanceIds: insertedRecords.map((record) => record._id),
        });
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });

    return result;
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Mark single attendance
export const markAttendance = async (req, res) => {
  return executeWithRetry(async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const attendanceRecords = Array.isArray(req.body) ? req.body : [req.body];
      const userId = req.user._id;
      const errors = [];
      const updatedRecords = [];

      const userLocationIds = req.user.location.map((loc) =>
        loc.toString()
      );

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

        if (status === "leave" || status === "half-day") {
          await correctMonthlyLeaves(employee, year, month, session);
        }

        let monthlyLeave = await initializeMonthlyLeaves(employee, year, month, session);

        if ((status === "leave" || status === "half-day") && monthlyLeave.available <= 0) {
          errors.push({
            message: `No leave balance available for ${employeeId}`,
          });
          continue;
        }

        let leaveDeduction = 0;
        if (status === "leave") {
          leaveDeduction = 1;
        } else if (status === "half-day") {
          leaveDeduction = 0.5;
        }

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
    const limitNum = Math.min(parseInt(limit, 10), 100);
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
    const limitNum = Math.min(parseInt(limit, 10), 100); // Cap limit to prevent abuse

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