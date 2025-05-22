import mongoose from 'mongoose';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Settings from '../../models/Settings.js';
import { deleteFile, uploadFile } from '../../utils/fileUtils.js';

export const getEmployees = async (req, res) => {
  try {
    const { location } = req.query;
    const { user } = req;
    let query = {};

    if (location && mongoose.isValidObjectId(location)) {
      query.location = location;
    }

    if (user.role === 'siteincharge') {
      query.location = { $in: user.locations };
    }

    const employees = await Employee.find(query)
      .populate('location')
      .lean();

    res.json(employees);
  } catch (error) {
    console.error('Get employees error:', error.message);
    res.status(500).json({ message: 'Server error while fetching employees' });
  }
};

export const addEmployee = async (req, res) => {
  try {
    const { employeeId, name, email, designation, department, salary, location, phone, dob, paidLeaves } = req.body;
    const documents = req.files;
    const { user } = req;

    if (!employeeId || !name || !email || !designation || !department || !salary || !location) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }

    const existingEmployee = await Employee.findOne({ $or: [{ employeeId }, { email }] });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Employee ID or email already exists' });
    }

    const locationExists = await Location.findById(location);
    if (!locationExists) {
      return res.status(400).json({ message: 'Invalid location' });
    }

    const settings = await Settings.findOne();
    const defaultPaidLeaves = settings ? settings.paidLeavesPerMonth : 2;

    let uploadedDocuments = [];
    if (documents && documents.length > 0) {
      uploadedDocuments = await Promise.all(
        documents.map(async (file) => {
          const { path, filename } = await uploadFile(file);
          return { name: filename, path, uploadedAt: new Date() };
        })
      );
    }

    const employee = new Employee({
      employeeId,
      name,
      email,
      designation,
      department,
      salary: Number(salary),
      location,
      phone,
      dob: dob ? new Date(dob) : undefined,
      paidLeaves: paidLeaves ? JSON.parse(paidLeaves) : { available: defaultPaidLeaves, used: 0, carriedForward: 0 },
      documents: uploadedDocuments,
      createdBy: user._id,
    });

    await employee.save();
    const populatedEmployee = await Employee.findById(employee._id).populate('location').lean();

    res.status(201).json(populatedEmployee);
  } catch (error) {
    console.error('Add employee error:', error.message);
    res.status(500).json({ message: 'Server error while adding employee' });
  }
};

export const editEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId, name, email, designation, department, salary, location, phone, dob, paidLeaves } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (employeeId && employeeId !== employee.employeeId) {
      const existingEmployeeId = await Employee.findOne({ employeeId });
      if (existingEmployeeId) {
        return res.status(400).json({ message: 'Employee ID already exists' });
      }
      employee.employeeId = employeeId;
    }

    if (email && email !== employee.email) {
      const existingEmail = await Employee.findOne({ email });
      if (existingEmail) {
        return res.status(400).json({ message: 'Email already exists' });
      }
      employee.email = email;
    }

    if (name) employee.name = name;
    if (designation) employee.designation = designation;
    if (department) employee.department = department;
    if (salary) employee.salary = Number(salary);
    if (location) {
      const locationExists = await Location.findById(location);
      if (!locationExists) {
        return res.status(400).json({ message: 'Invalid location' });
      }
      employee.location = location;
    }
    if (phone !== undefined) employee.phone = phone;
    if (dob) employee.dob = new Date(dob);
    if (paidLeaves) {
      employee.paidLeaves = {
        available: paidLeaves.available || employee.paidLeaves.available,
        used: paidLeaves.used || employee.paidLeaves.used,
        carriedForward: paidLeaves.carriedForward || employee.paidLeaves.carriedForward,
      };
    }

    await employee.save();
    const populatedEmployee = await Employee.findById(id).populate('location').lean();

    res.json(populatedEmployee);
  } catch (error) {
    console.error('Edit employee error:', error.message);
    res.status(500).json({ message: 'Server error while editing employee' });
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

    if (employee.documents && employee.documents.length > 0) {
      await Promise.all(employee.documents.map(async (doc) => {
        await deleteFile(doc.path);
      }));
    }

    await Employee.deleteOne({ _id: id });

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Delete employee error:', error.message);
    res.status(500).json({ message: 'Server error while deleting employee' });
  }
};

export const uploadDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.file;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid employee ID' });
    }

    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const { path, filename } = await uploadFile(file);
    employee.documents.push({ name: filename, path, uploadedAt: new Date() });
    await employee.save();

    const populatedEmployee = await Employee.findById(id).populate('location').lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Upload document error:', error.message);
    res.status(500).json({ message: 'Server error while uploading document' });
  }
};

export const deleteDocument = async (req, res) => {
  try {
    const { id, documentId } = req.params;

    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ message: 'Invalid employee ID or document ID' });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const document = employee.documents.id(documentId);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    await deleteFile(document.path);
    employee.documents.pull(documentId);
    await employee.save();

    const populatedEmployee = await Employee.findById(id).populate('location').lean();
    res.json(populatedEmployee);
  } catch (error) {
    console.error('Delete document error:', error.message);
    res.status(500).json({ message: 'Server error while deleting document' });
  }
};
