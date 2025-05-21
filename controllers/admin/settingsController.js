import Settings from '../../models/Settings.js';
import Employee from '../../models/Employee.js';

export const getSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
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
    const { paidLeavesPerMonth, halfDayDeduction } = req.body;

    if (!Number.isInteger(paidLeavesPerMonth) || paidLeavesPerMonth < 1 || paidLeavesPerMonth > 30) {
      return res.status(400).json({ message: 'Paid leaves must be an integer between 1 and 30' });
    }

    if (isNaN(halfDayDeduction) || halfDayDeduction < 0 || halfDayDeduction > 1) {
      return res.status(400).json({ message: 'Half-day deduction must be between 0 and 1' });
    }

    const settings = await Settings.findOneAndUpdate(
      {},
      { paidLeavesPerMonth, halfDayDeduction },
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
              'paidLeaves.available': Math.min(newAvailable, 30), // Cap at 30 leaves
              'paidLeaves.carriedForward': Math.max(0, newAvailable - 30), // Carry forward excess
            },
          },
          { new: true }
        );
      })
    );

    res.json({ message: 'Employee leaves updated successfully', updatedEmployees });
  } catch (error) {
    console.error('Update employee leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
