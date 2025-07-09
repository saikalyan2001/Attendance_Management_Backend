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

// Utility function to calculate prorated leaves
const calculateProratedLeaves = (joinDate, paidLeavesPerYear) => {
  const join = new Date(joinDate);
  const joinYear = join.getFullYear();
  const joinMonth = join.getMonth(); // 0-based
  const currentYear = new Date().getFullYear();
  if (joinYear === currentYear) {
    const remainingMonths = 12 - joinMonth;
    return Math.round((paidLeavesPerYear * remainingMonths) / 12);
  }
  return paidLeavesPerYear;
};

export const rejoinEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejoinDate } = req.body;

    // Validate employee ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    // Validate rejoin date
    if (!rejoinDate || isNaN(new Date(rejoinDate))) {
      return res.status(400).json({ message: 'Invalid rejoin date' });
    }

    // Fetch employee
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check location permissions
    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);
    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    // Check if employee is already active
    if (employee.status === 'active') {
      return res.status(400).json({ message: 'Employee is already active' });
    }

    // Validate rejoin date against last endDate
    const latestEmployment = employee.employmentHistory[employee.employmentHistory.length - 1];
    if (latestEmployment.endDate && new Date(rejoinDate) <= new Date(latestEmployment.endDate)) {
      return res.status(400).json({ message: 'Rejoin date must be after the last end date' });
    }

    // Fetch settings with fallback
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24,
        halfDayDeduction: 0.5,
      });
    }

    // Calculate prorated leaves
    const proratedLeaves = calculateProratedLeaves(rejoinDate, settings.paidLeavesPerYear);

    // Update employee status and employment history
    employee.status = 'active';
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

    // Update paidLeaves with prorated value
    employee.paidLeaves = {
      available: proratedLeaves,
      used: 0,
      carriedForward: 0,
    };

    // Update monthlyLeaves for the rejoin month
    const joinYear = new Date(rejoinDate).getFullYear();
    const joinMonth = new Date(rejoinDate).getMonth() + 1;
    const monthlyAllocation = settings.paidLeavesPerYear / 12;
    employee.monthlyLeaves.push({
      year: joinYear,
      month: joinMonth,
      allocated: monthlyAllocation,
      taken: 0,
      carriedForward: 0,
      available: monthlyAllocation,
    });

    // Reset transferTimestamp
    employee.transferTimestamp = null;

    // Save employee
    await employee.save();

    // Populate and return updated employee
    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    ('Rejoin employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


export const getEmployees = async (req, res) => {
  try {
    const { location, status, month, year } = req.query;
    const userLocationIds = getUserLocationIds(req.user);
    const requestedLocationId = normalizeLocationId(location);

    if (!location || !mongoose.isValidObjectId(requestedLocationId)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

    if (!userLocationIds.includes(requestedLocationId)) {
      return res.status(403).json({ message: 'Location not assigned to user' });
    }

    const query = { location: requestedLocationId };
    if (status && ['active', 'inactive'].includes(status)) {
      query.status = status;
    }

    const employees = await Employee.find(query)
      .select('employeeId name email designation department salary location paidLeaves monthlyLeaves documents phone dob joinDate bankDetails status transferTimestamp advances advanceHistory')
      .populate('location', 'name address')
      .lean();

    (`getEmployees query: ${JSON.stringify(query)}`);
    (`Found ${employees.length} employees`);

    let filteredEmployees = employees;
    if (month && year) {
      const parsedMonth = parseInt(month);
      const parsedYear = parseInt(year);
      if (isNaN(parsedMonth) || isNaN(parsedYear) || parsedMonth < 1 || parsedMonth > 12) {
        return res.status(400).json({ message: 'Invalid month or year' });
      }
      filteredEmployees = employees.map((emp) => ({
        ...emp,
        monthlyLeaves: (emp.monthlyLeaves || []).filter(
          (ml) => ml.year === parsedYear && ml.month === parsedMonth
        ),
      }));
    }

    ('Returning employees:', filteredEmployees.map(e => ({
      _id: e._id,
      employeeId: e.employeeId,
      name: e.name,
      monthlyLeaves: e.monthlyLeaves,
    })));
    res.set('Cache-Control', req.headers['cache-control'] || 'no-cache');
    res.json({ employees: filteredEmployees });
  } catch (error) {
    ('Get employees error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id)
      .select('employeeId name email designation department salary location paidLeaves monthlyLeaves documents phone dob joinDate bankDetails status transferTimestamp advances advanceHistory')
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

    let filteredEmployee = employee;
    if (month && year) {
      const parsedMonth = parseInt(month);
      const parsedYear = parseInt(year);
      if (isNaN(parsedMonth) || isNaN(parsedYear) || parsedMonth < 1 || parsedMonth > 12) {
        return res.status(400).json({ message: 'Invalid month or year' });
      }
      filteredEmployee = {
        ...employee,
        monthlyLeaves: (employee.monthlyLeaves || []).filter(
          (ml) => ml.year === parsedYear && ml.month === parsedMonth
        ),
      };
    }

    ('Returning employee:', {
      _id: filteredEmployee._id,
      employeeId: filteredEmployee.employeeId,
      name: filteredEmployee.name,
      monthlyLeaves: filteredEmployee.monthlyLeaves,
    });
    res.set('Cache-Control', req.headers['cache-control'] || 'no-cache');
    res.json({ employee: filteredEmployee });
  } catch (error) {
    ('Get employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ... Other endpoints remain unchanged from your original code ...
export const registerEmployee = async (req, res) => {
  try {
    const { employeeId, name, email, designation, department, salary, location, phone, dob, joinDate, bankDetails } = req.body;
    const userLocationIds = getUserLocationIds(req.user);
    const requestedLocationId = normalizeLocationId(location);

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
        paidLeavesPerYear: 24,
        halfDayDeduction: 0.5,
      });
    }

    const joinDateObj = new Date(joinDate);
    const paidLeavesPerMonth = settings.paidLeavesPerYear / 12;

    const employeeData = {
      employeeId,
      name,
      email,
      designation,
      department,
      salary: parseFloat(salary),
      location: requestedLocationId,
      paidLeaves: {
        available: settings.paidLeavesPerYear,
        used: 0,
        carriedForward: 0,
      },
      documents: [],
      phone: phone || null,
      dob: dob ? new Date(dob) : null,
      joinDate: joinDateObj,
      bankDetails: {
        accountNo,
        ifscCode,
        bankName,
        accountHolder,
      },
      createdBy: req.user._id,
      advances: [],
      advanceHistory: [],
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
          size: file.size,
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
    ('Register employee error:', error);
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

    if (bankDetails) {
      const { accountNo, ifscCode, bankName, accountHolder } = bankDetails;
      const hasAnyBankDetail = accountNo || ifscCode || bankName || accountHolder;
      if (hasAnyBankDetail && !(accountNo && ifscCode && bankName && accountHolder)) {
        return res.status(400).json({ message: 'All bank details fields are required if any bank detail is provided' });
      }
    }

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

    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24,
        halfDayDeduction: 0.5,
      });
    }
    const paidLeavesPerMonth = settings.paidLeavesPerYear / 12;

    employee.name = name;
    employee.email = email;
    employee.designation = designation;
    employee.department = department;
    employee.salary = parseFloat(salary);
    employee.phone = phone || null;
    employee.dob = dob ? new Date(dob) : null;

    if (bankDetails) {
      employee.bankDetails = {
        accountNo: bankDetails.accountNo,
        ifscCode: bankDetails.ifscCode,
        bankName: bankDetails.bankName,
        accountHolder: bankDetails.accountHolder,
      };
    }

    if (paidLeaves) {
      employee.paidLeaves = {
        available: parseFloat(paidLeaves.available),
        used: parseFloat(paidLeaves.used),
        carriedForward: parseFloat(paidLeaves.carriedForward),
      };
      // Ensure monthlyLeaves is consistent with paidLeaves
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      let monthlyLeave = employee.monthlyLeaves.find(
        (ml) => ml.year === currentYear && ml.month === currentMonth
      );
      if (!monthlyLeave) {
        monthlyLeave = {
          month: currentMonth,
          year: currentYear,
          allocated: paidLeavesPerMonth,
          taken: 0,
          carriedForward: 0,
          available: paidLeavesPerMonth,
        };
        employee.monthlyLeaves.push(monthlyLeave);
      }
      monthlyLeave.available = paidLeaves.available / 12; // Sync with paidLeaves.available
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
    ('Edit employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24,
        halfDayDeduction: 0.5,
      });
    }
    res.json(settings);
  } catch (error) {
    ('Get settings error:', error);
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

    const startDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
    const endDate = new Date(Date.UTC(yearNum, monthNum, 1));

    const attendance = await Attendance.find({
      employee: id,
      date: { $gte: startDate, $lt: endDate },
      isDeleted: false,
    })
      .sort({ date: -1, updatedAt: -1 })
      .lean();

    res.json({ attendance });
  } catch (error) {
    ('Get employee attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const transferEmployee = async (req, res) => {
   try {
    const { id } = req.params;
    const { location, transferTimestamp } = req.body;

    if (!location) {
      return res.status(400).json({ message: 'Location is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(location)) {
      return res.status(400).json({ message: 'Invalid location ID format' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const newLocation = await Location.findById(location);
    if (!newLocation) {
      return res.status(400).json({ message: 'Location does not exist' });
    }

    if (employee.status !== 'active') {
      return res.status(400).json({ message: 'Cannot transfer an inactive employee' });
    }

    const siteInchargeLocations = req.user.locations.map(loc => loc._id.toString());
    if (!siteInchargeLocations.includes(employee.location.toString())) {
      return res.status(403).json({ message: 'You do not have access to this employee’s location' });
    }

    const previousLocation = employee.location;

    employee.location = location;
    employee.transferTimestamp = transferTimestamp ? new Date(transferTimestamp) : new Date();
    employee.updatedAt = Date.now();

    employee.transferHistory.push({
      fromLocation: previousLocation,
      toLocation: location,
      transferDate: employee.transferTimestamp,
    });

    await employee.save();

    await employee.populate('location');
    res.status(200).json(employee);
  } catch (error) {
    ('Transfer employee error:', error.message);
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
    ('Upload document error:', error);
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
        (`Failed to delete file ${filePath}:`, err);
      });
    }

    await Attendance.deleteMany({ employee: id });
    await Employee.findByIdAndDelete(id);

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    ('Delete employee error:', error);
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

    employee.status = 'inactive';

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
    ('Deactivate employee error:', error);
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
    ('Get locations error:', error);
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
      .populate('transferHistory.fromLocation', 'name address')
      .populate('transferHistory.toLocation', 'name address')
      .lean();

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userLocationIds = getUserLocationIds(req.user);
    const employeeLocationId = normalizeLocationId(employee.location);

    if (!userLocationIds.includes(employeeLocationId)) {
      return res.status(403).json({ message: 'Employee not in assigned location' });
    }

    res.json({
      transferHistory: employee.transferHistory || [],
      employmentHistory: employee.employmentHistory || [],
    });
  } catch (error) {
    ('Get employee history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateEmployeeAdvance = async (req, res) => {
  try {
    const { id } = req.params;
    const { advance, year, month } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (advance === undefined || advance === null || isNaN(advance) || parseFloat(advance) < 0) {
      return res.status(400).json({ message: 'Advance must be a non-negative number' });
    }

    if (!year || isNaN(year) || year < 2000 || year > new Date().getFullYear() + 1) {
      return res.status(400).json({ message: 'Valid year is required' });
    }

    if (!month || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ message: 'Valid month (1-12) is required' });
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

    const parsedAdvance = parseFloat(advance);
    const parsedYear = parseInt(year);
    const parsedMonth = parseInt(month);

    const advanceIndex = employee.advances.findIndex(
      (adv) => adv.year === parsedYear && adv.month === parsedMonth
    );

    const advanceEntry = {
      year: parsedYear,
      month: parsedMonth,
      amount: parsedAdvance,
      updatedAt: new Date(),
      updatedBy: req.user._id,
    };

    if (advanceIndex !== -1) {
      employee.advances[advanceIndex] = advanceEntry;
    } else {
      employee.advances.push(advanceEntry);
    }

    employee.advanceHistory.push({
      year: parsedYear,
      month: parsedMonth,
      amount: parsedAdvance,
      updatedAt: new Date(),
      updatedBy: req.user._id,
    });

    employee.advance = 0;

    await employee.save();

    const populatedEmployee = await Employee.findById(id)
      .populate('location', 'name address')
      .lean();
    res.json(populatedEmployee);
  } catch (error) {
    ('Update employee advance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};