import Location from '../../models/Location.js';

export const getLocations = async (req, res) => {
  try {
    const locations = await Location.find().lean();
    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const addLocation = async (req, res) => {
  try {
    const { name, address } = req.body;

    if (!name || !address) {
      return res.status(400).json({ message: 'Name and address are required' });
    }

    const existingLocation = await Location.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
    if (existingLocation) {
      return res.status(400).json({ message: 'Location name already exists' });
    }

    const location = new Location({ name, address });
    await location.save();

    res.status(201).json(location);
  } catch (error) {
    console.error('Add location error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const editLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address } = req.body;

    if (!name || !address) {
      return res.status(400).json({ message: 'Name and address are required' });
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
    await location.save();

    res.json(location);
  } catch (error) {
    console.error('Edit location error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;

    const location = await Location.findById(id);
    if (!location) {
      return res.status(404).json({ message: 'Location not found' });
    }

    await Location.deleteOne({ _id: id });

    res.json({ message: 'Location deleted' });
  } catch (error) {
    console.error('Delete location error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};