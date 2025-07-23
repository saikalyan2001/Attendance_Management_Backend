// models/Employee.js
import mongoose from 'mongoose';

const advanceSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  amount: { type: Number, required: true, min: 0 },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { _id: false });

const monthlyLeaveSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  allocated: { type: Number, default: 2, min: 0 },
  taken: { type: Number, default: 0, min: 0 },
  carriedForward: { type: Number, default: 0, min: 0 },
  available: { type: Number, default: 2, min: 0 },
}, { _id: false });

const employeeSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  designation: { type: String, required: true },
  department: { type: String, required: true },
  salary: { type: Number, required: true },
  location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  paidLeaves: {
    available: { type: Number, default: 0, min: 0 },
    used: { type: Number, default: 0, min: 0 },
    carriedForward: { type: Number, default: 0, min: 0 },
  },
  monthlyLeaves: [monthlyLeaveSchema],
  advances: [advanceSchema],
  documents: [
    {
      name: { type: String, required: true },
      path: { type: String, required: true },
      uploadedAt: { type: Date, default: Date.now },
      size: { type: Number },
    },
  ],
  phone: { type: String },
  dob: { type: Date },
  joinDate: { type: Date, required: true },
  bankDetails: {
    accountNo: { type: String, required: true },
    ifscCode: { type: String, required: true },
    bankName: { type: String, required: true },
    accountHolder: { type: String, required: true },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  isDeleted: { type: Boolean, default: false }, // Added isDeleted field
  transferHistory: [
    {
      fromLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
      toLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
      transferDate: { type: Date, default: Date.now },
    },
  ],
  employmentHistory: [
    {
      startDate: { type: Date, required: true },
      endDate: { type: Date, default: null },
      status: { type: String, enum: ['active', 'inactive'], required: true },
      leaveBalanceAtEnd: { type: Number },
    },
  ],
  advance: { type: Number, default: 0, min: 0, select: false },
  advanceHistory: [advanceSchema],
  transferTimestamp: { type: Date, default: null },
});

// Initialize employmentHistory, monthlyLeaves, and advances for new employees
employeeSchema.pre('save', async function (next) {
  const joinDate = new Date(this.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const settings = await mongoose.model('Settings').findOne().lean();
  const monthlyAllocation = (settings?.paidLeavesPerYear || 24) / 12;

  // Initialize monthlyLeaves only for new employees
  if (this.isNew && (!this.monthlyLeaves || this.monthlyLeaves.length === 0)) {
    this.monthlyLeaves = [];
    for (let y = joinYear; y <= currentYear; y++) {
      const startMonth = y === joinYear ? joinMonth : 1;
      const endMonth = y === currentYear ? currentMonth : 12;
      for (let m = startMonth; m <= endMonth; m++) {
        this.monthlyLeaves.push({
          year: y,
          month: m,
          allocated: monthlyAllocation,
          taken: 0,
          carriedForward: 0,
          available: monthlyAllocation,
        });
      }
    }
  }

  // Initialize employmentHistory for new employees
  if (this.isNew && !this.employmentHistory.length) {
    this.employmentHistory = [{
      startDate: this.joinDate,
      status: 'active',
    }];
  }

  // Initialize advances for new employees
  if (this.isNew && !this.advances.length) {
    this.advances = [];
    for (let y = joinYear; y <= currentYear; y++) {
      const startMonth = y === joinYear ? joinMonth : 1;
      const endMonth = y === currentYear ? currentMonth : 12;
      for (let m = startMonth; m <= endMonth; m++) {
        this.advances.push({
          year: y,
          month: m,
          amount: 0,
          updatedAt: new Date(),
          updatedBy: this.createdBy,
        });
      }
    }
  }

  // Only update paidLeaves based on existing monthlyLeaves data
  if (!this.isNew) {
    const totalTaken = this.monthlyLeaves.reduce((sum, ml) => sum + ml.taken, 0);
    this.paidLeaves.used = totalTaken;
    this.paidLeaves.available = (settings?.paidLeavesPerYear || 24) - totalTaken;
  }

  next();
});

// Add case-insensitive index for email
employeeSchema.index({ email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export default mongoose.model('Employee', employeeSchema);