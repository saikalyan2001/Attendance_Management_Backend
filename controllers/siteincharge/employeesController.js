import mongoose from 'mongoose';
import Employee from '../../models/Employee.js';
import Settings from '../../models/Settings.js';
import Attendance from '../../models/Attendance.js';
import Location from '../../models/Location.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { initializeMonthlyLeaves } from '../../utils/leaveUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const getUserLocationIds = (user) => {
  if (!user || !Array.isArray(user.locations)) {
    console.warn('getUserLocationIds: user.locations is not an array or user is undefined', {
      user: user ? user._id : 'undefined',
      locations: user?.locations,
    });
    return [];
  }
  const locationIds = user.locations
    .map((loc) => {
      // Handle both ObjectId and populated Location objects
      if (loc && typeof loc === 'object' && loc._id) {
        return loc._id.toString();
      } else if (mongoose.isValidObjectId(loc)) {
        return loc.toString();
      }
      console.warn('getUserLocationIds: Invalid location entry', { loc });
      return null;
    })
    .filter((id) => id !== null); // Remove invalid entries
  return locationIds;
};

const normalizeLocationId = (location) => {
  return location?._id ? location._id.toString() : location.toString();
};

const calculateProratedLeaves = (joinDate, paidLeavesPerYear = 24) => {
  const join = new Date(joinDate);
  const currentYear = join.getFullYear();
  const currentMonth = join.getMonth();
  const monthsRemaining = 12 - currentMonth;
  return (paidLeavesPerYear / 12) * monthsRemaining;
};

export const getEmployees = async (req, res) => {
  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const { location, status, page = 1, limit = 5, month, year } = req.query;

      // Validate pagination parameters
      const pageNum = parseInt(page, 10);
      const limitNum = Math.min(parseInt(limit, 10), 100);
      if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
        return res.status(400).json({ message: "Invalid pagination parameters" });
      }

      const query = {};
      if (location) query.location = location;
      if (status) query.status = status;

      const skip = (pageNum - 1) * limitNum;

      // Start a session for fetching employees
      const session = await mongoose.startSession();
      try {
        session.startTransaction();

        // Fetch total count and employees without modifying documents
        const total = await Employee.countDocuments(query).session(session);
        const employees = await Employee.find(query)
          .populate("location")
          .sort({ employeeId: 1 })
          .skip(skip)
          .limit(limitNum)
          .session(session)
          .lean();

        await session.commitTransaction();
        session.endSession();

        // Initialize monthlyLeaves for each employee in separate transactions
        const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;
        const targetYear = year ? parseInt(year) : new Date().getFullYear();
        const updatedEmployees = [];

        for (const employee of employees) {
          const empSession = await mongoose.startSession();
          try {
            empSession.startTransaction();
            const emp = await Employee.findById(employee._id).session(empSession);
            if (emp) {
              await initializeMonthlyLeaves(emp, targetYear, targetMonth, empSession);
              updatedEmployees.push({ ...employee, monthlyLeaves: emp.monthlyLeaves });
            } else {
              updatedEmployees.push(employee);
            }
            await empSession.commitTransaction();
          } catch (error) {
            await empSession.abortTransaction();
            throw error;
          } finally {
            empSession.endSession();
          }
        }

        const response = {
          employees: updatedEmployees,
          pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
          },
        };

        res.status(200).json(response);
        return; // Exit on success
      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
      }
    } catch (error) {
      if (error.code === 112 && error.errorLabels?.includes('TransientTransactionError')) {
        retries++;
        console.warn(`WriteConflict in getEmployees, retrying (${retries}/${maxRetries})`);
        if (retries === maxRetries) {
          console.error("Max retries reached for getEmployees:", error);
          return res.status(500).json({ message: "Server error", error: error.message });
        }
        // Exponential backoff: wait 100ms * 2^retries
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, retries)));
        continue;
      }
      console.error("Error fetching employees:", error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }
};

export const getEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year, documentsPage = 1, documentsLimit = 10, advancesPage = 1, advancesLimit = 5 } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    // Validate pagination parameters for documents
    const docPageNum = parseInt(documentsPage, 10);
    const docLimitNum = Math.min(parseInt(documentsLimit, 10), 100);
    if (isNaN(docPageNum) || docPageNum < 1 || isNaN(docLimitNum) || docLimitNum < 1) {
      return res.status(400).json({ message: 'Invalid documents pagination parameters' });
    }

    // Validate pagination parameters for advances
    const advPageNum = parseInt(advancesPage, 10);
    const advLimitNum = Math.min(parseInt(advancesLimit, 10), 100);
    if (isNaN(advPageNum) || advPageNum < 1 || isNaN(advLimitNum) || advLimitNum < 1) {
      return res.status(400).json({ message: 'Invalid advances pagination parameters' });
    }

    // Start a session for initializing monthlyLeaves
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const employee = await Employee.findById(id)
        .select('employeeId name email designation department salary location paidLeaves monthlyLeaves documents phone dob joinDate bankDetails status transferTimestamp advances advanceHistory')
        .populate('location', 'name address')
        .session(session)
        .lean();

      if (!employee) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: 'Employee not found' });
      }

      const userLocationIds = getUserLocationIds(req.user);
      const employeeLocationId = normalizeLocationId(employee.location);

      if (!userLocationIds.includes(employeeLocationId)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ message: 'Employee not in assigned location' });
      }

      // Initialize monthlyLeaves for the current or specified month/year
      const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;
      const targetYear = year ? parseInt(year) : new Date().getFullYear();
      const emp = await Employee.findById(id).session(session);
      if (emp) {
        await initializeMonthlyLeaves(emp, targetYear, targetMonth, session);
        employee.monthlyLeaves = emp.monthlyLeaves;
      }

      let filteredEmployee = { ...employee };

      // Paginate documents
      const documents = employee.documents || [];
      const totalDocuments = documents.length;
      const docSkip = (docPageNum - 1) * docLimitNum;
      const paginatedDocuments = documents.slice(docSkip, docSkip + docLimitNum);
      filteredEmployee.documents = paginatedDocuments;
      filteredEmployee.documentsPagination = {
        total: totalDocuments,
        page: docPageNum,
        limit: docLimitNum,
        totalPages: Math.ceil(totalDocuments / docLimitNum),
      };

      // Paginate advances
      const advances = employee.advances || [];
      const totalAdvances = advances.length;
      const advSkip = (advPageNum - 1) * advLimitNum;
      const paginatedAdvances = advances.slice(advSkip, advSkip + advLimitNum);
      filteredEmployee.advances = paginatedAdvances;
      filteredEmployee.advancesPagination = {
        total: totalAdvances,
        page: advPageNum,
        limit: advLimitNum,
        totalPages: Math.ceil(totalAdvances / advLimitNum),
      };

      // Filter monthlyLeaves if month and year are provided
      if (month && year) {
        const parsedMonth = parseInt(month);
        const parsedYear = parseInt(year);
        if (isNaN(parsedMonth) || isNaN(parsedYear) || parsedMonth < 1 || parsedMonth > 12) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ message: 'Invalid month or year' });
        }
        filteredEmployee.monthlyLeaves = (employee.monthlyLeaves || []).filter(
          (ml) => ml.year === parsedYear && ml.month === parsedMonth
        );
      }

      await session.commitTransaction();

      console.log('Returning employee:', {
        _id: filteredEmployee._id,
        employeeId: filteredEmployee.employeeId,
        name: filteredEmployee.name,
        monthlyLeaves: filteredEmployee.monthlyLeaves,
        documentsCount: filteredEmployee.documents.length,
        documentsPagination: filteredEmployee.documentsPagination,
        advancesCount: filteredEmployee.advances.length,
        advancesPagination: filteredEmployee.advancesPagination,
      });

      res.set('Cache-Control', req.headers['cache-control'] || 'no-cache');
      res.json({ employee: filteredEmployee });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getAttendance = async (req, res) => {
  try {
    const { location, date, status, isDeleted = 'false', page = 1, limit = 5 } = req.query;

    // Validate pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: 'Invalid pagination parameters' });
    }

    // Build query
    const query = {};
    if (location) {
      if (!mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: 'Invalid location ID' });
      }
      query.location = location;
    }
    if (date) {
      const dateStr = date.split('T')[0];
      query.date = {
        $gte: new Date(`${dateStr}T00:00:00+05:30`),
        $lte: new Date(`${dateStr}T23:59:59+05:30`),
      };
    }
    if (status) {
      query.status = { $in: status.split(',') };
    }
    query.isDeleted = isDeleted === 'true';

    // Validate user permissions
    const userLocationIds = getUserLocationIds(req.user);
    if (location && !userLocationIds.includes(location)) {
      return res.status(403).json({ message: 'Location not assigned to user' });
    }

    // Fetch total count for pagination
    const total = await Attendance.countDocuments(query);

    // Fetch paginated attendance records
    const attendance = await Attendance.find(query)
      .populate('employee', 'name employeeId')
      .sort({ date: -1, updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    // Validate attendance records
    const validAttendance = attendance.filter(record => record.status && record.employee && record.date);

    res.json({
      attendance: validAttendance,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Get attendance error:', error);
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
    console.error('Get employee attendance error:', error);
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
    console.error('Get settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

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
    console.error('Register employee error:', error);
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
    console.error('Edit employee error:', error);
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
    console.error('Rejoin employee error:', error);
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
    console.error('Deactivate employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLocations = async (req, res) => {
  try {
    const userLocationIds = getUserLocationIds(req.user);
    
    if (userLocationIds.length === 0) {
      console.warn('getLocations: No valid locations assigned to user', {
        userId: req.user?._id || 'unknown',
        attemptedLocationIds: user?.locations,
      });
      return res.status(200).json([]);
    }

    // Validate ObjectIds before querying
    const validLocationIds = userLocationIds.filter((id) => mongoose.isValidObjectId(id));
    if (validLocationIds.length < userLocationIds.length) {
      console.warn('getLocations: Some location IDs are invalid', {
        userId: req.user?._id || 'unknown',
        invalidIds: userLocationIds.filter((id) => !mongoose.isValidObjectId(id)),
      });
    }

    if (validLocationIds.length === 0) {
      return res.status(200).json([]);
    }

    const locations = await Location.find({ _id: { $in: validLocationIds } })
      .select('name address')
      .lean();

    console.log('Fetched locations:', {
      count: locations.length,
      locationIds: validLocationIds,
      userId: req.user?._id || 'unknown',
    });

    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', {
      message: error.message,
      stack: error.stack,
      userId: req.user?._id || 'unknown',
      attemptedLocationIds: user?.locations,
    });
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
    console.error('Get employee history error:', error);
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
    console.error('Update employee advance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};