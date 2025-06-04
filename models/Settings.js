import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  paidLeavesPerMonth: {
    type: Number,
    required: true,
    min: 1,
    max: 30,
    default: 2,
  },
  halfDayDeduction: {
    type: Number,
    required: true,
    min: 0,
    max: 1,
    default: 0.5,
  },
  highlightDuration: {
    type: Number,
    required: true,
    min: 0,
    default: 24 * 60 * 60 * 1000, // Default to 24 hours in milliseconds
  },
});

export default mongoose.model('Settings', settingsSchema);