import Employee from "../../models/Employee.js";
import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import Settings from "../../models/Settings.js";
import path from "path";
import XLSX from "xlsx";
import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import Location from "../../models/Location.js";
import xlsx from "xlsx";
import AppError from "../../utils/AppError.js";
import Attendance from "../../models/Attendance.js";
import googleDriveService from '../../utils/googleDriveService.js';

// Helper function to parse salary with commas
const parseSalary = (salary) => {
  if (!salary) return NaN;
  if (typeof salary === 'number') return salary;
  
  // Remove commas, whitespace, and convert to number
  const normalized = salary.toString().replace(/,/g, '').trim();
  const num = parseFloat(normalized);
  return isNaN(num) ? NaN : num;
};

// Helper function to calculate prorated leaves
const calculateProratedLeaves = (joinDate, paidLeavesPerYear) => {
  const join = new Date(joinDate);
  const joinYear = join.getFullYear();
  const joinMonth = join.getMonth(); 
  const currentYear = new Date().getFullYear();

  if (joinYear === currentYear) {
    const remainingMonths = 12 - joinMonth;
    return Math.round((paidLeavesPerYear * remainingMonths) / 12);
  }
  return paidLeavesPerYear;
};

// @desc    Update employee advance
// @route   PUT /api/admin/employees/:id/advance
// @access  Private/Admin
const updateEmployeeAdvance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { advance, year, month } = req.body;

  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  const parsedAdvance = Number(advance);
  const parsedYear = Number(year);
  const parsedMonth = Number(month);

  // Update or add advance for the specified month
  const advanceIndex = employee.advances.findIndex(
    (adv) => adv.year === parsedYear && adv.month === parsedMonth
  );
  if (advanceIndex !== -1) {
    // Update existing advance
    employee.advances[advanceIndex].amount = parsedAdvance;
    employee.advances[advanceIndex].updatedAt = new Date();
    employee.advances[advanceIndex].updatedBy = req.user._id;
  } else {
    // Add new advance entry
    employee.advances.push({
      year: parsedYear,
      month: parsedMonth,
      amount: parsedAdvance,
      updatedAt: new Date(),
      updatedBy: req.user._id,
    });
  }

  // Update advanceHistory
  employee.advanceHistory.push({
    year: parsedYear,
    month: parsedMonth,
    amount: parsedAdvance,
    updatedAt: new Date(),
    updatedBy: req.user._id,
  });

  try {
    await employee.save();

    let populatedEmployee;
    try {
      populatedEmployee = await Employee.findById(id)
        .populate("location", "name")
        .populate("createdBy", "name");
    } catch (populateError) {
      populatedEmployee = await Employee.findById(id);
    }

    res.status(200).json(populatedEmployee);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to update advance", error: error.message });
  }
});

// @desc    Check if employee exists by employeeId or email
// @route   GET /api/admin/employees/check
// @access  Private/Admin
const checkEmployeeExists = asyncHandler(async (req, res) => {
  const { employeeId, email } = req.query;
  const query = {};
  if (employeeId) query.employeeId = employeeId;
  if (email) query.email = email.toLowerCase();
  const employee = await Employee.findOne(query);
  if (employee) {
    res
      .status(200)
      .json({ exists: true, field: employeeId ? "employeeId" : "email" });
  } else {
    res.status(200).json({ exists: false });
  }
});

// @desc    Get all employees with pagination
// @route   GET /api/admin/employees?page=<page>&limit=<limit>
// @access  Private/Admin
const getEmployees = asyncHandler(async (req, res) => {
  const { location, status, department, search, month, year, page = 1, limit = 10, isDeleted, _cacheBuster, cacheBuster } = req.query;

  // Cache busting headers when cache buster is present
  if (_cacheBuster || cacheBuster) {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'ETag': false,
      'Last-Modified': false
    });
  }

  let query = {};
  
  if (isDeleted !== undefined) {
    query.isDeleted = isDeleted === "true";
  } else {
    query.isDeleted = false;
  }
  
  if (location && mongoose.Types.ObjectId.isValid(location)) {
    query.location = new mongoose.Types.ObjectId(location);
  }
  
  if (status && status !== "deleted") query.status = status;
  if (department) query.department = department;
  
  // Add search functionality
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { employeeId: { $regex: search, $options: "i" } }
    ];
  }

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const skip = (parsedPage - 1) * parsedLimit;
  const totalEmployees = await Employee.countDocuments(query);

  // Calculate previous month and year
  const parsedMonth = parseInt(month);
  const parsedYear = parseInt(year);
  const prevMonthDate = new Date(parsedYear, parsedMonth - 1, 1);
  prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
  const prevMonth = prevMonthDate.getMonth() + 1;
  const prevYear = prevMonthDate.getFullYear();

  // Get settings for paid leaves
  const settings = await Settings.findOne();
  const paidLeavesPerMonth = settings ? settings.paidLeavesPerYear / 12 : 2;

  const pipeline = [
    { $match: query },
    {
      $lookup: {
        from: "locations",
        localField: "location",
        foreignField: "_id",
        as: "location",
      },
    },
    { $unwind: { path: "$location", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "createdBy",
      },
    },
    { $unwind: { path: "$createdBy", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        // Initialize monthlyLeaves if empty
        monthlyLeaves: {
          $cond: {
            if: { $eq: [{ $size: "$monthlyLeaves" }, 0] },
            then: {
              $map: {
                input: {
                  $range: [
                    0,
                    {
                      $add: [
                        {
                          $multiply: [
                            { $subtract: [new Date().getFullYear(), { $year: "$joinDate" }] },
                            12
                          ]
                        },
                        { $subtract: [new Date().getMonth() + 1, { $month: "$joinDate" }] },
                        1
                      ]
                    }
                  ]
                },
                as: "index",
                in: {
                  year: {
                    $add: [
                      { $year: "$joinDate" },
                      { $floor: { $divide: ["$$index", 12] } }
                    ]
                  },
                  month: {
                    $add: [
                      { $mod: ["$$index", 12] },
                      1
                    ]
                  },
                  allocated: paidLeavesPerMonth,
                  taken: 0,
                  carriedForward: 0,
                  available: paidLeavesPerMonth
                }
              }
            },
            else: "$monthlyLeaves"
          }
        }
      }
    },
    {
      $project: {
        employeeId: 1,
        name: 1,
        email: 1,
        designation: 1,
        department: 1,
        salary: 1,
        location: { name: 1 },
        paidLeaves: 1,
        advances: 1,
        documents: 1,
        phone: 1,
        dob: 1,
        joinDate: 1,
        bankDetails: 1,
        createdBy: { name: 1 },
        status: 1,
        transferHistory: 1,
        employmentHistory: 1,
        transferTimestamp: 1,
        isDeleted: 1,
        monthlyLeaves: {
          $filter: {
            input: "$monthlyLeaves",
            as: "leave",
            cond: {
              $or: [
                {
                  $and: [
                    { $eq: ["$$leave.month", parsedMonth] },
                    { $eq: ["$$leave.year", parsedYear] },
                  ],
                },
                {
                  $and: [
                    { $eq: ["$$leave.month", prevMonth] },
                    { $eq: ["$$leave.year", prevYear] },
                  ],
                },
              ],
            },
          },
        },
      },
    },
    { $sort: { employeeId: 1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  ];

  const employees = await Employee.aggregate(pipeline);
  const totalPages = Math.ceil(totalEmployees / parsedLimit);

  res.status(200).json({
    employees,
    pagination: {
      currentPage: parsedPage,
      totalPages,
      totalItems: totalEmployees,
      itemsPerPage: parsedLimit,
    },
  });
});

// @desc    Get a single employee by ID with paginated documents
// @route   GET /api/admin/employees/:id?page=<page>&limit=<limit>
// @access  Private/Admin
const getEmployeeById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { _cacheBuster, cacheBuster } = req.query;

    const employee = await Employee.findById(id).populate("location");
    if (!employee) {
      return next(new AppError("Employee not found", 404));
    }

    // Cache busting headers when needed
    if (_cacheBuster || cacheBuster) {
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'ETag': false,
        'Last-Modified': false
      });
    }

    res.status(200).json(employee);
  } catch (error) {
    next(new AppError(error.message || "Failed to fetch employee", 500));
  }
};

// @desc    Add a new employee
// @route   POST /api/admin/employees
// @access  Private/Admin
const addEmployee = asyncHandler(async (req, res) => {
  const {
    employeeId,
    name,
    email,
    designation,
    department,
    salary,
    location,
    phone,
    joinDate,
    bankDetails,
    createdBy,
  } = req.body;

  const files = req.files;

  // Get location name for folder organization
  let locationName = 'General';
  try {
    const locationDoc = await Location.findById(location);
    if (locationDoc) {
      locationName = locationDoc.name;
    }
  } catch (error) {
    // Use default
  }

  // Upload files to location-specific folder
  let googleDriveDocuments = [];
  try {
    googleDriveDocuments = await googleDriveService.uploadMultipleFiles(files, employeeId, locationName);
  } catch (error) {
    res.status(500);
    throw new Error(`Failed to upload documents to Google Drive: ${error.message}`);
  }

  let parsedBankDetails;
  try {
    parsedBankDetails = JSON.parse(bankDetails);
  } catch (error) {
    parsedBankDetails = bankDetails;
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error("Settings not found");
  }

  // Parse joinDate
  const parsedJoinDate = new Date(joinDate);

  // Calculate prorated leaves
  const proratedLeaves = calculateProratedLeaves(
    parsedJoinDate,
    settings.paidLeavesPerYear
  );

  // Enhanced document metadata with location info
  const documents = googleDriveDocuments.map(doc => ({
    googleDriveId: doc.googleDriveId,
    originalName: doc.originalName,
    filename: doc.filename,
    mimeType: doc.mimeType,
    size: doc.size,
    webViewLink: doc.webViewLink,
    webContentLink: doc.webContentLink,
    uploadedAt: doc.uploadedAt,
    createdTime: doc.createdTime,
    locationName: doc.locationName,
    locationFolderId: doc.locationFolderId,
    // Backward compatibility
    name: doc.originalName,
    path: doc.googleDriveId,
  }));

  const employee = new Employee({
    employeeId,
    name,
    email: email.toLowerCase(),
    designation,
    department,
    salary: Number(salary),
    location,
    phone,
    joinDate: parsedJoinDate,
    bankDetails: parsedBankDetails,
    paidLeaves: {
      available: proratedLeaves,
      used: 0,
      carriedForward: 0,
    },
    documents,
    createdBy,
    advance: 0,
  });

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const createdEmployee = await employee.save({ session });
    await session.commitTransaction();
    const populatedEmployee = await Employee.findById(createdEmployee._id)
      .populate("location")
      .populate("createdBy");
    res.status(201).json(populatedEmployee);
  } catch (error) {
    await session.abortTransaction();
    res
      .status(500)
      .json({ message: "Failed to create employee", error: error.message });
  } finally {
    session.endSession();
  }
});

// @desc    Update an employee
// @route   PUT /api/admin/employees/:id
// @access  Private/Admin
const editEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    name,
    email,
    designation,
    department,
    salary,
    phone,
    dob,
    paidLeaves,
    location,
    bankDetails,
  } = req.body;

  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error("Settings not found");
  }

  // Calculate max allowed available leaves based on proration
  const proratedLeaves = calculateProratedLeaves(employee.joinDate, settings.paidLeavesPerYear);

  try {
    // Update employee fields
    employee.name = name;
    employee.email = email.toLowerCase();
    employee.designation = designation;
    employee.department = department;
    employee.salary = Number(salary);
    employee.phone = phone || null;
    employee.dob = dob ? new Date(dob) : null;
    if (location) {
      employee.location = location;
    }

    // Handle bank details using safe nested updates
    if (bankDetails) {
      employee.set('bankDetails.accountNo', bankDetails.accountNo);
      employee.set('bankDetails.ifscCode', bankDetails.ifscCode);
      employee.set('bankDetails.bankName', bankDetails.bankName);
      employee.set('bankDetails.accountHolder', bankDetails.accountHolder);
    }

    // Handle manual paidLeaves update using safe nested updates
    if (paidLeaves) {
      employee.isManualPaidLeavesUpdate = true;
      
      // Use safe nested updates instead of object replacement
      employee.set('paidLeaves.available', paidLeaves.available);
      employee.set('paidLeaves.used', paidLeaves.used);
      employee.set('paidLeaves.carriedForward', paidLeaves.carriedForward);
      
      // Distribute across remaining months only
      await redistributeMonthlyLeaves(employee, paidLeaves);
      
      employee.markModified('paidLeaves');
      employee.markModified('monthlyLeaves');
    }

    // Single save operation
    await employee.save();

    // Populate and return response
    let updatedEmployee;
    try {
      updatedEmployee = await Employee.findById(id)
        .populate("location")
        .populate("createdBy");
    } catch (populateError) {
      updatedEmployee = await Employee.findById(id);
    }
    
    // Force cache invalidation after employee update
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'ETag': false,
      'Last-Modified': false
    });

    res.status(200).json(updatedEmployee);
    
  } catch (error) {
    res.status(500).json({ message: "Failed to update employee", error: error.message });
  }
});

// Function to redistribute manual updates across monthly leaves
const redistributeMonthlyLeaves = async (employee, paidLeaves) => {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  
  // Calculate remaining months including current month
  const monthsRemainingInYear = 12 - currentMonth + 1;
  const perMonthAllocation = paidLeaves.available / monthsRemainingInYear;
  
  // Force change detection: Clone and replace monthlyLeaves array
  const updatedMonthlyLeaves = [...employee.monthlyLeaves];
  
  // Update only current and future months in the current year
  for (let i = 0; i < updatedMonthlyLeaves.length; i++) {
    const ml = updatedMonthlyLeaves[i];
    
    if (ml.year === currentYear && ml.month >= currentMonth) {
      const previousTaken = ml.taken || 0;
      
      // Create new object to trigger change detection
      updatedMonthlyLeaves[i] = {
        ...ml,
        allocated: Math.round(perMonthAllocation * 10) / 10,
        taken: previousTaken,
        carriedForward: ml.carriedForward || 0,
        available: Math.max(0, Math.round(perMonthAllocation * 10) / 10 - previousTaken)
      };
    }
  }
  
  // Force Mongoose to detect changes
  employee.monthlyLeaves = updatedMonthlyLeaves;
  employee.markModified('monthlyLeaves');
};

// Helper function to check attendance in month
const hasAttendanceInMonth = async (employeeId, year, month) => {
  try {
    const startStr = `${year}-${month.toString().padStart(2, '0')}-01T00:00:00+05:30`;
    const endDate = new Date(year, month, 0);
    const endStr = `${year}-${month.toString().padStart(2, '0')}-${endDate.getDate()}T23:59:59+05:30`;
    
    const count = await mongoose.model('Attendance').countDocuments({
      employee: employeeId,
      date: { $gte: startStr, $lte: endStr },
      status: { $in: ['present', 'leave', 'half-day'] },
      isDeleted: false,
    });
    
    return count > 0;
  } catch (error) {
    return false;
  }
};

// Salary calculation endpoints
// GET /api/superadmin/employees/:id/salary/:year/:month
export const getEmployeeMonthlySalary = async (req, res) => {
  try {
    const { id, year, month } = req.params;
    
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Find monthly presence record
    const monthlyPresence = employee.monthlyPresence.find(
      mp => mp.year === parseInt(year) && mp.month === parseInt(month)
    ) || { totalPresenceDays: 0, workingDaysInMonth: 30 };
    
    // Calculate salary based on presence days only
    const monthlySalary = employee.salary || 0;
    const workingDaysForCalculation = monthlyPresence.workingDaysInMonth || 30;
    const dailySalary = monthlySalary / workingDaysForCalculation;
    const payableSalary = dailySalary * monthlyPresence.totalPresenceDays;
    
    // Get leave information for reference
    const monthlyLeave = employee.monthlyLeaves.find(
      ml => ml.year === parseInt(year) && ml.month === parseInt(month)
    ) || { allocated: 2, taken: 0, available: 2, carriedForward: 0 };
    
    // Calculate attendance summary
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01T00:00:00+05:30`;
    const endDate = `${year}-${month.toString().padStart(2, '0')}-31T23:59:59+05:30`;
    
    const attendanceRecords = await Attendance.find({
      employee: id,
      date: { $gte: startDate, $lte: endDate },
      isDeleted: false
    }).lean();

    const attendanceSummary = {
      totalDays: attendanceRecords.length,
      presentDays: attendanceRecords.filter(a => a.status === 'present').length,
      halfDays: attendanceRecords.filter(a => a.status === 'half-day').length,
      leaveDays: attendanceRecords.filter(a => a.status === 'leave').length,
      absentDays: attendanceRecords.filter(a => a.status === 'absent').length,
    };
    
    res.status(200).json({
      employee: {
        _id: employee._id,
        name: employee.name,
        employeeId: employee.employeeId,
        salary: monthlySalary
      },
      salaryCalculation: {
        baseMonthlySalary: monthlySalary,
        workingDaysForCalculation: workingDaysForCalculation,
        dailySalary: dailySalary,
        totalPresenceDays: monthlyPresence.totalPresenceDays,
        payableSalary: payableSalary,
        salaryEfficiency: ((monthlyPresence.totalPresenceDays / workingDaysForCalculation) * 100).toFixed(1) + '%'
      },
      attendanceSummary: attendanceSummary,
      leaveInformation: {
        allocated: monthlyLeave.allocated,
        taken: monthlyLeave.taken,
        available: monthlyLeave.available,
        carriedForward: monthlyLeave.carriedForward,
        withinLimit: monthlyLeave.taken <= (monthlyLeave.allocated + monthlyLeave.carriedForward)
      },
      month: parseInt(month),
      year: parseInt(year)
    });
    
  } catch (error) {
    res.status(500).json({ message: 'Server error calculating salary' });
  }
};

// Bulk salary calculation for payroll
// GET /api/superadmin/payroll/:year/:month?location=locationId
export const getPayrollSummary = async (req, res) => {
  try {
    const { year, month } = req.params;
    const { location } = req.query;
    
    // Build query for employees
    const employeeQuery = { 
      status: 'active', 
      isDeleted: false 
    };
    
    if (location && location !== 'all') {
      employeeQuery.location = new mongoose.Types.ObjectId(location);
    }
    
    const employees = await Employee.find(employeeQuery)
      .populate('location', 'name')
      .lean();
    
    const payrollData = [];
    let totalPayableSalary = 0;
    
    for (const employee of employees) {
      // Find monthly presence
      const monthlyPresence = employee.monthlyPresence.find(
        mp => mp.year === parseInt(year) && mp.month === parseInt(month)
      ) || { totalPresenceDays: 0, workingDaysInMonth: 30 };
      
      // Calculate salary
      const monthlySalary = employee.salary || 0;
      const dailySalary = monthlySalary / (monthlyPresence.workingDaysInMonth || 30);
      const payableSalary = dailySalary * monthlyPresence.totalPresenceDays;
      
      // Get leave info
      const monthlyLeave = employee.monthlyLeaves.find(
        ml => ml.year === parseInt(year) && ml.month === parseInt(month)
      ) || { allocated: 2, taken: 0, available: 2, carriedForward: 0 };
      
      payrollData.push({
        employee: {
          _id: employee._id,
          employeeId: employee.employeeId,
          name: employee.name,
          department: employee.department,
          designation: employee.designation,
          location: employee.location?.name || 'N/A'
        },
        salary: {
          baseMonthlySalary: monthlySalary,
          dailySalary: dailySalary,
          presenceDays: monthlyPresence.totalPresenceDays,
          payableSalary: payableSalary,
          efficiency: ((monthlyPresence.totalPresenceDays / 30) * 100).toFixed(1) + '%'
        },
        leaves: {
          allocated: monthlyLeave.allocated,
          taken: monthlyLeave.taken,
          available: monthlyLeave.available,
          withinLimit: monthlyLeave.taken <= (monthlyLeave.allocated + monthlyLeave.carriedForward)
        }
      });
      
      totalPayableSalary += payableSalary;
    }
    
    res.status(200).json({
      payroll: payrollData,
      summary: {
        totalEmployees: employees.length,
        totalPayableSalary: totalPayableSalary,
        averageSalary: employees.length > 0 ? (totalPayableSalary / employees.length) : 0,
        month: parseInt(month),
        year: parseInt(year),
        location: location || 'all'
      }
    });
    
  } catch (error) {
    res.status(500).json({ message: 'Server error generating payroll' });
  }
};

// @desc    Deactivate an employee
// @route   PUT /api/admin/employees/:id/deactivate
// @access  Private/Admin
const deactivateEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    // Find the employee
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Ensure employmentDetails exists
    if (!employee.employmentDetails) {
      employee.employmentDetails = {};
    }

    // Ensure employmentHistory exists
    if (!employee.employmentHistory) {
      employee.employmentHistory = [];
    }

    // Calculate leaveBalanceAtEnd
    const leaveBalanceAtEnd = Math.max(
      (employee.paidLeaves.available || 0) +
      (employee.paidLeaves.carriedForward || 0) -
      (employee.paidLeaves.used || 0),
      0
    );

    // Set endDate and status
    employee.employmentDetails.endDate = new Date();
    employee.status = 'inactive';

    // Update employmentHistory
    if (employee.employmentHistory.length > 0) {
      employee.employmentHistory[employee.employmentHistory.length - 1].endDate = new Date();
      employee.employmentHistory[employee.employmentHistory.length - 1].status = 'inactive';
      employee.employmentHistory[employee.employmentHistory.length - 1].leaveBalanceAtEnd = leaveBalanceAtEnd;
    } else {
      // If employmentHistory is empty, add an initial entry
      employee.employmentHistory.push({
        startDate: employee.joinDate || new Date(),
        endDate: new Date(),
        status: 'inactive',
        leaveBalanceAtEnd: leaveBalanceAtEnd,
      });
    }

    // Save the updated employee
    await employee.save();

    // Populate necessary fields for response
    const updatedEmployee = await Employee.findById(id)
      .populate("location", "name")
      .populate("createdBy", "name");

    res.status(200).json({
      message: 'Employee deactivated successfully',
      employee: updatedEmployee,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to deactivate employee', error: error.message });
  }
};

// @desc    Transfer an employee to a new location
// @route   PUT /api/admin/employees/:id/transfer
// @access  Private/Admin
const transferEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { location, transferTimestamp } = req.body;

  const parsedTransferTimestamp = new Date(transferTimestamp);

  const employee = await Employee.findById(id).populate("location");
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Update transfer history
  employee.transferHistory.push({
    fromLocation: employee.location._id,
    toLocation: location,
    transferDate: parsedTransferTimestamp,
  });

  // Update employee
  employee.location = location;
  employee.transferTimestamp = parsedTransferTimestamp;

  await employee.save();

  const updatedEmployee = await Employee.findById(id)
    .populate("location")
    .populate("createdBy");
  res.status(200).json(updatedEmployee);
});

// @desc    Rejoin an employee
// @route   PUT /api/admin/employees/:id/rejoin
// @access  Private/Admin
const rejoinEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rejoinDate } = req.body;

  const parsedRejoinDate = new Date(rejoinDate);

  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Ensure employmentHistory exists
  if (!employee.employmentHistory) {
    employee.employmentHistory = [];
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error("Settings not found");
  }

  // Calculate prorated leaves for rejoin year
  const proratedLeaves = calculateProratedLeaves(
    parsedRejoinDate,
    settings.paidLeavesPerYear
  );

  // Update status and employment history
  employee.status = "active";
  employee.employmentHistory.push({
    startDate: parsedRejoinDate,
    status: "active",
  });

  // Set prorated leave balance
  employee.paidLeaves = {
    available: proratedLeaves,
    used: 0,
    carriedForward: 0,
  };

  // Reset transferTimestamp on rejoin
  employee.transferTimestamp = null;

  await employee.save();

  const updatedEmployee = await Employee.findById(id)
    .populate("location")
    .populate("createdBy");
  res.status(200).json(updatedEmployee);
});

// @desc    Get employee history (transfer and employment)
// @route   GET /api/admin/employees/:id/history
// @access  Private/Admin
const getEmployeeHistory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const employee = await Employee.findById(id)
    .populate("transferHistory.fromLocation")
    .populate("transferHistory.toLocation");

  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  res.status(200).json({
    transferHistory: employee.transferHistory,
    employmentHistory: employee.employmentHistory,
    advanceHistory: employee.advanceHistory || [],
  });
});

// @desc    Add documents to an existing employee
// @route   POST /api/admin/employees/:id/documents
// @access  Private/Admin
const addEmployeeDocuments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const files = req.files;
  const { page = 1, limit = 5 } = req.query;

  // Fetch employee with populated location
  const employee = await Employee.findById(id).populate('location');
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Get location name
  const locationName = employee.location?.name || 'General';

  // Upload to location-specific folder
  let googleDriveDocuments = [];
  try {
    googleDriveDocuments = await googleDriveService.uploadMultipleFiles(files, employee.employeeId, locationName);
  } catch (error) {
    res.status(500);
    throw new Error(`Failed to upload documents to Google Drive: ${error.message}`);
  }

  // Convert to document schema format
  const newDocuments = googleDriveDocuments.map(doc => ({
    googleDriveId: doc.googleDriveId,
    originalName: doc.originalName,
    filename: doc.filename,
    mimeType: doc.mimeType,
    size: doc.size,
    webViewLink: doc.webViewLink,
    webContentLink: doc.webContentLink,
    uploadedAt: doc.uploadedAt,
    createdTime: doc.createdTime,
    name: doc.originalName,
    path: doc.googleDriveId,
  }));

  employee.documents.push(...newDocuments);

  try {
    await employee.save();

    // Fetch updated employee with paginated documents
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const skip = (parsedPage - 1) * parsedLimit;

    const pipeline = [
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
      {
        $lookup: {
          from: "locations",
          localField: "location",
          foreignField: "_id",
          as: "location",
        },
      },
      { $unwind: { path: "$location", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "createdBy",
        },
      },
      { $unwind: { path: "$createdBy", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          employeeId: 1,
          name: 1,
          email: 1,
          designation: 1,
          department: 1,
          salary: 1,
          location: { name: 1, _id: 1 },
          paidLeaves: 1,
          advances: 1,
          phone: 1,
          dob: 1,
          joinDate: 1,
          bankDetails: 1,
          createdBy: { name: 1, _id: 1 },
          status: 1,
          transferHistory: 1,
          employmentHistory: 1,
          advanceHistory: 1,
          transferTimestamp: 1,
          monthlyLeaves: 1,
          totalDocuments: { $size: "$documents" },
          documents: { $slice: ["$documents", skip, parsedLimit] },
        },
      },
    ];

    const [updatedEmployee] = await Employee.aggregate(pipeline);
    if (!updatedEmployee) {
      res.status(404);
      throw new Error("Employee not found after update");
    }

    const totalDocuments = updatedEmployee.totalDocuments || 0;
    const totalPages = Math.ceil(totalDocuments / parsedLimit);
    delete updatedEmployee.totalDocuments;

    res.status(200).json({
      employee: updatedEmployee,
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems: totalDocuments,
        itemsPerPage: parsedLimit,
      },
    });
  } catch (error) {
    // Clean up uploaded files on save error
    for (const doc of googleDriveDocuments) {
      try {
        await googleDriveService.deleteFile(doc.googleDriveId);
      } catch (deleteError) {
        // Continue
      }
    }
    throw error;
  }
});

// @desc    Get settings
// @route   GET /api/admin/employees/settings
// @access  Private/Admin
const getSettings = asyncHandler(async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24,
        halfDayDeduction: 0.5,
        highlightDuration: 24 * 60 * 60 * 1000,
      });
    }
    res.status(200).json(settings);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// @desc    Get count of active employees
// @route   GET /api/admin/employees/count
// @access  Private/Admin
const getEmployeeCount = asyncHandler(async (req, res) => {
  try {
    const count = await Employee.countDocuments({
      status: "active",
      isDeleted: false,
    });
    res.status(200).json({ count });
  } catch (error) {
    res.status(500).json({ message: "Server error fetching employee count" });
  }
});

// @desc    Get paginated advances for an employee
// @route   GET /api/admin/employees/:id/advances?page=<page>&limit=<limit>&sortField=<field>&sortOrder=<order>
// @access  Private/Admin
const getEmployeeAdvances = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    page = 1,
    limit = 5,
    sortField = "year",
    sortOrder = "desc",
  } = req.query;

  // Parse pagination parameters
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  // Calculate skip value for pagination
  const skip = (parsedPage - 1) * parsedLimit;

  // Fetch employee with paginated and sorted advances using aggregation
  const pipeline = [
    { $match: { _id: new mongoose.Types.ObjectId(id) } },
    {
      $unwind: { path: "$advances", preserveNullAndEmptyArrays: true },
    },
    {
      $sort: {
        [`advances.${sortField}`]: sortOrder === "asc" ? 1 : -1,
      },
    },
    {
      $group: {
        _id: "$_id",
        advances: { $push: "$advances" },
        totalAdvances: { $sum: 1 },
        advanceUsers: { $first: "$advanceUsers" },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "advances.updatedBy",
        foreignField: "_id",
        as: "advanceUsers",
      },
    },
    {
      $project: {
        totalAdvances: 1,
        advances: { $slice: ["$advances", skip, parsedLimit] },
        advanceUsers: 1,
      },
    },
  ];

  const [result] = await Employee.aggregate(pipeline);

  if (!result) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Handle case where advances array is empty
  const totalAdvances = result.totalAdvances || 0;
  const totalPages = Math.ceil(totalAdvances / parsedLimit);

  // Populate updatedBy for each advance
  const advances = (result.advances || []).map((advance) => {
    const updatedByUser = result.advanceUsers.find((user) =>
      user._id.equals(advance.updatedBy)
    );
    return {
      ...advance,
      updatedBy: updatedByUser
        ? { _id: updatedByUser._id, name: updatedByUser.name }
        : null,
    };
  });

  res.status(200).json({
    advances,
    pagination: {
      currentPage: parsedPage,
      totalPages,
      totalItems: totalAdvances,
      itemsPerPage: parsedLimit,
    },
  });
});

// @desc    Add employees from Excel file
// @route   POST /api/admin/employees/excel
// @access  Private/Admin
const addEmployeesFromExcel = async (req, res, next) => {
  try {
    console.log('📁 Starting Excel processing...');
    console.log('📋 Request files:', req.files ? Object.keys(req.files) : 'No files');
    console.log('👤 User info:', req.user ? req.user._id : 'No user');

    if (!req.files || !req.files.excelFile || req.files.excelFile.length === 0) {
      console.log('❌ No Excel file found in request');
      return next(new AppError("No Excel file uploaded", 400));
    }

    const excelFile = req.files.excelFile[0];
    console.log('📄 Excel file details:', {
      originalname: excelFile.originalname,
      mimetype: excelFile.mimetype,
      size: excelFile.size,
      path: excelFile.path
    });

    const documentFiles = req.files.documents || [];
    console.log('📎 Document files count:', documentFiles.length);

    const requiredHeaders = [
      "employeeId", "name", "email", "designation", "department", 
      "salary", "locationName", "phone", "joinDate", "accountNo", 
      "ifscCode", "bankName", "accountHolder",
    ];

    let employees = [];
    const fileExtension = excelFile.originalname.split(".").pop().toLowerCase();
    console.log('📊 File extension:', fileExtension);

    if (fileExtension === "csv") {
      console.log('🔍 Processing CSV file...');
      const fileContent = await fs.readFile(excelFile.path, 'utf8');
      const records = parse(fileContent, {
        columns: true,
        trim: true,
        skip_empty_lines: true,
        skip_lines_with_error: true,
      });
      employees = records;
    } else if (["xlsx", "xls"].includes(fileExtension)) {
      console.log('🔍 Processing Excel file...');
      const fileBuffer = await fs.readFile(excelFile.path);
      const workbook = XLSX.read(fileBuffer, { type: "buffer", dateNF: "yyyy-mm-dd" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      console.log('📋 Sheet name:', sheetName);
      console.log('📊 Sheet range:', sheet['!ref']);
      
      employees = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        blankrows: false,
        raw: false,
        dateNF: "yyyy-mm-dd",
      });

      if (employees.length < 1) {
        console.log('❌ Excel file is empty');
        return next(new AppError("Excel file is empty", 400));
      }

      const headers = employees[0].map((h) => h.toString().trim());
      console.log('📋 Headers found:', headers);
      
      employees = employees
        .slice(1)
        .map((row) => {
          const obj = {};
          headers.forEach((header, i) => {
            obj[header] = row[i] !== undefined ? row[i] : null;
          });
          return obj;
        })
        .filter((emp) => {
          return Object.values(emp).some((val) => val !== null && val !== "");
        });
    } else {
      console.log('❌ Unsupported file format:', fileExtension);
      return next(new AppError("Unsupported file format", 400));
    }

    console.log('📊 Total rows parsed:', employees.length);
    if (employees.length > 0) {
      console.log('👤 Sample employee data:', JSON.stringify(employees[0], null, 2));
    }

    const fileHeaders = employees.length > 0 ? Object.keys(employees[0]) : [];
    console.log('📋 File headers:', fileHeaders);

    const missingHeaders = requiredHeaders.filter((h) => !fileHeaders.includes(h));
    if (missingHeaders.length > 0) {
      console.log('❌ Missing headers:', missingHeaders);
      return next(new AppError(`Missing required headers: ${missingHeaders.join(", ")}`, 400));
    }

    const errors = [];
    const validEmployees = [];

    // Map documents to employeeIds
    const documentMap = {};
    documentFiles.forEach((file) => {
      const employeeIdMatch = file.originalname.match(/^([A-Z0-9-]+)-/);
      const employeeId = employeeIdMatch ? employeeIdMatch[1] : null;
      if (employeeId) {
        if (!documentMap[employeeId]) documentMap[employeeId] = [];
        documentMap[employeeId].push({
          name: file.originalname,
          path: `/Uploads/documents/${file.filename}`,
          uploadedAt: new Date(),
          size: file.size,
        });
      }
    });

    // Fetch all locations
    const locations = await Location.find().select("name _id");
    const locationMap = {};
    locations.forEach((loc) => {
      locationMap[loc.name.toLowerCase()] = loc._id;
    });
    console.log('📍 Available locations:', Object.keys(locationMap));

    // Fetch settings
    const settings = await Settings.findOne();
    if (!settings) {
      console.log('❌ Settings not found');
      return next(new AppError("Settings not found", 500));
    }

    // ✅ Check for duplicates (excluding email - duplicates allowed)
    console.log('🔍 Checking for existing duplicates in database...');
    const employeeIds = employees.map(emp => emp.employeeId).filter(Boolean);
    const phones = employees.map(emp => emp.phone).filter(Boolean);

    const existingEmployees = await Employee.find({
      $or: [
        { employeeId: { $in: employeeIds } },
        { phone: { $in: phones } }
        // ✅ No email check - duplicates allowed
      ]
    }).select('employeeId phone').lean();

    const existingEmployeeIds = new Set(existingEmployees.map(e => e.employeeId));
    const existingPhones = new Set(existingEmployees.map(e => e.phone));

    console.log('📋 Found existing duplicates:', {
      employeeIds: existingEmployeeIds.size,
      phones: existingPhones.size
      // ✅ No email duplicates check
    });

    console.log('⚙️ Processing employees for validation...');
    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      const row = i + 2;
      
      try {
        console.log(`🔍 Processing row ${row}:`, emp.employeeId, 'Salary:', emp.salary);

        // Basic field presence check (no strict validation)
        if (!emp.employeeId || !emp.name || !emp.email || !emp.designation || 
            !emp.department || !emp.salary || !emp.locationName || !emp.phone || 
            !emp.joinDate || !emp.accountNo || !emp.ifscCode || !emp.bankName || 
            !emp.accountHolder) {
          console.log(`❌ Row ${row}: Missing required fields`);
          errors.push({ row, message: "Missing required fields" });
          continue;
        }

        // ✅ Check duplicates (excluding email)
        if (existingEmployeeIds.has(emp.employeeId)) {
          console.log(`❌ Row ${row}: Duplicate Employee ID`);
          errors.push({ row, message: `Employee ID already exists: ${emp.employeeId}` });
          continue;
        }
        if (existingPhones.has(emp.phone)) {
          console.log(`❌ Row ${row}: Duplicate Phone`);
          errors.push({ row, message: `Phone already exists: ${emp.phone}` });
          continue;
        }
        // ✅ No email duplicate check - duplicates allowed

        // Parse salary with commas
        const parsedSalary = parseSalary(emp.salary);
        console.log(`💰 Row ${row}: Salary "${emp.salary}" -> ${parsedSalary}`);
        
        if (isNaN(parsedSalary) || parsedSalary <= 0) {
          console.log(`❌ Row ${row}: Invalid salary - ${emp.salary} -> ${parsedSalary}`);
          errors.push({ row, message: `Invalid salary: ${emp.salary}` });
          continue;
        }

        // Validate locationName
        const locationId = locationMap[emp.locationName.toLowerCase()];
        if (!locationId) {
          console.log(`❌ Row ${row}: Location not found: ${emp.locationName}`);
          errors.push({ row, message: `Location not found: ${emp.locationName}` });
          continue;
        }

        // Parse joinDate
        let parsedJoinDate;
        if (typeof emp.joinDate === "number") {
          parsedJoinDate = XLSX.SSF.parse_date_code(emp.joinDate);
          parsedJoinDate = new Date(parsedJoinDate.y, parsedJoinDate.m - 1, parsedJoinDate.d);
        } else {
          parsedJoinDate = new Date(emp.joinDate);
        }

        if (isNaN(parsedJoinDate)) {
          console.log(`❌ Row ${row}: Invalid join date`);
          errors.push({ row, message: "Invalid join date" });
          continue;
        }

        // Calculate prorated leaves
        const calculateProratedLeaves = (joinDate, paidLeavesPerYear) => {
          const join = new Date(joinDate);
          const joinYear = join.getFullYear();
          const joinMonth = join.getMonth(); 
          const currentYear = new Date().getFullYear();

          if (joinYear === currentYear) {
            const remainingMonths = 12 - joinMonth;
            return Math.round((paidLeavesPerYear * remainingMonths) / 12);
          }
          return paidLeavesPerYear;
        };

        const proratedLeaves = calculateProratedLeaves(parsedJoinDate, settings.paidLeavesPerYear);
        const documents = documentMap[emp.employeeId] || [];

        const validEmployee = {
          employeeId: emp.employeeId,
          name: emp.name,
          email: emp.email.toLowerCase(), // ✅ No uniqueness constraint
          designation: emp.designation,
          department: emp.department,
          salary: parsedSalary,
          location: locationId,
          phone: emp.phone,
          joinDate: parsedJoinDate,
          bankDetails: {
            accountNo: emp.accountNo,
            ifscCode: emp.ifscCode,
            bankName: emp.bankName,
            accountHolder: emp.accountHolder,
          },
          paidLeaves: {
            available: proratedLeaves,
            used: 0,
            carriedForward: 0,
          },
          documents,
          createdBy: req.user._id,
          status: "active",
          employmentHistory: [
            {
              startDate: parsedJoinDate,
              status: "active",
            },
          ],
        };

        validEmployees.push(validEmployee);
        console.log(`✅ Row ${row}: Valid employee processed - Salary: ${parsedSalary}`);

      } catch (err) {
        console.log(`❌ Row ${row}: Processing error:`, err.message);
        errors.push({ row, message: err.message });
      }
    }

    console.log('📊 Processing summary:', {
      totalRows: employees.length,
      validEmployees: validEmployees.length,
      errors: errors.length
    });

    if (validEmployees.length === 0) {
      console.log('❌ No valid employees to register');
      return res.status(400).json({
        message: "No valid employees to register",
        totalProcessed: employees.length,
        errors: errors,
        summary: {
          successfullyInserted: 0,
          validationErrors: errors.length,
          duplicatesSkipped: errors.filter(e => e.message.includes('already exists')).length
        }
      });
    }

    console.log('💾 Attempting to insert', validEmployees.length, 'employees into database...');

    try {
      const insertResult = await Employee.insertMany(validEmployees, { 
        ordered: false, // Continue on errors
        rawResult: true 
      });

      console.log('✅ Database insertion completed!');
      console.log('📊 Insert result:', {
        insertedCount: insertResult.insertedCount || insertResult.length,
        hasErrors: insertResult.writeErrors && insertResult.writeErrors.length > 0
      });

      const insertedCount = insertResult.insertedCount || insertResult.length;
      const insertedEmployees = insertResult.ops || insertResult;
      
      res.status(201).json({
        message: `Successfully processed ${insertedCount} employees${errors.length > 0 ? ` with ${errors.length} errors` : ''}`,
        count: insertedCount,
        employees: insertedEmployees,
        summary: {
          totalProcessed: employees.length,
          successfullyInserted: insertedCount,
          validationErrors: errors.length,
          duplicatesSkipped: errors.filter(e => e.message.includes('already exists')).length
        },
        errors: errors.length > 0 ? errors : undefined
      });

    } catch (insertError) {
      console.log('❌ Database insertion had errors:', insertError);
      
      // Handle BulkWriteError - extract successful insertions
      if (insertError.name === 'BulkWriteError' || insertError.code === 11000) {
        const insertedCount = insertError.result?.insertedCount || insertError.insertedDocs?.length || 0;
        const writeErrors = insertError.writeErrors || [];
        
        console.log('📊 BulkWriteError summary:', {
          insertedCount,
          writeErrorsCount: writeErrors.length,
          totalAttempted: validEmployees.length
        });

        const insertedEmployees = insertError.insertedDocs || [];

        return res.status(201).json({
          message: `Partially successful: ${insertedCount} employees inserted, ${writeErrors.length} failed`,
          count: insertedCount,
          employees: insertedEmployees,
          summary: {
            totalProcessed: employees.length,
            successfullyInserted: insertedCount,
            validationErrors: errors.length,
            duplicatesSkipped: errors.filter(e => e.message.includes('already exists')).length,
            insertionErrors: writeErrors.length
          },
          errors: errors.length > 0 ? errors : undefined,
          insertionErrors: writeErrors.map((err, index) => ({
            index: err.index,
            error: err.errmsg || err.err?.message || 'Unknown insertion error'
          }))
        });
      }

      throw insertError;
    }

  } catch (error) {
    console.log('❌ Overall function error:', error);
    
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        message: error.message,
        errors: error.errors || [],
      });
    }
    
    res.status(500).json({ 
      message: "Server error during Excel processing", 
      error: error.message 
    });
  }
};

// @desc    Get unique departments
// @route   GET /api/admin/employees/departments
// @access  Private/Admin
const getDepartments = asyncHandler(async (req, res) => {
  try {
    const { location } = req.query;
    let query = { isDeleted: false };
    if (location && mongoose.Types.ObjectId.isValid(location)) {
      query.location = new mongoose.Types.ObjectId(location);
    }
    const departments = await Employee.distinct("department", query);
    res.status(200).json({ departments });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch departments", error: error.message });
  }
});

const deleteEmployee = asyncHandler(async (req, res) => {
  const employee = await Employee.findById(req.params.id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  employee.isDeleted = true;
  await employee.save();
  res.status(200).json({ message: "Employee deleted successfully", id: req.params.id });
});

// @desc    Restore a deleted employee
// @route   PUT /api/admin/employees/:id/restore
// @access  Private/Admin
const restoreEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Find the employee
  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Restore the employee
  employee.isDeleted = false;
  await employee.save();

  // Populate necessary fields
  const restoredEmployee = await Employee.findById(id)
    .populate("location", "name")
    .populate("createdBy", "name");

  res.status(200).json({
    message: "Employee restored successfully",
    employee: restoredEmployee,
  });
});

export const getEmployeeAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { month, year, page = 1, limit = 10 } = req.query;

  // Build query for attendance
  const query = {
    employee: id,
    ...(month && year && {
      date: {
        $gte: new Date(year, month - 1, 1),
        $lt: new Date(year, month, 1),
      },
    }),
  };

  // Fetch attendance with pagination
  const totalItems = await Attendance.countDocuments(query);
  const attendance = await Attendance.find(query)
    .populate("employee", "name employeeId")
    .populate("location", "name")
    .sort({ date: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  res.status(200).json({
    attendance,
    pagination: {
      currentPage: Number(page),
      totalPages: Math.ceil(totalItems / limit),
      totalItems,
      itemsPerPage: Number(limit),
    },
  });
});

// @desc    Get paginated documents for an employee
// @route   GET /api/admin/employees/:id/documents?page=<page>&limit=<limit>
// @access  Private/Admin
const getEmployeeDocuments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 5, searchQuery = "" } = req.query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const skip = (parsedPage - 1) * parsedLimit;

  const pipeline = [
    { $match: { _id: new mongoose.Types.ObjectId(id) } },
    {
      $lookup: {
        from: "locations",
        localField: "location",
        foreignField: "_id",
        as: "location",
      },
    },
    { $unwind: { path: "$location", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "createdBy",
      },
    },
    { $unwind: { path: "$createdBy", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        employeeId: 1,
        name: 1,
        email: 1,
        designation: 1,
        department: 1,
        salary: 1,
        location: { name: 1, _id: 1 },
        paidLeaves: 1,
        advances: 1,
        phone: 1,
        dob: 1,
        joinDate: 1,
        bankDetails: 1,
        createdBy: { name: 1, _id: 1 },
        status: 1,
        transferHistory: 1,
        employmentHistory: 1,
        advanceHistory: 1,
        transferTimestamp: 1,
        monthlyLeaves: 1,
        filteredDocuments: {
          $filter: {
            input: "$documents",
            as: "doc",
            cond: {
              $regexMatch: {
                input: "$$doc.name",
                regex: searchQuery,
                options: "i",
              },
            },
          },
        },
        totalDocuments: {
          $cond: {
            if: { $eq: [searchQuery, ""] },
            then: { $size: "$documents" },
            else: {
              $size: {
                $filter: {
                  input: "$documents",
                  as: "doc",
                  cond: {
                    $regexMatch: {
                      input: "$$doc.name",
                      regex: searchQuery,
                      options: "i",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      $project: {
        employeeId: 1,
        name: 1,
        email: 1,
        designation: 1,
        department: 1,
        salary: 1,
        location: 1,
        paidLeaves: 1,
        advances: 1,
        phone: 1,
        dob: 1,
        joinDate: 1,
        bankDetails: 1,
        createdBy: 1,
        status: 1,
        transferHistory: 1,
        employmentHistory: 1,
        advanceHistory: 1,
        transferTimestamp: 1,
        monthlyLeaves: 1,
        totalDocuments: 1,
        documents: { $slice: ["$filteredDocuments", skip, parsedLimit] },
      },
    },
  ];

  const [employee] = await Employee.aggregate(pipeline);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  const totalDocuments = employee.totalDocuments || 0;
  const totalPages = Math.ceil(totalDocuments / parsedLimit);
  delete employee.totalDocuments;
  delete employee.filteredDocuments;

  res.status(200).json({
    employee,
    pagination: {
      currentPage: parsedPage,
      totalPages,
      totalItems: totalDocuments,
      itemsPerPage: parsedLimit,
    },
  });
});

export {
  getEmployees,
  getSettings,
  getEmployeeById,
  addEmployee,
  editEmployee,
  updateEmployeeAdvance,
  deactivateEmployee,
  transferEmployee,
  rejoinEmployee,
  getEmployeeHistory,
  addEmployeeDocuments,
  checkEmployeeExists,
  getEmployeeCount,
  getEmployeeAdvances,
  addEmployeesFromExcel,
  getDepartments,
  deleteEmployee,
  restoreEmployee,
  getEmployeeDocuments,
  redistributeMonthlyLeaves
};
