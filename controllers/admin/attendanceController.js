import mongoose from 'mongoose';
import Attendance from "../../models/Attendance.js";
import AttendanceRequest from "../../models/AttendanceRequest.js";
import Employee from "../../models/Employee.js";
import Location from "../../models/Location.js";
import { format, parseISO, isValid } from "date-fns";

export const getAttendance = async (req, res) => {
  try {
    const { month, year, location, date, status, employeeId } = req.query;
    const match = { isDeleted: false };

    console.log('getAttendance query:', req.query);

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
      const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
      const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999);
      if (!isValid(startDate) || !isValid(endDate)) {
        return res.status(400).json({ message: 'Invalid date range' });
      }
      match.date = { $gte: startDate, $lte: endDate };
    } else {
      console.log('No month/year provided, fetching all non-deleted attendance');
    }

    if (date) {
      const parsedDate = parseISO(date);
      if (!isValid(parsedDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      const dateStart = new Date(parsedDate.setHours(0, 0, 0, 0));
      const dateEnd = new Date(parsedDate.setHours(23, 59, 59, 999));
      match.date = { $gte: dateStart, $lte: dateEnd };
    }

    if (status) {
      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      match.status = status;
    }

    console.log('MongoDB query match:', match);

    const attendance = await Attendance.find(match)
      .populate({
        path: 'employee',
        select: 'employeeId name',
        options: { lean: true },
      })
      .populate({
        path: 'location',
        select: 'name',
        options: { lean: true },
      })
      .lean();

    console.log('getAttendance result:', attendance.length, 'records', attendance);

    res.status(200).json(attendance);
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
    const requests = await AttendanceRequest.find()
      .populate("employee", "name employeeId")
      .populate("location", "name")
      .lean();

    console.log('getAttendanceRequests result:', requests.length, 'records');
    res.json(requests);
  } catch (error) {
    console.error("Get attendance requests error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Server error while fetching attendance requests" });
  }
};

export const handleAttendanceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || !["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Valid status is required (approved, rejected)" });
    }

    const request = await AttendanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Attendance request not found" });
    }

    request.status = status;
    request.reviewedAt = new Date();
    request.reviewedBy = req.user?._id || null;
    await request.save();

    if (status === "approved") {
      const attendance = await Attendance.findOne({
        employee: request.employee,
        location: request.location,
        date: request.date,
        isDeleted: { $ne: true },
      }).populate("employee");
      if (attendance) {
        const employee = attendance.employee;
        let leaveAdjustment = 0;

        const oldStatus = attendance.status;
        const newStatus = request.requestedStatus;

        if (oldStatus !== newStatus) {
          if (oldStatus === "leave") leaveAdjustment += 1;
          else if (oldStatus === "half-day") leaveAdjustment += 0.5;
          if (newStatus === "leave") leaveAdjustment -= 1;
          else if (newStatus === "half-day") leaveAdjustment -= 0.5;

          if (
            leaveAdjustment < 0 &&
            employee.paidLeaves.available < Math.abs(leaveAdjustment)
          ) {
            return res.status(400).json({ message: "Employee has insufficient leaves" });
          }

          attendance.status = newStatus;
          attendance.editedBy = req.user?._id || null;
          await attendance.save();

          if (leaveAdjustment !== 0) {
            employee.paidLeaves.available += leaveAdjustment;
            employee.paidLeaves.used -= leaveAdjustment;
            await employee.save();
          }
        }
      }
    }

    res.json({ message: `Request ${status} successfully`, request });
  } catch (error) {
    console.error("Handle attendance request error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Server error while handling attendance request" });
  }
};

export const requestAttendanceEdit = async (req, res) => {
  try {
    const { attendanceId, requestedStatus, reason } = req.body;
    if (!attendanceId || !requestedStatus || !reason) {
      return res.status(400).json({
        message: "Attendance ID, requested status, and reason are required",
      });
    }
    if (!["present", "absent", "leave", "half-day"].includes(requestedStatus)) {
      return res.status(400).json({
        message: "Invalid requested status (present, absent, leave, half-day)",
      });
    }

    const attendance = await Attendance.findById(attendanceId);
    if (!attendance || attendance.isDeleted) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    const request = new AttendanceRequest({
      employee: attendance.employee,
      location: attendance.location,
      date: attendance.date,
      requestedStatus,
      reason,
      status: "pending",
      requestedBy: req.user?._id || null,
    });

    await request.save();
    res.status(201).json(request);
  } catch (error) {
    console.error("Request attendance edit error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Server error while requesting attendance edit" });
  }
};

export const exportAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required" });
    }
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const match = {
      date: { $gte: startDate, $lte: endDate },
      isDeleted: { $ne: true },
    };
    if (location) {
      const locationExists = await Location.findById(location);
      if (!locationExists) {
        return res.status(400).json({ message: "Invalid location ID" });
      }
      match.location = location;
    }

    const attendance = await Attendance.find(match)
      .populate("employee", "name employeeId")
      .populate("location", "name")
      .lean();

    console.log('exportAttendance result:', attendance.length, 'records');

    const csvData = attendance.map((record) => ({
      Employee: `${record.employee?.name || "Unknown"} (${record.employee?.employeeId || "N/A"})`,
      Location: record.location?.name || "N/A",
      Date: format(new Date(record.date), "yyyy-MM-dd"),
      Status: record.status.charAt(0).toUpperCase() + record.status.slice(1),
    }));

    const csvHeaders = ["Employee", "Location", "Date", "Status"];
    const csvRows = [csvHeaders.join(",")];
    csvData.forEach((row) => {
      const values = csvHeaders.map((header) => `"${row[header]}"`);
      csvRows.push(values.join(","));
    });

    const csvContent = csvRows.join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=attendance_${month}_${year}.csv`
    );
    res.send(csvContent);
  } catch (error) {
    console.error("Export attendance error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Server error while exporting attendance" });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const { attendance } = req.body;
    if (!Array.isArray(attendance) || !attendance.length) {
      return res.status(400).json({
        message: "Attendance array is required and must not be empty",
      });
    }
    const location = attendance[0]?.location;
    if (!location) {
      return res.status(400).json({ message: "Location is required in attendance records" });
    }
    const locationExists = await Location.findById(location);
    if (!locationExists) {
      return res.status(400).json({ message: "Invalid location ID" });
    }
    const employees = await Employee.find({ location });
    if (!employees.length) {
      return res.status(400).json({ message: "No employees found for this location" });
    }
    const validStatuses = ["present", "absent", "half-day", "leave"];
    const employeeIds = employees.map((emp) => emp._id.toString());
    const leaveAdjustments = [];
    const attendanceIds = [];
    for (const entry of attendance) {
      if (!entry.employeeId || !entry.status || !entry.date) {
        return res.status(400).json({
          message: "Each attendance entry must have employeeId, status, and date",
        });
      }
      if (!employeeIds.includes(entry.employeeId)) {
        return res.status(400).json({ message: `Invalid employee ID: ${entry.employeeId}` });
      }
      if (!validStatuses.includes(entry.status)) {
        return res.status(400).json({
          message: `Invalid status: ${entry.status}. Must be one of ${validStatuses.join(", ")}`,
        });
      }
      const parsedDate = parseISO(entry.date);
      if (!isValid(parsedDate) || parsedDate > new Date()) {
        return res.status(400).json({ message: `Invalid or future date: ${entry.date}` });
      }
      const empId = entry.employeeId;
      const targetDate = parsedDate;
      const dateStart = new Date(targetDate.setHours(0, 0, 0, 0));
      const dateEnd = new Date(targetDate.setHours(23, 59, 59, 999));
      const newStatus = entry.status;
      const employee = employees.find((emp) => emp._id.toString() === empId);
      const existingRecord = await Attendance.findOne({
        employee: empId,
        location,
        date: { $gte: dateStart, $lte: dateEnd },
        isDeleted: false,
      });
      let leaveAdjustment = 0;
      if (existingRecord) {
        const oldStatus = existingRecord.status;
        if (oldStatus !== newStatus) {
          if (oldStatus === "leave") leaveAdjustment += 1;
          if (newStatus === "leave") {
            if (employee.paidLeaves.available < 1) {
              return res.status(400).json({
                message: `Employee ${employee.name} (${employee.employeeId}) has insufficient paid leaves`,
              });
            }
            leaveAdjustment -= 1;
          }
          if (
            leaveAdjustment < 0 &&
            employee.paidLeaves.available < Math.abs(leaveAdjustment)
          ) {
            return res.status(400).json({
              message: `Employee ${employee.name} (${employee.employeeId}) has insufficient paid leaves`,
            });
          }
          existingRecord.status = newStatus;
          existingRecord.markedBy = req.user?._id || null;
          await existingRecord.save();
          attendanceIds.push(existingRecord._id.toString());
          if (leaveAdjustment !== 0) {
            leaveAdjustments.push({
              employeeId: empId,
              adjustment: leaveAdjustment,
            });
          }
        } else {
          attendanceIds.push(existingRecord._id.toString());
        }
      } else {
        if (newStatus === "leave") {
          if (employee.paidLeaves.available < 1) {
            return res.status(400).json({
              message: `Employee ${employee.name} (${employee.employeeId}) has insufficient paid leaves`,
            });
          }
          leaveAdjustments.push({ employeeId: empId, adjustment: -1 });
        }
        const newRecord = new Attendance({
          employee: empId,
          location,
          date: targetDate,
          status: newStatus,
          markedBy: req.user?._id || null,
        });
        await newRecord.save();
        attendanceIds.push(newRecord._id.toString());
      }
    }
    for (const { employeeId, adjustment } of leaveAdjustments) {
      if (adjustment !== 0) {
        await Employee.findByIdAndUpdate(
          employeeId,
          {
            $inc: {
              "paidLeaves.available": adjustment,
              "paidLeaves.used": -adjustment,
            },
          },
          { new: true }
        );
      }
    }
    res.status(201).json({ message: "Attendance marked successfully", attendanceIds });
  } catch (error) {
    console.error("Mark attendance error:", {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });
    res.status(500).json({ message: "Server error while marking attendance" });
  }
};

export const bulkMarkAttendance = async (req, res) => {
  try {
    const { attendance, overwrite = false } = req.body;
    if (!Array.isArray(attendance) || !attendance.length) {
      return res.status(400).json({
        message: "Attendance array is required and must not be empty",
      });
    }
    const location = attendance[0]?.location;
    if (!location) {
      return res.status(400).json({ message: "Location is required in attendance records" });
    }
    const locationExists = await Location.findById(location);
    if (!locationExists) {
      return res.status(400).json({ message: "Invalid location ID" });
    }
    const employees = await Employee.find({ location });
    if (!employees.length) {
      return res.status(400).json({ message: "No employees found for this location" });
    }
    const validStatuses = ["present", "absent", "half-day", "leave"];
    const employeeIds = employees.map((emp) => emp._id.toString());
    const leaveAdjustments = [];
    const datesProcessed = new Set();
    const attendanceIds = [];
    const existingRecordsToReturn = [];
    for (const entry of attendance) {
      if (!entry.employeeId || !entry.status || !entry.date) {
        return res.status(400).json({
          message: "Each attendance entry must have employeeId, status, and date",
        });
      }
      if (!employeeIds.includes(entry.employeeId)) {
        return res.status(400).json({ message: `Invalid employee ID: ${entry.employeeId}` });
      }
      if (!validStatuses.includes(entry.status)) {
        return res.status(400).json({
          message: `Invalid status: ${entry.status}. Must be one of ${validStatuses.join(", ")}`,
        });
      }
      const parsedDate = parseISO(entry.date);
      if (!isValid(parsedDate) || parsedDate > new Date()) {
        return res.status(400).json({ message: `Invalid or future date: ${entry.date}` });
      }
      datesProcessed.add(format(parsedDate, "yyyy-MM-dd"));
    }
    const attendanceRecords = [];
    for (const dateStr of datesProcessed) {
      const targetDate = parseISO(dateStr);
      const dateStart = new Date(targetDate.setHours(0, 0, 0, 0));
      const dateEnd = new Date(targetDate.setHours(23, 59, 59, 999));
      const existingRecords = await Attendance.find({
        location,
        date: { $gte: dateStart, $lte: dateEnd },
        employee: { $in: employeeIds },
        isDeleted: false,
      });
      const existingRecordsMap = new Map(
        existingRecords.map((record) => [record.employee.toString(), record])
      );
      if (existingRecords.length && !overwrite) {
        existingRecordsToReturn.push(
          ...existingRecords.map((record) => ({
            employeeId: record.employee.toString(),
            date: format(record.date, "yyyy-MM-dd"),
            status: record.status,
          }))
        );
      } else {
        for (const emp of employees) {
          const empId = emp._id.toString();
          const entry = attendance.find(
            (a) =>
              a.employeeId === empId &&
              format(parseISO(a.date), "yyyy-MM-dd") === dateStr
          );
          const newStatus = entry ? entry.status : "present";
          const existingRecord = existingRecordsMap.get(empId);
          let leaveAdjustment = 0;
          if (existingRecord) {
            const oldStatus = existingRecord.status;
            if (oldStatus !== newStatus) {
              if (oldStatus === "leave") leaveAdjustment += 1;
              if (newStatus === "leave") {
                if (emp.paidLeaves.available < 1) {
                  return res.status(400).json({
                    message: `Employee ${emp.name} (${emp.employeeId}) has insufficient paid leaves for ${dateStr}`,
                  });
                }
                leaveAdjustment -= 1;
              }
              if (
                leaveAdjustment < 0 &&
                emp.paidLeaves.available < Math.abs(leaveAdjustment)
              ) {
                return res.status(400).json({
                  message: `Employee ${emp.name} (${emp.employeeId}) has insufficient paid leaves for ${dateStr}`,
                });
              }
              existingRecord.status = newStatus;
              existingRecord.markedBy = req.user?._id || null;
              await existingRecord.save();
              attendanceIds.push(existingRecord._id.toString());
              if (leaveAdjustment !== 0) {
                leaveAdjustments.push({
                  employeeId: empId,
                  adjustment: leaveAdjustment,
                });
              }
            } else {
              attendanceIds.push(existingRecord._id.toString());
            }
          } else {
            if (newStatus === "leave") {
              if (emp.paidLeaves.available < 1) {
                return res.status(400).json({
                  message: `Employee ${emp.name} (${emp.employeeId}) has insufficient paid leaves for ${dateStr}`,
                });
              }
              leaveAdjustments.push({ employeeId: empId, adjustment: -1 });
            }
            const newRecord = new Attendance({
              employee: empId,
              location,
              date: targetDate,
              status: newStatus,
              markedBy: req.user?._id || null,
            });
            attendanceRecords.push(newRecord);
          }
        }
      }
    }
    if (existingRecordsToReturn.length) {
      return res.status(400).json({
        message: `Attendance already marked for ${existingRecordsToReturn.length} employee(s)`,
        existingRecords: existingRecordsToReturn,
      });
    }
    if (attendanceRecords.length) {
      const insertedRecords = await Attendance.insertMany(attendanceRecords);
      attendanceIds.push(...insertedRecords.map((record) => record._id.toString()));
    }
    for (const { employeeId, adjustment } of leaveAdjustments) {
      if (adjustment !== 0) {
        await Employee.findByIdAndUpdate(
          employeeId,
          {
            $inc: {
              "paidLeaves.available": adjustment,
              "paidLeaves.used": -adjustment,
            },
          },
          { new: true }
        );
      }
    }
    res.status(201).json({ message: "Bulk attendance marked successfully", attendanceIds });
  } catch (error) {
    console.error("Bulk mark attendance error:", {
      message: error.message,
      stack: error.stack,
      body: req.body,
      user: req.user?._id || "unknown",
    });
    res.status(500).json({
      message: error.message || "Server error while marking bulk attendance",
    });
  }
};

export const undoMarkAttendance = async (req, res) => {
  try {
    const { attendanceIds } = req.body;
    if (!Array.isArray(attendanceIds) || !attendanceIds.length) {
      return res.status(400).json({ message: "Array of attendance IDs is required" });
    }
    const attendanceRecords = await Attendance.find({
      _id: { $in: attendanceIds },
      isDeleted: false,
    }).populate("employee");
    if (!attendanceRecords.length) {
      return res.status(404).json({ message: "No valid attendance records found to undo" });
    }
    const leaveAdjustments = [];
    for (const record of attendanceRecords) {
      const employee = record.employee;
      const status = record.status;
      if (status === "leave") {
        leaveAdjustments.push({ employeeId: employee._id, adjustment: 1 });
      }
      record.isDeleted = true;
      record.deletedAt = new Date();
      record.deletedBy = req.user?._id || null;
      await record.save();
    }
    for (const { employeeId, adjustment } of leaveAdjustments) {
      if (adjustment !== 0) {
        await Employee.findByIdAndUpdate(
          employeeId,
          {
            $inc: {
              "paidLeaves.available": adjustment,
              "paidLeaves.used": -adjustment,
            },
          },
          { new: true }
        );
      }
    }
    res.json({ message: "Attendance marking undone successfully" });
  } catch (error) {
    console.error("Undo attendance error:", {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });
    res.status(500).json({ message: "Server error while undoing attendance" });
  }
};

export const editAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (
      !status ||
      !["present", "absent", "half-day", "leave"].includes(status)
    ) {
      return res.status(400).json({
        message: "Valid status is required (present, absent, half-day, leave)",
      });
    }
    const attendance = await Attendance.findById(id).populate("employee");
    if (!attendance || attendance.isDeleted) {
      return res.status(404).json({ message: "Attendance record not found" });
    }
    const employee = attendance.employee;
    let leaveAdjustment = 0;
    const oldStatus = attendance.status;
    if (oldStatus !== status) {
      if (oldStatus === "leave") leaveAdjustment += 1;
      if (status === "leave") {
        if (employee.paidLeaves.available < 1) {
          return res.status(400).json({ message: "Employee has insufficient leaves" });
        }
        leaveAdjustment -= 1;
      }
      if (
        leaveAdjustment < 0 &&
        employee.paidLeaves.available < Math.abs(leaveAdjustment)
      ) {
        return res.status(400).json({ message: "Employee has insufficient leaves" });
      }
      attendance.status = status;
      attendance.editedBy = req.user?._id || null;
      await attendance.save();
      if (leaveAdjustment !== 0) {
        employee.paidLeaves.available += leaveAdjustment;
        employee.paidLeaves.used -= leaveAdjustment;
        await employee.save();
      }
    }
    res.json({ message: "Attendance updated successfully", attendance });
  } catch (error) {
    console.error("Edit attendance error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Server error while editing attendance" });
  }
};