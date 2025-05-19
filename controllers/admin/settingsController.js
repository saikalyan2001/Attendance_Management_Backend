import Settings from '../../models/Settings.js';

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