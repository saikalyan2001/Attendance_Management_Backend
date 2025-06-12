import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  paidLeavesPerYear: {
    type: Number,
    required: true,
    min: 4, // Minimum 12 leaves per year (1 per month)
    max: 360, // Maximum 360 leaves per year (30 per month)
    default: 24, // Default to 24 leaves per year (2 per month)
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
