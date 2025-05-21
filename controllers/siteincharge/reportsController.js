import mongoose from 'mongoose';
import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import Location from '../../models/Location.js';
import { startOfDay, endOfDay, differenceInDays } from 'date-fns';

export const getAttendanceReports = async (req, res) => {
  try {
    const { startDate, endDate, location, department } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start and end dates are required' });
    }

    const start = startOfDay(new Date(startDate));
    const end = endOfDay(new Date(endDate));
    const daysInPeriod = differenceInDays(end, start) + 1;

    // Validate location if provided
    if (location && location !== 'all' && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    // Fetch locations and departments
    const locations = await Location.find().lean();
    const departments = await Employee.distinct('department');

    // Build employee query
    const employeeQuery = {};
    if (location && location !== 'all') {
      employeeQuery.location = location;
    }
    if (department && department !== 'all') {
      employeeQuery.department = department;
    }

    // Fetch employees
    const employees = await Employee.find(employeeQuery).lean();

    // Fetch attendance
    const attendance = await Attendance.find({
      date: { $gte: start, $lte: end },
      employee: { $in: employees.map((emp) => emp._id) },
    }).lean();

    // Calculate reports
    const reports = employees.map((emp) => {
      const empAttendance = attendance.filter((att) => att.employee.toString() === emp._id.toString());
      const presentDays = empAttendance.filter((att) => att.status === 'present').length;
      const absentDays = empAttendance.filter((att) => att.status === 'absent').length;
      const halfDays = empAttendance.filter((att) => att.status === 'half-day').length;
      const leaveDays = emp.paidLeaves.used; // Use paidLeaves.used from Employee
      const dailySalary = emp.salary / daysInPeriod;
      const salary = emp.salary - (leaveDays * dailySalary + halfDays * dailySalary * 0.5);

      return {
        employeeId: emp.employeeId,
        name: emp.name,
        presentDays,
        absentDays,
        halfDays,
        leaveDays,
        salary,
      };
    });

    res.json({ reports, locations, departments });
  } catch (error) {
    console.error('Get attendance reports error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLeaveReports = async (req, res) => {
  try {
    const { startDate, endDate, location, department } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start and end dates are required' });
    }

    // Validate location if provided
    if (location && location !== 'all' && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    // Fetch locations and departments
    const locations = await Location.find().lean();
    const departments = await Employee.distinct('department');

    // Build employee query
    const employeeQuery = {};
    if (location && location !== 'all') {
      employeeQuery.location = location;
    }
    if (department && department !== 'all') {
      employeeQuery.department = department;
    }

    // Fetch employees
    const employees = await Employee.find(employeeQuery).lean();

    // Calculate leave reports
    const reports = employees.map((emp) => ({
      employeeId: emp.employeeId,
      name: emp.name,
      availableLeaves: emp.paidLeaves.available,
      usedLeaves: emp.paidLeaves.used,
      carriedForward: emp.paidLeaves.carriedForward,
    }));

    res.json({ reports, locations, departments });
  } catch (error) {
    console.error('Get leave reports error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};