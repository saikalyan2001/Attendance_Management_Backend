import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';

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
    const { designation, department, location } = req.body;

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (designation) employee.designation = designation;
    if (department) employee.department = department;
    if (location) {
      const locationExists = await Location.findById(location);
      if (!locationExists) {
        return res.status(400).json({ message: 'Invalid location' });
      }
      employee.location = location;
    }

    await employee.save();
    const updatedEmployee = await Employee.findById(id).populate('location', 'name');
    res.json(updatedEmployee);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update employee' });
  }
};