import mongoose from 'mongoose';
import Location from '../../models/Location.js';
import Employee from '../../models/Employee.js';

// Original getLocations (unchanged)
// In locationController.js - update getLocations function
export const getLocations = async (req, res) => {
  try {
    const { user } = req;
    const { filter, role: queryRole } = req.query;
    
    let query = { isDeleted: false };
    
    // ✅ FIXED: Role-based location visibility filtering
    if (user.role === 'siteincharge') {
      // Site-in-charge: only their assigned locations
      query._id = { $in: user.locations };
    } else if (user.role === 'admin') {
      // Admin: only specific locations (add your business logic here)
      // Example: Exclude headquarter locations for admins
      query.locationType = { $ne: 'headquarters' };
    } else if (user.role === 'super_admin') {
      // ✅ SuperAdmin filtering - choose one of these approaches:
      
      // APPROACH 1: Limit SuperAdmin to specific location types
      if (filter === 'attendance_locations') {
        query.locationType = { $in: ['office', 'branch', 'warehouse'] }; // Exclude headquarters
      }
      
      // APPROACH 2: Exclude locations with specific criteria  
      else if (filter === 'operational_only') {
        query.$and = [
          { name: { $not: /test|demo|training/i } }, // Exclude test locations
          { isActive: true } // Only active locations
        ];
      }
      
      // APPROACH 3: Only show locations with minimum employee count
      else if (filter === 'active_locations') {
        const locationIds = await Employee.aggregate([
          { $match: { isDeleted: false, status: 'active' } },
          { $group: { _id: '$location', count: { $sum: 1 } } },
          { $match: { count: { $gte: 1 } } }, // At least 1 active employee
          { $project: { _id: 1 } }
        ]);
        
        const activeLocationIds = locationIds.map(item => item._id);
        query._id = { $in: activeLocationIds };
      }
      
      // APPROACH 4: Custom business logic
      else if (filter === 'restricted') {
        // Example: SuperAdmin can't see certain sensitive locations
        const restrictedLocationNames = ['HR Office', 'Executive Floor', 'Board Room'];
        query.name = { $nin: restrictedLocationNames };
      }
    }

    const locations = await Location.find(query).lean();
    const locationsWithCount = await Promise.all(
      locations.map(async (loc) => {
        const employeeCount = await Employee.countDocuments({ 
          location: loc._id,
          isDeleted: false,
          status: 'active' // Only count active employees
        });
        return { ...loc, employeeCount };
      })
    );
    
    res.json(locationsWithCount);
  } catch (error) {
    
    res.status(500).json({ message: 'Server error while fetching locations' });
  }
};



// ✅ FIXED: Enhanced getPaginatedLocations with proper sorting
export const getPaginatedLocations = async (req, res) => {
  try {
    const { user } = req;
    const { search = "", page = 1, limit = 10, sortColumn = "name", sortOrder = "asc" } = req.query;
    let query = { isDeleted: false };

    if (user.role === "siteincharge") {
      query._id = { $in: user.locations };
    }

    if (search) {
      const regex = new RegExp(search, "i");
      query.$or = [
        { name: regex },
        { address: regex },
        { city: regex },
        { state: regex },
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const totalLocations = await Location.countDocuments(query);
    const totalPages = Math.ceil(totalLocations / limitNum) || 1;
    const adjustedPage = Math.min(pageNum, totalPages);

    // ✅ ENHANCED: Handle different sorting scenarios
    let locations;
    
    if (sortColumn === 'employeeCount') {
      // Special handling for employee count - use aggregation for accurate sorting
      locations = await Location.aggregate([
        { $match: query },
        {
          $lookup: {
            from: "employees",
            let: { locationId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$location", "$$locationId"] },
                      { $eq: ["$isDeleted", false] }
                    ]
                  }
                }
              }
            ],
            as: "employees"
          }
        },
        {
          $addFields: {
            employeeCount: { $size: "$employees" }
          }
        },
        {
          $sort: { 
            employeeCount: sortOrder === "asc" ? 1 : -1 
          }
        },
        { $skip: (adjustedPage - 1) * limitNum },
        { $limit: limitNum }
      ]).collation({ locale: "en", strength: 2, numericOrdering: true });
      
    } else {
      // ✅ FIXED: Standard string sorting with case-insensitive collation
      const sortOptions = {};
      sortOptions[sortColumn] = sortOrder === "asc" ? 1 : -1;

      locations = await Location.find(query)
        .sort(sortOptions)
        .collation({ 
          locale: "en", 
          strength: 2, // Case-insensitive
          numericOrdering: true // Handle numbers in strings properly
        })
        .skip((adjustedPage - 1) * limitNum)
        .limit(limitNum)
        .lean();

      // Add employee count for non-employeeCount sorts
      locations = await Promise.all(
        locations.map(async (loc) => {
          const employeeCount = await Employee.countDocuments({
            location: loc._id,
            isDeleted: false,
          });
          return { ...loc, employeeCount };
        })
      );
    }

    res.json({
      locations: locations,
      totalPages,
      currentPage: adjustedPage,
    });
  } catch (error) {

    res.status(500).json({ message: "Server error while fetching paginated locations" });
  }
};

// Other functions remain unchanged...
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

    const employeeCount = await Employee.countDocuments({ location: id, isDeleted: false });
    res.json({ ...location.toObject(), employeeCount });
  } catch (error) {

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

    const employees = await Employee.find({ location: id, isDeleted: false }).lean();
    if (employees.length > 0) {
      return res.status(400).json({ message: 'Cannot delete location with assigned employees' });
    }

    await Location.deleteOne({ _id: id });
    res.json({ message: 'Location deleted successfully' });
  } catch (error) {

    res.status(500).json({ message: 'Server error while deleting location' });
  }
};
