import mongoose from 'mongoose';
import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import Location from '../../models/Location.js';
import { startOfDay, endOfDay, differenceInDays } from 'date-fns';

/**
 * Robust location authorization check for attendance/leave reports.
 * Allows admin to access all locations.
 */
function userHasLocationAccess(user, location) {
  if (!user || !user.locations) return false;
  if (user.role === 'admin') return true;
  const userLocationIds = user.locations.map(loc =>
    loc._id ? loc._id.toString() : loc.toString()
  );
  return userLocationIds.includes(location);
}

export const getAttendanceReports = async (req, res) => {
  try {
    const { startDate, endDate, location, department } = req.query;

    console.log('getAttendanceReports:', {
      user: req.user.email,
      location,
      userLocations: req.user.locations.map(loc => loc._id.toString()),
      department,
    });

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start and end dates are required' });
    }

    if (location && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    if (location && !userHasLocationAccess(req.user, location)) {
      return res.status(403).json({ message: 'Location not assigned to user' });
    }

    const start = startOfDay(new Date(startDate));
    const end = endOfDay(new Date(endDate));
    const daysInPeriod = differenceInDays(end, start) + 1;

    const locations = await Location.find().lean();
    const departments = await Employee.distinct('department');

    const employeeQuery = { location };
    if (department && department !== 'all') {
      employeeQuery.department = department;
    }

    const employees = await Employee.find(employeeQuery).lean();

    const attendance = await Attendance.find({
      date: { $gte: start, $lte: end },
      employee: { $in: employees.map((emp) => emp._id) },
    }).lean();

    const reports = employees.map((emp) => {
      const empAttendance = attendance.filter((att) => att.employee.toString() === emp._id.toString());
      const presentDays = empAttendance.filter((att) => att.status === 'present').length;
      const absentDays = empAttendance.filter((att) => att.status === 'absent').length;
      const halfDays = empAttendance.filter((att) => att.status === 'half-day').length;
      const leaveDays = empAttendance.filter((att) => att.status === 'leave').length;

      const totalAbsences = absentDays + leaveDays; // Combine absences and leaves
      const paidLeavesUsed = Math.min(emp.paidLeaves.used || 0, 2); // Up to 2 paid leaves
      const unpaidAbsences = Math.max(0, totalAbsences - paidLeavesUsed); // Excess absences

      const dailySalary = emp.salary / daysInPeriod;
      const leaveUnits = paidLeavesUsed + halfDays * 0.5; // Total leave usage including half-days
      const paidLeaveUnits = Math.min(leaveUnits, 2); // Up to 2 paid leave units
      const paidFullLeaves = Math.min(paidLeavesUsed, Math.floor(paidLeaveUnits));
      const paidHalfDays = Math.min(halfDays, Math.ceil((paidLeaveUnits - paidFullLeaves) * 2));
      const unpaidHalfDays = halfDays - paidHalfDays;

      const salary = emp.salary - (
        unpaidAbsences * dailySalary +
        unpaidHalfDays * dailySalary * 0.5
      );

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

    console.log('getLeaveReports:', {
      user: req.user.email,
      location,
      userLocations: req.user.locations.map(loc => loc._id.toString()),
      department,
    });

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start and end dates are required' });
    }

    if (location && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    if (location && !userHasLocationAccess(req.user, location)) {
      return res.status(403).json({ message: 'Location not assigned to user' });
    }

    const start = startOfDay(new Date(startDate));
    const end = endOfDay(new Date(endDate));

    const locations = await Location.find().lean();
    const departments = await Employee.distinct('department');

    const employeeQuery = { location };
    if (department && department !== 'all') {
      employeeQuery.department = department;
    }

    const employees = await Employee.find(employeeQuery).lean();

    const reports = employees.map((emp) => {
      const usedLeaves = emp.paidLeaves.used || 0;
      const availableLeaves = 2 + (emp.paidLeaves.carriedForward || 0);
      const carriedForward = Math.max(0, availableLeaves - usedLeaves);

      return {
        employeeId: emp.employeeId,
        name: emp.name,
        availableLeaves,
        usedLeaves,
        carriedForward,
      };
    });

    res.json({ reports, locations, departments });
  } catch (error) {
    console.error('Get leave reports error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
