import mongoose from 'mongoose';
import Location from '../../models/Location.js';
import Employee from '../../models/Employee.js';

export const getLocations = async (req, res) => {
  try {
    const { user } = req;
    let query = {};
    if (user.role === 'siteincharge') {
      query._id = { $in: user.locations };
    }
    const locations = await Location.find(query).lean();
    const locationsWithCount = await Promise.all(
      locations.map(async (loc) => {
        const employeeCount = await Employee.countDocuments({ 
          location: loc._id,
          isDeleted: false // Only count non-deleted employees
        });
        return { ...loc, employeeCount };
      })
    );
    res.json(locationsWithCount);
  } catch (error) {
    console.error('Get locations error:', error.message);
    res.status(500).json({ message: 'Server error while fetching locations' });
  }
};

export const addLocation = async (req, res) => {
  try {
    const { name, address, city, state } = req.body;

    if (!name || !address || !city || !state) {
      return res.status(400).json({ message: 'Name, address, city, and state are required' });
    }

    const existingLocation = await Location.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
    if (existingLocation) {
      return res.status(400).json({ message: 'Location name already exists' });
    }

    const location = new Location({ name, address, city, state });
    await location.save();

    res.status(201).json({ ...location.toObject(), employeeCount: 0 });
  } catch (error) {
    ('Add location error:', error.message);
    res.status(500).json({ message: 'Server error while adding location' });
  }
};

export const editLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address, city, state } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    if (!name || !address || !city || !state) {
      return res.status(400).json({ message: 'Name, address, city, and state are required' });
    }

    const location = await Location.findById(id);
    if (!location) {
      return res.status(404).json({ message: 'Location not found' });
    }

    const existingLocation = await Location.findOne({
      name: { $regex: `^${name}$`, $options: 'i' },
      _id: { $ne: id },
    });
    if (existingLocation) {
      return res.status(400).json({ message: 'Location name already exists' });
    }

    location.name = name;
    location.address = address;
    location.city = city;
    location.state = state;
    await location.save();

    const employeeCount = await Employee.countDocuments({ location: id });
    res.json({ ...location.toObject(), employeeCount });
  } catch (error) {
    ('Edit location error:', error.message);
    res.status(500).json({ message: 'Server error while editing location' });
  }
};

export const deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const location = await Location.findById(id);
    if (!location) {
      return res.status(404).json({ message: 'Location not found' });
    }

    const employees = await Employee.find({ location: id }).lean();
    if (employees.length > 0) {
      return res.status(400).json({ message: 'Cannot delete location with assigned employees' });
    }

    await Location.deleteOne({ _id: id });

    res.json({ message: 'Location deleted successfully' });
  } catch (error) {
    ('Delete location error:', error.message);
    res.status(500).json({ message: 'Server error while deleting location' });
  }
};
