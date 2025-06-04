import Attendance from '../../models/Attendance.js';
import AttendanceRequest from '../../models/AttendanceRequest.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import { format, eachDayOfInterval, parseISO, isValid } from 'date-fns';

export const getAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const match = {
      date: { $gte: startDate, $lte: endDate },
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

    res.json(attendance);
  } catch (error) {
    console.error('Get attendance error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching attendance' });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const { date, dates, location, attendance } = req.body;

    // Validate required fields
    if (!location || !Array.isArray(attendance)) {
      return res.status(400).json({ message: 'Location and attendance (array) are required' });
    }
    if (!date && !dates) {
      return res.status(400).json({ message: 'Either date or dates array is required' });
    }

    // Validate location
    const locationExists = await Location.findById(location);
    if (!locationExists) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    // Fetch all employees for the location
    const employees = await Employee.find({ location });
    if (!employees.length) {
      return res.status(400).json({ message: 'No employees found for this location' });
    }

    // Validate the attendance array
    const validStatuses = ['present', 'absent', 'half-day', 'leave'];
    const employeeIds = employees.map((emp) => emp._id.toString());
    const attendanceMap = new Map();

    for (const entry of attendance) {
      if (!entry.employeeId || !entry.status) {
        return res.status(400).json({ message: 'Each attendance entry must have employeeId and status' });
      }
      if (!employeeIds.includes(entry.employeeId)) {
        return res.status(400).json({ message: `Invalid employee ID: ${entry.employeeId}` });
      }
      if (!validStatuses.includes(entry.status)) {
        return res.status(400).json({ message: `Invalid status: ${entry.status}. Must be one of ${validStatuses.join(', ')}` });
      }
      attendanceMap.set(entry.employeeId, entry.status);
    }

    // Parse dates
    let targetDates = [];
    if (date) {
      const parsedDate = parseISO(date);
      if (!isValid(parsedDate)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      targetDates = [parsedDate];
    } else if (dates) {
      targetDates = dates
        .map((d) => parseISO(d))
        .filter((d) => isValid(d) && d <= new Date());
      if (!targetDates.length) {
        return res.status(400).json({ message: 'No valid dates provided' });
      }
    }

    // Process each date
    for (const targetDate of targetDates) {
      const dateStart = new Date(targetDate.setHours(0, 0, 0, 0));
      const dateEnd = new Date(targetDate.setHours(23, 59, 59, 999));

      // Fetch existing attendance records for the date
      const existingRecords = await Attendance.find({
        location,
        date: { $gte: dateStart, $lte: dateEnd },
      }).populate('employee');

      const existingRecordsMap = new Map(
        existingRecords.map((record) => [record.employee._id.toString(), record])
      );

      // Track employees whose leaves need adjustment
      const leaveAdjustments = [];

      // Process each employee
      for (const emp of employees) {
        const empId = emp._id.toString();
        const newStatus = attendanceMap.get(empId) || 'present';
        const existingRecord = existingRecordsMap.get(empId);

        // Calculate leave adjustments if status changes
        let leaveAdjustment = 0;
        if (existingRecord) {
          const oldStatus = existingRecord.status;
          if (oldStatus !== newStatus) {
            // Refund leaves if moving away from "leave" or "half-day"
            if (oldStatus === 'leave') leaveAdjustment += 1;
            else if (oldStatus === 'half-day') leaveAdjustment += 0.5;
            // Deduct leaves if moving to "leave" or "half-day"
            if (newStatus === 'leave') leaveAdjustment -= 1;
            else if (newStatus === 'half-day') leaveAdjustment -= 0.5;

            if (leaveAdjustment < 0) {
              // Check if there are enough leaves for deduction
              const leavesNeeded = Math.abs(leaveAdjustment);
              if (emp.paidLeaves.available < leavesNeeded) {
                return res.status(400).json({
                  message: `Employee ${emp.name} (${emp.employeeId}) has insufficient paid leaves`,
                });
              }
            }

            // Update the existing record
            existingRecord.status = newStatus;
            existingRecord.markedBy = req.user?._id || null;
            await existingRecord.save();

            if (leaveAdjustment !== 0) {
              leaveAdjustments.push({ employeeId: empId, adjustment: leaveAdjustment });
            }
          }
        } else {
          // Create a new record
          if (newStatus === 'leave' || newStatus === 'half-day') {
            const deduction = newStatus === 'leave' ? 1 : 0.5;
            if (emp.paidLeaves.available < deduction) {
              return res.status(400).json({
                message: `Employee ${emp.name} (${emp.employeeId}) has insufficient paid leaves`,
              });
            }
            leaveAdjustments.push({ employeeId: empId, adjustment: -deduction });
          }

          const newRecord = new Attendance({
            employee: emp._id,
            location,
            date: targetDate,
            status: newStatus,
            markedBy: req.user?._id || null,
          });
          await newRecord.save();
        }
      }

      // Apply leave adjustments
      for (const { employeeId, adjustment } of leaveAdjustments) {
        if (adjustment !== 0) {
          await Employee.findByIdAndUpdate(
            employeeId,
            {
              $inc: {
                'paidLeaves.available': adjustment,
                'paidLeaves.used': -adjustment,
              },
            },
            { new: true }
          );
        }
      }
    }

    res.status(201).json({ message: 'Attendance marked successfully for provided dates' });
  } catch (error) {
    console.error('Mark attendance error:', { message: error.message, stack: error.stack, body: req.body });
    res.status(500).json({ message: 'Server error while marking attendance' });
  }
};

export const editAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || !['present', 'absent', 'leave', 'half-day'].includes(status)) {
      return res.status(400).json({ message: 'Valid status is required (present, absent, leave, half-day)' });
    }

    const attendance = await Attendance.findById(id).populate('employee');
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const employee = attendance.employee;
    let leaveAdjustment = 0;

    // Calculate leave adjustment based on status change
    const oldStatus = attendance.status;
    if (oldStatus !== status) {
      if (oldStatus === 'leave') leaveAdjustment += 1;
      else if (oldStatus === 'half-day') leaveAdjustment += 0.5;
      if (status === 'leave') leaveAdjustment -= 1;
      else if (status === 'half-day') leaveAdjustment -= 0.5;

      if (leaveAdjustment < 0) {
        const leavesNeeded = Math.abs(leaveAdjustment);
        if (employee.paidLeaves.available < leavesNeeded) {
          return res.status(400).json({ message: 'Employee has insufficient leaves' });
        }
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

    res.json({ message: 'Attendance updated successfully', attendance });
  } catch (error) {
    console.error('Edit attendance error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while editing attendance' });
  }
};

export const getAttendanceRequests = async (req, res) => {
  try {
    const requests = await AttendanceRequest.find()
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .lean();

    res.json(requests);
  } catch (error) {
    console.error('Get attendance requests error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching attendance requests' });
  }
};

export const handleAttendanceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Valid status is required (approved, rejected)' });
    }

    const request = await AttendanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Attendance request not found' });
    }

    request.status = status;
    request.reviewedAt = new Date();
    request.reviewedBy = req.user?._id || null;
    await request.save();

    if (status === 'approved') {
      const attendance = await Attendance.findOne({
        employee: request.employee,
        location: request.location,
        date: request.date,
      }).populate('employee');
      if (attendance) {
        const employee = attendance.employee;
        let leaveAdjustment = 0;

        const oldStatus = attendance.status;
        const newStatus = request.requestedStatus;

        if (oldStatus !== newStatus) {
          if (oldStatus === 'leave') leaveAdjustment += 1;
          else if (oldStatus === 'half-day') leaveAdjustment += 0.5;
          if (newStatus === 'leave') leaveAdjustment -= 1;
          else if (newStatus === 'half-day') leaveAdjustment -= 0.5;

          if (leaveAdjustment < 0) {
            const leavesNeeded = Math.abs(leaveAdjustment);
            if (employee.paidLeaves.available < leavesNeeded) {
              return res.status(400).json({ message: 'Employee has insufficient leaves' });
            }
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
    console.error('Handle attendance request error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while handling attendance request' });
  }
};

export const requestAttendanceEdit = async (req, res) => {
  try {
    const { attendanceId, requestedStatus, reason } = req.body;
    if (!attendanceId || !requestedStatus || !reason) {
      return res.status(400).json({ message: 'Attendance ID, requested status, and reason are required' });
    }
    if (!['present', 'absent', 'leave', 'half-day'].includes(requestedStatus)) {
      return res.status(400).json({ message: 'Invalid requested status (present, absent, leave, half-day)' });
    }

    const attendance = await Attendance.findById(attendanceId);
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const request = new AttendanceRequest({
      employee: attendance.employee,
      location: attendance.location,
      date: attendance.date,
      requestedStatus,
      reason,
      status: 'pending',
      requestedBy: req.user?._id || null,
    });

    await request.save();
    res.status(201).json(request);
  } catch (error) {
    console.error('Request attendance edit error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while requesting attendance edit' });
  }
};

export const exportAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const match = {
      date: { $gte: startDate, $lte: endDate },
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
      Date: format(new Date(record.date), 'yyyy-MM-dd'),
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
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${month}_${year}.csv`);
    res.send(csvContent);
  } catch (error) {
    console.error('Export attendance error:', { message: error.message, stack: error.stack });
    res.status(500).json({ message: 'Server error while exporting attendance' });
  }
};