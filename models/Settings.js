import mongoose from 'mongoose';

// Working day policy schema with dynamic calculation support
const workingDayPolicySchema = new mongoose.Schema({
  policyName: {
    type: String,
    required: true,
    trim: true,
  },
  policyType: {
    type: String,
    enum: ['all_days', 'exclude_sundays', 'exclude_weekends', 'custom_fixed'],
    required: true,
    default: 'all_days',
  },
  // Only used when policyType is 'custom_fixed'
  fixedWorkingDays: {
    type: Number,
    min: 20,
    max: 31,
    default: 30,
  },
  // Days to exclude (0=Sunday, 1=Monday, ..., 6=Saturday)
  excludeDays: [{
    type: Number,
    min: 0,
    max: 6,
  }],
  locations: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    required: true,
  }],
  description: {
    type: String,
    default: '',
  },
  isDefault: {
    type: Boolean,
    default: false,
  }
}, { _id: true });

// Holiday schema remains the same
const holidaySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  date: {
    type: Date,
    required: true,
  },
  locations: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    required: true,
  }],
  isRecurring: {
    type: Boolean,
    default: false,
  },
  recurringType: {
    type: String,
    enum: ['yearly', 'monthly'],
    default: 'yearly',
  },
  description: {
    type: String,
    default: '',
  }
}, { _id: true });

const locationLeaveSettingSchema = new mongoose.Schema({
  location: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    required: true,
  },
  paidLeavesPerYear: {
    type: Number,
    required: true,
    min: 12,
    max: 360,
    default: 24,
  },
}, { _id: false });

const settingsSchema = new mongoose.Schema({
  paidLeavesPerYear: {
    type: Number,
    required: true,
    min: 12,
    max: 360,
    default: 24,
  },
  
  locationLeaveSettings: [locationLeaveSettingSchema],
  
  // Updated working day policies with dynamic calculation
  workingDayPolicies: [workingDayPolicySchema],
  
  holidays: [holidaySchema],
  
  // Default policy for locations not in any specific policy
  defaultWorkingDayPolicy: {
    type: String,
    enum: ['all_days', 'exclude_sundays', 'exclude_weekends', 'custom_fixed'],
    default: 'all_days',
  },
  
  defaultFixedWorkingDays: {
    type: Number,
    min: 20,
    max: 31,
    default: 30,
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
    default: 24 * 60 * 60 * 1000,
  },
});

// Indexes for efficient queries
settingsSchema.index({ 'locationLeaveSettings.location': 1 });
settingsSchema.index({ 'workingDayPolicies.locations': 1 });
settingsSchema.index({ 'holidays.locations': 1 });
settingsSchema.index({ 'holidays.date': 1 });

export default mongoose.model('Settings', settingsSchema);
