import Settings from '../../models/Settings.js';
import Employee from '../../models/Employee.js';

export const getSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
        highlightDuration: 24 * 60 * 60 * 1000, // Default to 24 hours in milliseconds
      });
    }
    res.json(settings);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { paidLeavesPerMonth, halfDayDeduction, highlightDuration } = req.body;

    if (!Number.isInteger(paidLeavesPerMonth) || paidLeavesPerMonth < 1 || paidLeavesPerMonth > 30) {
      return res.status(400).json({ message: 'Paid leaves must be an integer between 1 and 30' });
    }

    if (isNaN(halfDayDeduction) || halfDayDeduction < 0 || halfDayDeduction > 1) {
      return res.status(400).json({ message: 'Half-day deduction must be between 0 and 1' });
    }

    if (!Number.isInteger(highlightDuration) || highlightDuration < 60 * 1000 || highlightDuration > 7 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ message: 'Highlight duration must be between 1 minute and 7 days (in milliseconds)' });
    }

    const settings = await Settings.findOneAndUpdate(
      {},
      { paidLeavesPerMonth, halfDayDeduction, highlightDuration },
      { new: true, upsert: true }
    );

    res.json(settings);
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateEmployeeLeaves = async (req, res) => {
  try {
    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ message: 'Settings not found' });
    }

    const { paidLeavesPerMonth } = settings;
    const employees = await Employee.find();

    const updatedEmployees = await Promise.all(
      employees.map(async (employee) => {
        const newAvailable = employee.paidLeaves.available + paidLeavesPerMonth;
        return await Employee.findByIdAndUpdate(
          employee._id,
          {
            $set: {
              'paidLeaves.available': Math.min(newAvailable, 30),
              'paidLeaves.carriedForward': Math.max(0, newAvailable - 30),
            },
          },
          { new: true }
        );
      })
    );

    res.json({ 
      message: 'Employee leaves updated successfully', 
      employeeCount: updatedEmployees.length 
    });
  } catch (error) {
    console.error('Update employee leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};