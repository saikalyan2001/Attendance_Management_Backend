import Settings from '../../models/Settings.js';
import Employee from '../../models/Employee.js';
import Location from '../../models/Location.js';
import Attendance from '../../models/Attendance.js';
import asyncHandler from 'express-async-handler';

// Helper function to calculate working days for a specific month/year based on policy
const calculateWorkingDaysForMonth = (year, month, policy) => {
  const daysInMonth = new Date(year, month, 0).getDate(); // Get actual days in month
  
  
  
  switch (policy.policyType) {
    case 'all_days':
      
      return daysInMonth;
      
    case 'custom_fixed':
      const fixedDays = Math.min(policy.fixedWorkingDays || 30, daysInMonth);
      
      return fixedDays;
      
    case 'exclude_sundays':
    case 'exclude_weekends':
    default:
      // Count actual working days by excluding specified days
      let workingDays = 0;
      const excludeDays = policy.excludeDays || [];
      
      // Add default exclusions based on policy type
      if (policy.policyType === 'exclude_sundays' && !excludeDays.includes(0)) {
        excludeDays.push(0); // Sunday
      } else if (policy.policyType === 'exclude_weekends') {
        if (!excludeDays.includes(0)) excludeDays.push(0); // Sunday
        if (!excludeDays.includes(6)) excludeDays.push(6); // Saturday
      }
      
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
        
        if (!excludeDays.includes(dayOfWeek)) {
          workingDays++;
        }
      }
      
      
      return workingDays;
  }
};

// Helper function to get working days for a location in a specific month/year
const getWorkingDaysForLocation = (settings, locationId, year, month) => {
  if (!settings) {
    return new Date(year, month, 0).getDate(); // Default: all days in month
  }
  
  // Find the working day policy that includes this location
  const policy = settings.workingDayPolicies?.find(policy => 
    policy.locations.some(loc => loc._id.toString() === locationId.toString())
  );
  
  if (policy) {
    return calculateWorkingDaysForMonth(year, month, policy);
  }
  
  // Use default policy if no specific policy found
  const defaultPolicy = {
    policyType: settings.defaultWorkingDayPolicy || 'all_days',
    excludeDays: settings.defaultWorkingDayPolicy === 'exclude_sundays' ? [0] : 
                settings.defaultWorkingDayPolicy === 'exclude_weekends' ? [0, 6] : [],
    fixedWorkingDays: settings.defaultFixedWorkingDays || 30
  };
  
  return calculateWorkingDaysForMonth(year, month, defaultPolicy);
};

// Helper function to get holidays for a location in a specific month/year
const getHolidaysForLocation = (settings, locationId, year, month) => {
  if (!settings || !settings.holidays) {
    return [];
  }
  
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  
  return settings.holidays.filter(holiday => {
    // Check if holiday applies to this location
    const appliesToLocation = holiday.locations.some(loc => 
      loc._id.toString() === locationId.toString()
    );
    
    if (!appliesToLocation) return false;
    
    const holidayDate = new Date(holiday.date);
    
    // For recurring holidays, check if it falls in the target month/year
    if (holiday.isRecurring) {
      if (holiday.recurringType === 'yearly') {
        // Same month and day, any year >= holiday year
        return holidayDate.getMonth() === (month - 1) && 
               holidayDate.getDate() >= startDate.getDate() && 
               holidayDate.getDate() <= endDate.getDate();
      } else if (holiday.recurringType === 'monthly') {
        // Same day every month
        return holidayDate.getDate() >= startDate.getDate() && 
               holidayDate.getDate() <= endDate.getDate();
      }
    }
    
    // For non-recurring holidays, exact date match within month
    return holidayDate >= startDate && holidayDate <= endDate;
  });
};

export const getSettings = asyncHandler(async (req, res) => {
  try {
    let settings = await Settings.findOne()
      .populate('locationLeaveSettings.location')
      .populate('workingDayPolicies.locations')
      .populate('holidays.locations');
    
    if (!settings) {
      settings = await Settings.create({
        paidLeavesPerYear: 24,
        locationLeaveSettings: [],
        workingDayPolicies: [],
        holidays: [],
        defaultWorkingDayPolicy: 'all_days',
        defaultFixedWorkingDays: 30,
        halfDayDeduction: 0.5,
        highlightDuration: 24 * 60 * 60 * 1000,
      });
    }
    
    // If no policies exist, create default ones
    if (settings.workingDayPolicies.length === 0) {
      const locations = await Location.find({ isDeleted: false });
      
      if (locations.length > 0) {
        const defaultPolicy = {
          policyName: 'All Calendar Days',
          policyType: 'all_days',
          excludeDays: [],
          fixedWorkingDays: 30,
          locations: locations.map(loc => loc._id),
          description: 'Include all calendar days in the month (31 for Jan, 30 for Sep, etc.)',
          isDefault: true
        };
        
        settings.workingDayPolicies = [defaultPolicy];
        await settings.save();
        await settings.populate(['workingDayPolicies.locations']);
      }
    }
    
    // Populate leave settings if empty
    if (settings.locationLeaveSettings.length === 0) {
      const locations = await Location.find({ isDeleted: false });
      const locationSettings = locations.map(location => ({
        location: location._id,
        paidLeavesPerYear: settings.paidLeavesPerYear,
      }));
      
      settings.locationLeaveSettings = locationSettings;
      await settings.save();
      await settings.populate('locationLeaveSettings.location');
    }
    
    res.status(200).json(settings);
  } catch (error) {
    
    res.status(500).json({ message: 'Could not load system settings due to a server issue. Please try again later.' });
  }
});

export const updateSettings = asyncHandler(async (req, res) => {
  try {
    const { 
      paidLeavesPerYear, 
      locationLeaveSettings, 
      workingDayPolicies,
      holidays,
      defaultWorkingDayPolicy,
      defaultFixedWorkingDays,
      halfDayDeduction, 
      highlightDuration 
    } = req.body;
    
    const updateFields = {};
    
    // Validate global paid leaves per year
    if (paidLeavesPerYear !== undefined) {
      if (!Number.isInteger(paidLeavesPerYear) || paidLeavesPerYear < 12 || paidLeavesPerYear > 360) {
        return res.status(400).json({ message: 'Paid leaves per year must be between 12 and 360 days' });
      }
      updateFields.paidLeavesPerYear = paidLeavesPerYear;
    }
    
    // Validate location-based leave settings (same as before)
    if (locationLeaveSettings !== undefined) {
      if (!Array.isArray(locationLeaveSettings)) {
        return res.status(400).json({ message: 'Location leave settings must be an array' });
      }
      
      for (const setting of locationLeaveSettings) {
        if (!setting.location) {
          return res.status(400).json({ message: 'Each location setting must have a location ID' });
        }
        
        if (!Number.isInteger(setting.paidLeavesPerYear) || 
            setting.paidLeavesPerYear < 12 || 
            setting.paidLeavesPerYear > 360) {
          return res.status(400).json({ message: 'Each location\'s paid leaves per year must be between 12 and 360 days' });
        }
        
        const locationExists = await Location.findById(setting.location);
        if (!locationExists) {
          return res.status(400).json({ message: `Location with ID ${setting.location} does not exist` });
        }
      }
      
      updateFields.locationLeaveSettings = locationLeaveSettings;
    }
    
    // Validate working day policies
    if (workingDayPolicies !== undefined) {
      if (!Array.isArray(workingDayPolicies)) {
        return res.status(400).json({ message: 'Working day policies must be an array' });
      }
      
      for (const policy of workingDayPolicies) {
        if (!policy.policyName || !policy.policyName.trim()) {
          return res.status(400).json({ message: 'Each policy must have a name' });
        }
        
        if (!['all_days', 'exclude_sundays', 'exclude_weekends', 'custom_fixed'].includes(policy.policyType)) {
          return res.status(400).json({ message: 'Invalid policy type' });
        }
        
        if (policy.policyType === 'custom_fixed') {
          if (!Number.isInteger(policy.fixedWorkingDays) || 
              policy.fixedWorkingDays < 20 || 
              policy.fixedWorkingDays > 31) {
            return res.status(400).json({ message: 'Fixed working days must be between 20 and 31' });
          }
        }
        
        if (policy.excludeDays && Array.isArray(policy.excludeDays)) {
          for (const day of policy.excludeDays) {
            if (!Number.isInteger(day) || day < 0 || day > 6) {
              return res.status(400).json({ message: 'Exclude days must be integers between 0 and 6' });
            }
          }
        }
        
        if (!Array.isArray(policy.locations) || policy.locations.length === 0) {
          return res.status(400).json({ message: 'Each policy must have at least one location' });
        }
        
        // Verify all locations exist
        for (const locationId of policy.locations) {
          const locationExists = await Location.findById(locationId);
          if (!locationExists) {
            return res.status(400).json({ message: `Location with ID ${locationId} does not exist` });
          }
        }
      }
      
      updateFields.workingDayPolicies = workingDayPolicies;
    }
    
    // Validate holidays (same as before)
    if (holidays !== undefined) {
      if (!Array.isArray(holidays)) {
        return res.status(400).json({ message: 'Holidays must be an array' });
      }
      
      for (const holiday of holidays) {
        if (!holiday.name || !holiday.name.trim()) {
          return res.status(400).json({ message: 'Each holiday must have a name' });
        }
        
        if (!holiday.date) {
          return res.status(400).json({ message: 'Each holiday must have a date' });
        }
        
        if (!Array.isArray(holiday.locations) || holiday.locations.length === 0) {
          return res.status(400).json({ message: 'Each holiday must apply to at least one location' });
        }
        
        // Verify all locations exist
        for (const locationId of holiday.locations) {
          const locationExists = await Location.findById(locationId);
          if (!locationExists) {
            return res.status(400).json({ message: `Location with ID ${locationId} does not exist` });
          }
        }
      }
      
      updateFields.holidays = holidays;
    }
    
    // Validate default working day policy
    if (defaultWorkingDayPolicy !== undefined) {
      if (!['all_days', 'exclude_sundays', 'exclude_weekends', 'custom_fixed'].includes(defaultWorkingDayPolicy)) {
        return res.status(400).json({ message: 'Invalid default working day policy' });
      }
      updateFields.defaultWorkingDayPolicy = defaultWorkingDayPolicy;
    }
    
    // Validate default fixed working days
    if (defaultFixedWorkingDays !== undefined) {
      if (!Number.isInteger(defaultFixedWorkingDays) || 
          defaultFixedWorkingDays < 20 || 
          defaultFixedWorkingDays > 31) {
        return res.status(400).json({ message: 'Default fixed working days must be between 20 and 31' });
      }
      updateFields.defaultFixedWorkingDays = defaultFixedWorkingDays;
    }
    
    // Validate half day deduction and highlight duration (same as before)
    if (halfDayDeduction !== undefined) {
      if (isNaN(halfDayDeduction) || halfDayDeduction < 0 || halfDayDeduction > 1) {
        return res.status(400).json({ message: 'Half-day deduction must be between 0 and 1' });
      }
      updateFields.halfDayDeduction = halfDayDeduction;
    }
    
    if (highlightDuration !== undefined) {
      if (!Number.isInteger(highlightDuration) || highlightDuration < 60 * 1000 || highlightDuration > 7 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ message: 'Highlight duration must be between 1 minute and 7 days' });
      }
      updateFields.highlightDuration = highlightDuration;
    }
    
    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ message: 'Please provide at least one valid setting to update' });
    }
    
    const settings = await Settings.findOneAndUpdate(
      {},
      { $set: updateFields },
      { new: true, upsert: true }
    ).populate(['locationLeaveSettings.location', 'workingDayPolicies.locations', 'holidays.locations']);
    
    res.json(settings);
  } catch (error) {
    
    res.status(500).json({ message: 'Could not update settings due to a server issue. Please try again later.' });
  }
});

export const updateEmployeeLeaves = asyncHandler(async (req, res) => {
  try {
    const settings = await Settings.findOne().populate('locationLeaveSettings.location');
    if (!settings) {
      return res.status(404).json({ message: 'System settings not found. Please contact support.' });
    }
    
    const employees = await Employee.find({ status: 'active', isDeleted: false }).populate('location');
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    
    const updatedEmployees = await Promise.all(
      employees.map(async (employee) => {
        try {
          // Find location-specific leave setting
          const locationSetting = settings.locationLeaveSettings.find(
            setting => setting.location._id.toString() === employee.location._id.toString()
          );
          
          // Use location-specific setting or fallback to global setting
          const paidLeavesPerYear = locationSetting ? locationSetting.paidLeavesPerYear : settings.paidLeavesPerYear;
          const monthlyAllocation = Math.floor(paidLeavesPerYear / 12);
          
          const remainingMonths = 12 - currentMonth + 1;
          const totalLeaves = remainingMonths * monthlyAllocation;
          
          const newMonthlyLeaves = [];
          for (let m = currentMonth; m <= 12; m++) {
            const startDate = new Date(currentYear, m - 1, 1).toISOString().split('T')[0];
            const endDate = new Date(currentYear, m, 1).toISOString().split('T')[0];
            
            const attendanceRecords = await Attendance.find({
              employee: employee._id,
              date: { $gte: `${startDate}T00:00:00+05:30`, $lt: `${endDate}T00:00:00+05:30` },
              status: { $in: ['leave', 'half-day'] },
              isDeleted: false,
            }).lean();
            
            const taken = attendanceRecords.reduce((sum, record) => {
              return sum + (record.status === 'leave' ? 1 : settings.halfDayDeduction || 0.5);
            }, 0);
            
            const allocatedLeaves = monthlyAllocation;
            const openingLeaves = allocatedLeaves;
            const closingLeaves = Math.max(0, openingLeaves - taken);
            
            newMonthlyLeaves.push({
              year: currentYear,
              month: m,
              allocated: allocatedLeaves,
              taken,
              carriedForward: 0,
              openingLeaves,
              closingLeaves,
              available: closingLeaves,
            });
          }
          
          employee.monthlyLeaves = newMonthlyLeaves;
          employee.paidLeaves.available = Math.max(0, totalLeaves - employee.paidLeaves.used);
          employee.paidLeaves.carriedForward = 0;
          
          await employee.save();
          return employee;
        } catch (error) {
          
          return employee;
        }
      })
    );
    
    res.json({
      message: 'Employee leave balances updated successfully',
      employeeCount: updatedEmployees.length,
    });
  } catch (error) {
    
    res.status(500).json({ message: 'Could not update employee leave balances due to a server issue. Please try again later.' });
  }
});

export const getLocationsForSettings = asyncHandler(async (req, res) => {
  try {
    const locations = await Location.find({ isDeleted: false }).select('_id name city state');
    res.json(locations);
  } catch (error) {
    
    res.status(500).json({ message: 'Could not fetch locations. Please try again later.' });
  }
});

// Export helper functions
export { getWorkingDaysForLocation, getHolidaysForLocation, calculateWorkingDaysForMonth };
