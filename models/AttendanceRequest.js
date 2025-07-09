// models/AttendanceRequest.js
import mongoose from 'mongoose';

const attendanceRequestSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  location: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    required: true,
  },
  date: {
    type: String, // Changed to String
    required: true,
    validate: {
      validator: function (value) {
        return /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/.test(value);
      },
      message: 'Date must be a valid ISO 8601 string',
    },
  },
  requestedStatus: {
    type: String,
    enum: ['present', 'absent', 'leave', 'half-day'],
    required: true,
  },
  reason: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: {
    type: Date,
  },
}, {
  timestamps: true,
});

export default mongoose.model('AttendanceRequest', attendanceRequestSchema);