import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema({
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
    type: String,
    required: true,
    validate: {
      validator: function (value) {
        return /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(\+\d{2}:\d{2})$/.test(value);
      },
      message: 'Date must be a valid ISO 8601 string',
    },
  },
  status: {
    type: String,
    enum: ['present', 'absent', 'leave', 'half-day'],
    required: true,
  },
  markedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  isDeleted: {
    type: Boolean,
    default: false,
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  deletedAt: {
    type: Date,
  },
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

// Add unique index on employee and date (ignoring time)
attendanceSchema.index(
  { employee: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    collation: {
      locale: 'en',
      strength: 2,
      // Normalize date to start of day for uniqueness
      key: { date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } } },
    },
  }
);

export default mongoose.model('Attendance', attendanceSchema);