import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Employee from "../../models/Employee.js";
import Location from "../../models/Location.js";
import Settings from "../../models/Settings.js";
import { DateTime } from "luxon";

const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate();
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

    // Log all attendance records (for debugging, consider removing in production)
    const allRecords = await Attendance.find({})
      .populate("employee", "name employeeId")
      .populate("location", "name")
      .lean();
    console.log("All Attendance Records:", allRecords);

    if (startDate && endDate) {
      // Parse dates in IST
      const start = DateTime.fromFormat(startDate, "yyyy-MM-dd", {
        zone: "Asia/Kolkata",
      }).startOf("day");
      const end = DateTime.fromFormat(endDate.split("T")[0], "yyyy-MM-dd", {
        zone: "Asia/Kolkata",
      }).endOf("day");
      console.log("Query Range:", { start: start.toISO(), end: end.toISO() });
      if (!start.isValid || !end.isValid) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      // Use string comparison for date field
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

    console.log("Match Object:", match);

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
    console.log("Filtered Attendance Records:", attendance);

    // Debug specific records (consider removing in production)
    const debugRecords = await Attendance.find({
      _id: {
        $in: [
          new mongoose.Types.ObjectId("685679d66e07565d58116ece"),
          new mongoose.Types.ObjectId("685679d66e07565d58116ed4"),
        ],
      },
    }).lean();
    console.log("Debug Specific Records:", debugRecords);

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
    console.error("Attendance report error:", error.message);
    res
      .status(500)
      .json({ message: "Server error while fetching attendance report" });
  }
};

export const getLeaveReport = async (req, res) => {
  try {
    const { location, month, year, page = 1, limit = 10 } = req.query;
    const match = { status: "active", isDeleted: false };

    // Fetch settings
    const settings = await Settings.findOne().lean();
    const PAID_LEAVE_LIMIT = settings?.paidLeavesPerYear / 12 || 2;

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid page or limit parameters" });
    }

    if (location && location !== "all") {
      if (!mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }
      match.location = new mongoose.Types.ObjectId(location);
    }

    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required" });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    if (isNaN(monthNum) || isNaN(yearNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: "Invalid month or year" });
    }

    // Count total employees for pagination metadata
    const totalEmployees = await Employee.countDocuments(match);

    // Fetch paginated employees
    const employees = await Employee.find(match)
      .populate("location", "name")
      .select("employeeId name monthlyLeaves location")
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const filteredEmployees = employees.map((emp) => {
      const monthlyLeave = emp.monthlyLeaves.find(
        (leave) => leave.year === yearNum && leave.month === monthNum
      ) || {
        year: yearNum,
        month: monthNum,
        allocated: PAID_LEAVE_LIMIT, // Use settings value
        taken: 0,
        carriedForward: 0,
        available: PAID_LEAVE_LIMIT, // Use settings value
      };
      return {
        ...emp,
        monthlyLeaves: [monthlyLeave],
      };
    });

    const summary = await Employee.aggregate([
      { $match: { status: "active", isDeleted: false } },
      { $unwind: "$monthlyLeaves" },
      {
        $match: {
          "monthlyLeaves.year": yearNum,
          "monthlyLeaves.month": monthNum,
        },
      },
      {
        $group: {
          _id: null,
          totalAvailable: { $sum: "$monthlyLeaves.available" },
          totalUsed: { $sum: "$monthlyLeaves.taken" },
          totalCarriedForward: { $sum: "$monthlyLeaves.carriedForward" },
        },
      },
    ]);

    res.json({
      employees: filteredEmployees,
      summary: summary[0] || {
        totalAvailable: 0,
        totalUsed: 0,
        totalCarriedForward: 0,
      },
      pagination: {
        totalRecords: totalEmployees,
        totalPages: Math.ceil(totalEmployees / limitNum),
        currentPage: pageNum,
        limit: limitNum,
      },
    });
  } catch (error) {
    console.error("Leave report error:", error.message);
    res.status(500).json({ message: "Server error while fetching leave report" });
  }
};

export const getSalaryReport = async (req, res) => {
  try {
    const { startDate, endDate, location, page = 1, limit = 10 } = req.query;
    const match = { isDeleted: false };

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({ message: "Invalid page or limit parameters" });
    }

    let workingDays, reportYear, reportMonth;
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
      match.date = {
        $gte: start.toFormat("yyyy-MM-dd'T'HH:mm:ss+05:30"),
        $lte: end.toFormat("yyyy-MM-dd'T'HH:mm:ss+05:30"),
      };
      reportYear = start.year;
      reportMonth = start.month;
      workingDays = getDaysInMonth(reportYear, reportMonth);
    } else {
      const now = DateTime.now().setZone("Asia/Kolkata");
      reportYear = now.year;
      reportMonth = now.month;
      workingDays = getDaysInMonth(reportYear, reportMonth);
    }

    if (location && location !== "all") {
      if (!mongoose.isValidObjectId(location)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }
      match.location = new mongoose.Types.ObjectId(location);
    }

    // Count total employees for pagination metadata
    const totalEmployees = await Employee.countDocuments(
      location && location !== "all"
        ? { location, status: "active", isDeleted: false }
        : { status: "active", isDeleted: false }
    );

    // Fetch paginated employees
    const employees = await Employee.find(
      location && location !== "all"
        ? { location, status: "active", isDeleted: false }
        : { status: "active", isDeleted: false }
    )
      .select("name employeeId salary advances location monthlyLeaves joinDate")
      .populate("location", "name")
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const settings = await Settings.findOne().lean();
    const PAID_LEAVE_LIMIT = settings?.paidLeavesPerYear / 12 || 2;
    const HALF_DAY_WEIGHT = settings?.halfDayDeduction || 0.5;

    const attendance = await Attendance.find({ ...match, isDeleted: false })
      .populate("employee", "name employeeId")
      .lean();

    const salaryReport = await Promise.all(
      employees.map(async (emp) => {
        const empAttendance = attendance.filter(
          (att) => att.employee?._id.toString() === emp._id.toString()
        );
        const presentDays = empAttendance.filter(
          (att) => att.status === "present"
        ).length;
        const halfDays = empAttendance.filter(
          (att) => att.status === "half-day"
        ).length;
        const absentDays = empAttendance.filter(
          (att) => att.status === "absent"
        ).length;
        const leaveDays = empAttendance.filter(
          (att) => att.status === "leave"
        ).length;
        const totalRecordedDays = presentDays + halfDays + leaveDays + absentDays;

        // Handle no attendance records
        if (totalRecordedDays === 0) {
          return {
            employee: {
              _id: emp._id,
              name: emp.name,
              employeeId: emp.employeeId,
            },
            location: emp.location,
            presentDays: 0,
            halfDays: 0,
            absentDays: 0,
            leaveDays: 0,
            paidLeaveUsed: 0,
            unpaidDays: workingDays,
            grossSalary: parseFloat(emp.salary.toFixed(2)),
            dailySalary: parseFloat((emp.salary / workingDays).toFixed(2)),
            netSalary: 0.0,
            advance: 0.0,
            totalSalary: 0.0,
          };
        }

        // Find advance for the report month
        const advanceEntry = emp.advances.find(
          (adv) => adv.year === reportYear && adv.month === reportMonth
        );
        const advance = advanceEntry ? advanceEntry.amount : 0;

        // Find monthly leave record
        const leaveEntry = emp.monthlyLeaves.find(
          (leave) => leave.year === reportYear && leave.month === reportMonth
        ) || {
          year: reportYear,
          month: reportMonth,
          allocated: PAID_LEAVE_LIMIT,
          taken: 0,
          carriedForward: 0,
          available: PAID_LEAVE_LIMIT,
        };

        const grossSalary = emp.salary;
        const dailySalary = grossSalary / workingDays;

        // Only leaveDays count as paid leaves
        const paidLeaveUsed = Math.min(leaveDays, PAID_LEAVE_LIMIT);
        const unpaidDays =
          (leaveDays > PAID_LEAVE_LIMIT ? leaveDays - PAID_LEAVE_LIMIT : 0) +
          absentDays;

        // Calculate payable days
        const payableDays =
          presentDays + paidLeaveUsed + halfDays * HALF_DAY_WEIGHT;
        // Net salary includes advance deduction
        const netSalary = Math.max(payableDays * dailySalary - advance, 0);
        const totalSalary = netSalary; // Net and total salary are the same

        return {
          employee: {
            _id: emp._id,
            name: emp.name,
            employeeId: emp.employeeId,
          },
          location: emp.location,
          presentDays,
          halfDays,
          absentDays,
          leaveDays,
          paidLeaveUsed: parseFloat(paidLeaveUsed.toFixed(2)),
          unpaidDays: parseFloat(unpaidDays.toFixed(2)),
          grossSalary: parseFloat(grossSalary.toFixed(2)),
          dailySalary: parseFloat(dailySalary.toFixed(2)),
          netSalary: parseFloat(netSalary.toFixed(2)),
          advance: parseFloat(advance.toFixed(2)),
          totalSalary: parseFloat(netSalary.toFixed(2)),
        };
      })
    );

    const summary = {
      totalPresentDays: salaryReport.reduce((sum, emp) => sum + emp.presentDays, 0),
      totalHalfDays: salaryReport.reduce((sum, emp) => sum + emp.halfDays, 0),
      totalAbsentDays: salaryReport.reduce((sum, emp) => sum + emp.absentDays, 0),
      totalLeaveDays: salaryReport.reduce((sum, emp) => sum + emp.leaveDays, 0),
      totalPaidLeaveUsed: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.paidLeaveUsed, 0).toFixed(2)
      ),
      totalUnpaidDays: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.unpaidDays, 0).toFixed(2)
      ),
      totalGrossSalary: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.grossSalary, 0).toFixed(2)
      ),
      totalNetSalary: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.netSalary, 0).toFixed(2)
      ),
      totalAdvance: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.advance, 0).toFixed(2)
      ),
      totalSalary: parseFloat(
        salaryReport.reduce((sum, emp) => sum + emp.totalSalary, 0).toFixed(2)
      ),
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
    console.error("Salary report error:", error.message);
    res.status(500).json({ message: "Server error while fetching salary report" });
  }
};