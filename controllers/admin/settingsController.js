import Settings from '../../models/Settings.js';
import Employee from '../../models/Employee.js';
import Attendance from '../../models/Attendance.js';
import asyncHandler from 'express-async-handler';

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

    res.status(500).json({ message: 'Could not load system settings due to a server issue. Please try again later.' });
  }
});

export const updateSettings = asyncHandler(async (req, res) => {
  try {
    const { paidLeavesPerYear, halfDayDeduction, highlightDuration } = req.body;

    // Prepare update object with only provided fields
    const updateFields = {};

    if (paidLeavesPerYear !== undefined) {
      if (!Number.isInteger(paidLeavesPerYear) || paidLeavesPerYear < 12 || paidLeavesPerYear > 360) {
        return res.status(400).json({ message: 'Paid leaves per year must be between 12 and 360 days' });
      }
      updateFields.paidLeavesPerYear = paidLeavesPerYear;
    }

    if (halfDayDeduction !== undefined) {
      if (isNaN(halfDayDeduction) || halfDayDeduction < 0 || halfDayDeduction > 1) {
        return res.status(400).json({ message: 'Half-day deduction must be between 0 and 1' });
      }
      updateFields.halfDayDeduction = halfDayDeduction;
    }

    if (highlightDuration !== undefined) {
      if (!Number.isInteger(highlightDuration) || highlightDuration < 60 * 1000 || highlightDuration > 7 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ message: 'Highlight duration must be between 1 minute and 7 days' });
      }
      updateFields.highlightDuration = highlightDuration;
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ message: 'Please provide at least one valid setting to update' });
    }

    const settings = await Settings.findOneAndUpdate(
      {},
      { $set: updateFields },
      { new: true, upsert: true }
    );

    res.json(settings);
  } catch (error) {

    res.status(500).json({ message: 'Could not update settings due to a server issue. Please try again later.' });
  }
});

export const updateEmployeeLeaves = asyncHandler(async (req, res) => {
  try {
    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ message: 'System settings not found. Please contact support.' });
    }

    const { paidLeavesPerYear } = settings;
    const monthlyAllocation = Math.floor(paidLeavesPerYear / 12);

    const employees = await Employee.find({ status: 'active', isDeleted: false });
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const remainingMonths = 12 - currentMonth + 1;
    const totalLeaves = remainingMonths * monthlyAllocation;

    const updatedEmployees = await Promise.all(
      employees.map(async (employee) => {
        try {
          const newMonthlyLeaves = [];
          for (let m = currentMonth; m <= 12; m++) {
            const startDate = new Date(currentYear, m - 1, 1).toISOString().split('T')[0];
            const endDate = new Date(currentYear, m, 1).toISOString().split('T')[0];

            const attendanceRecords = await Attendance.find({
              employee: employee._id,
              date: { $gte: `${startDate}T00:00:00+05:30`, $lt: `${endDate}T00:00:00+05:30` },
              status: { $in: ['leave', 'half-day'] },
              isDeleted: false,
            }).lean();

            const taken = attendanceRecords.reduce((sum, record) => {
              return sum + (record.status === 'leave' ? 1 : settings.halfDayDeduction || 0.5);
            }, 0);

            const allocatedLeaves = monthlyAllocation;
            const openingLeaves = allocatedLeaves;
            const closingLeaves = Math.max(0, openingLeaves - taken);

            newMonthlyLeaves.push({
              year: currentYear,
              month: m,
              allocated: allocatedLeaves,
              taken,
              carriedForward: 0,
              openingLeaves,
              closingLeaves,
              available: closingLeaves,
            });
          }

          employee.monthlyLeaves = newMonthlyLeaves;
          employee.paidLeaves.available = Math.max(0, totalLeaves - employee.paidLeaves.used);
          employee.paidLeaves.carriedForward = 0;
          await employee.save();


          return employee;
        } catch (error) {

          return employee;
        }
      })
    );

    res.json({
      message: 'Employee leave balances updated successfully',
      employeeCount: updatedEmployees.length,
    });
  } catch (error) {

    res.status(500).json({ message: 'Could not update employee leave balances due to a server issue. Please try again later.' });
  }
});
