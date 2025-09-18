import mongoose from 'mongoose';

const getEmployeeWorkingDays = async (locationId, year, month) => {
  try {
    const Settings = mongoose.model('Settings');
    const settings = await Settings.findOne()
      .populate('workingDayPolicies.locations')
      .lean();
    
    if (!settings) return 30;
    
    const policy = settings.workingDayPolicies?.find(policy => 
      policy.locations.some(loc => loc._id.toString() === locationId.toString())
    );
    
    if (policy) {
      return policy.workingDaysPerMonth;
    }
    
    return settings.defaultWorkingDaysPerMonth || 30;
  } catch (error) {
    return 30;
  }
};

const documentSchema = new mongoose.Schema({
  googleDriveId: { type: String }, 
  originalName: { type: String }, 
  filename: { type: String }, 
  mimeType: { type: String }, 
  size: { type: Number }, 
  webViewLink: { type: String }, 
  webContentLink: { type: String }, 
  uploadedAt: { type: Date, default: Date.now },
  createdTime: { type: String }, 
  locationName: { type: String, default: 'General' },
  locationFolderId: { type: String },
  name: { type: String }, 
  path: { type: String }, 
}, { _id: true });

const advanceSchema = new mongoose.Schema({
  year: { type: Number },
  month: { type: Number },
  amount: { type: Number },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const monthlyLeaveSchema = new mongoose.Schema({
  year: { type: Number },
  month: { type: Number },
  allocated: { type: Number, default: 2 },
  taken: { type: Number, default: 0 },
  carriedForward: { type: Number, default: 0 },
  available: { type: Number, default: 2 },
  isFinalized: { type: Boolean, default: false },
  finalizedAt: { type: Date },
}, { _id: false });

const monthlyPresenceSchema = new mongoose.Schema({
  year: { type: Number },
  month: { type: Number },
  totalPresenceDays: { type: Number, default: 0 },
  workingDaysInMonth: { type: Number, default: 30 },
  lastUpdated: { type: Date, default: Date.now }
}, { _id: false });

// ✅ UPDATED: Employee Schema with prorated leave fixes
const employeeSchema = new mongoose.Schema({
  employeeId: { type: String },
  name: { type: String },
  email: { type: String, lowercase: true },
  designation: { type: String },
  department: { type: String },
  salary: { type: Number },
  location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
  
  // ✅ CRITICAL FIX: PaidLeaves with allocated field
  paidLeaves: {
    allocated: { type: Number, default: 0 },      // ✅ ADDED: Missing critical field
    available: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    carriedForward: { type: Number, default: 0 },
  },
  
  monthlyLeaves: [monthlyLeaveSchema],
  monthlyPresence: [monthlyPresenceSchema],
  advances: [advanceSchema],
  documents: [
    {
      name: { type: String },
      path: { type: String },
      uploadedAt: { type: Date, default: Date.now },
      size: { type: Number },
    },
  ],
  phone: { type: String },
  dob: { type: Date },
  joinDate: { type: Date },
  bankDetails: {
    accountNo: { type: String },
    ifscCode: { type: String },
    bankName: { type: String },
    accountHolder: { type: String },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, default: 'active' },
  isDeleted: { type: Boolean, default: false },
  transferHistory: [
    {
      fromLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
      toLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
      transferDate: { type: Date, default: Date.now },
    },
  ],
  employmentHistory: [
    {
      startDate: { type: Date },
      endDate: { type: Date, default: null },
      status: { type: String },
      leaveBalanceAtEnd: { type: Number },
    },
  ],
  advance: { type: Number, default: 0, select: false },
  advanceHistory: [advanceSchema],
  isManualPaidLeavesUpdate: { type: Boolean, default: false },
  transferTimestamp: { type: Date, default: null },
  
  // ✅ NEW: Prorated employee tracking
  isProratedEmployee: { type: Boolean, default: false },
});

// ✅ CRITICAL FIX: Pre-save hook with prorated leave calculation
employeeSchema.pre('save', async function (next) {
  const joinDate = new Date(this.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // Fetch settings with populated location data
  const settings = await mongoose.model('Settings').findOne().populate('locationLeaveSettings.location');
  
  // Get location-specific or global leave allocation
  let monthlyAllocation = 2;
  let totalYearlyAllocation = 24;
  
  if (settings && this.location) {
    const locationSetting = settings.locationLeaveSettings.find(
      setting => setting.location._id.toString() === this.location.toString()
    );
    
    if (locationSetting) {
      totalYearlyAllocation = locationSetting.paidLeavesPerYear;
      monthlyAllocation = locationSetting.paidLeavesPerYear / 12;
    } else {
      totalYearlyAllocation = settings.paidLeavesPerYear || 24;
      monthlyAllocation = (settings.paidLeavesPerYear || 24) / 12;
    }
  }

  // ✅ CRITICAL: Detect prorated employees early
  const isProrated = this.isProratedEmployee === true || 
                     (this.paidLeaves?.allocated > 0 && 
                      this.paidLeaves?.allocated < totalYearlyAllocation);  // Initialize monthlyLeaves only for new employees
  if (this.isNew && (!this.monthlyLeaves || this.monthlyLeaves.length === 0)) {
    this.monthlyLeaves = [];
    let totalAllocatedAcrossMonths = 0;
    
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
          isFinalized: false,
          finalizedAt: null
        });
        
        totalAllocatedAcrossMonths += monthlyAllocation;
      }
    }  }

  // Initialize monthlyPresence, employmentHistory, advances (same as before)
  if (this.isNew && (!this.monthlyPresence || this.monthlyPresence.length === 0)) {
    this.monthlyPresence = [];
    for (let y = joinYear; y <= currentYear; y++) {
      const startMonth = y === joinYear ? joinMonth : 1;
      const endMonth = y === currentYear ? currentMonth : 12;
      for (let m = startMonth; m <= endMonth; m++) {
        const workingDaysInMonth = await getEmployeeWorkingDays(this.location, y, m);
        
        this.monthlyPresence.push({
          year: y,
          month: m,
          totalPresenceDays: 0,
          workingDaysInMonth: workingDaysInMonth,
          lastUpdated: new Date()
        });
      }
    }
  }

  if (this.isNew && !this.employmentHistory.length) {
    this.employmentHistory = [{
      startDate: this.joinDate,
      status: 'active',
    }];
  }

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

  // ✅ CRITICAL FIX: Skip auto-calculation for prorated employees
  const paidLeavesModified = this.isModified('paidLeaves.available') || 
                             this.isModified('paidLeaves.used') || 
                             this.isModified('paidLeaves.carriedForward');
  
  const shouldAutoCalculate = !this.isNew && 
                              !this.isManualPaidLeavesUpdate && 
                              !paidLeavesModified &&
                              !isProrated; // ✅ CRITICAL: Skip for prorated employees

 // ✅ FIXED: In employeeSchema.pre('save') hook
if (shouldAutoCalculate) {

  
  // ✅ Calculate capped total usage
  let cappedTotalUsage = 0;
  this.monthlyLeaves.forEach(ml => {
    const monthlyAvailable = (ml.allocated || 0) + (ml.carriedForward || 0);
    const cappedUsage = Math.min(ml.taken || 0, monthlyAvailable);
    cappedTotalUsage += cappedUsage;
  });
  
  this.set('paidLeaves.used', cappedTotalUsage); // ✅ Use capped total
  this.set('paidLeaves.available', Math.max(0, totalYearlyAllocation - cappedTotalUsage));
} else if (this.isNew) {
    // For new employees, calculate prorated allocation
    const actualTotalAllocation = this.monthlyLeaves.reduce((sum, ml) => sum + ml.allocated, 0);
    const isProratedNew = (joinMonth > 1) && (joinYear >= currentYear);
    const finalAllocation = isProratedNew ? actualTotalAllocation : totalYearlyAllocation;    this.set('paidLeaves.allocated', finalAllocation);
    this.set('paidLeaves.available', finalAllocation);
    this.set('paidLeaves.used', 0);
    this.set('paidLeaves.carriedForward', 0);
    this.isProratedEmployee = isProratedNew;
  } else if (isProrated) {
    // ✅ CRITICAL: For existing prorated employees, preserve their values

  }

  next();
});


export default mongoose.model('Employee', employeeSchema);
