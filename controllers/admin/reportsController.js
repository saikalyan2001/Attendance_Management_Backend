import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Employee from "../../models/Employee.js";
import Location from "../../models/Location.js";
import Settings from "../../models/Settings.js";
import { DateTime } from "luxon";
import { getWorkingDaysForLocation, getHolidaysForLocation, calculateWorkingDaysForMonth } from './settingsController.js';
import { isWorkingDay, shouldCountForSalary } from "../../utils/workingDayValidator.js";

const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate();
};

// ✅ Helper function to get location-specific paid leave allocation
const getLocationSpecificLeaveAllocation = (settings, locationId) => {
  if (!settings) {
    
    return 2; // Default fallback
  }

  // Check if there are location-specific settings
  if (settings.locationLeaveSettings && settings.locationLeaveSettings.length > 0) {
    const locationSetting = settings.locationLeaveSettings.find(
      setting => setting.location._id.toString() === locationId.toString()
    );
    
    if (locationSetting) {
      const monthlyAllocation = locationSetting.paidLeavesPerYear / 12;
      
      return monthlyAllocation;
    }
  }
  
  // Fall back to global setting
  const globalMonthlyAllocation = (settings.paidLeavesPerYear || 24) / 12;
  
  return globalMonthlyAllocation;
};

export const getAttendanceReport = async (req, res) => {
  try {
    const { startDate, endDate, location, page = 1, limit = 10 } = req.query;
    const match = { isDeleted: false };

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid page or limit parameters" });
    }

    if (startDate && endDate) {
      // Parse dates in IST
      const start = DateTime.fromFormat(startDate, "yyyy-MM-dd", {
        zone: "Asia/Kolkata",
      }).startOf("day");
      const end = DateTime.fromFormat(endDate.split("T")[0], "yyyy-MM-dd", {
        zone: "Asia/Kolkata",
      }).endOf("day");
      
      if (!start.isValid || !end.isValid) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      
      match.date = {
        $gte: start.toFormat("yyyy-MM-dd'T'HH:mm:ss+05:30"),
        $lte: end.toFormat("yyyy-MM-dd'T'HH:mm:ss+05:30"),
      };
    }

    if (location && location !== "all") {
      if (!mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }
      match.location = new mongoose.Types.ObjectId(location);
    }

    // Count total attendance records for pagination metadata
    const totalRecords = await Attendance.countDocuments(match);

    // Fetch paginated attendance records
    const attendance = await Attendance.find(match)
      .populate("employee", "name employeeId")
      .populate("location", "name")
      .sort({ date: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const summary = await Attendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const totalPresent = summary.find((s) => s._id === "present")?.count || 0;
    const totalAbsent = summary.find((s) => s._id === "absent")?.count || 0;
    const totalLeave = summary.find((s) => s._id === "leave")?.count || 0;
    const totalHalfDay = summary.find((s) => s._id === "half-day")?.count || 0;

    res.json({
      attendance,
      summary: { totalPresent, totalAbsent, totalLeave, totalHalfDay },
      pagination: {
        totalRecords,
        totalPages: Math.ceil(totalRecords / limitNum),
        currentPage: pageNum,
        limit: limitNum,
      },
    });
  } catch (error) {
    
    res.status(500).json({ message: "Server error while fetching attendance report" });
  }
};

export const getLeaveReport = async (req, res) => {
  try {
    const { location, month, year, page = 1, limit = 10 } = req.query;

    // ✅ FIXED: Fetch settings with location-specific data
    const settings = await Settings.findOne().populate('locationLeaveSettings.location').lean();

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid page or limit parameters" });
    }

    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required" });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    if (isNaN(monthNum) || isNaN(yearNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: "Invalid month or year" });
    }

    // ✅ STEP 1: Get unique employee IDs from attendance records for this location/month
    let uniqueEmployeeIds;
    
    if (location && location !== "all") {
      if (!mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }

      // Build date range for the month
      const startStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${new Date(yearNum, monthNum, 0).getDate()}T23:59:59+05:30`;

      // ✅ Get employees who had attendance at this location during this month
      uniqueEmployeeIds = await Attendance.distinct('employee', {
        location: new mongoose.Types.ObjectId(location),
        date: { $gte: startStr, $lte: endStr },
        isDeleted: false
      });

      if (uniqueEmployeeIds.length === 0) {
        return res.json({
          employees: [],
          summary: {
            totalAvailable: 0,
            totalUsed: 0,
            totalUnpaidLeaves: 0,
            totalCarriedForward: 0,
          },
          pagination: {
            totalRecords: 0,
            totalPages: 0,
            currentPage: pageNum,
            limit: limitNum,
          },
        });
      }
    }

    // ✅ STEP 2: Build employee query based on attendance history
    const employeeMatch = { 
      status: "active", 
      isDeleted: false 
    };

    // If location filter is applied, only get employees who had attendance there
    if (uniqueEmployeeIds) {
      employeeMatch._id = { $in: uniqueEmployeeIds };
    }

    // Count total employees for pagination metadata
    const totalEmployees = await Employee.countDocuments(employeeMatch);

    // Fetch paginated employees with location populated
    const employees = await Employee.find(employeeMatch)
      .populate("location", "name _id")
      .select("employeeId name monthlyLeaves location")
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const filteredEmployees = employees.map((emp) => {
      // ✅ Get location-specific paid leave allocation
      const PAID_LEAVE_LIMIT = getLocationSpecificLeaveAllocation(settings, emp.location._id);

      const monthlyLeave = emp.monthlyLeaves.find(
        (leave) => leave.year === yearNum && leave.month === monthNum
      ) || {
        year: yearNum,
        month: monthNum,
        allocated: PAID_LEAVE_LIMIT,
        taken: 0,
        carriedForward: 0,
        available: PAID_LEAVE_LIMIT,
      };

      // ✅ Calculate total available leaves and cap the displayed usage
      const totalAvailableLeaves = (monthlyLeave.allocated || 0) + (monthlyLeave.carriedForward || 0);
      const rawTaken = monthlyLeave.taken || 0;
      const displayedTaken = Math.min(rawTaken, totalAvailableLeaves);
      const unpaidLeaves = Math.max(0, rawTaken - totalAvailableLeaves);
      
      return {
        ...emp,
        monthlyLeaves: [{
          year: yearNum,
          month: monthNum,
          allocated: monthlyLeave.allocated || PAID_LEAVE_LIMIT,
          taken: parseFloat(displayedTaken.toFixed(2)),
          carriedForward: monthlyLeave.carriedForward || 0,
          available: parseFloat(Math.max(0, totalAvailableLeaves - displayedTaken).toFixed(2)),
          unpaidLeaves: parseFloat(unpaidLeaves.toFixed(2)),
          actualTaken: parseFloat(rawTaken.toFixed(2)),
        }],
      };
    });

    // ✅ Calculate summary with capped values
    const summary = {
      totalAvailable: 0,
      totalUsed: 0,
      totalUnpaidLeaves: 0,
      totalCarriedForward: 0,
    };

    filteredEmployees.forEach(emp => {
      const monthlyLeave = emp.monthlyLeaves[0];
      summary.totalAvailable += monthlyLeave.available || 0;
      summary.totalUsed += monthlyLeave.taken || 0;
      summary.totalUnpaidLeaves += monthlyLeave.unpaidLeaves || 0;
      summary.totalCarriedForward += monthlyLeave.carriedForward || 0;
    });

    res.json({
      employees: filteredEmployees,
      summary,
      pagination: {
        totalRecords: totalEmployees,
        totalPages: Math.ceil(totalEmployees / limitNum),
        currentPage: pageNum,
        limit: limitNum,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching leave report" });
  }
};



export const getSalaryReport = async (req, res) => {
  try {
    const { startDate, endDate, location, page = 1, limit = 10 } = req.query;
    const attendanceMatch = { isDeleted: false };

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ message: "Invalid page or limit parameters" });
    }

    let reportYear, reportMonth;
    if (startDate && endDate) {
      const start = DateTime.fromFormat(startDate, "yyyy-MM-dd", {
        zone: "Asia/Kolkata",
      }).startOf("day");
      const end = DateTime.fromFormat(endDate.split("T")[0], "yyyy-MM-dd", {
        zone: "Asia/Kolkata",
      }).endOf("day");
      if (!start.isValid || !end.isValid) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      attendanceMatch.date = {
        $gte: start.toFormat("yyyy-MM-dd'T'HH:mm:ss+05:30"),
        $lte: end.toFormat("yyyy-MM-dd'T'HH:mm:ss+05:30"),
      };
      reportYear = start.year;
      reportMonth = start.month;
    } else {
      const now = DateTime.now().setZone("Asia/Kolkata");
      reportYear = now.year;
      reportMonth = now.month;
      
      // Default to current month if no dates provided
      const startStr = `${reportYear}-${reportMonth.toString().padStart(2, '0')}-01T00:00:00+05:30`;
      const endStr = `${reportYear}-${reportMonth.toString().padStart(2, '0')}-${new Date(reportYear, reportMonth, 0).getDate()}T23:59:59+05:30`;
      attendanceMatch.date = { $gte: startStr, $lte: endStr };
    }

    // ✅ STEP 1: Get unique employee IDs from attendance records
    let uniqueEmployeeIds;
    
    if (location && location !== "all") {
      if (!mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }
      attendanceMatch.location = new mongoose.Types.ObjectId(location);
    }

    // ✅ Get employees who had attendance during the reporting period
    uniqueEmployeeIds = await Attendance.distinct('employee', attendanceMatch);

    if (uniqueEmployeeIds.length === 0) {
      return res.json({
        employees: [],
        summary: {
          totalPresentDays: 0,
          totalHalfDays: 0,
          totalAbsentDays: 0,
          totalLeaveDays: 0,
          totalPaidLeaveUsed: 0,
          totalUnpaidDays: 0,
          totalUnpaidDeduction: 0,
          totalPaidHolidayDays: 0,
          totalGrossSalary: 0,
          totalNetSalary: 0,
          totalAdvance: 0,
          totalSalary: 0,
          totalHolidays: 0,
          summaryPolicy: "All employees receive full pay for holidays that fall on working days"
        },
        pagination: {
          totalRecords: 0,
          totalPages: 0,
          currentPage: pageNum,
          limit: limitNum,
        },
      });
    }

    // ✅ STEP 2: Build employee query based on attendance history
    const employeeMatch = {
      _id: { $in: uniqueEmployeeIds },
      status: "active",
      isDeleted: false
    };

    // Count total employees for pagination metadata
    const totalEmployees = await Employee.countDocuments(employeeMatch);

    // Fetch paginated employees with location populated
    const employees = await Employee.find(employeeMatch)
      .select("name employeeId salary advances location monthlyLeaves monthlyPresence joinDate")
      .populate("location", "name _id")
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    // Fetch settings with dynamic working day policies
    const settings = await Settings.findOne()
      .populate('locationLeaveSettings.location')
      .populate('workingDayPolicies.locations')
      .populate('holidays.locations')
      .lean();

    // Get attendance data with presenceDays field
    const attendance = await Attendance.find({ ...attendanceMatch, isDeleted: false })
      .populate("employee", "name employeeId")
      .select("employee status date presenceDays location")
      .lean();

    const salaryReport = await Promise.all(
      employees.map(async (emp) => {
        const empAttendance = attendance.filter(
          (att) => att.employee?._id.toString() === emp._id.toString()
        );

        // Get location-specific working days for the SPECIFIC month/year
        const workingDaysForCalculation = getWorkingDaysForLocation(
          settings, 
          emp.location._id, 
          reportYear, 
          reportMonth
        );
        
        // ✅ Get holidays for this location and calculate paid holiday days
        const holidaysInMonth = getHolidaysForLocation(settings, emp.location._id, reportYear, reportMonth);
        
        let paidHolidayDays = 0;
        const paidHolidayNames = [];

        if (empAttendance.length > 0) {
          for (const holiday of holidaysInMonth) {
            const holidayDate = new Date(holiday.date);
            const employeeJoinDate = new Date(emp.joinDate);

            const latestAttendanceDate = empAttendance.reduce((latest, att) => {
              const attDate = new Date(att.date);
              return attDate > latest ? attDate : latest;
            }, new Date(empAttendance[0].date));

            const actualWorkingPeriodEnd = latestAttendanceDate;

            if (
              employeeJoinDate <= holidayDate &&
              holidayDate <= actualWorkingPeriodEnd &&
              isWorkingDay(settings, emp.location._id, holidayDate)
            ) {
              paidHolidayDays += 1;
              paidHolidayNames.push(holiday.name);
            }
          }
        } else {
          paidHolidayDays = 0;
          paidHolidayNames.push('None');
        }

        // Filter attendance to only count working days for salary
        let salaryEligibleAttendance = 0;
        let totalAttendanceRecords = 0;
        
        for (const attendanceRecord of empAttendance) {
          totalAttendanceRecords++;
          
          if (shouldCountForSalary(attendanceRecord, settings, emp.location._id)) {
            salaryEligibleAttendance += (attendanceRecord.presenceDays || 0);
          }
        }
        
        // Get location-specific paid leave allocation
        const PAID_LEAVE_LIMIT = getLocationSpecificLeaveAllocation(settings, emp.location._id);

        // Calculate attendance breakdown
        const presentDays = empAttendance.filter((att) => att.status === "present").length;
        const halfDays = empAttendance.filter((att) => att.status === "half-day").length;
        const absentDays = empAttendance.filter((att) => att.status === "absent").length;
        const leaveDays = empAttendance.filter((att) => att.status === "leave").length;
        const exceptionDays = empAttendance.filter((att) => att.isException).length;

        // Find advance for the report month
        const advanceEntry = emp.advances.find(
          (adv) => adv.year === reportYear && adv.month === reportMonth
        );
        const advance = advanceEntry ? advanceEntry.amount : 0;

        // ✅ SALARY CALCULATION WITH HOLIDAY PAY
        const grossSalary = emp.salary;
        const dailySalaryRate = grossSalary / workingDaysForCalculation;

        const halfDayRate = settings?.halfDayDeduction || 0.5;

        const halfDayPresenceCredit = halfDays * halfDayRate;
        const halfDayAbsentPortion = halfDays * halfDayRate;

        const totalLeaveNeeded = leaveDays + halfDayAbsentPortion;

        const monthlyLeave = emp.monthlyLeaves.find(
          (ml) => ml.year === reportYear && ml.month === reportMonth
        );

        let totalAvailableLeaves;
        if (monthlyLeave) {
          totalAvailableLeaves = (monthlyLeave.allocated || 0) + (monthlyLeave.carriedForward || 0);
        } else {
          totalAvailableLeaves = getLocationSpecificLeaveAllocation(settings, emp.location._id);
        }

        const paidLeaveUsed = Math.min(totalLeaveNeeded, totalAvailableLeaves);
        const unpaidLeaveDays = Math.max(0, totalLeaveNeeded - totalAvailableLeaves);
        const unpaidLeaveDeduction = unpaidLeaveDays * dailySalaryRate;

        const salaryEligibleDaysForCalculation = presentDays + halfDayPresenceCredit + paidLeaveUsed + paidHolidayDays;

        const netSalary = Math.max((salaryEligibleDaysForCalculation * dailySalaryRate) - advance, 0);

        return {
          employee: { _id: emp._id, name: emp.name, employeeId: emp.employeeId },
          location: emp.location,
          presentDays,
          halfDays,
          absentDays,
          leaveDays,
          exceptionDays,
          paidLeaveUsed: parseFloat(paidLeaveUsed.toFixed(2)),
          unpaidLeaveDays: parseFloat(unpaidLeaveDays.toFixed(2)),
          unpaidLeaveDeduction: parseFloat(unpaidLeaveDeduction.toFixed(2)),
          paidHolidayDays: parseFloat(paidHolidayDays.toFixed(2)),
          paidHolidayNames: paidHolidayNames.join(', ') || 'None',
          salaryEligibleDays: parseFloat(salaryEligibleAttendance.toFixed(2)),
          salaryEligibleDaysForCalculation: parseFloat(salaryEligibleDaysForCalculation.toFixed(2)),
          totalAttendanceRecords,
          grossSalary: parseFloat(grossSalary.toFixed(2)),
          netSalary: parseFloat(netSalary.toFixed(2)),
          advance: parseFloat(advance.toFixed(2)),
          totalSalary: parseFloat(netSalary.toFixed(2)),
          dailySalaryRate: parseFloat(dailySalaryRate.toFixed(2)),
          halfDayRate: parseFloat(halfDayRate.toFixed(2)),
          workingDaysForCalculation: workingDaysForCalculation,
          holidaysInMonth: holidaysInMonth.length,
          holidayNames: holidaysInMonth.map(h => h.name).join(', ') || 'None',
          locationAllocation: parseFloat(PAID_LEAVE_LIMIT.toFixed(2)),
          salaryPolicy: "Paid leaves + Holidays do NOT reduce salary (both are PAID)",
        };
      })
    );

    // ✅ Enhanced summary with holiday pay totals
    const summary = {
      totalPresentDays: salaryReport.reduce((sum, emp) => sum + emp.presentDays, 0),
      totalHalfDays: salaryReport.reduce((sum, emp) => sum + emp.halfDays, 0),
      totalAbsentDays: salaryReport.reduce((sum, emp) => sum + emp.absentDays, 0),
      totalLeaveDays: salaryReport.reduce((sum, emp) => sum + emp.leaveDays, 0),
      totalPaidLeaveUsed: parseFloat(salaryReport.reduce((sum, emp) => sum + emp.paidLeaveUsed, 0).toFixed(2)),
      totalUnpaidDays: parseFloat(salaryReport.reduce((sum, emp) => sum + (emp.unpaidLeaveDays || 0), 0).toFixed(2)),
      totalUnpaidDeduction: parseFloat(salaryReport.reduce((sum, emp) => sum + (emp.unpaidLeaveDeduction || 0), 0).toFixed(2)),
      totalPaidHolidayDays: parseFloat(salaryReport.reduce((sum, emp) => sum + (emp.paidHolidayDays || 0), 0).toFixed(2)),
      totalGrossSalary: parseFloat(salaryReport.reduce((sum, emp) => sum + emp.grossSalary, 0).toFixed(2)),
      totalNetSalary: parseFloat(salaryReport.reduce((sum, emp) => sum + emp.netSalary, 0).toFixed(2)),
      totalAdvance: parseFloat(salaryReport.reduce((sum, emp) => sum + emp.advance, 0).toFixed(2)),
      totalSalary: parseFloat(salaryReport.reduce((sum, emp) => sum + emp.totalSalary, 0).toFixed(2)),
      totalHolidays: salaryReport.reduce((sum, emp) => sum + emp.holidaysInMonth, 0),
      summaryPolicy: "All employees receive full pay for holidays that fall on working days"
    };

    res.json({
      employees: salaryReport,
      summary,
      pagination: {
        totalRecords: totalEmployees,
        totalPages: Math.ceil(totalEmployees / limitNum),
        currentPage: pageNum,
        limit: limitNum,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching salary report" });
  }
};

