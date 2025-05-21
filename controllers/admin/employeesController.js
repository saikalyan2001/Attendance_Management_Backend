import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import fs from 'fs/promises';
import path from 'path';

export const getEmployees = async (req, res) => {
  try {
    const { location } = req.query;
    const query = {};
    if (location) query.location = location;

    const employees = await Employee.find(query).populate('location', 'name');
    res.json(employees);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
};

export const createEmployee = async (req, res) => {
  try {
    const {
      employeeId,
      name,
      email,
      designation,
      department,
      salary,
      location,
      phone,
      dob,
      paidLeaves,
      documents,
    } = req.body;

    const existingEmployee = await Employee.findOne({ $or: [{ employeeId }, { email }] });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Employee ID or email already exists' });
    }

    const locationExists = await Location.findById(location);
    if (!locationExists) {
      return res.status(400).json({ message: 'Invalid location' });
    }

    const employee = new Employee({
      employeeId,
      name,
      email,
      designation,
      department,
      salary,
      location,
      phone,
      dob,
      paidLeaves: paidLeaves || { available: 3, used: 0, carriedForward: 0 },
      documents: documents || [],
    });

    await employee.save();
    const newEmployee = await Employee.findById(employee._id).populate('location', 'name');
    res.status(201).json(newEmployee);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create employee' });
  }
};

export const updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId, name, email, designation, department, salary, location, phone, dob, paidLeaves } = req.body;

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (employeeId && employeeId !== employee.employeeId) {
      const existingEmployee = await Employee.findOne({ employeeId });
      if (existingEmployee) {
        return res.status(400).json({ message: 'Employee ID already exists' });
      }
      employee.employeeId = employeeId;
    }

    if (email && email !== employee.email) {
      const existingEmployee = await Employee.findOne({ email });
      if (existingEmployee) {
        return res.status(400).json({ message: 'Email already exists' });
      }
      employee.email = email;
    }

    if (designation) employee.designation = designation;
    if (department) employee.department = department;
    if (salary) employee.salary = salary;
    if (location) {
      const locationExists = await Location.findById(location);
      if (!locationExists) {
        return res.status(400).json({ message: 'Invalid location' });
      }
      employee.location = location;
    }
    if (phone) employee.phone = phone;
    if (dob) employee.dob = dob;
    if (paidLeaves) employee.paidLeaves = {
      ...employee.paidLeaves,
      ...paidLeaves,
    };

    await employee.save();
    const updatedEmployee = await Employee.findById(id).populate('location', 'name');
    res.json(updatedEmployee);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update employee' });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Delete associated documents from filesystem
    for (const doc of employee.documents) {
      const filePath = path.join(path.resolve(), 'uploads', path.basename(doc.path));
      try {
        await fs.unlink(filePath);
      } catch (err) {
        console.error('Failed to delete file:', err);
      }
    }

    await Employee.deleteOne({ _id: id });
    res.json({ message: 'Employee deleted successfully', id });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete employee' });
  }
};

export const uploadDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const document = {
      name: req.file.originalname,
      path: `/uploads/${req.file.filename}`,
      uploadedAt: new Date(),
    };

    employee.documents.push(document);
    await employee.save();

    const updatedEmployee = await Employee.findById(id).populate('location', 'name');
    res.status(201).json(updatedEmployee);
  } catch (error) {
    res.status(500).json({ message: 'Failed to upload document' });
  }
};

export const deleteDocument = async (req, res) => {
  try {
    const { id, documentId } = req.params;
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const document = employee.documents.id(documentId);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const filePath = path.join(path.resolve(), 'Uploads', path.basename(document.path));
    try {
      await fs.unlink(filePath);
    } catch (err) {
      console.error('Failed to delete file:', err);
    }

    employee.documents.pull(documentId);
    await employee.save();

    const updatedEmployee = await Employee.findById(id).populate('location', 'name');
    res.json(updatedEmployee);
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete document' });
  }
};
