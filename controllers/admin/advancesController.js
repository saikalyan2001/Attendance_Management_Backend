// controllers/admin/advancesController.js
import asyncHandler from 'express-async-handler';
import Advance from '../../models/Advance.js';
import Employee from '../../models/Employee.js';
import mongoose from 'mongoose';

// @desc    Get advances with filters
// @route   GET /api/admin/advances
// @access  Private/Admin
const getAdvances = asyncHandler(async (req, res) => {
  const { employeeId, month, status } = req.query;
  const match = {};

  if (employeeId) {
    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      res.status(400);
      throw new Error('Invalid employee ID');
    }
    match.employee = employeeId;
  }

  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400);
      throw new Error('Month must be in YYYY-MM format');
    }
    match.month = month;
  }

  if (status) {
    if (!['pending', 'deducted'].includes(status)) {
      res.status(400);
      throw new Error('Invalid status');
    }
    match.status = status;
  }

  const advances = await Advance.find(match)
    .populate('employee', 'name employeeId')
    .populate('updatedBy', 'name')
    .lean();

  res.status(200).json(advances);
});

// @desc    Delete an advance (only if pending)
// @route   DELETE /api/admin/advances/:id
// @access  Private/Admin
const deleteAdvance = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid advance ID');
  }

  const advance = await Advance.findById(id);
  if (!advance) {
    res.status(404);
    throw new Error('Advance not found');
  }

  if (advance.status === 'deducted') {
    res.status(400);
    throw new Error('Cannot delete a deducted advance');
  }

  await Advance.deleteOne({ _id: id });
  res.status(200).json({ message: 'Advance deleted successfully' });
});

export { getAdvances, deleteAdvance };