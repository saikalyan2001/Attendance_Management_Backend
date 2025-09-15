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
  // Store presence value for salary calculation
  presenceDays: {
    type: Number,
    default: function() {
      if (this.status === 'present') return 1.0;
      if (this.status === 'half-day') return 0.5;
      return 0; // absent, leave
    }
  },
  
  // ✅ NEW: Exception handling fields
  isException: {
    type: Boolean,
    default: false,
  },
  exceptionReason: {
    type: String,
    enum: ['overtime', 'emergency', 'client_work', 'management_approval', 'other'],
    required: function() { return this.isException; }
  },
  exceptionDescription: {
    type: String,
    required: function() { return this.isException && this.exceptionReason === 'other'; }
  },
  
  markedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function() { return this.isException; }
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

// Pre-save hook to calculate presence days
attendanceSchema.pre('save', function(next) {
  if (this.status === 'present') {
    this.presenceDays = 1.0;
  } else if (this.status === 'half-day') {
    this.presenceDays = 0.5;
  } else if (this.status === 'leave') {
    this.presenceDays = 1.0; // ✅ FIXED: Paid leaves should count as full attendance
  }  else {
    this.presenceDays = 0; // absent, leave
  }
  next();
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
    },
  }
);

export default mongoose.model('Attendance', attendanceSchema);
