// models/Advance.js
import mongoose from 'mongoose';

const advanceSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  month: {
    type: String, // Format: "YYYY-MM" (e.g., "2025-06")
    required: true,
    match: [/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format'],
  },
  status: {
    type: String,
    enum: ['pending', 'deducted'],
    default: 'pending',
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

advanceSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Advance', advanceSchema);