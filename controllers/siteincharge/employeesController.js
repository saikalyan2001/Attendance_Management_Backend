import mongoose from 'mongoose';
import Employee from '../../models/Employee.js';
import Settings from '../../models/Settings.js';
import Attendance from '../../models/Attendance.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const registerEmployee = async (req, res) => {
  try {
    const { employeeId, name, email, designation, department, salary, location, phone, dob } = req.body;

    if (!employeeId || !name || !email || !designation || !department || !salary || !location) {
      return res.status(400).json({ message: 'All fields except documents, phone, and DOB are required' });
    }

    if (!mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Invalid location ID' });
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
      location,
      paidLeaves: {
        available: settings.paidLeavesPerMonth,
        used: 0,
        carriedForward: 0,
      },
      documents: [],
      phone: phone || null,
      dob: dob ? new Date(dob) : null,
    };

    if (req.files && req.files.length > 0) {
      const uploadDir = path.join(__dirname, '..', '..', 'Uploads');
      await fs.mkdir(uploadDir, { recursive: true });

      for (const file of req.files) {
        const filePath = `/uploads/${file.filename}`;
        employeeData.documents.push({
          name: file.originalname,
          path: filePath,
          uploadedAt: new Date(),
        });
      }
    }

    const employee = new Employee(employeeData);
    await employee.save();

    res.status(201).json(employee);
  } catch (error) {
    console.error('Register employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const bulkRegisterEmployees = async (req, res) => {
  try {
    const employees = req.body;
    console.log('Received bulk employee registration:', employees);

    if (!Array.isArray(employees) || !employees.length) {
      return res.status(400).json({ message: 'Array of employee records required' });
    }

    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerMonth: 2,
        halfDayDeduction: 0.5,
      });
    }

    const employeeData = [];
    const errors = [];
    const seenIds = new Set();
    const seenEmails = new Set();

    for (const [index, emp] of employees.entries()) {
      const { employeeId, name, email, designation, department, salary, location, phone, dob } = emp;

      if (!employeeId || !name || !email || !designation || !department || !salary || !location) {
        errors.push({ row: index + 1, message: 'All fields except phone and DOB are required' });
        continue;
      }

      if (!mongoose.isValidObjectId(location)) {
        errors.push({ row: index + 1, message: 'Invalid location ID' });
        continue;
      }

      if (isNaN(salary) || parseFloat(salary) <= 0) {
        errors.push({ row: index + 1, message: 'Salary must be a positive number' });
        continue;
      }

      if (phone && !/^\d{10}$/.test(phone)) {
        errors.push({ row: index + 1, message: 'Phone number must be 10 digits' });
        continue;
      }

      if (dob && isNaN(new Date(dob))) {
        errors.push({ row: index + 1, message: 'Invalid date of birth' });
        continue;
      }

      if (seenIds.has(employeeId) || seenEmails.has(email)) {
        errors.push({ row: index + 1, message: 'Duplicate employeeId or email in request' });
        continue;
      }

      const existingEmployee = await Employee.findOne({
        $or: [{ employeeId }, { email }],
      });
      if (existingEmployee) {
        errors.push({ row: index + 1, message: 'Employee ID or email already exists in database' });
        continue;
      }

      seenIds.add(employeeId);
      seenEmails.add(email);

      employeeData.push({
        employeeId,
        name,
        email,
        designation,
        department,
        salary: parseFloat(salary),
        location,
        paidLeaves: {
          available: settings.paidLeavesPerMonth,
          used: 0,
          carriedForward: 0,
        },
        documents: [],
        phone: phone || null,
        dob: dob ? new Date(dob) : null,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation errors in bulk registration', errors });
    }

    const insertedEmployees = await Employee.insertMany(employeeData);
    console.log('Inserted bulk employees:', insertedEmployees);

    res.status(201).json({ employees: insertedEmployees });
  } catch (error) {
    console.error('Bulk register employees error:', error);
    res.status(500).json({ message: 'Server error during bulk registration' });
  }
};

export const getEmployees = async (req, res) => {
  try {
    const { location } = req.query;
    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

    const employees = await Employee.find({ location })
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

    res.json({ employee });
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const editEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, designation, department, salary, phone, dob } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (!name || !email || !designation || !department || !salary) {
      return res.status(400).json({ message: 'All fields except phone and DOB are required' });
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

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const existingEmployee = await Employee.findOne({
      $or: [{ email }],
      _id: { $ne: id },
    });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    employee.name = name;
    employee.email = email;
    employee.designation = designation;
    employee.department = department;
    employee.salary = parseFloat(salary);
    employee.phone = phone || null;
    employee.dob = dob ? new Date(dob) : null;
    await employee.save();

    res.json(employee);
  } catch (error) {
    console.error('Edit employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const transferEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { location } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (!location || !mongoose.isValidObjectId(location)) {
      return res.status(400).json({ message: 'Valid location ID is required' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    employee.location = location;
    await employee.save();

    res.json(employee);
  } catch (error) {
    console.error('Transfer employee error:', error);
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

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const uploadDir = path.join(__dirname, '..', '..', 'Uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    for (const file of req.files) {
      const filePath = `/uploads/${file.filename}`;
      employee.documents.push({
        name: file.originalname,
        path: filePath,
        uploadedAt: new Date(),
      });
    }

    await employee.save();
    res.json(employee);
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

    await Attendance.deleteMany({ employee: id });
    await Employee.deleteOne({ _id: id });

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
