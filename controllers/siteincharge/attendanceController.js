import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getAttendance = async (req, res) => {
  try {
    const { date, status, location } = req.query;
    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
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

    console.log('Fetched attendance:', attendance);
    res.json({ attendance });
  } catch (error) {
    console.error('Get attendance error:', error.message);
    res.status(500).json({ message: 'Server error while fetching attendance' });
  }
};

export const markAttendance = async (req, res) => {
  try {
    const { employeeId, date, status, location } = req.body;

    if (!employeeId || !date || !status || !location) {
      return res.status(400).json({ message: 'Employee ID, date, status, and location are required' });
    }

    if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid employee or location ID' });
    }

    if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    if (employee.location.toString() !== location) {
      return res.status(403).json({ message: 'Employee not assigned to this location' });
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
      return res.status(400).json({ message: 'Attendance already marked for this date' });
    }

    if (status === 'leave' && employee.paidLeaves.available < 1) {
      return res.status(400).json({ message: 'No paid leaves available' });
    }

    if (status === 'leave') {
      employee.paidLeaves.available -= 1;
      employee.paidLeaves.used += 1;
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

    console.log('Marked attendance:', populatedAttendance);
    res.status(201).json(populatedAttendance);
  } catch (error) {
    console.error('Mark attendance error:', error.message);
    res.status(500).json({ message: 'Server error while marking attendance' });
  }
};

export const markBulkAttendance = async (req, res) => {
  try {
    const records = req.body;
    console.log('Received bulk attendance request:', records);
    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ message: 'Array of attendance records required' });
    }

    const attendanceRecords = [];
    for (const { employeeId, date, status, location } of records) {
      if (!employeeId || !date || !status || !location) {
        return res.status(400).json({ message: 'Employee ID, date, status, and location required for all records' });
      }

      if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: 'Invalid employee or location ID' });
      }

      if (!['present', 'absent', 'leave', 'half-day'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }

      const employee = await Employee.findById(employeeId);
      if (!employee) {
        return res.status(404).json({ message: `Employee ${employeeId} not found` });
      }
      if (employee.location.toString() !== location) {
        return res.status(403).json({ message: `Employee ${employeeId} not assigned to location` });
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
        return res.status(400).json({ message: `Attendance already marked for employee ${employeeId} on ${date}` });
      }

      if (status === 'leave' && employee.paidLeaves.available < 1) {
        return res.status(400).json({ message: `No paid leaves available for employee ${employeeId}` });
      }

      if (status === 'leave') {
        employee.paidLeaves.available -= 1;
        employee.paidLeaves.used += 1;
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

    console.log('Marked bulk attendance:', attendanceRecords);
    res.status(201).json({ attendance: attendanceRecords });
  } catch (error) {
    console.error('Mark bulk attendance error:', error.message);
    res.status(500).json({ message: 'Server error while marking bulk attendance' });
  }
};

export const getMonthlyAttendance = async (req, res) => {
  try {
    const { month, year, location } = req.query;

    console.log('Received monthly attendance request:', { month, year, location });

    if (!month || !year || !location) {
      return res.status(400).json({ message: 'Month, year, and location are required' });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const parsedMonth = parseInt(month) - 1;
    const parsedYear = parseInt(year);

    if (isNaN(parsedMonth) || isNaN(parsedYear) || parsedMonth < 0 || parsedMonth > 11) {
      return res.status(400).json({ message: 'Invalid month or year' });
    }

    const startDate = new Date(parsedYear, parsedMonth, 1);
    const endDate = new Date(parsedYear, parsedMonth + 1, 1);

    const attendance = await Attendance.find({
      date: {
        $gte: startDate,
        $lt: endDate,
      },
      location: new mongoose.Types.ObjectId(location),
    })
      .populate('employee', 'name employeeId')
      .lean();

    console.log('Fetched monthly attendance:', attendance);
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
    })
      .sort({ date: -1 })
      .lean();

    console.log('Fetched employee attendance:', attendance);
    res.json({ attendance });
  } catch (error) {
    console.error('Get employee attendance error:', error.message);
    res.status(500).json({ message: 'Server error while fetching employee attendance' });
  }
};
