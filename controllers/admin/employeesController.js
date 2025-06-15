import Employee from '../../models/Employee.js';
import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Settings from '../../models/Settings.js';

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
    res.status(200).json({ exists: true, field: employeeId ? 'employeeId' : 'email' });
  } else {
    res.status(200).json({ exists: false });
  }
});

// @desc    Get all employees
// @route   GET /api/admin/employees
// @access  Private/Admin
const getEmployees = asyncHandler(async (req, res) => {
  const { location, status } = req.query;
  const query = {};
  if (location) query.location = location;
  if (status) query.status = status;
  const employees = await Employee.find(query).populate('location').populate('createdBy');
  res.status(200).json(employees);
});

// @desc    Get a single employee by ID
// @route   GET /api/admin/employees/:id
// @access  Private/Admin
const getEmployeeById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const employee = await Employee.findById(id).populate('location').populate('createdBy');
  
  if (!employee) {
    res.status(404);
    throw new Error('Employee not found');
  }

  res.status(200).json(employee);
});

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

  if (!employeeId || !name || !email || !designation || !department || !salary || !location || !joinDate || !bankDetails || !createdBy) {
    res.status(400);
    throw new Error('All required fields must be provided');
  }

  if (!files || files.length === 0) {
    res.status(400);
    throw new Error('At least one document is required');
  }

  if (!mongoose.Types.ObjectId.isValid(location)) {
    res.status(400);
    throw new Error('Invalid location ID');
  }
  if (!mongoose.Types.ObjectId.isValid(createdBy)) {
    res.status(400);
    throw new Error('Invalid createdBy ID');
  }

  let parsedBankDetails;
  try {
    parsedBankDetails = JSON.parse(bankDetails);
  } catch (error) {
    res.status(400);
    throw new Error('Invalid bankDetails format');
  }

  if (!parsedBankDetails.accountNo || !parsedBankDetails.ifscCode || !parsedBankDetails.bankName || !parsedBankDetails.accountHolder) {
    res.status(400);
    throw new Error('All bank details fields are required');
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error('Settings not found');
  }

  // Validate and parse joinDate
  const parsedJoinDate = new Date(joinDate);
  if (isNaN(parsedJoinDate)) {
    res.status(400);
    throw new Error('Invalid join date');
  }

  // Calculate prorated leaves
  const proratedLeaves = calculateProratedLeaves(parsedJoinDate, settings.paidLeavesPerYear);

  const documents = files.map((file) => ({
    name: file.originalname,
    path: file.path,
    uploadedAt: new Date(),
    size: file.size,
  }));

  const employee = new Employee({
    employeeId,
    name,
    email: email.toLowerCase(), // Normalize email
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
      .populate('location')
      .populate('createdBy');
    res.status(201).json(populatedEmployee);
  } catch (error) {
    await session.abortTransaction();
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: 'Validation failed', errors });
    } else if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      res.status(400).json({ 
        message: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`,
        field
      });
    } else {
      res.status(500).json({ message: 'Failed to create employee', error: error.message });
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
  const { name, email, designation, department, salary, phone, dob, paidLeaves, location, bankDetails } = req.body;

  console.log('Editing employee with ID:', id);
  console.log('Request body:', req.body);

  if (!mongoose.Types.ObjectId.isValid(id)) {
    console.log('Invalid employee ID:', id);
    res.status(400);
    throw new Error('Invalid employee ID');
  }

  const employee = await Employee.findById(id);
  if (!employee) {
    console.log('Employee not found for ID:', id);
    res.status(404);
    throw new Error('Employee not found');
  }

  if (!name || !email || !designation || !department || !salary) {
    console.log('Missing required fields:', { name, email, designation, department, salary });
    res.status(400);
    throw new Error('Name, email, designation, department, and salary are required');
  }

  if (typeof name !== 'string' || name.length < 3 || name.length > 50) {
    console.log('Validation failed for name:', name);
    res.status(400);
    throw new Error('Name must be a string between 3 and 50 characters');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log('Validation failed for email format:', email);
    res.status(400);
    throw new Error('Invalid email address');
  }

  if (typeof designation !== 'string' || designation.length < 2 || designation.length > 50) {
    console.log('Validation failed for designation:', designation);
    res.status(400);
    throw new Error('Designation must be a string between 2 and 50 characters');
  }

  if (typeof department !== 'string' || department.length < 2 || department.length > 50) {
    console.log('Validation failed for department:', department);
    res.status(400);
    throw new Error('Department must be a string between 2 and 50 characters');
  }

  const parsedSalary = Number(salary);
  if (isNaN(parsedSalary) || parsedSalary < 1000) {
    console.log('Validation failed for salary:', salary);
    res.status(400);
    throw new Error('Salary must be a number greater than or equal to 1000');
  }

  if (phone && !/^\d{10}$/.test(phone)) {
    console.log('Validation failed for phone:', phone);
    res.status(400);
    throw new Error('Phone number must be 10 digits');
  }

  if (dob) {
    const parsedDob = new Date(dob);
    if (isNaN(parsedDob.getTime())) {
      console.log('Validation failed for dob:', dob);
      res.status(400);
      throw new Error('Invalid date of birth');
    }
  }

  if (location && !mongoose.Types.ObjectId.isValid(location)) {
    console.log('Validation failed for location:', location);
    res.status(400);
    throw new Error('Invalid location ID');
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error('Settings not found');
  }

  // Calculate max allowed available leaves based on proration
  const proratedLeaves = calculateProratedLeaves(employee.joinDate, settings.paidLeavesPerYear);

  if (paidLeaves) {
    const { available, used, carriedForward } = paidLeaves;
    if (
      available === undefined || used === undefined || carriedForward === undefined ||
      typeof available !== 'number' || available < 0 ||
      typeof used !== 'number' || used < 0 ||
      typeof carriedForward !== 'number' || carriedForward < 0
    ) {
      console.log('Validation failed for paidLeaves:', paidLeaves);
      res.status(400);
      throw new Error('paidLeaves fields (available, used, carriedForward) must be non-negative numbers');
    }
    if (available > proratedLeaves) {
      console.log(`Available leaves (${available}) exceeds prorated limit (${proratedLeaves})`);
      res.status(400);
      throw new Error(`Available leaves cannot exceed prorated limit of ${proratedLeaves}`);
    }
  }

  if (bankDetails) {
    const { accountNo, ifscCode, bankName, accountHolder } = bankDetails;
    const hasAnyBankDetail = accountNo || ifscCode || bankName || accountHolder;
    if (hasAnyBankDetail && !(accountNo && ifscCode && bankName && accountHolder)) {
      console.log('Validation failed for bankDetails:', bankDetails);
      res.status(400);
      throw new Error('All bank details fields are required if any bank detail is provided');
    }
  }

  // Check for duplicate email
  if (email) {
    console.log('Checking for duplicate email:', email);
    const existingEmployee = await Employee.findOne({ 
      email: email.toLowerCase(), 
      _id: { $ne: id } 
    });
    if (existingEmployee) {
      console.log('Duplicate email found:', email);
      return res.status(400).json({ message: 'Email already exists' });
    } else {
      console.log('No duplicate email found for:', email);
    }
  }

  try {
    // Update employee fields
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
    if (paidLeaves) {
      employee.paidLeaves = {
        available: paidLeaves.available,
        used: paidLeaves.used,
        carriedForward: paidLeaves.carriedForward,
      };
    }
    if (bankDetails) {
      employee.bankDetails = {
        accountNo: bankDetails.accountNo,
        ifscCode: bankDetails.ifscCode,
        bankName: bankDetails.bankName,
        accountHolder: bankDetails.accountHolder,
      };
    }

    console.log('Saving employee...');
    await employee.save();
    console.log('Employee saved successfully');

    let updatedEmployee;
    try {
      updatedEmployee = await Employee.findById(id).populate('location').populate('createdBy');
    } catch (populateError) {
      console.error('Error during populate:', populateError);
      updatedEmployee = await Employee.findById(id);
    }
    res.status(200).json(updatedEmployee);
  } catch (error) {
    console.error('Error during employee update:', error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: 'Validation failed', errors });
    } else if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      res.status(400).json({ message: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists` });
    } else {
      console.error('Unhandled error during employee update:', error);
      res.status(500).json({ message: 'Failed to update employee', error: error.message });
    }
  }
});

// @desc    Update employee advance
// @route   PUT /api/admin/employees/:id/advance
// @access  Private/Admin
const updateEmployeeAdvance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { advance } = req.body;

  console.log('Updating advance for employee ID:', id, 'with advance:', advance, 'req.body:', req.body);

  // Validate employee ID
  if (!mongoose.Types.ObjectId.isValid(id)) {
    console.error('Invalid employee ID:', id);
    res.status(400);
    throw new Error('Invalid employee ID');
  }

  // Fetch employee
  const employee = await Employee.findById(id);
  if (!employee) {
    console.error('Employee not found for ID:', id);
    res.status(404);
    throw new Error('Employee not found');
  }

  // Validate advance
  if (advance === undefined) {
    console.error('Advance is undefined in request body:', req.body);
    res.status(400);
    throw new Error('Advance is required');
  }
  const parsedAdvance = Number(advance);
  if (isNaN(parsedAdvance) || parsedAdvance < 0) {
    console.error('Invalid advance amount:', advance);
    res.status(400);
    throw new Error('Advance must be a non-negative number');
  }

  // Validate req.user
  if (!req.user || !req.user._id) {
    console.error('No authenticated user found:', req.user);
    res.status(401);
    throw new Error('Unauthorized: No user authenticated');
  }

  // Update advance and advanceHistory
  employee.advance = parsedAdvance;
  employee.advanceHistory.push({
    amount: parsedAdvance,
    updatedBy: req.user._id,
    updatedAt: new Date(),
  });

  try {
    console.log('Saving employee ID:', id);
    await employee.save();
    console.log('Employee saved successfully');

    // Populate response
    let populatedEmployee;
    try {
      populatedEmployee = await Employee.findById(id)
        .populate('location', 'name')
        .populate('createdBy', 'name');
    } catch (populateError) {
      console.error('Population error:', populateError.message, populateError.stack);
      populatedEmployee = await Employee.findById(id);
    }

    res.status(200).json(populatedEmployee);
  } catch (error) {
    console.error('Error updating employee advance:', error.message, error.stack);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: 'Validation failed', errors });
    } else {
      res.status(500).json({ message: 'Failed to update advance', error: error.message });
    }
  }
});

// @desc    Deactivate an employee
// @route   PUT /api/admin/employees/:id/deactivate
// @access  Private/Admin
const deactivateEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const employee = await Employee.findById(id);

  if (!employee) {
    res.status(404);
    throw new Error('Employee not found');
  }

  if (employee.status === 'inactive') {
    res.status(400);
    throw new Error('Employee is already inactive');
  }

  // Update status and employment history
  employee.status = 'inactive';
  const latestEmployment = employee.employmentHistory[employee.employmentHistory.length - 1];
  latestEmployment.endDate = new Date();
  latestEmployment.status = 'inactive';
  latestEmployment.leaveBalanceAtEnd = employee.paidLeaves.available + employee.paidLeaves.carriedForward - employee.paidLeaves.used;

  try {
    await employee.save();
    res.status(200).json({ message: 'Employee deactivated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to deactivate employee', error: error.message });
  }
});

// @desc    Transfer an employee to a new location
// @route   PUT /api/admin/employees/:id/transfer
// @access  Private/Admin
const transferEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { location, transferTimestamp } = req.body;

  if (!location) {
    res.status(400);
    throw new Error('Location is required');
  }

  if (!transferTimestamp) {
    res.status(400);
    throw new Error('Transfer timestamp is required');
  }

  const parsedTransferTimestamp = new Date(transferTimestamp);
  if (isNaN(parsedTransferTimestamp)) {
    res.status(400);
    throw new Error('Invalid transfer timestamp');
  }

  if (!mongoose.Types.ObjectId.isValid(location)) {
    res.status(400);
    throw new Error('Invalid location ID');
  }

  const employee = await Employee.findById(id).populate('location');
  if (!employee) {
    res.status(404);
    throw new Error('Employee not found');
  }

  if (employee.location._id.toString() === location) {
    res.status(400);
    throw new Error('Employee is already at this location');
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

  const updatedEmployee = await Employee.findById(id).populate('location').populate('createdBy');
  res.status(200).json(updatedEmployee);
});

// @desc    Rejoin an employee
// @route   PUT /api/admin/employees/:id/rejoin
// @access  Private/Admin
const rejoinEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rejoinDate } = req.body;

  if (!rejoinDate) {
    res.status(400);
    throw new Error('Rejoin date is required');
  }

  const parsedRejoinDate = new Date(rejoinDate);
  if (isNaN(parsedRejoinDate)) {
    res.status(400);
    throw new Error('Invalid rejoin date');
  }

  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error('Employee not found');
  }

  if (employee.status === 'active') {
    res.status(400);
    throw new Error('Employee is already active');
  }

  const latestEmployment = employee.employmentHistory[employee.employmentHistory.length - 1];
  if (latestEmployment.endDate && parsedRejoinDate <= latestEmployment.endDate) {
    res.status(400);
    throw new Error('Rejoin date must be after the last end date');
  }

  // Fetch settings for paidLeavesPerYear
  const settings = await Settings.findOne();
  if (!settings) {
    res.status(500);
    throw new Error('Settings not found');
  }

  // Calculate prorated leaves for rejoin year
  const proratedLeaves = calculateProratedLeaves(parsedRejoinDate, settings.paidLeavesPerYear);

  // Update status and employment history
  employee.status = 'active';
  employee.employmentHistory.push({
    startDate: parsedRejoinDate,
    status: 'active',
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

  const updatedEmployee = await Employee.findById(id).populate('location').populate('createdBy');
  res.status(200).json(updatedEmployee);
});

// @desc    Get employee history (transfer and employment)
// @route   GET /api/admin/employees/:id/history
// @access  Private/Admin
const getEmployeeHistory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const employee = await Employee.findById(id)
    .populate('transferHistory.fromLocation')
    .populate('transferHistory.toLocation');

  if (!employee) {
    res.status(404);
    throw new Error('Employee not found');
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

  if (!files || files.length === 0) {
    res.status(400);
    throw new Error('At least one document is required');
  }

  const employee = await Employee.findById(id);
  if (!employee) {
    res.status(404);
    throw new Error('Employee not found');
  }

  const newDocuments = files.map((file) => ({
    name: file.originalname,
    path: file.path,
    uploadedAt: new Date(),
    size: file.size,
  }));

  employee.documents.push(...newDocuments);

  try {
    await employee.save();
    const updatedEmployee = await Employee.findById(id).populate('location').populate('createdBy');
    res.status(200).json(updatedEmployee);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: 'Validation failed', errors });
    } else {
      res.status(500).json({ message: 'Failed to add documents', error: error.message });
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
    console.error('Get settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export { getEmployees, getSettings, getEmployeeById, addEmployee, editEmployee, updateEmployeeAdvance, deactivateEmployee, transferEmployee, rejoinEmployee, getEmployeeHistory, addEmployeeDocuments, checkEmployeeExists };