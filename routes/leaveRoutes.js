
const express = require("express");
const db = require("../db");
const { sendLeaveNotification } = require("../utils/emailService");

const router = express.Router();

const ALLOWED_LEAVE_TYPES = ["SL", "CL", "EL"];

const LEAVE_ALLOCATION = {
  CL: 12,
  SL: 12,
  EL: 15
};

// --------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function daysBetween(start, end) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);

  return Math.floor((endTime - startTime) / 86400000) + 1;
}

// Calculate the number of leave days falling inside a particular year.
function daysInYear(startDate, endDate, year) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const start = startDate > yearStart ? startDate : yearStart;
  const end = endDate < yearEnd ? endDate : yearEnd;

  if (start > end) return 0;

  return daysBetween(start, end);
}

function getYears(startDate, endDate) {
  const years = [];

  const firstYear = Number(startDate.substring(0, 4));
  const lastYear = Number(endDate.substring(0, 4));

  for (let year = firstYear; year <= lastYear; year++) {
    years.push(year);
  }

  return years;
}

function calculateYearlyUsage(leaves, year) {
  const result = {
    CL: { used: 0, pending: 0 },
    SL: { used: 0, pending: 0 },
    EL: { used: 0, pending: 0 }
  };

  for (const leave of leaves) {
    if (!result[leave.leave_type]) continue;

    const days = daysInYear(
      leave.start_date,
      leave.end_date,
      year
    );

    if (leave.status === "Approved") {
      result[leave.leave_type].used += days;
    } else if (leave.status === "Pending") {
      result[leave.leave_type].pending += days;
    }
  }

  return result;
}

function buildBalanceResponse(employeeId, year, leaves) {
  const usage = calculateYearlyUsage(leaves, year);

  const leaveBalances = {};

  for (const type of ALLOWED_LEAVE_TYPES) {
    const total = LEAVE_ALLOCATION[type];
    const used = usage[type].used;
    const pending = usage[type].pending;

    leaveBalances[type] = {
      total,
      used,
      pending,
      remaining: total - used - pending
    };
  }

  return {
    success: true,
    employeeId,
    year,
    leaveBalances
  };
}

// Get a connection that supports transactions.
async function getConnection() {
  return db.promise().getConnection();
}

// --------------------------------------------------
// 1. APPLY FOR LEAVE
// POST /api/leave/apply
// --------------------------------------------------

router.post("/apply", async (req, res) => {
  const {
    employeeId,
    leaveType,
    startDate,
    endDate,
    reason
  } = req.body;

  if (!employeeId || !leaveType || !startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: "Employee ID, leave type, start date and end date are required"
    });
  }

  if (!ALLOWED_LEAVE_TYPES.includes(leaveType)) {
    return res.status(400).json({
      success: false,
      message: "Invalid leave type. Allowed types: SL, CL, EL"
    });
  }

  if (
    !isValidDate(startDate) ||
    !isValidDate(endDate) ||
    endDate < startDate
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide valid dates in YYYY-MM-DD format. End date must not be before start date."
    });
  }

  let connection;
  let leaveId;

  try {
    connection = await getConnection();
    await connection.beginTransaction();

    // Lock the employee row so simultaneous applications
    // for the same employee are processed one at a time.
    const [employees] = await connection.execute(
      `SELECT employee_id
       FROM employees
       WHERE employee_id = ?
         AND status = 'Active'
       FOR UPDATE`,
      [employeeId]
    );

    if (employees.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Employee not found or inactive"
      });
    }

    // Get all active reservations and approved leave records.
    const [existingLeaves] = await connection.execute(
      `SELECT leave_type, start_date, end_date, status
       FROM leaves
       WHERE employee_id = ?
         AND status IN ('Pending', 'Approved')
         AND leave_type IN ('SL', 'CL', 'EL')`,
      [employeeId]
    );

    // Prevent overlapping pending or approved leave applications.
    const overlaps = existingLeaves.some(leave => {
      return startDate <= leave.end_date &&
        endDate >= leave.start_date;
    });

    if (overlaps) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "You already have a pending or approved leave application for overlapping dates."
      });
    }

    // Check the requested days against each calendar year's balance.
    const years = getYears(startDate, endDate);

    for (const year of years) {
      const requestedDays = daysInYear(startDate, endDate, year);

      const usage = calculateYearlyUsage(existingLeaves, year);

      const used = usage[leaveType].used;
      const pending = usage[leaveType].pending;

      const total = LEAVE_ALLOCATION[leaveType];
      const remaining = total - used - pending;

      if (requestedDays > remaining) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: `Insufficient ${leaveType} balance for ${year}.`,
          year,
          total,
          used,
          pending,
          remaining,
          requested: requestedDays
        });
      }
    }

    // Insert pending leave.
    // Pending leave immediately reserves the requested days.
    const [insertResult] = await connection.execute(
      `INSERT INTO leaves
       (employee_id, leave_type, start_date, end_date, reason, status)
       VALUES (?, ?, ?, ?, ?, 'Pending')`,
      [
        employeeId,
        leaveType,
        startDate,
        endDate,
        reason || null
      ]
    );

    leaveId = insertResult.insertId;

    await connection.commit();

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Leave transaction rollback error:", rollbackError);
      }
    }

    console.error("Leave application error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to apply for leave",
      error: error.message
    });

  } finally {
    if (connection) connection.release();
  }

  // Send notifications only after the leave application is committed.
  // A notification failure does not cancel the application.

  const recipientSql = `
    SELECT
      e.employee_id AS employeeId,
      e.name AS employeeName,
      e.department,

      rm.name AS directManagerName,
      rm.email AS directManagerEmail,

      dh.name AS departmentHeadName,
      dh.email AS departmentHeadEmail,

      'support@yesgobus.com' AS supportEmail

    FROM employees e

    LEFT JOIN employees rm
      ON rm.employee_id = e.reporting_manager_id
     AND rm.status = 'Active'

    LEFT JOIN employees dh
      ON TRIM(dh.department) = TRIM(e.department)
     AND TRIM(dh.role) = 'Manager'
     AND dh.status = 'Active'

    WHERE e.employee_id = ?
      AND e.status = 'Active'
  `;

  try {
    const [rows] = await db.promise().execute(
      recipientSql,
      [employeeId]
    );

    const employee = rows[0];

    if (!employee) {
      return res.json({
        success: true,
        message: "Leave applied, but employee details were not found.",
        leaveId,
        status: "Pending",
        emailSent: false
      });
    }

    const recipients = [
      {
        name: employee.directManagerName,
        email: employee.directManagerEmail
      },
      {
        name: employee.departmentHeadName,
        email: employee.departmentHeadEmail
      },
      {
        name: "Support",
        email: employee.supportEmail
      }
    ];

    const uniqueRecipients = [
      ...new Map(
        recipients
          .filter(
            recipient =>
              typeof recipient.email === "string" &&
              recipient.email.trim() !== ""
          )
          .map(recipient => {
            const email = recipient.email.trim();

            return [
              email.toLowerCase(),
              { ...recipient, email }
            ];
          })
      ).values()
    ];

    if (uniqueRecipients.length === 0) {
      return res.json({
        success: true,
        message: "Leave applied, but no notification recipients were found.",
        leaveId,
        status: "Pending",
        emailSent: false,
        sentTo: [],
        failedFor: []
      });
    }

    const results = await Promise.allSettled(
      uniqueRecipients.map(recipient =>
        sendLeaveNotification({
          managerEmail: recipient.email,
          employeeName: employee.employeeName,
          employeeId: employee.employeeId,
          leaveType,
          startDate,
          endDate,
          reason,
          leaveId
        })
      )
    );

    const sentTo = [];
    const failedFor = [];

    results.forEach((result, index) => {
      const recipient = uniqueRecipients[index];

      if (result.status === "fulfilled") {
        sentTo.push(recipient.email);

        console.log(
          `Leave ${leaveId}: email accepted by SMTP for ${recipient.email}`
        );
      } else {
        failedFor.push(recipient.email);

        console.error(
          `Leave ${leaveId}: email failed for ${recipient.email}:`,
          result.reason?.message || result.reason
        );
      }
    });

    return res.json({
      success: true,
      message: failedFor.length === 0
        ? "Leave applied and all notification emails accepted by SMTP."
        : "Leave applied, but some notification emails failed.",
      leaveId,
      status: "Pending",
      emailSent: failedFor.length === 0,
      sentTo,
      failedFor
    });

  } catch (error) {
    console.error("Leave notification error:", error);

    return res.json({
      success: true,
      message: "Leave applied, but notification processing failed.",
      leaveId,
      status: "Pending",
      emailSent: false
    });
  }
});

// --------------------------------------------------
// 2. GET EMPLOYEE LEAVE HISTORY
// GET /api/leave/history/:employeeId
// --------------------------------------------------

router.get("/history/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      id,
      employee_id,
      leave_type,
      start_date,
      end_date,
      reason,
      status,
      applied_at
    FROM leaves
    WHERE employee_id = ?
    ORDER BY applied_at DESC
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Leave history error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    return res.json({
      success: true,
      count: results.length,
      leaves: results
    });
  });
});

// --------------------------------------------------
// 3. GET PENDING LEAVES FOR REPORTING MANAGER
// GET /api/leave/manager/:managerId/pending
// --------------------------------------------------

router.get("/manager/:managerId/pending", (req, res) => {
  const { managerId } = req.params;

  const sql = `
    SELECT
      l.id,
      l.employee_id,
      e.name,
      e.department,
      e.designation,
      l.leave_type,
      l.start_date,
      l.end_date,
      l.reason,
      l.status,
      l.applied_at
    FROM leaves l
    INNER JOIN employees e
      ON l.employee_id = e.employee_id
    WHERE e.reporting_manager_id = ?
      AND l.status = 'Pending'
    ORDER BY l.applied_at DESC
  `;

  db.query(sql, [managerId], (err, results) => {
    if (err) {
      console.error("Manager pending leaves error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    return res.json({
      success: true,
      managerId,
      count: results.length,
      leaves: results
    });
  });
});

// --------------------------------------------------
// 4. MANAGER APPROVE OR REJECT LEAVE
// PUT /api/leave/status/:leaveId
// --------------------------------------------------

router.put("/status/:leaveId", async (req, res) => {
  const { leaveId } = req.params;
  const { status, managerId } = req.body;

  if (!status || !["Approved", "Rejected"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be Approved or Rejected"
    });
  }

  if (!managerId) {
    return res.status(400).json({
      success: false,
      message: "Manager ID is required"
    });
  }

  let connection;

  try {
    connection = await getConnection();
    await connection.beginTransaction();

    // Find the employee associated with this leave.
    const [initialRows] = await connection.execute(
      `SELECT employee_id
       FROM leaves
       WHERE id = ?`,
      [leaveId]
    );

    if (initialRows.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Leave application not found"
      });
    }

    const employeeId = initialRows[0].employee_id;

    // Lock employee first to serialize balance-affecting operations.
    await connection.execute(
      `SELECT employee_id
       FROM employees
       WHERE employee_id = ?
       FOR UPDATE`,
      [employeeId]
    );

    // Recheck leave and manager authorization under the transaction.
    const [leaveRows] = await connection.execute(
      `SELECT
         l.id,
         l.employee_id,
         l.status,
         e.reporting_manager_id
       FROM leaves l
       INNER JOIN employees e
         ON l.employee_id = e.employee_id
       WHERE l.id = ?
       FOR UPDATE`,
      [leaveId]
    );

    if (leaveRows.length === 0 || leaveRows[0].status !== "Pending") {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Pending leave application not found or already processed"
      });
    }

    const leave = leaveRows[0];

    if (String(leave.reporting_manager_id) !== String(managerId)) {
      await connection.rollback();

      return res.status(403).json({
        success: false,
        message: "You are not authorized to approve or reject this leave"
      });
    }

    const [updateResult] = await connection.execute(
      `UPDATE leaves
       SET status = ?
       WHERE id = ?
         AND status = 'Pending'`,
      [status, leaveId]
    );

    if (updateResult.affectedRows === 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "Leave status was already changed. Refresh and try again."
      });
    }

    await connection.commit();

    return res.json({
      success: true,
      message: `Leave ${status.toLowerCase()} successfully`,
      leaveId,
      employeeId,
      status,
      balanceAction: status === "Rejected"
        ? "Reserved leave restored"
        : "Leave deduction retained"
    });

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Status rollback error:", rollbackError);
      }
    }

    console.error("Leave status update error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update leave status",
      error: error.message
    });

  } finally {
    if (connection) connection.release();
  }
});

// --------------------------------------------------
// 5. GET ALL PENDING LEAVES
// GET /api/leave/pending
// --------------------------------------------------

router.get("/pending", (req, res) => {
  const sql = `
    SELECT
      l.id,
      l.employee_id,
      e.name,
      e.department,
      e.designation,
      l.leave_type,
      l.start_date,
      l.end_date,
      l.reason,
      l.status,
      l.applied_at
    FROM leaves l
    INNER JOIN employees e
      ON l.employee_id = e.employee_id
    WHERE l.status = 'Pending'
    ORDER BY l.applied_at DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Pending leaves error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    return res.json({
      success: true,
      count: results.length,
      leaves: results
    });
  });
});

// --------------------------------------------------
// 6. GET EMPLOYEE LEAVE BALANCE
// GET /api/leave/balance/:employeeId
// Optional: ?year=2026
// --------------------------------------------------

router.get("/balance/:employeeId", async (req, res) => {
  const { employeeId } = req.params;

  const year = req.query.year
    ? Number(req.query.year)
    : new Date().getFullYear();

  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid calendar year"
    });
  }

  try {
    const [employees] = await db.promise().execute(
      `SELECT employee_id
       FROM employees
       WHERE employee_id = ?
         AND status = 'Active'`,
      [employeeId]
    );

    if (employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Active employee not found"
      });
    }

    const [leaves] = await db.promise().execute(
      `SELECT
         leave_type,
         start_date,
         end_date,
         status
       FROM leaves
       WHERE employee_id = ?
         AND status IN ('Pending', 'Approved')
         AND leave_type IN ('SL', 'CL', 'EL')
         AND start_date <= ?
         AND end_date >= ?`,
      [
        employeeId,
        `${year}-12-31`,
        `${year}-01-01`
      ]
    );

    const response = buildBalanceResponse(
      employees[0].employee_id,
      year,
      leaves
    );

    return res.json(response);

  } catch (error) {
    console.error("Get leave balance error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to calculate leave balance",
      error: error.message
    });
  }
});

module.exports = router;
