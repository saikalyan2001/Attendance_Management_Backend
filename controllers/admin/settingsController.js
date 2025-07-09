import Settings from '../../models/Settings.js';
import Employee from '../../models/Employee.js';
import asyncHandler from 'express-async-handler';
import Attendance from '../../models/Attendance.js';

export const getSettings = asyncHandler(async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24,
        halfDayDeduction: 0.5,
        highlightDuration: 24 * 60 * 60 * 1000,
      });
    }
    res.status(200).json(settings);
  } catch (error) {
    ('Get settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export const updateSettings = asyncHandler(async (req, res) => {
  try {
    const { paidLeavesPerYear, halfDayDeduction, highlightDuration } = req.body;

    if (!Number.isInteger(paidLeavesPerYear) || paidLeavesPerYear < 12 || paidLeavesPerYear > 360) {
      return res.status(400).json({ message: 'Paid leaves per year must be an integer between 12 and 360' });
    }

    if (isNaN(halfDayDeduction) || halfDayDeduction < 0 || halfDayDeduction > 1) {
      return res.status(400).json({ message: 'Half-day deduction must be between 0 and 1' });
    }

    if (!Number.isInteger(highlightDuration) || highlightDuration < 60 * 1000 || highlightDuration > 7 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ message: 'Highlight duration must be between 1 minute and 7 days (in milliseconds)' });
    }

    const settings = await Settings.findOneAndUpdate(
      {},
      { paidLeavesPerYear, halfDayDeduction, highlightDuration },
      { new: true, upsert: true }
    );

    res.json(settings);
  } catch (error) {
    ('Update settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export const updateEmployeeLeaves = asyncHandler(async (req, res) => {
  try {
    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ message: 'Settings not found' });
    }

    const { paidLeavesPerYear } = settings;
    const monthlyAllocation = paidLeavesPerYear / 12;
    const employees = await Employee.find();
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;

    const updatedEmployees = await Promise.all(
      employees.map(async (employee) => {
        const joinDate = new Date(employee.joinDate);
        const joinYear = joinDate.getFullYear();
        const joinMonth = joinDate.getMonth() + 1;

        let previousClosingLeaves = 0;
        let totalLeaves = 0;
        const newMonthlyLeaves = [];

        for (let y = joinYear; y <= currentYear; y++) {
          const startMonth = y === joinYear ? joinMonth : 1;
          const endMonth = y === currentYear ? currentMonth : 12;

          for (let m = startMonth; m <= endMonth; m++) {
            // Calculate taken leaves from attendance records
            const startDate = new Date(y, m - 1, 1).toISOString().split('T')[0];
            const endDate = new Date(y, m, 1).toISOString().split('T')[0];
            const attendanceRecords = await Attendance.find({
              employee: employee._id,
              date: { $gte: `${startDate}T00:00:00+05:30`, $lt: `${endDate}T00:00:00+05:30` },
              status: { $in: ['leave', 'half-day'] },
              isDeleted: false,
            }).lean();

            const taken = attendanceRecords.reduce((sum, record) => {
              return sum + (record.status === 'leave' ? 1 : settings.halfDayDeduction || 0.5);
            }, 0);

            const daysInMonth = new Date(y, m, 0).getDate();
            const joinDay = y === joinYear && m === joinMonth ? joinDate.getDate() : 1;
            const prorationFactor = (daysInMonth - joinDay + 1) / daysInMonth;
            const allocatedLeaves = Math.round(monthlyAllocation * prorationFactor * 10) / 10;

            const openingLeaves = allocatedLeaves + previousClosingLeaves;
            const closingLeaves = Math.max(0, openingLeaves - taken);
            newMonthlyLeaves.push({
              year: y,
              month: m,
              allocated: allocatedLeaves,
              taken,
              carriedForward: previousClosingLeaves,
              openingLeaves,
              closingLeaves,
              available: closingLeaves,
            });
            totalLeaves += allocatedLeaves;
            previousClosingLeaves = closingLeaves;
          }
        }

        employee.monthlyLeaves = newMonthlyLeaves;
        employee.paidLeaves.available = Math.max(0, totalLeaves - employee.paidLeaves.used);
        employee.paidLeaves.carriedForward = 0;
        await employee.save();
        return employee;
      })
    );

    res.json({
      message: 'Employee leaves updated successfully',
      employeeCount: updatedEmployees.length,
    });
  } catch (error) {
    ('Update employee leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});