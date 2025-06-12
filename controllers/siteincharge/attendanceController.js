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

export const getAttendance = async (req, res) => {
  try {
    const { date, status, location } = req.query;
    console.log('getAttendance:', { user: req.user.email, location, date, status });
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
      const parsedDate = new Date(date);
      if (isNaN(parsedDate)) {
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
    console.error('Get attendance error:', error.message);
    res.status(500).json({ message: 'Server error while fetching attendance' });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    console.log('markAttendance:', { user: req.user.email, records });
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
          requestedLocation: location.toString()
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

      const parsedDate = new Date(date);
      if (isNaN(parsedDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }

      const existingAttendance = await Attendance.findOne({
        employee: employeeId,
        date: parsedDate,
        location,
      });
      if (existingAttendance) {
        return res.status(400).json({
          message: 'Attendance already marked for this date',
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
      });
      await attendance.save();

      const populatedAttendance = await Attendance.findById(attendance._id)
        .populate('employee', 'name employeeId')
        .lean();
      attendanceRecords.push(populatedAttendance);
    }

    res.status(201).json(attendanceRecords);
  } catch (error) {
    console.error('Mark attendance error:', error.message);
    res.status(500).json({ message: 'Server error while marking attendance' });
  }
};

export const markBulkAttendance = async (req, res) => {
  try {
    const records = req.body;
    console.log('markBulkAttendance:', { user: req.user.email, records });
    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({
        message: 'Array of attendance records required',
      });
    }

    const attendanceRecords = [];
    const settings = await Settings.findOne({});

    for (const { employeeId, date, status, location } of records) {
      if (!employeeId || !date || !status || !location) {
        return res.status(400).json({
          message: 'Employee ID, date, status, and location required for all records',
        });
      }

      if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: 'Invalid employee or location ID' });
      }

      if (!userHasLocation(req.user, location)) {
        return res.status(403).json({ 
          message: 'Location not assigned to user',
          userLocations: req.user.locations.map(loc => typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()),
          requestedLocation: location.toString()
        });
      }

      const employee = await Employee.findById(employeeId);
      if (!employee) {
        return res.status(404).json({ message: `Employee ${employeeId} not found` });
      }
      if (employee.location.toString() !== location) {
        return res.status(403).json({
          message: `Employee ${employeeId} not assigned to location`,
        });
      }

      const parsedDate = new Date(date);
      if (isNaN(parsedDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }

      const existingAttendance = await Attendance.findOne({
        employee: employeeId,
        date: parsedDate,
        location,
      });
      if (existingAttendance) {
        return res.status(400).json({
          message: `Attendance already marked for employee ${employeeId} on ${date}`,
        });
      }

      if (status === 'leave' && employee.paidLeaves.available < 1) {
        return res.status(400).json({
          message: `No paid leaves available for employee ${employeeId}`,
        });
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
      });
      await attendance.save();
      const populatedAttendance = await Attendance.findById(attendance._id)
        .populate('employee', 'name employeeId')
        .lean();
      attendanceRecords.push(populatedAttendance);
    }

    res.status(201).json({ attendance: attendanceRecords });
  } catch (error) {
    console.error('Mark bulk attendance error:', error.message);
    res.status(500).json({ message: 'Server error while marking bulk attendance' });
  }
};

export const getMonthlyAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    console.log('getMonthlyAttendance:', { user: req.user.email, month, year, location });

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
      const endDate = new Date(parsedYear, parsedMonth + 1, 1);
      match.date = { $gte: startDate, $lt: endDate };
    } else {
      const startDate = new Date(parsedYear, 0, 1);
      const endDate = new Date(parsedYear + 1, 0, 1);
      match.date = { $gte: startDate, $lt: endDate };
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .lean();

    res.json({ attendance });
  } catch (error) {
    console.error('Get monthly attendance error:', error.message);
    res.status(500).json({ message: 'Server error while fetching monthly attendance' });
  }
};

export const getEmployeeAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    console.log('getEmployeeAttendance:', { user: req.user.email, employeeId: id, month, year });
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
    const endDate = new Date(parsedYear, parsedMonth + 1, 1);

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
    console.error('Get employee attendance error:', error.message);
    res.status(500).json({ message: 'Server error while fetching employee attendance' });
  }
};

export const requestAttendanceEdit = async (req, res) => {
  try {
    const { employeeId, location, date, requestedStatus, reason } = req.body;
    console.log('requestAttendanceEdit:', { user: req.user.email, employeeId, location, date, requestedStatus });
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
        requestedLocation: location.toString()
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

    const parsedDate = new Date(date);
    if (isNaN(parsedDate)) {
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
    console.error('Request attendance edit error:', error.message);
    res.status(500).json({ message: 'Server error while requesting attendance edit' });
  }
};


export const getAttendanceEditRequests = async (req, res) => {
  try {
    const { location } = req.query;
    console.log('getAttendanceEditRequests:', { user: req.user.email, location });

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

    // Add currentStatus to each request
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
    console.error('Get attendance edit requests error:', error.message);
    res.status(500).json({ message: 'Server error while fetching attendance edit requests' });
  }
};

