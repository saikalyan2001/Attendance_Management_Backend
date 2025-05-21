import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Settings from '../../models/Settings.js';

export const getAttendanceReport = async (req, res) => {
  try {
    const { startDate, endDate, location } = req.query;
    const match = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start) || isNaN(end)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      match.date = {
        $gte: start,
        $lte: end,
      };
    }

    if (location && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }
    if (location) {
      match.location = location;
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .populate('location', 'name')
      .sort({ date: -1 })
      .lean();

    const summary = await Attendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const totalPresent = summary.find((s) => s._id === 'present')?.count || 0;
    const totalAbsent = summary.find((s) => s._id === 'absent')?.count || 0;
    const totalLeave = summary.find((s) => s._id === 'leave')?.count || 0;
    const totalHalfDay = summary.find((s) => s._id === 'half-day')?.count || 0;

    res.json({
      attendance,
      summary: { totalPresent, totalAbsent, totalLeave, totalHalfDay },
    });
  } catch (error) {
    console.error('Attendance report error:', error.message);
    res.status(500).json({ message: 'Server error while fetching attendance report' });
  }
};

export const getLeaveReport = async (req, res) => {
  try {
    const { location } = req.query;
    const match = {};

    if (location && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }
    if (location) {
      match.location = location;
    }

    const employees = await Employee.find(match)
      .select('name employeeId paidLeaves location')
      .populate('location', 'name')
      .lean();

    const summary = await Employee.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalAvailable: { $sum: '$paidLeaves.available' },
          totalUsed: { $sum: '$paidLeaves.used' },
          totalCarriedForward: { $sum: '$paidLeaves.carriedForward' },
        },
      },
    ]);

    res.json({
      employees,
      summary: summary[0] || { totalAvailable: 0, totalUsed: 0, totalCarriedForward: 0 },
    });
  } catch (error) {
    console.error('Leave report error:', error.message);
    res.status(500).json({ message: 'Server error while fetching leave report' });
  }
};

export const getSalaryReport = async (req, res) => {
  try {
    const { startDate, endDate, location } = req.query;
    const match = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start) || isNaN(end)) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      match.date = {
        $gte: start,
        $lte: end,
      };
    }

    if (location && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const employees = await Employee.find(location ? { location } : {})
      .select('name employeeId salary paidLeaves location')
      .populate('location', 'name')
      .lean();

    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ message: 'Settings not found' });
    }
    const { halfDayDeduction } = settings;

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .lean();

    const WORKING_DAYS = 22; // Exclude weekends
    const salaryReport = employees.map((emp) => {
      const empAttendance = attendance.filter(
        (att) => att.employee?._id.toString() === emp._id.toString()
      );
      const presentDays = empAttendance.filter((att) => att.status === 'present').length;
      const halfDays = empAttendance.filter((att) => att.status === 'half-day').length;
      const leaveDays = empAttendance.filter((att) => att.status === 'leave').length;
      const dailySalary = emp.salary / WORKING_DAYS;
      const effectiveDays = presentDays + halfDays * (1 - halfDayDeduction);
      const totalSalary = effectiveDays * dailySalary;

      return {
        employee: {
          _id: emp._id,
          name: emp.name,
          employeeId: emp.employeeId,
        },
        location: emp.location,
        presentDays,
        halfDays,
        leaveDays,
        totalSalary: parseFloat(totalSalary.toFixed(2)),
      };
    });

    const summary = {
      totalPresentDays: salaryReport.reduce((sum, emp) => sum + emp.presentDays, 0),
      totalHalfDays: salaryReport.reduce((sum, emp) => sum + emp.halfDays, 0),
      totalLeaveDays: salaryReport.reduce((sum, emp) => sum + emp.leaveDays, 0),
      totalSalary: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.totalSalary, 0).toFixed(2)
      ),
    };

    res.json({ employees: salaryReport, summary });
  } catch (error) {
    console.error('Salary report error:', error.message);
    res.status(500).json({ message: 'Server error while fetching salary report' });
  }
};
