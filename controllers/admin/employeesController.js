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


// Helper function to calculate prorated leaves
const calculateProratedLeaves = (joinDate, paidLeavesPerYear) => {
  const join = new Date(joinDate);
  const joinYear = join.getFullYear();
  const joinMonth = join.getMonth(); // 0-based (0 = January)
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

  "Updating advance for employee ID:",
    id,
    "with advance:",
    advance,
    "year:",
    year,
    "month:",
    month;

  // Validate inputs
  if (!mongoose.Types.ObjectId.isValid(id)) {
    "Invalid employee ID:", id;
    res.status(400);
    throw new Error("Invalid employee ID");
  }
  if (advance === undefined || year === undefined || month === undefined) {
    "Missing required fields:", { advance, year, month };
    res.status(400);
    throw new Error("Advance, year, and month are required");
  }
  const parsedAdvance = Number(advance);
  if (isNaN(parsedAdvance) || parsedAdvance < 0) {
    "Invalid advance amount:", advance;
    res.status(400);
    throw new Error("Advance must be a non-negative number");
  }
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  if (
    isNaN(parsedYear) ||
    isNaN(parsedMonth) ||
    parsedMonth < 1 ||
    parsedMonth > 12
  ) {
    "Invalid year or month:", { year, month };
    res.status(400);
    throw new Error("Invalid year or month");
  }
  if (!req.user || !req.user._id) {
    "No authenticated user found:", req.user;
    res.status(401);
    throw new Error("Unauthorized: No user authenticated");
  }

  // Fetch employee
  const employee = await Employee.findById(id);
  if (!employee) {
    "Employee not found for ID:", id;
    res.status(404);
    throw new Error("Employee not found");
  }

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
    "Saving employee ID:", id;
    await employee.save();
    ("Employee saved successfully");

    let populatedEmployee;
    try {
      populatedEmployee = await Employee.findById(id)
        .populate("location", "name")
        .populate("createdBy", "name");
    } catch (populateError) {
      "Population error:", populateError.message;
      populatedEmployee = await Employee.findById(id);
    }

    res.status(200).json(populatedEmployee);
  } catch (error) {
    "Error updating employee advance:", error.message;
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: "Validation failed", errors });
    } else {
      res
        .status(500)
        .json({ message: "Failed to update advance", error: error.message });
    }
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

    // ✅ ADD: Cache busting headers when cache buster is present
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
  } else if (location) {
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
  if (isNaN(parsedPage) || parsedPage < 1) {
    res.status(400);
    throw new Error("Invalid page number");
  }
  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    res.status(400);
    throw new Error("Invalid limit value (must be between 1 and 100)");
  }

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
    const { _cacheBuster, cacheBuster } = req.query; // ✅ ADD: Extract cache busting params

    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
      return next(new AppError("Invalid employee ID format", 400));
    }
    const employee = await Employee.findById(id).populate("location");
    if (!employee) {
      return next(new AppError("Employee not found", 404));
    }

      // ✅ ADD: Cache busting headers when needed
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

  if (
    !employeeId ||
    !name ||
    !email ||
    !designation ||
    !department ||
    !salary ||
    !location ||
    !joinDate ||
    !bankDetails ||
    !createdBy
  ) {
    res.status(400);
    throw new Error("All required fields must be provided");
  }

  if (!files || files.length === 0) {
    res.status(400);
    throw new Error("At least one document is required");
  }

  // ✅ Get location name for folder organization
  let locationName = 'General'; // Default fallback
  try {
    const locationDoc = await Location.findById(location);
    if (locationDoc) {
      locationName = locationDoc.name;
      
    }
  } catch (error) {
      }


// ✅ Upload files to location-specific folder
  let googleDriveDocuments = [];
  try {
    
    googleDriveDocuments = await googleDriveService.uploadMultipleFiles(files, employeeId, locationName);
    
  } catch (error) {
    
    res.status(500);
    throw new Error(`Failed to upload documents to Google Drive: ${error.message}`);
  }


  if (!mongoose.Types.ObjectId.isValid(location)) {
    res.status(400);
    throw new Error("Invalid location ID");
  }
  if (!mongoose.Types.ObjectId.isValid(createdBy)) {
    res.status(400);
    throw new Error("Invalid createdBy ID");
  }

  let parsedBankDetails;
  try {
    parsedBankDetails = JSON.parse(bankDetails);
  } catch (error) {
    res.status(400);
    throw new Error("Invalid bankDetails format");
  }

  if (
    !parsedBankDetails.accountNo ||
    !parsedBankDetails.ifscCode ||
    !parsedBankDetails.bankName ||
    !parsedBankDetails.accountHolder
  ) {
    res.status(400);
    throw new Error("All bank details fields are required");
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error("Settings not found");
  }

  // Validate and parse joinDate
  const parsedJoinDate = new Date(joinDate);
  if (isNaN(parsedJoinDate)) {
    res.status(400);
    throw new Error("Invalid join date");
  }

  // Calculate prorated leaves
  const proratedLeaves = calculateProratedLeaves(
    parsedJoinDate,
    settings.paidLeavesPerYear
  );

  // const documents = files.map((file) => ({
  //   name: file.originalname,
  //   path: `/Uploads/${file.filename}`, // Use subfolder for documents
  //   uploadedAt: new Date(),
  //   size: file.size,
  // }));

 // ✅ Enhanced document metadata with location info
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
    locationName: doc.locationName, // ✅ Store location info
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
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: "Validation failed", errors });
    } else if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      res.status(400).json({
        message: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`,
        field,
      });
    } else {
      res
        .status(500)
        .json({ message: "Failed to create employee", error: error.message });
    }
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

  
  

  if (!mongoose.Types.ObjectId.isValid(id)) {
    
    res.status(400);
    throw new Error("Invalid employee ID");
  }

  const employee = await Employee.findById(id);
  if (!employee) {
    
    res.status(404);
    throw new Error("Employee not found");
  }

  if (!name || !email || !designation || !department || !salary) {
    
    res.status(400);
    throw new Error("Name, email, designation, department, and salary are required");
  }

  // ✅ ALL VALIDATION CODE (keep your existing validation)
  if (typeof name !== "string" || name.length < 3 || name.length > 50) {
    
    res.status(400);
    throw new Error("Name must be a string between 3 and 50 characters");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    
    res.status(400);
    throw new Error("Invalid email address");
  }

  if (typeof designation !== "string" || designation.length < 2 || designation.length > 50) {
    
    res.status(400);
    throw new Error("Designation must be a string between 2 and 50 characters");
  }

  if (typeof department !== "string" || department.length < 2 || department.length > 50) {
    
    res.status(400);
    throw new Error("Department must be a string between 2 and 50 characters");
  }

  const parsedSalary = Number(salary);
  if (isNaN(parsedSalary) || parsedSalary < 1000) {
    
    res.status(400);
    throw new Error("Salary must be a number greater than or equal to 1000");
  }

  if (phone && !/^\d{10}$/.test(phone)) {
    
    res.status(400);
    throw new Error("Phone number must be 10 digits");
  }

  if (dob) {
    const parsedDob = new Date(dob);
    if (isNaN(parsedDob.getTime())) {
      
      res.status(400);
      throw new Error("Invalid date of birth");
    }
  }

  if (location && !mongoose.Types.ObjectId.isValid(location)) {
    
    res.status(400);
    throw new Error("Invalid location ID");
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error("Settings not found");
  }

  // Calculate max allowed available leaves based on proration
  const proratedLeaves = calculateProratedLeaves(employee.joinDate, settings.paidLeavesPerYear);

  if (paidLeaves) {
    const { available, used, carriedForward } = paidLeaves;
    if (
      available === undefined ||
      used === undefined ||
      carriedForward === undefined ||
      typeof available !== "number" ||
      available < 0 ||
      typeof used !== "number" ||
      used < 0 ||
      typeof carriedForward !== "number" ||
      carriedForward < 0
    ) {
      
      res.status(400);
      throw new Error("paidLeaves fields (available, used, carriedForward) must be non-negative numbers");
    }
    if (available > proratedLeaves) {
      
      res.status(400);
      throw new Error(`Available leaves cannot exceed prorated limit of ${proratedLeaves}`);
    }
  }

  if (bankDetails) {
    const { accountNo, ifscCode, bankName, accountHolder } = bankDetails;
    const hasAnyBankDetail = accountNo || ifscCode || bankName || accountHolder;
    if (hasAnyBankDetail && !(accountNo && ifscCode && bankName && accountHolder)) {
      
      res.status(400);
      throw new Error("All bank details fields are required if any bank detail is provided");
    }
  }

  // Check for duplicate email
  if (email) {
    
    const existingEmployee = await Employee.findOne({
      email: email.toLowerCase(),
      _id: { $ne: id },
    });
    if (existingEmployee) {
      
      return res.status(400).json({ message: "Email already exists" });
    } else {
      
    }
  }

  try {
    // ✅ UPDATE EMPLOYEE FIELDS
    employee.name = name;
    employee.email = email.toLowerCase();
    employee.designation = designation;
    employee.department = department;
    employee.salary = parsedSalary;
    employee.phone = phone || null;
    employee.dob = dob ? new Date(dob) : null;
    if (location) {
      employee.location = location;
    }

    // ✅ Handle bank details using safe nested updates
    if (bankDetails) {
      employee.set('bankDetails.accountNo', bankDetails.accountNo);
      employee.set('bankDetails.ifscCode', bankDetails.ifscCode);
      employee.set('bankDetails.bankName', bankDetails.bankName);
      employee.set('bankDetails.accountHolder', bankDetails.accountHolder);
    }

    // ✅ Handle manual paidLeaves update using safe nested updates
    if (paidLeaves) {
      
      
      

      employee.isManualPaidLeavesUpdate = true;
      
      // ✅ USE SAFE NESTED UPDATES instead of object replacement
      employee.set('paidLeaves.available', paidLeaves.available);
      employee.set('paidLeaves.used', paidLeaves.used);
      employee.set('paidLeaves.carriedForward', paidLeaves.carriedForward);
      
      // ✅ Distribute across remaining months only
      await redistributeMonthlyLeaves(employee, paidLeaves);
      
      employee.markModified('paidLeaves');
      employee.markModified('monthlyLeaves');
      
      
    }

    // ✅ SINGLE SAVE OPERATION
    
    await employee.save();
    

    // ✅ DO NOT RESET THE FLAG - Keep it true to preserve manual values
    if (paidLeaves) {
      
      // Keep isManualPaidLeavesUpdate = true permanently to prevent future auto-calculations
    }

    // ✅ Populate and return response
    let updatedEmployee;
    try {
      updatedEmployee = await Employee.findById(id)
        .populate("location")
        .populate("createdBy");
    } catch (populateError) {
      
      updatedEmployee = await Employee.findById(id);
    }
    
    // ✅ ADD: Force cache invalidation after employee update
res.set({
  'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
  'ETag': false,
  'Last-Modified': false
});


    res.status(200).json(updatedEmployee);
    
  } catch (error) {
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: "Validation failed", errors });
    } else if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      res.status(400).json({
        message: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`,
      });
    } else {
      
      res.status(500).json({ message: "Failed to update employee", error: error.message });
    }
  }
});




// ✅ NEW: Function to redistribute manual updates across monthly leaves
// ✅ ENHANCED: Function to redistribute manual updates across monthly leaves
const redistributeMonthlyLeaves = async (employee, paidLeaves) => {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1; // 1-based month
  
  
  
  
  // ✅ Calculate remaining months including current month
  const monthsRemainingInYear = 12 - currentMonth + 1;
  const perMonthAllocation = paidLeaves.available / monthsRemainingInYear;
  
  // ✅ FORCE CHANGE DETECTION: Clone and replace monthlyLeaves array
  const updatedMonthlyLeaves = [...employee.monthlyLeaves];
  
  // ✅ Update only current and future months in the current year
  for (let i = 0; i < updatedMonthlyLeaves.length; i++) {
    const ml = updatedMonthlyLeaves[i];
    
    if (ml.year === currentYear && ml.month >= currentMonth) {
      const previousTaken = ml.taken || 0;
      
      // ✅ Create new object to trigger change detection
      updatedMonthlyLeaves[i] = {
        ...ml,
        allocated: Math.round(perMonthAllocation * 10) / 10,
        taken: previousTaken,
        carriedForward: ml.carriedForward || 0,
        available: Math.max(0, Math.round(perMonthAllocation * 10) / 10 - previousTaken)
      };
      
      
    }
  }
  
  // ✅ FORCE MONGOOSE TO DETECT CHANGES
  employee.monthlyLeaves = updatedMonthlyLeaves;
  employee.markModified('monthlyLeaves');
  
  
};

// ✅ ADD: Helper function to check attendance in month
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


// ✅ NEW: Salary calculation endpoints
// GET /api/superadmin/employees/:id/salary/:year/:month
export const getEmployeeMonthlySalary = async (req, res) => {
  try {
    const { id, year, month } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }
    
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    // Find monthly presence record
    const monthlyPresence = employee.monthlyPresence.find(
      mp => mp.year === parseInt(year) && mp.month === parseInt(month)
    ) || { totalPresenceDays: 0, workingDaysInMonth: 30 };
    
    // ✅ Calculate salary based on presence days only
    const monthlySalary = employee.salary || 0;
    const workingDaysForCalculation = monthlyPresence.workingDaysInMonth || 30;
    const dailySalary = monthlySalary / workingDaysForCalculation;
    const payableSalary = dailySalary * monthlyPresence.totalPresenceDays;
    
    // Get leave information for reference
    const monthlyLeave = employee.monthlyLeaves.find(
      ml => ml.year === parseInt(year) && ml.month === parseInt(month)
    ) || { allocated: 2, taken: 0, available: 2, carriedForward: 0 };
    
    // ✅ Calculate attendance summary
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

// ✅ NEW: Bulk salary calculation for payroll
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
      if (!mongoose.Types.ObjectId.isValid(location)) {
        return res.status(400).json({ message: 'Invalid location ID' });
      }
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
// employeesController.js
// @desc    Deactivate an employee
// @route   PUT /api/admin/employees/:id/deactivate
// @access  Private/Admin
// @desc    Deactivate an employee
// @route   PUT /api/admin/employees/:id/deactivate
// @access  Private/Admin
const deactivateEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    // Find the employee
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Prevent deactivation if already inactive
    if (employee.status === 'inactive') {
      return res.status(400).json({ message: 'Employee is already deactivated' });
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

  if (!location) {
    res.status(400);
    throw new Error("Location is required");
  }

  if (!transferTimestamp) {
    res.status(400);
    throw new Error("Transfer timestamp is required");
  }

  const parsedTransferTimestamp = new Date(transferTimestamp);
  if (isNaN(parsedTransferTimestamp)) {
    res.status(400);
    throw new Error("Invalid transfer timestamp");
  }

  if (!mongoose.Types.ObjectId.isValid(location)) {
    res.status(400);
    throw new Error("Invalid location ID");
  }

  const employee = await Employee.findById(id).populate("location");
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  if (employee.location._id.toString() === location) {
    res.status(400);
    throw new Error("Employee is already at this location");
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
// @desc    Rejoin an employee
// @route   PUT /api/admin/employees/:id/rejoin
// @access  Private/Admin
const rejoinEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rejoinDate } = req.body;

  if (!rejoinDate) {
    res.status(400);
    throw new Error("Rejoin date is required");
  }

  const parsedRejoinDate = new Date(rejoinDate);
  if (isNaN(parsedRejoinDate)) {
    res.status(400);
    throw new Error("Invalid rejoin date");
  }

  // Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid employee ID");
  }

  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  if (employee.status === "active") {
    res.status(400);
    throw new Error("Employee is already active");
  }

  // Ensure employmentHistory exists
  if (!employee.employmentHistory) {
    employee.employmentHistory = [];
  }

  // Check the latest employment entry
  const latestEmployment = employee.employmentHistory.length > 0
    ? employee.employmentHistory[employee.employmentHistory.length - 1]
    : null;

  if (latestEmployment && latestEmployment.endDate && parsedRejoinDate <= latestEmployment.endDate) {
    res.status(400);
    throw new Error("Rejoin date must be after the last end date");
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
  const { page = 1, limit = 5 } = req.query; // Support pagination in response

  if (!files || files.length === 0) {
    res.status(400);
    throw new Error("At least one document is required");
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid employee ID");
  }

   // ✅ FETCH EMPLOYEE WITH POPULATED LOCATION
  const employee = await Employee.findById(id).populate('location');
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

   // ✅ Get location name
  const locationName = employee.location?.name || 'General';
  

  // ✅ Upload to location-specific folder
  let googleDriveDocuments = [];
  try {
    googleDriveDocuments = await googleDriveService.uploadMultipleFiles(files, employee.employeeId, locationName);
  } catch (error) {
    
    res.status(500);
    throw new Error(`Failed to upload documents to Google Drive: ${error.message}`);
  }


  // const newDocuments = files.map((file) => ({
  //   name: file.originalname,
  //   path: `/Uploads/${file.filename}`,
  //   uploadedAt: new Date(),
  //   size: file.size,
  // }));

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
            
          }
        }
        throw error;

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: "Validation failed", errors });
    } else {
      res
        .status(500)
        .json({ message: "Failed to add documents", error: error.message });
    }
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
        highlightDuration: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
      });
    }
    res.status(200).json(settings);
  } catch (error) {
    "Get settings error:", error;
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
    "Get employee count error:", error;
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

  // Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid employee ID");
  }

  // Parse pagination parameters
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  if (isNaN(parsedPage) || parsedPage < 1) {
    res.status(400);
    throw new Error("Invalid page number");
  }
  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    res.status(400);
    throw new Error("Invalid limit value (must be between 1 and 100)");
  }

  // Validate sort parameters
  const validSortFields = ["amount", "month", "year"];
  if (!validSortFields.includes(sortField)) {
    res.status(400);
    throw new Error("Invalid sort field");
  }
  const validSortOrders = ["asc", "desc"];
  if (!validSortOrders.includes(sortOrder)) {
    res.status(400);
    throw new Error("Invalid sort order");
  }

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
// @desc    Add employees from Excel file
// @route   POST /api/admin/employees/excel
// @access  Private/Admin
// @desc    Add employees from Excel file
// @route   POST /api/admin/employees/excel
// @access  Private/Admin
// @desc    Add employees from Excel file
// @route   POST /api/admin/employees/excel
// @access  Private/Admin
const addEmployeesFromExcel = async (req, res, next) => {
  try {
   

    if (!req.files || !req.files.excelFile || req.files.excelFile.length === 0) {
      return next(new AppError("No Excel file uploaded", 400));
    }

    const excelFile = req.files.excelFile[0];
   

    // Handle document uploads
    const documentFiles = req.files.documents || [];

    const requiredHeaders = [
      "employeeId",
      "name",
      "email",
      "designation",
      "department",
      "salary",
      "locationName",
      "phone",
      "joinDate",
      "accountNo",
      "ifscCode",
      "bankName",
      "accountHolder",
    ];

    let employees = [];
    const fileExtension = excelFile.originalname.split(".").pop().toLowerCase();

    if (fileExtension === "csv") {

      const records = await new Promise((resolve, reject) => {
        const parser = parse({
          columns: true,
          trim: true,
          skip_empty_lines: true,
          skip_lines_with_error: true,
        });
        const results = [];
        parser.on("readable", () => {
          let record;
          while ((record = parser.read())) {
            results.push(record);
          }
        });
        parser.on("error", reject);
        parser.on("end", () => resolve(results));
        parser.write(cleanedText);
        parser.end();
      });

      employees = records;
    } else if (["xlsx", "xls"].includes(fileExtension)) {
      const fileBuffer = await fs.readFile(excelFile.path);
      const workbook = XLSX.read(fileBuffer, { type: "buffer", dateNF: "yyyy-mm-dd" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      employees = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        blankrows: false,
        raw: false, // Ensure dates are parsed as strings
        dateNF: "yyyy-mm-dd", // Enforce date format
      });

      if (employees.length < 1) {
        return next(new AppError("Excel file is empty", 400));
      }
      const headers = employees[0].map((h) => h.toString().trim());
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
      return next(new AppError("Unsupported file format", 400));
    }

    const fileHeaders = employees.length > 0 ? Object.keys(employees[0]) : [];

    const missingHeaders = requiredHeaders.filter((h) => !fileHeaders.includes(h));
    if (missingHeaders.length > 0) {
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
      } else {
      }
    });

    // Fetch all locations to map locationName to location _id
    const locations = await Location.find().select("name _id");
    const locationMap = {};
    locations.forEach((loc) => {
      locationMap[loc.name.toLowerCase()] = loc._id;
    });

    // Fetch settings for paid leaves
    const settings = await Settings.findOne();
    if (!settings) {
      return next(new AppError("Settings not found", 500));
    }

    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      const row = i + 2; // Account for header row
      try {
        // Basic validation
        if (
          !emp.employeeId ||
          !emp.name ||
          !emp.email ||
          !emp.designation ||
          !emp.department ||
          !emp.salary ||
          !emp.locationName ||
          !emp.phone ||
          !emp.joinDate ||
          !emp.accountNo ||
          !emp.ifscCode ||
          !emp.bankName ||
          !emp.accountHolder
        ) {
          errors.push({ row, message: "Missing required fields" });
          continue;
        }

        // Additional validations
        if (!/^[A-Z0-9-]+$/.test(emp.employeeId)) {
          errors.push({
            row,
            message: "Employee ID must be alphanumeric with hyphens",
          });
          continue;
        }
        if (!/^[a-zA-Z\s]+$/.test(emp.name)) {
          errors.push({
            row,
            message: "Name must contain only letters and spaces",
          });
          continue;
        }
        if (!/^\d{10,15}$/.test(emp.phone)) {
          errors.push({ row, message: "Phone number must be 10 to 15 digits" });
          continue;
        }
        const parsedSalary = Number(emp.salary);
        if (isNaN(parsedSalary) || parsedSalary < 1000 || parsedSalary > 10000000) {
          errors.push({
            row,
            message: "Salary must be a number between 1000 and 10,000,000",
          });
          continue;
        }

        // Validate locationName
        const locationId = locationMap[emp.locationName.toLowerCase()];
        if (!locationId) {
          errors.push({ row, message: `Location not found: ${emp.locationName}` });
          continue;
        }

        // Check for duplicates
        const existingEmployee = await Employee.findOne({
          $or: [
            { employeeId: emp.employeeId },
            { email: emp.email.toLowerCase() },
            { phone: emp.phone },
          ],
        });
        if (existingEmployee) {
          errors.push({
            row,
            message: `Duplicate found: ${existingEmployee.employeeId === emp.employeeId ? "Employee ID" : existingEmployee.email === emp.email.toLowerCase() ? "Email" : "Phone"} already exists`,
          });
          continue;
        }

        // Validate and parse joinDate
        let parsedJoinDate;
        if (typeof emp.joinDate === "number") {
          // Handle Excel numeric date (days since 1900-01-01)
          parsedJoinDate = XLSX.SSF.parse_date_code(emp.joinDate);
          parsedJoinDate = new Date(parsedJoinDate.y, parsedJoinDate.m - 1, parsedJoinDate.d);
        } else {
          // Handle string date
          parsedJoinDate = new Date(emp.joinDate);
        }

        if (isNaN(parsedJoinDate) || parsedJoinDate > new Date()) {
          errors.push({ row, message: "Invalid or future join date" });
          continue;
        }

        // Validate email format
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emp.email)) {
          errors.push({ row, message: "Invalid email address" });
          continue;
        }

        const proratedLeaves = calculateProratedLeaves(parsedJoinDate, settings.paidLeavesPerYear);

        // Assign documents for this employee
        const documents = documentMap[emp.employeeId] || [];

        validEmployees.push({
          employeeId: emp.employeeId,
          name: emp.name,
          email: emp.email.toLowerCase(),
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
        });
      } catch (err) {
        errors.push({ row, message: err.message });
      }
    }

    if (errors.length > 0) {
      return next(new AppError("Validation errors in file", 400, errors));
    }

    if (validEmployees.length === 0) {
      return next(new AppError("No valid employees to register", 400));
    }

    const insertedEmployees = await Employee.insertMany(validEmployees, { ordered: false });
    res.status(201).json({
      message: "Employees registered successfully",
      count: insertedEmployees.length,
      employees: insertedEmployees,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        message: error.message,
        errors: error.errors || [],
      });
    }
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


// @desc    Get unique departments
// @route   GET /api/admin/employees/departments
// @access  Private/Admin
// @desc    Get unique departments
// @route   GET /api/admin/employees/departments
// @access  Private/Admin
const getDepartments = asyncHandler(async (req, res) => {
  try {
    const { location } = req.query;
    let query = { isDeleted: false }; // Add isDeleted: false to exclude deleted employees
    if (location && mongoose.Types.ObjectId.isValid(location)) {
      query.location = new mongoose.Types.ObjectId(location);
    } else if (location && location !== "all") {
      return res.status(400).json({ message: "Invalid location ID" });
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
  if (employee.isDeleted) {
    res.status(400);
    throw new Error("Employee is already deleted");
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

  // Validate ObjectId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid employee ID");
  }

  // Find the employee
  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Check if employee is already active (not deleted)
  if (!employee.isDeleted) {
    res.status(400);
    throw new Error("Employee is not deleted");
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
  const { id } = req.params; // Employee ID from URL
  const { month, year, page = 1, limit = 10 } = req.query;

  // Validate employee exists
  const employee = await Employee.findById(id);
  if (!employee || employee.isDeleted) {
    res.status(404);
    throw new Error("Employee not found");
  }

  // Build query for attendance
  const query = {
    employee: id, // Filter by employee ID
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

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid employee ID");
  }

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  if (isNaN(parsedPage) || parsedPage < 1) {
    res.status(400);
    throw new Error("Invalid page number");
  }
  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    res.status(400);
    throw new Error("Invalid limit value (must be between 1 and 100)");
  }

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
                options: "i", // Case-insensitive
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
