import mongoose from 'mongoose';


const getEmployeeWorkingDays = async (locationId, year, month) => {
  try {
    const Settings = mongoose.model('Settings');
    const settings = await Settings.findOne()
      .populate('workingDayPolicies.locations')
      .lean();
    
    if (!settings) return 30; // Default fallback
    
    // Find the working day policy that includes this location
    const policy = settings.workingDayPolicies?.find(policy => 
      policy.locations.some(loc => loc._id.toString() === locationId.toString())
    );
    
    if (policy) {
      return policy.workingDaysPerMonth;
    }
    
    // Return default if no policy found
    return settings.defaultWorkingDaysPerMonth || 30;
  } catch (error) {
    
    return 30; // Default fallback
  }
};

const documentSchema = new mongoose.Schema({
  // Google Drive fields (primary)
  googleDriveId: { type: String, required: true }, 
  originalName: { type: String, required: true }, 
  filename: { type: String, required: true }, 
  mimeType: { type: String, required: true }, 
  size: { type: Number, required: true }, 
  webViewLink: { type: String }, 
  webContentLink: { type: String }, 
  uploadedAt: { type: Date, default: Date.now },
  createdTime: { type: String }, 

  // ✅ NEW: Location tracking
  locationName: { type: String, default: 'General' },
  locationFolderId: { type: String },
  
  
  // Backward compatibility (keep for existing documents)
  name: { type: String }, 
  path: { type: String }, 
}, { _id: true });

const advanceSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  amount: { type: Number, required: true, min: 0 },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { _id: false });

// models/Employee.js - UPDATE the monthlyLeaveSchema
const monthlyLeaveSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  allocated: { type: Number, default: 2 }, // ✅ REMOVED: min: 0
  taken: { type: Number, default: 0 }, // ✅ REMOVED: min: 0  
  carriedForward: { type: Number, default: 0 }, // ✅ REMOVED: min: 0
  available: { type: Number, default: 2 }, // ✅ REMOVED: min: 0 - Allow negative balances
}, { _id: false });


// ✅ NEW: Monthly presence tracking schema
const monthlyPresenceSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  totalPresenceDays: { type: Number, default: 0, min: 0 },
  workingDaysInMonth: { type: Number, default: 30 }, // Base days for calculation
  lastUpdated: { type: Date, default: Date.now }
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
  // ✅ NEW: Monthly presence tracking for salary calculation
  monthlyPresence: [monthlyPresenceSchema],
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
      startDate: { type: Date, required: true },
      endDate: { type: Date, default: null },
      status: { type: String, enum: ['active', 'inactive'], required: true },
      leaveBalanceAtEnd: { type: Number },
    },
  ],
  advance: { type: Number, default: 0, min: 0, select: false },
  advanceHistory: [advanceSchema],
  isManualPaidLeavesUpdate: { type: Boolean, default: false },
  transferTimestamp: { type: Date, default: null },
});

// ✅ ENHANCED pre-save hook with presence initialization
employeeSchema.pre('save', async function (next) {
  const joinDate = new Date(this.joinDate);
  const joinYear = joinDate.getFullYear();
  const joinMonth = joinDate.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // Fetch settings with populated location data
  const settings = await mongoose.model('Settings').findOne().populate('locationLeaveSettings.location');
  
  // Get location-specific or global leave allocation
  let monthlyAllocation = 2; // default fallback
  let totalYearlyAllocation = 24; // default fallback
  
  if (settings && this.location) {
    // Try to find location-specific setting first
    const locationSetting = settings.locationLeaveSettings.find(
      setting => setting.location._id.toString() === this.location.toString()
    );
    
    if (locationSetting) {
      // Use location-specific setting - REMOVE Math.floor() to allow decimals
      totalYearlyAllocation = locationSetting.paidLeavesPerYear;
      monthlyAllocation = locationSetting.paidLeavesPerYear / 12; // Keep decimal precision
      
    } else {
      // Fall back to global setting
      totalYearlyAllocation = settings.paidLeavesPerYear || 24;
      monthlyAllocation = (settings.paidLeavesPerYear || 24) / 12; // Keep decimal precision
      
    }
  }

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
          allocated: monthlyAllocation, // Now supports decimal values
          taken: 0,
          carriedForward: 0,
          available: monthlyAllocation, // Now supports decimal values
        });
      }
    }
  }

  // ✅ NEW: Initialize monthlyPresence with location-specific working days
  if (this.isNew && (!this.monthlyPresence || this.monthlyPresence.length === 0)) {
    this.monthlyPresence = [];
    for (let y = joinYear; y <= currentYear; y++) {
      const startMonth = y === joinYear ? joinMonth : 1;
      const endMonth = y === currentYear ? currentMonth : 12;
      for (let m = startMonth; m <= endMonth; m++) {
        // ✅ Calculate location-specific working days
        const workingDaysInMonth = await getEmployeeWorkingDays(this.location, y, m);
        
        this.monthlyPresence.push({
          year: y,
          month: m,
          totalPresenceDays: 0,
          workingDaysInMonth: workingDaysInMonth, // ✅ Use location-specific working days
          lastUpdated: new Date()
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

  // Auto-calculate logic
  
  
  
  
  
  

  const paidLeavesModified = this.isModified('paidLeaves.available') || 
                             this.isModified('paidLeaves.used') || 
                             this.isModified('paidLeaves.carriedForward');

  const shouldAutoCalculate = !this.isNew && 
                              !this.isManualPaidLeavesUpdate && 
                              !paidLeavesModified;

  if (shouldAutoCalculate) {
    
    const totalTaken = this.monthlyLeaves.reduce((sum, ml) => sum + ml.taken, 0);
    
    this.set('paidLeaves.used', totalTaken);
    this.set('paidLeaves.available', Math.max(0, totalYearlyAllocation - totalTaken));
    
  } else if (this.isNew) {
    // Set initial paidLeaves for new employees based on location
    this.set('paidLeaves.available', totalYearlyAllocation);
    this.set('paidLeaves.used', 0);
    this.set('paidLeaves.carriedForward', 0);
    
  } else {
    
  }

  next();
});


// Add case-insensitive index for email
employeeSchema.index({ email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export default mongoose.model('Employee', employeeSchema);
