import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Settings from '../../models/Settings.js';

// Utility function for location validation
function userHasLocation(user, location) {
  const userLocationIds = user.locations.map(loc =>
    typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()
  );
  return userLocationIds.includes(location.toString());
}

// Utility function for date normalization
function normalizeDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date)) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export const getAttendance = async (req, res) => {
  try {
    const { date, status, location } = req.query;
    console.log('getAttendance:', { user: req.user.email, role: req.user.role, location, date, status });
    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }
    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({
        message: 'Location not assigned to user',
        userLocations: req.user.locations.map(loc => typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()),
        requestedLocation: location.toString()
      });
    }

    const match = { location: new mongoose.Types.ObjectId(location) };
    if (date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({ message: 'Date must be in YYYY-MM-DD format' });
      }
      const parsedDate = normalizeDate(date);
      if (!parsedDate) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      match.date = parsedDate;
    }
    if (status && ['present', 'absent', 'leave', 'half-day'].includes(status)) {
      match.status = status;
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .sort({ date: -1 })
      .lean();

    res.json({ attendance });
  } catch (error) {
    console.error('Get attendance error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching attendance' });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    console.log('markAttendance:', { user: req.user.email, role: req.user.role, records });
    const attendanceRecords = [];
    const settings = await Settings.findOne({});

    for (const { employeeId, date, status, location } of records) {
      if (!employeeId || !date || !status || !location) {
        return res.status(400).json({
          message: 'Employee ID, date, status, and location are required',
        });
      }

      if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: 'Invalid employee or location ID' });
      }

      if (!userHasLocation(req.user, location)) {
        return res.status(403).json({
          message: 'Location not assigned to user',
          userLocations: req.user.locations.map(loc => typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()),
          requestedLocation: location.toString(),
        });
      }

      const employee = await Employee.findById(employeeId);
      if (!employee) {
        return res.status(404).json({ message: 'Employee not found' });
      }
      if (employee.location.toString() !== location) {
        return res.status(403).json({
          message: 'Employee not assigned to this location',
        });
      }

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({ message: 'Date must be in YYYY-MM-DD format' });
      }

      const parsedDate = normalizeDate(date);
      if (!parsedDate) {
        return res.status(400).json({ message: 'Invalid date format' });
      }

      console.log('Checking existing attendance:', { employeeId, date: parsedDate.toISOString(), location, userRole: req.user.role });
      const existingAttendance = await Attendance.findOne({
        employee: employeeId,
        date: parsedDate,
        location,
      });
      if (existingAttendance) {
        console.log('Duplicate attendance found:', { existingAttendance, markedBy: existingAttendance.markedBy });
        return res.status(400).json({
          message: `Attendance already marked for employee ${employeeId} on ${date} by user ${existingAttendance.markedBy}`,
        });
      }

      if (status === 'leave' && employee.paidLeaves.available < 1) {
        return res.status(400).json({ message: 'No paid leaves available' });
      }

      if (status === 'leave') {
        employee.paidLeaves.available -= 1;
        employee.paidLeaves.used += 1;
        await employee.save();
      } else if (status === 'half-day' && settings?.halfDayDeduction) {
        employee.paidLeaves.available -= settings.halfDayDeduction;
        employee.paidLeaves.used += settings.halfDayDeduction;
        await employee.save();
      }

      const attendance = new Attendance({
        employee: employeeId,
        location,
        date: parsedDate,
        status,
        markedBy: req.user._id,
      });
      await attendance.save();

      const populatedAttendance = await Attendance.findById(attendance._id)
        .populate('employee', 'name employeeId')
        .lean();
      attendanceRecords.push(populatedAttendance);
    }

    res.status(201).json(attendanceRecords);
  } catch (error) {
    console.error('Mark attendance error:', { message: error.message, stack: error.stack });
    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Attendance already marked for this employee on this date',
      });
    }
    if (error.message.includes('Location not assigned to user')) {
      return res.status(403).json({
        message: error.message,
        userLocations: req.user.locations.map(loc => typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()),
        requestedLocation: error.cause?.requestedLocation
      });
    }
    if (['Employee ID, date, status, and location are required', 'Invalid employee or location ID', 'Employee not found', 'Employee not assigned to this location', 'Date must be in YYYY-MM-DD format', 'Invalid date format', 'No paid leaves available', 'Attendance already marked'].some(msg => error.message.includes(msg))) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error while marking attendance' });
  }
};


export const markBulkAttendance = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { attendance: records, overwrite = false } = req.body;

    if (!Array.isArray(records) || !records.length) {
      throw new Error('Attendance must be an array of records');
    }

    const userLocationIds = req.user.locations.map(loc => loc._id.toString());
    const attendanceRecords = [];

    for (const { employeeId, date, status, location } of records) {
      if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(location)) {
        throw new Error('Invalid employee or location ID');
      }

      const parsedDate = new Date(date);
      if (isNaN(parsedDate)) {
        throw new Error('Invalid date format');
      }

      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        throw new Error('Invalid status');
      }

      const employee = await Employee.findById(employeeId).session(session);
      if (!employee) {
        throw new Error(`Employee ${employeeId} not found`);
      }

      if (!userLocationIds.includes(location.toString())) {
        throw new Error(`Location ${location} not assigned to user`);
      }

      const startOfDay = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()));
      const endOfDay = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate() + 1));

      const existing = await Attendance.findOne({
        employee: employeeId,
        location,
        date: { $gte: startOfDay, $lt: endOfDay },
        isDeleted: false,
      }).session(session);

      let attendance;
      if (existing && overwrite) {
        attendance = await Attendance.findByIdAndUpdate(
          existing._id,
          { status, markedBy: req.user._id, updatedAt: new Date(), isDeleted: false },
          { new: true, session }
        );
      } else if (!existing) {
        attendance = new Attendance({
          employee: employeeId,
          location,
          date: startOfDay,
          status,
          markedBy: req.user._id,
        });
        await attendance.save({ session });
      } else {
        continue; // Skip if exists and no overwrite
      }

      attendanceRecords.push(attendance);
    }

    await session.commitTransaction();
    res.status(201).json({
      attendance: attendanceRecords,
      attendanceIds: attendanceRecords.map((rec) => rec._id.toString()),
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Mark bulk attendance error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Duplicate attendance record' });
    }
    res.status(400).json({ message: error.message });
  } finally {
    session.endSession();
  }
};

export const undoAttendance = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { attendanceIds } = req.body;
    if (!Array.isArray(attendanceIds) || !attendanceIds.length) {
      return res.status(400).json({ message: 'Array of attendance IDs required' });
    }

    const attendanceRecords = await Attendance.find({ _id: { $in: attendanceIds } }).session(session);
    for (const record of attendanceRecords) {
      if (!userHasLocation(req.user, record.location)) {
        throw new Error('Location not assigned to user');
      }
      const employee = await Employee.findById(record.employee).session(session);
      if (record.status === 'leave') {
        employee.paidLeaves.available += 1;
        employee.paidLeaves.used -= 1;
      } else if (record.status === 'half-day' && settings?.halfDayDeduction) {
        employee.paidLeaves.available += settings.halfDayDeduction;
        employee.paidLeaves.used -= settings.halfDayDeduction;
      }
      await employee.save({ session });
    }

    await Attendance.deleteMany({ _id: { $in: attendanceIds } }).session(session);
    await session.commitTransaction();
    res.status(200).json({ message: 'Attendance undone successfully' });
  } catch (error) {
    await session.abortTransaction();
    res.status(400).json({ message: error.message });
  } finally {
    session.endSession();
  }
};

export const getMonthlyAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    console.log('getMonthlyAttendance:', { user: req.user.email, role: req.user.role, month, year, location });

    if (!year || !location) {
      return res.status(400).json({ message: 'Year and location are required' });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({
        message: 'Location not assigned to user',
        userLocations: req.user.locations.map(loc => typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()),
        requestedLocation: location.toString()
      });
    }

    const parsedYear = parseInt(year);
    if (isNaN(parsedYear)) {
      return res.status(400).json({ message: 'Invalid year' });
    }

    const match = {
      location: new mongoose.Types.ObjectId(location),
    };

    if (month) {
      const parsedMonth = parseInt(month) - 1;
      if (isNaN(parsedMonth) || parsedMonth < 0 || parsedMonth > 11) {
        return res.status(400).json({ message: 'Invalid month' });
      }
      const startDate = new Date(parsedYear, parsedMonth, 1);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(parsedYear, parsedMonth + 1, 1);
      endDate.setHours(0, 0, 0, 0);
      match.date = { $gte: startDate, $lt: endDate };
    } else {
      const startDate = new Date(parsedYear, 0, 1);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(parsedYear + 1, 0, 1);
      endDate.setHours(0, 0, 0, 0);
      match.date = { $gte: startDate, $lt: endDate };
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .lean();

    res.json({ attendance });
  } catch (error) {
    console.error('Get monthly attendance error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching monthly attendance' });
  }
};

export const getEmployeeAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    console.log('getEmployeeAttendance:', { user: req.user.email, role: req.user.role, employeeId: id, month, year });
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    const parsedMonth = parseInt(month) - 1;
    const parsedYear = parseInt(year);

    if (isNaN(parsedMonth) || isNaN(parsedYear) || parsedMonth < 0 || parsedMonth > 11) {
      return res.status(400).json({ message: 'Invalid month or year' });
    }

    const startDate = new Date(parsedYear, parsedMonth, 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(parsedYear, parsedMonth + 1, 1);
    endDate.setHours(0, 0, 0, 0);

    const attendance = await Attendance.find({
      employee: new mongoose.Types.ObjectId(id),
      date: {
        $gte: startDate,
        $lt: endDate,
      },
      location: { $in: req.user.locations },
    })
      .sort({ date: -1 })
      .lean();

    res.json({ attendance });
  } catch (error) {
    console.error('Get employee attendance error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching employee attendance' });
  }
};

export const requestAttendanceEdit = async (req, res) => {
  try {
    const { employeeId, location, date, requestedStatus, reason } = req.body;
    console.log('requestAttendanceEdit:', { user: req.user.email, role: req.user.role, employeeId, location, date, requestedStatus });
    if (!employeeId || !location || !date || !requestedStatus || !reason) {
      return res.status(400).json({
        message: 'Employee ID, location, date, requested status, and reason are required',
      });
    }

    if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid employee or location ID' });
    }

    if (!['present', 'absent', 'leave', 'half-day'].includes(requestedStatus)) {
      return res.status(400).json({ message: 'Invalid requested status' });
    }

    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({
        message: 'Location not assigned to user',
        userLocations: req.user.locations.map(loc => typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()),
        requestedLocation: location.toString(),
      });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    if (employee.location.toString() !== location) {
      return res.status(403).json({
        message: 'Employee not assigned to this location',
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ message: 'Date must be in YYYY-MM-DD format' });
    }

    const parsedDate = normalizeDate(date);
    if (!parsedDate) {
      return res.status(400).json({ message: 'Invalid date format' });
    }

    const existingRequest = await AttendanceRequest.findOne({
      employee: employeeId,
      location,
      date: parsedDate,
      status: 'pending',
    });
    if (existingRequest) {
      return res.status(400).json({
        message: 'Pending edit request already exists for this date',
      });
    }

    const attendanceRequest = new AttendanceRequest({
      employee: employeeId,
      location,
      date: parsedDate,
      requestedStatus,
      reason,
      requestedBy: req.user._id,
      status: 'pending',
    });
    await attendanceRequest.save();

    res.status(201).json(attendanceRequest);
  } catch (error) {
    console.error('Request attendance edit error:', { message: error.message, stack: error.stack });
    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Attendance request already exists for this employee on this date',
      });
    }
    if (['Employee ID, location, date, requested status, and reason are required', 'Invalid employee or location ID', 'Invalid requested status', 'Employee not found', 'Employee not assigned to this location', 'Date must be in YYYY-MM-DD format', 'Invalid date format', 'Pending edit request already exists'].some(msg => error.message.includes(msg))) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error while requesting attendance edit' });
  }
};

export const getAttendanceEditRequests = async (req, res) => {
  try {
    const { location } = req.query;
    console.log('getAttendanceEditRequests:', { user: req.user.email, role: req.user.role, location });

    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

    if (!userHasLocation(req.user, location)) {
      return res.status(403).json({
        message: 'Location not assigned to user',
        userLocations: req.user.locations.map(loc =>
          typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()
        ),
        requestedLocation: location.toString(),
      });
    }

    const requests = await AttendanceRequest.find({
      requestedBy: req.user._id,
      location: new mongoose.Types.ObjectId(location),
    })
      .populate('employee', 'name employeeId')
      .sort({ createdAt: -1 })
      .lean();

    const requestsWithStatus = await Promise.all(
      requests.map(async (request) => {
        const attendance = await Attendance.findOne({
          employee: request.employee._id,
          location: request.location,
          date: request.date,
        }).lean();
        return {
          ...request,
          currentStatus: attendance ? attendance.status : 'N/A',
        };
      })
    );

    res.json({ requests: requestsWithStatus });
  } catch (error) {
    console.error('Get attendance edit requests error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching attendance edit requests' });
  }
};
