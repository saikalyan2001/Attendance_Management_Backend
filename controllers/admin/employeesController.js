  import Employee from '../../models/Employee.js';
  import asyncHandler from 'express-async-handler';
  import mongoose from 'mongoose';
  import Settings from '../../models/Settings.js';
  import path from 'path';

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

    ('Updating advance for employee ID:', id, 'with advance:', advance, 'year:', year, 'month:', month);

    // Validate inputs
    if (!mongoose.Types.ObjectId.isValid(id)) {
      ('Invalid employee ID:', id);
      res.status(400);
      throw new Error('Invalid employee ID');
    }
    if (advance === undefined || year === undefined || month === undefined) {
      ('Missing required fields:', { advance, year, month });
      res.status(400);
      throw new Error('Advance, year, and month are required');
    }
    const parsedAdvance = Number(advance);
    if (isNaN(parsedAdvance) || parsedAdvance < 0) {
      ('Invalid advance amount:', advance);
      res.status(400);
      throw new Error('Advance must be a non-negative number');
    }
    const parsedYear = Number(year);
    const parsedMonth = Number(month);
    if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
      ('Invalid year or month:', { year, month });
      res.status(400);
      throw new Error('Invalid year or month');
    }
    if (!req.user || !req.user._id) {
      ('No authenticated user found:', req.user);
      res.status(401);
      throw new Error('Unauthorized: No user authenticated');
    }

    // Fetch employee
    const employee = await Employee.findById(id);
    if (!employee) {
      ('Employee not found for ID:', id);
      res.status(404);
      throw new Error('Employee not found');
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
      ('Saving employee ID:', id);
      await employee.save();
      ('Employee saved successfully');

      let populatedEmployee;
      try {
        populatedEmployee = await Employee.findById(id)
          .populate('location', 'name')
          .populate('createdBy', 'name');
      } catch (populateError) {
        ('Population error:', populateError.message);
        populatedEmployee = await Employee.findById(id);
      }

      res.status(200).json(populatedEmployee);
    } catch (error) {
      ('Error updating employee advance:', error.message);
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

 // @desc    Get all employees with pagination
// @route   GET /api/admin/employees?page=<page>&limit=<limit>
// @access  Private/Admin
const getEmployees = asyncHandler(async (req, res) => {
  ('employees getting', { queryParams: req.query });
  const { location, status, month, year, page = 1, limit = 10 } = req.query;
  let query = {};
  if (location && mongoose.Types.ObjectId.isValid(location)) {
    query.location = new mongoose.Types.ObjectId(location);
  } else if (location) {
    console.warn('Invalid location ID:', location);
  }
  if (status) query.status = status;
  ('getEmployees query:', query);

  // Parse pagination parameters
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  if (isNaN(parsedPage) || parsedPage < 1) {
    res.status(400);
    throw new Error('Invalid page number');
  }
  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    res.status(400);
    throw new Error('Invalid limit value (must be between 1 and 100)');
  }

  // Calculate skip value for pagination
  const skip = (parsedPage - 1) * parsedLimit;

  // Count total employees matching the query
  const totalEmployees = await Employee.countDocuments(query);
  ('Total employees matching query:', totalEmployees);

  const pipeline = [
    { $match: query },
    {
      $lookup: {
        from: 'locations',
        localField: 'location',
        foreignField: '_id',
        as: 'location',
      },
    },
    { $unwind: { path: '$location', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'createdBy',
        foreignField: '_id',
        as: 'createdBy',
      },
    },
    { $unwind: { path: '$createdBy', preserveNullAndEmptyArrays: true } },
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
        monthlyLeaves: {
          $filter: {
            input: '$monthlyLeaves',
            as: 'leave',
            cond: {
              $and: [
                { $eq: ['$$leave.month', parseInt(month)] },
                { $eq: ['$$leave.year', parseInt(year)] },
              ],
            },
          },
        },
      },
    },
    { $sort: { employeeId: 1 } }, // Default sorting by employeeId
    { $skip: skip },
    { $limit: parsedLimit },
  ];

  const employees = await Employee.aggregate(pipeline);
  ('Aggregation result:', employees.length, 'employees found');

  // Calculate pagination metadata
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
      path: `/Uploads/${file.filename}`, // Use subfolder for documents
      uploadedAt: new Date(),
      size: file.size,
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

    ('Editing employee with ID:', id);
    ('Request body:', req.body);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      ('Invalid employee ID:', id);
      res.status(400);
      throw new Error('Invalid employee ID');
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      ('Employee not found for ID:', id);
      res.status(404);
      throw new Error('Employee not found');
    }

    if (!name || !email || !designation || !department || !salary) {
      ('Missing required fields:', { name, email, designation, department, salary });
      res.status(400);
      throw new Error('Name, email, designation, department, and salary are required');
    }

    if (typeof name !== 'string' || name.length < 3 || name.length > 50) {
      ('Validation failed for name:', name);
      res.status(400);
      throw new Error('Name must be a string between 3 and 50 characters');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      ('Validation failed for email format:', email);
      res.status(400);
      throw new Error('Invalid email address');
    }

    if (typeof designation !== 'string' || designation.length < 2 || designation.length > 50) {
      ('Validation failed for designation:', designation);
      res.status(400);
      throw new Error('Designation must be a string between 2 and 50 characters');
    }

    if (typeof department !== 'string' || department.length < 2 || department.length > 50) {
      ('Validation failed for department:', department);
      res.status(400);
      throw new Error('Department must be a string between 2 and 50 characters');
    }

    const parsedSalary = Number(salary);
    if (isNaN(parsedSalary) || parsedSalary < 1000) {
      ('Validation failed for salary:', salary);
      res.status(400);
      throw new Error('Salary must be a number greater than or equal to 1000');
    }

    if (phone && !/^\d{10}$/.test(phone)) {
      ('Validation failed for phone:', phone);
      res.status(400);
      throw new Error('Phone number must be 10 digits');
    }

    if (dob) {
      const parsedDob = new Date(dob);
      if (isNaN(parsedDob.getTime())) {
        ('Validation failed for dob:', dob);
        res.status(400);
      }
    }

    if (location && !mongoose.Types.ObjectId.isValid(location)) {
      ('Validation failed for location:', location);
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
        ('Validation failed for paidLeaves:', paidLeaves);
        res.status(400);
        throw new Error('paidLeaves fields (available, used, carriedForward) must be non-negative numbers');
      }
      if (available > proratedLeaves) {
        (`Available leaves (${available}) exceeds prorated limit (${proratedLeaves})`);
        res.status(400);
        throw new Error(`Available leaves cannot exceed prorated limit of ${proratedLeaves}`);
      }
    }

    if (bankDetails) {
      const { accountNo, ifscCode, bankName, accountHolder } = bankDetails;
      const hasAnyBankDetail = accountNo || ifscCode || bankName || accountHolder;
      if (hasAnyBankDetail && !(accountNo && ifscCode && bankName && accountHolder)) {
        ('Validation failed for bankDetails:', bankDetails);
        res.status(400);
        throw new Error('All bank details fields are required if any bank detail is provided');
      }
    }

    // Check for duplicate email
    if (email) {
      ('Checking for duplicate email:', email);
      const existingEmployee = await Employee.findOne({ 
        email: email.toLowerCase(), 
        _id: { $ne: id } 
      });
      if (existingEmployee) {
        ('Duplicate email found:', email);
        return res.status(400).json({ message: 'Email already exists' });
      } else {
        ('No duplicate email found for:', email);
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

      ('Saving employee...');
      await employee.save();
      ('Employee saved successfully');

      let updatedEmployee;
      try {
        updatedEmployee = await Employee.findById(id).populate('location').populate('createdBy');
      } catch (populateError) {
        ('Error during populate:', populateError);
        updatedEmployee = await Employee.findById(id);
      }
      res.status(200).json(updatedEmployee);
    } catch (error) {
      ('Error during employee update:', error);
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
        ('Unhandled error during employee update:', error);
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
      path: `/Uploads/${file.filename}`, // Use subfolder for documents
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
      ('Get settings error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });


  // @desc    Get count of active employees
// @route   GET /api/admin/employees/count
// @access  Private/Admin
const getEmployeeCount = asyncHandler(async (req, res) => {
  try {
    const count = await Employee.countDocuments({ status: 'active', isDeleted: false });
    res.status(200).json({ count });
  } catch (error) {
    ('Get employee count error:', error);
    res.status(500).json({ message: 'Server error fetching employee count' });
  }
});

// Update the export statement to include getEmployeeCount
export { getEmployees, getSettings, getEmployeeById, addEmployee, editEmployee, updateEmployeeAdvance, deactivateEmployee, transferEmployee, rejoinEmployee, getEmployeeHistory, addEmployeeDocuments, checkEmployeeExists, getEmployeeCount };

  