import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Settings from '../../models/Settings.js';

// Helper function to get total days in a month
const getDaysInMonth = (year, month) => {
  // month is 1-based (1 = Jan, 12 = Dec)
  return new Date(year, month, 0).getDate();
};

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

    let workingDays;
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
      const year = start.getFullYear();
      const month = start.getMonth() + 1;
      workingDays = getDaysInMonth(year, month);
    } else {
      const now = new Date();
      workingDays = getDaysInMonth(now.getFullYear(), now.getMonth() + 1);
    }

    if (location && !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const employees = await Employee.find(location ? { location } : {})
      .select('name employeeId salary advance location paidLeaves')
      .populate('location', 'name')
      .lean();

    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ message: 'Settings not found' });
    }

    const attendance = await Attendance.find(match)
      .populate('employee', 'name employeeId')
      .lean();

    const PAID_LEAVE_LIMIT = settings.paidLeavesPerMonth || 2;
    const HALF_DAY_WEIGHT = 0.5; // Half-day counts as 0.5 days for paid leave consumption

    const salaryReport = employees.map((emp) => {
      const empAttendance = attendance.filter(
        (att) => att.employee?._id.toString() === emp._id.toString()
      );
      const presentDays = empAttendance.filter((att) => att.status === 'present').length;
      const halfDays = empAttendance.filter((att) => att.status === 'half-day').length;
      const leaveDays = empAttendance.filter((att) => att.status === 'leave').length;
      const absentDays = empAttendance.filter((att) => att.status === 'absent').length;

      // Calculate total recorded days
      const totalRecordedDays = presentDays + halfDays + leaveDays + absentDays;

      // If no attendance records, assume all days are unrecorded
      if (totalRecordedDays === 0) {
        return {
          employee: {
            _id: emp._id,
            name: emp.name,
            employeeId: emp.employeeId,
          },
          location: emp.location,
          presentDays: 0,
          halfDays: 0,
          absentDays: 0,
          unrecordedDays: workingDays,
          leaveDays: 0,
          grossSalary: parseFloat(emp.salary.toFixed(2)),
          netSalary: 0.00,
          advance: parseFloat((emp.advance || 0).toFixed(2)),
          totalSalary: 0.00,
        };
      }

      const dailySalary = emp.salary / workingDays;
      // Calculate non-working days (including unrecorded days)
      const nonWorkingDays = absentDays + leaveDays + halfDays * HALF_DAY_WEIGHT;
      const unrecordedDays = workingDays - totalRecordedDays;
      const totalNonWorkingDays = nonWorkingDays + unrecordedDays;
      const paidLeaveDays = Math.min(totalNonWorkingDays, PAID_LEAVE_LIMIT);
      const unpaidDays = totalNonWorkingDays - paidLeaveDays;

      // Gross salary: Full base salary
      const grossSalary = emp.salary;
      // Net salary: Deduct unpaid days
      const netSalary = Math.max(grossSalary - unpaidDays * dailySalary, 0);
      // Total salary: Deduct advance
      const advance = emp.advance || 0;
      const totalSalary = Math.max(netSalary - advance, 0);

      return {
        employee: {
          _id: emp._id,
          name: emp.name,
          employeeId: emp.employeeId,
        },
        location: emp.location,
        presentDays,
        halfDays,
        absentDays,
        unrecordedDays,
        leaveDays,
        grossSalary: parseFloat(grossSalary.toFixed(2)),
        netSalary: parseFloat(netSalary.toFixed(2)),
        advance: parseFloat(advance.toFixed(2)),
        totalSalary: parseFloat(totalSalary.toFixed(2)),
      };
    });

    const summary = {
      totalPresentDays: salaryReport.reduce((sum, emp) => sum + emp.presentDays, 0),
      totalHalfDays: salaryReport.reduce((sum, emp) => sum + emp.halfDays, 0),
      totalAbsentDays: salaryReport.reduce((sum, emp) => sum + emp.absentDays, 0),
      totalUnrecordedDays: salaryReport.reduce((sum, emp) => sum + emp.unrecordedDays, 0),
      totalLeaveDays: salaryReport.reduce((sum, emp) => sum + emp.leaveDays, 0),
      totalGrossSalary: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.grossSalary, 0).toFixed(2)
      ),
      totalNetSalary: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.netSalary, 0).toFixed(2)
      ),
      totalAdvance: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.advance, 0).toFixed(2)
      ),
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