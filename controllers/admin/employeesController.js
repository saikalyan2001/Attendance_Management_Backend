import Employee from '../../models/Employee.js';
import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Settings from '../../models/Settings.js';

// @desc    Get all employees
// @route   GET /api/admin/employees
// @access  Private/Admin
const getEmployees = asyncHandler(async (req, res) => {
  const { location, status } = req.query;
  const query = {};
  if (location) query.location = location;
  if (status) query.status = status; // Filter by status if provided
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
    paidLeaves,
    createdBy,
  } = req.body;

  const files = req.files;

  if (!employeeId || !name || !email || !designation || !department || !salary || !location || !joinDate || !bankDetails || !paidLeaves || !createdBy) {
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

  let parsedBankDetails, parsedPaidLeaves;
  try {
    parsedBankDetails = JSON.parse(bankDetails);
    parsedPaidLeaves = JSON.parse(paidLeaves);
  } catch (error) {
    res.status(400);
    throw new Error('Invalid bankDetails or paidLeaves format');
  }

  if (!parsedBankDetails.accountNo || !parsedBankDetails.ifscCode || !parsedBankDetails.bankName || !parsedBankDetails.accountHolder) {
    res.status(400);
    throw new Error('All bank details fields are required');
  }

  const documents = files.map((file) => ({
    name: file.originalname,
    path: file.path,
    uploadedAt: new Date(),
    size: file.size,
  }));

  const employee = new Employee({
    employeeId,
    name,
    email,
    designation,
    department,
    salary: Number(salary),
    location,
    phone,
    joinDate,
    bankDetails: parsedBankDetails,
    paidLeaves: parsedPaidLeaves,
    documents,
    createdBy,
  });

  try {
    const createdEmployee = await employee.save();
    const populatedEmployee = await Employee.findById(createdEmployee._id).populate('location').populate('createdBy');
    res.status(201).json(populatedEmployee);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
      }));
      res.status(400).json({ message: 'Validation failed', errors });
    } else if (error.code === 11000) {
      res.status(400).json({ message: 'Employee ID or email already exists' });
    } else {
      res.status(500).json({ message: 'Failed to create employee', error: error.message });
    }
  }
});

// @desc    Update an employee
// @route   PUT /api/admin/employees/:id
// @access  Private/Admin

const editEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Destructure req.body, explicitly excluding employeeId to prevent it from being updated
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

  // Check for duplicate email (simplified, no regex)
  if (email) {
    console.log('Checking for duplicate email:', email);
    const existingEmployee = await Employee.findOne({ 
      email: email, 
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
    // Update employee fields, explicitly excluding employeeId to ensure it remains unchanged
    employee.name = name;
    employee.email = email;
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

  // Add to transfer history
  employee.transferHistory.push({
    fromLocation: employee.location._id,
    toLocation: location,
    transferDate: parsedTransferTimestamp,
  });

  // Update location and transferTimestamp
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

  // Update status and employment history
  employee.status = 'active';
  employee.employmentHistory.push({
    startDate: parsedRejoinDate,
    status: 'active',
  });

  // Reset leave balance
  employee.paidLeaves = {
    available: 0,
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
// @route   GET /api/admin/settings
// @access  Private/Admin
const getSettings = asyncHandler(async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
        highlightDuration: 24 * 60 * 60, // Default to 24 hours in seconds
      });
    }
    res.json(settings);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export { getEmployees, getSettings, getEmployeeById, addEmployee, editEmployee, deactivateEmployee, transferEmployee, rejoinEmployee, getEmployeeHistory, addEmployeeDocuments };