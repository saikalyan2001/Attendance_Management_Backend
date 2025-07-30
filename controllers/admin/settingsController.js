import Settings from '../../models/Settings.js';
import Employee from '../../models/Employee.js';

export const getSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24, // Default to 24 leaves per year
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

    const { paidLeavesPerYear } = settings;
    const employees = await Employee.find();
    const currentYear = new Date().getFullYear();

    const updatedEmployees = await Promise.all(
      employees.map(async (employee) => {
        const joinDate = new Date(employee.joinDate);
        const joinYear = joinDate.getFullYear();
        const joinMonth = joinDate.getMonth(); // 0-based (0 = January, 2 = March, etc.)
        
        // Calculate remaining months in the join year
        const remainingMonths = joinYear === currentYear ? 12 - joinMonth : 12;
        // Prorate leaves based on remaining months
        const proratedLeaves = Math.round((paidLeavesPerYear * remainingMonths) / 12);
        const monthlyLeaves = paidLeavesPerYear / 12;
        const newAvailable = Math.min(proratedLeaves, employee.paidLeaves.available + monthlyLeaves);

        return await Employee.findByIdAndUpdate(
          employee._id,
          {
            $set: {
              'paidLeaves.available': Math.min(newAvailable, 30), // Cap at 30
              'paidLeaves.carriedForward': Math.max(0, newAvailable - 30), // Carry forward excess
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
