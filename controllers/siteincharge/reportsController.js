import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import Location from '../../models/Location.js';
import { startOfMonth, endOfMonth, getDaysInMonth } from 'date-fns';

export const getReports = async (req, res) => {
  try {
    const { month, location } = req.query;
    const year = 2025; // Fixed for testing
    const startDate = startOfMonth(new Date(year, parseInt(month) - 1));
    const endDate = endOfMonth(startDate);
    const daysInMonth = getDaysInMonth(startDate);

    // Fetch all locations for dropdown
    const locations = await Location.find().lean();

    // Fetch employees with optional location filter
    const employeeQuery = location && location !== 'all' ? { location: location } : {};
    const employees = await Employee.find(employeeQuery).lean();

    // Fetch attendance for the month
    const attendance = await Attendance.find({
      date: { $gte: startDate, $lte: endDate },
      employee: { $in: employees.map((emp) => emp._id) },
    }).lean();

    // Calculate reports
    const reports = employees.map((emp) => {
      const empAttendance = attendance.filter((att) => att.employee.toString() === emp._id.toString());
      const presentDays = empAttendance.filter((att) => att.status === 'present').length;
      const absentDays = empAttendance.filter((att) => att.status === 'absent').length;
      const leaveDays = Math.max(0, absentDays - 2); // Deduct after 2 paid leaves
      const dailySalary = emp.salary / daysInMonth;
      const salary = emp.salary - leaveDays * dailySalary;

      return {
        employeeId: emp.employeeId,
        name: emp.name,
        presentDays,
        absentDays,
        leaveDays,
        salary,
      };
    });

    res.json({ reports, locations });
  } catch (error) {
    console.error('Get reports error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};