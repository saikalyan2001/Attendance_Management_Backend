/**
 * Check if a given date is a working day for a specific location
 */
export const isWorkingDay = (settings, locationId, date) => {
  try {
    const targetDate = new Date(date);
    const dayOfWeek = targetDate.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    
    // Find the working day policy for this location
    const policy = settings.workingDayPolicies?.find(policy => 
      policy.locations.some(loc => loc._id.toString() === locationId.toString())
    );
    
    let effectivePolicy;
    if (policy) {
      effectivePolicy = policy;
    } else {
      // Use default policy
      effectivePolicy = {
        policyType: settings.defaultWorkingDayPolicy || 'all_days',
        excludeDays: getDefaultExcludeDays(settings.defaultWorkingDayPolicy),
        fixedWorkingDays: settings.defaultFixedWorkingDays || 30
      };
    }
    
    // Check based on policy type
    switch (effectivePolicy.policyType) {
      case 'all_days':
        return true; // All days are working days
        
      case 'exclude_sundays':
        return dayOfWeek !== 0; // Exclude Sundays
        
      case 'exclude_weekends':
        return dayOfWeek !== 0 && dayOfWeek !== 6; // Exclude Sundays and Saturdays
        
      case 'custom_fixed':
        // For custom fixed, we'll allow all days but the salary calculation will handle it
        return true;
        
      default:
        return true;
    }
  } catch (error) {
    
    return true; // Default to allowing attendance if validation fails
  }
};

const getDefaultExcludeDays = (policyType) => {
  switch (policyType) {
    case 'exclude_sundays':
      return [0]; // Sunday
    case 'exclude_weekends':
      return [0, 6]; // Sunday and Saturday
    default:
      return [];
  }
};

/**
 * Get working day policy info for a location - ✅ RENAMED to avoid conflict
 */
export const getWorkingDayPolicyInfo = (settings, locationId) => {
  const policy = settings.workingDayPolicies?.find(policy => 
    policy.locations.some(loc => loc._id.toString() === locationId.toString())
  );
  
  if (policy) {
    return {
      policyName: policy.policyName,
      policyType: policy.policyType,
      description: policy.description,
      workingDaysPerMonth: policy.fixedWorkingDays || null
    };
  }
  
  return {
    policyName: 'Default Policy',
    policyType: settings.defaultWorkingDayPolicy || 'all_days',
    description: 'Default working day policy',
    workingDaysPerMonth: settings.defaultFixedWorkingDays || 30
  };
};

/**
 * Check if attendance should be counted for salary (working day + not exception or approved exception)
 * ✅ FIXED: Now properly handles paid leaves for salary calculation
 */
export const shouldCountForSalary = (attendance, settings, locationId) => {
  try {
    // ✅ PAID LEAVES: Always count paid leaves toward salary, regardless of working day
    if (attendance.status === 'leave') {
      
      return true;
    }
    
    // ✅ HALF-DAY LEAVES: Count half-day leaves toward salary (they already have 0.5 presenceDays)
    if (attendance.status === 'half-day') {
      
      return true;
    }
    
    // ✅ For present/absent status, check if it's a working day
    const isWorking = isWorkingDay(settings, locationId, attendance.date);
    
    if (!isWorking) {
      // Non-working day attendance (present/absent) should not count for salary
      // unless it's an approved exception
      if (attendance.isException && attendance.status === 'present') {
        
        return true;
      }
      
      
      return false;
    }
    
    // ✅ Working day present/absent attendance counts for salary
    
    return true;
    
  } catch (error) {
    
    // Default to not counting if there's an error
    return false;
  }
};

