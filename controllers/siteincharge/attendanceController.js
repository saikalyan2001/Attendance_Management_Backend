import Attendance from '../../models/Attendance.js';
import Employee from '../../models/Employee.js';
import Settings from '../../models/Settings.js';

export const markAttendance = async (req, res) => {
  try {
    const { employeeId, date, status } = req.body;

    if (!employeeId || !date || !status) {
      return res.status(400).json({ message: 'Employee ID, date, and status are required' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const parsedDate = new Date(date);
    if (isNaN(parsedDate)) {
      return res.status(400).json({ message: 'Invalid date format' });
    }

    const existingAttendance = await Attendance.findOne({
      employee: employeeId,
      date: parsedDate,
    });
    if (existingAttendance) {
      return res.status(400).json({ message: 'Attendance already marked for this date' });
    }

    // Fetch settings for halfDayDeduction
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
      });
    }

    // Handle leave and half-day deductions
    if (status === 'Leave' && employee.paidLeaves.available < 1) {
      return res.status(400).json({ message: 'No paid leaves available' });
    }
    if (status === 'Half-Day' && employee.paidLeaves.available < settings.halfDayDeduction) {
      return res.status(400).json({ message: 'Insufficient paid leaves for half-day' });
    }

    if (status === 'Leave') {
      employee.paidLeaves.available -= 1;
    } else if (status === 'Half-Day') {
      employee.paidLeaves.available -= settings.halfDayDeduction;
    }
    await employee.save();

    const attendance = new Attendance({
      employee: employeeId,
      date: parsedDate,
      status,
    });
    await attendance.save();

    res.status(201).json(attendance);
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getMonthlyAttendance = async (req, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    const parsedMonth = parseInt(month) - 1; // 0-based for Date
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
    })
      .populate('employee', 'name employeeId')
      .lean();

    res.json(attendance);
  } catch (error) {
    console.error('Get monthly attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};