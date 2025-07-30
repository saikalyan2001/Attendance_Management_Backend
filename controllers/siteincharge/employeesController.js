import mongoose from 'mongoose';
import Employee from '../../models/Employee.js';
import Settings from '../../models/Settings.js';
import Attendance from '../../models/Attendance.js';
import Location from '../../models/Location.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Utility function to normalize user location IDs to strings
function getUserLocationIds(user) {
  return user.locations.map(loc =>
    typeof loc === 'object' && loc._id ? loc._id.toString() : loc.toString()
  );
}

// Utility function to normalize a location value to string
function normalizeLocationId(location) {
  return typeof location === 'object' && location._id ? location._id.toString() : location.toString();
}

export const getSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
      });
    }
    res.json(settings);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const registerEmployee = async (req, res) => {
  try {
    const { employeeId, name, email, designation, department, salary, location, phone, dob, joinDate, bankDetails } = req.body;

    const userLocationIds = getUserLocationIds(req.user);
    const requestedLocationId = normalizeLocationId(location);

    console.log('registerEmployee:', {
      user: req.user.email,
      location: requestedLocationId,
      userLocations: userLocationIds
    });

    if (!employeeId || !name || !email || !designation || !department || !salary || !location || !joinDate || !bankDetails) {
      return res.status(400).json({ message: 'All fields except documents, phone, and DOB are required' });
    }

    const parsedBankDetails = typeof bankDetails === 'string' ? JSON.parse(bankDetails) : bankDetails;
    const { accountNo, ifscCode, bankName, accountHolder } = parsedBankDetails;

    if (!accountNo || !ifscCode || !bankName || !accountHolder) {
      return res.status(400).json({ message: 'All bank details fields are required' });
    }

    if (!mongoose.isValidObjectId(requestedLocationId)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    if (!userLocationIds.includes(requestedLocationId)) {
      console.log('Location validation failed:', {
        userLocations: userLocationIds,
        requestedLocation: requestedLocationId
      });
      return res.status(403).json({ message: 'Location not assigned to user' });
    }

    if (isNaN(salary) || parseFloat(salary) <= 0) {
      return res.status(400).json({ message: 'Salary must be a positive number' });
    }

    if (phone && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ message: 'Phone number must be 10 digits' });
    }

    if (dob && isNaN(new Date(dob))) {
      return res.status(400).json({ message: 'Invalid date of birth' });
    }

    if (isNaN(new Date(joinDate))) {
      return res.status(400).json({ message: 'Invalid join date' });
    }

    const existingEmployee = await Employee.findOne({
      $or: [{ employeeId }, { email }],
    });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Employee ID or email already exists' });
    }

    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
      });
    }

    const employeeData = {
      employeeId,
      name,
      email,
      designation,
      department,
      salary: parseFloat(salary),
      location: requestedLocationId,
      paidLeaves: {
        available: settings.paidLeavesPerMonth,
        used: 0,
        carriedForward: 0,
      },
      documents: [],
      phone: phone || null,
      dob: dob ? new Date(dob) : null,
      joinDate: new Date(joinDate),
      bankDetails: {
        accountNo,
        ifscCode,
        bankName,
        accountHolder,
      },
      createdBy: req.user._id,
    };

    if (req.files && req.files.length > 0) {
      const uploadDir = path.join(__dirname, '..', '..', 'Uploads');
      await fs.mkdir(uploadDir, { recursive: true });

      for (const file of req.files) {
        const filePath = `/Uploads/${file.filename}`;
        employeeData.documents.push({
          name: file.originalname,
          path: filePath,
          uploadedAt: new Date(),
          size: file.size, // Store file size in bytes
        });
      }
    }

    const employee = new Employee(employeeData);
    await employee.save();

    const populatedEmployee = await Employee.findById(employee._id)
      .populate('location', 'name address')
      .lean();
    res.status(201).json(populatedEmployee);
  } catch (error) {
    console.error('Register employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getEmployees = async (req, res) => {
  try {
    const { location, status } = req.query; // Added status query parameter
    const userLocationIds = getUserLocationIds(req.user);
    const requestedLocationId = normalizeLocationId(location);
    
    if (!location || !mongoose.isValidObjectId(requestedLocationId)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

    if (!userLocationIds.includes(requestedLocationId)) {
      return res.status(403).json({ message: 'Location not assigned to user' });
    }

    // Build the query object
    const query = { location: requestedLocationId };
    if (status && ['active', 'inactive'].includes(status)) {
      query.status = status;
    }

    const employees = await Employee.find(query)
      .populate('location', 'name address')
      .lean();
    res.json({ employees });
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    res.json({ employee });
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getEmployeeAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    if (isNaN(monthNum) || isNaN(yearNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: 'Invalid month or year' });
    }

    const employee = await Employee.findById(id).lean();
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    // MongoDB stores dates in UTC, so we need to query the date range for the specified month
    const startDate = new Date(yearNum, monthNum - 1, 1); // First day of the month
    const endDate = new Date(yearNum, monthNum, 1); // First day of the next month

    const attendance = await Attendance.find({
      employee: id,
      date: {
        $gte: startDate,
        $lt: endDate,
      },
    }).lean();

    res.json(attendance);
  } catch (error) {
    console.error('Get employee attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const transferEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { location, transferTimestamp } = req.body; // Extract transferTimestamp from request body

    // Validate request body
    if (!location) {
      return res.status(400).json({ message: 'Location is required' });
    }

    // Validate location is a valid ObjectID
    if (!mongoose.Types.ObjectId.isValid(location)) {
      return res.status(400).json({ message: 'Invalid location ID format' });
    }

    // Validate the employee exists
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Validate the location exists
    const newLocation = await Location.findById(location);
    if (!newLocation) {
      return res.status(400).json({ message: 'Location does not exist' });
    }

    // Check if the employee is active
    if (employee.status !== 'active') {
      return res.status(400).json({ message: 'Cannot transfer an inactive employee' });
    }

    // Check if the siteincharge user has access to the employee's current location
    const siteInchargeLocations = req.user.locations.map(loc => loc._id.toString());
    if (!siteInchargeLocations.includes(employee.location.toString())) {
      return res.status(403).json({ message: 'You do not have access to this employee’s location' });
    }

    // Store the current location before updating
    const previousLocation = employee.location;

    // Update the employee's location and transferTimestamp
    employee.location = location;
    employee.transferTimestamp = transferTimestamp ? new Date(transferTimestamp) : new Date(); // Use provided timestamp or current time
    employee.updatedAt = Date.now();

    // Add to transferHistory
    employee.transferHistory.push({
      fromLocation: previousLocation,
      toLocation: location,
      transferDate: employee.transferTimestamp,
    });

    await employee.save();

    // Temporarily comment out the EmployeeHistory.create call to isolate the issue
    /*
    await EmployeeHistory.create({
      employee: id,
      action: 'transfer',
      details: { from: employee.location, to: location },
      performedBy: req.user._id,
    });
    */

    // Populate the location for the response
    await employee.populate('location');
    res.status(200).json(employee);
  } catch (error) {
    console.error('Transfer employee error:', error.message);
    res.status(500).json({ message: 'Server error' });
  }
};

export const uploadDocument = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No documents uploaded' });
    }

    const uploadDir = path.join(__dirname, '..', '..', 'Uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    for (const file of req.files) {
      const filePath = `/Uploads/${file.filename}`;
      employee.documents.push({
        name: file.originalname,
        path: filePath,
        uploadedAt: new Date(),
        size: file.size,
      });
    }

    await employee.save();

    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Upload document error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    for (const doc of employee.documents) {
      const filePath = path.join(__dirname, '..', '..', doc.path);
      await fs.unlink(filePath).catch((err) => {
        console.error(`Failed to delete file ${filePath}:`, err);
      });
    }

    await Attendance.deleteMany({ employee: id });
    await Employee.findByIdAndDelete(id);

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deactivateEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    if (employee.status === 'inactive') {
      return res.status(400).json({ message: 'Employee is already inactive' });
    }

    // Update the employee's status
    employee.status = 'inactive';

    // Update employmentHistory: close the current period and add a new one
    const currentPeriod = employee.employmentHistory[employee.employmentHistory.length - 1];
    if (currentPeriod && !currentPeriod.endDate) {
      currentPeriod.endDate = new Date();
      currentPeriod.status = 'inactive';
      currentPeriod.leaveBalanceAtEnd = employee.paidLeaves.available;
    }

    employee.employmentHistory.push({
      startDate: new Date(),
      status: 'inactive',
    });

    await employee.save();

    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Deactivate employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const rejoinEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejoinDate } = req.body;

    // Validate employee ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    // Validate rejoinDate
    if (!rejoinDate || isNaN(new Date(rejoinDate))) {
      return res.status(400).json({ message: 'Invalid rejoin date' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check if the employee belongs to the site incharge's location
    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    // Check if the employee is already active
    if (employee.status === 'active') {
      return res.status(400).json({ message: 'Employee is already active' });
    }

    // Update the employee's status to active
    employee.status = 'active';

    // Update employmentHistory: close the current period and add a new one
    const currentPeriod = employee.employmentHistory[employee.employmentHistory.length - 1];
    if (currentPeriod && !currentPeriod.endDate) {
      currentPeriod.endDate = new Date(rejoinDate);
      currentPeriod.status = 'active';
      currentPeriod.leaveBalanceAtEnd = employee.paidLeaves.available;
    }

    employee.employmentHistory.push({
      startDate: new Date(rejoinDate),
      status: 'active',
    });

    // Optionally reset leave balances or carry forward leaves
    // For simplicity, we'll carry forward the existing leave balance
    // You can adjust this logic based on your requirements
    employee.paidLeaves.carriedForward = employee.paidLeaves.available;
    employee.paidLeaves.used = 0;

    await employee.save();

    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Rejoin employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const userLocationIds = getUserLocationIds(req.user);
    const locations = await Location.find({ _id: { $in: userLocationIds } })
      .select('name address')
      .lean();
    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getEmployeeHistory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id)
      .populate('location', 'name address')
      .populate('transferHistory.fromLocation', 'name address') // Populate fromLocation
      .populate('transferHistory.toLocation', 'name address') // Populate toLocation
      .lean();

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    // Return only the history data
    res.json({
      transferHistory: employee.transferHistory || [],
      employmentHistory: employee.employmentHistory || [],
    });
  } catch (error) {
    console.error('Get employee history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


export const updateEmployeeAdvance = async (req, res) => {
  try {
    const { id } = req.params;
    const { advance } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (advance === undefined || advance === null || isNaN(advance) || parseFloat(advance) < 0) {
      return res.status(400).json({ message: 'Advance must be a non-negative number' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    employee.advance = parseFloat(advance);

    employee.advanceHistory.push({
      amount: parseFloat(advance),
      updatedAt: new Date(),
      updatedBy: req.user._id,
    });

    await employee.save();

    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Update employee advance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};



export const editEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, designation, department, salary, phone, dob, status, bankDetails, paidLeaves } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (!name || !email || !designation || !department || !salary) {
      return res.status(400).json({ message: 'All fields except phone, DOB, status, bank details, and paid leaves are required' });
    }

    if (isNaN(salary) || parseFloat(salary) <= 0) {
      return res.status(400).json({ message: 'Salary must be a positive number' });
    }

    if (phone && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ message: 'Phone number must be 10 digits' });
    }

    if (dob && isNaN(new Date(dob))) {
      return res.status(400).json({ message: 'Invalid date of birth' });
    }

    if (status && !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ message: 'Status must be either "active" or "inactive"' });
    }

    // Validate bankDetails if provided
    if (bankDetails) {
      const { accountNo, ifscCode, bankName, accountHolder } = bankDetails;
      const hasAnyBankDetail = accountNo || ifscCode || bankName || accountHolder;
      if (hasAnyBankDetail && !(accountNo && ifscCode && bankName && accountHolder)) {
        return res.status(400).json({ message: 'All bank details fields are required if any bank detail is provided' });
      }
    }

    // Validate paidLeaves if provided
    if (paidLeaves) {
      const { available, used, carriedForward } = paidLeaves;
      const hasAnyLeaveDetail = available !== undefined || used !== undefined || carriedForward !== undefined;
      if (hasAnyLeaveDetail) {
        if (available === undefined || used === undefined || carriedForward === undefined) {
          return res.status(400).json({ message: 'All paid leave fields (available, used, carriedForward) are required if any is provided' });
        }
        if (isNaN(available) || parseFloat(available) < 0) {
          return res.status(400).json({ message: 'Available leaves must be a non-negative number' });
        }
        if (isNaN(used) || parseFloat(used) < 0) {
          return res.status(400).json({ message: 'Used leaves must be a non-negative number' });
        }
        if (isNaN(carriedForward) || parseFloat(carriedForward) < 0) {
          return res.status(400).json({ message: 'Carried forward leaves must be a non-negative number' });
        }
        if (parseFloat(available) < parseFloat(used)) {
          return res.status(400).json({ message: 'Available leaves cannot be less than used leaves' });
        }
      }
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    const existingEmployee = await Employee.findOne({
      $or: [{ email }],
      _id: { $ne: id },
    });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Update fields
    employee.name = name;
    employee.email = email;
    employee.designation = designation;
    employee.department = department;
    employee.salary = parseFloat(salary);
    employee.phone = phone || null;
    employee.dob = dob ? new Date(dob) : null;

    // Update bankDetails if provided
    if (bankDetails) {
      employee.bankDetails = {
        accountNo: bankDetails.accountNo,
        ifscCode: bankDetails.ifscCode,
        bankName: bankDetails.bankName,
        accountHolder: bankDetails.accountHolder,
      };
    }

    // Update paidLeaves if provided
    if (paidLeaves) {
      employee.paidLeaves = {
        available: parseFloat(paidLeaves.available),
        used: parseFloat(paidLeaves.used),
        carriedForward: parseFloat(paidLeaves.carriedForward),
      };
    }

    if (status) {
      employee.status = status;
      const currentPeriod = employee.employmentHistory[employee.employmentHistory.length - 1];
      if (currentPeriod && !currentPeriod.endDate) {
        currentPeriod.endDate = new Date();
        currentPeriod.status = status;
        currentPeriod.leaveBalanceAtEnd = employee.paidLeaves.available;
      }
      employee.employmentHistory.push({
        startDate: new Date(),
        status: status,
      });
    }

    await employee.save();

    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Edit employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

