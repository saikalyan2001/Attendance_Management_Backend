import mongoose from 'mongoose';

const monthlyLeaveSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 }, // 1 = January, 12 = December
  allocated: { type: Number, default: 2, min: 0 }, // 2 leaves per month
  taken: { type: Number, default: 0, min: 0 },
  carriedForward: { type: Number, default: 0, min: 0 },
  available: { type: Number, default: 2, min: 0 }, // carriedForward + allocated - taken
}, { _id: false });

const employeeSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true }, // Added lowercase: true
  designation: { type: String, required: true },
  department: { type: String, required: true },
  salary: { type: Number, required: true },
  location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  paidLeaves: {
    available: { type: Number, default: 0, min: 0 },
    used: { type: Number, default: 0, min: 0 },
    carriedForward: { type: Number, default: 0, min: 0 },
  },
  monthlyLeaves: [monthlyLeaveSchema], // New field for monthly leave records
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
  advance: { type: Number, default: 0, min: 0 },
  advanceHistory: [
    {
      amount: { type: Number, required: true, min: 0 },
      updatedAt: { type: Date, default: Date.now },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
  ],
  transferTimestamp: { type: Date, default: null },
});

// Initialize employmentHistory and monthlyLeaves for new employees
employeeSchema.pre('save', function (next) {
  if (this.isNew && !this.employmentHistory.length) {
    this.employmentHistory = [{
      startDate: this.joinDate,
      status: 'active',
    }];
  }
  if (this.isNew && !this.monthlyLeaves.length) {
    const joinDate = new Date(this.joinDate);
    const joinYear = joinDate.getFullYear();
    const joinMonth = joinDate.getMonth() + 1; // 1-based
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const monthlyAllocation = 24 / 12; // Default to 2 leaves/month (24 leaves/year)

    // Initialize monthly leaves from join month to current month
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
  next();
});

// Add case-insensitive index for email
employeeSchema.index({ email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export default mongoose.model('Employee', employeeSchema);