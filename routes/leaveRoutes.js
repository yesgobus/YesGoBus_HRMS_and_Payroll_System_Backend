
const express = require("express");
const db = require("../db");
const { sendLeaveNotification } = require("../utils/emailService");

const router = express.Router();

const ALLOWED_LEAVE_TYPES = ["SL", "CL", "EL"];

// APPLY FOR LEAVE
router.post("/apply", (req, res) => {
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

  // Validate date format and chronological order.
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  const isValidDate = (value) => {
    if (typeof value !== "string" || !datePattern.test(value)) {
      return false;
    }

    const date = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value;
  };

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

  const employeeSql = `
    SELECT employee_id
    FROM employees
    WHERE employee_id = ?
      AND status = 'Active'
  `;

  db.query(employeeSql, [employeeId], (err, employees) => {
    if (err) {
      console.error("Employee check error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (!employees || employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found or inactive"
      });
    }

    const leaveSql = `
      INSERT INTO leaves
        (employee_id, leave_type, start_date, end_date, reason, status)
      VALUES (?, ?, ?, ?, ?, 'Pending')
    `;

    db.query(
      leaveSql,
      [employeeId, leaveType, startDate, endDate, reason || null],
      (err, result) => {
        if (err) {
          console.error("Leave application error:", err);

          return res.status(500).json({
            success: false,
            message: "Unable to apply for leave"
          });
        }

        const leaveId = result.insertId;

        // Preserve the existing notification policy:
        // YGB004 receives notifications, along with the active
        // manager of the employee's department.
        const recipientSql = `
          SELECT
            e.employee_id AS employeeId,
            e.name AS employeeName,
            e.department,
            v.name AS directManagerName,
            v.email AS directManagerEmail,

            (
              SELECT dh.name
              FROM employees dh
              WHERE TRIM(dh.department) = TRIM(e.department)
                AND TRIM(dh.role) = 'Manager'
                AND dh.status = 'Active'
              ORDER BY dh.id
              LIMIT 1
            ) AS departmentHeadName,

            (
              SELECT dh.email
              FROM employees dh
              WHERE TRIM(dh.department) = TRIM(e.department)
                AND TRIM(dh.role) = 'Manager'
                AND dh.status = 'Active'
              ORDER BY dh.id
              LIMIT 1
            ) AS departmentHeadEmail

          FROM employees e

          LEFT JOIN employees v
            ON v.employee_id = 'YGB004'
           AND v.status = 'Active'

          WHERE e.employee_id = ?
            AND e.status = 'Active'
        `;

        db.query(
          recipientSql,
          [employeeId],
          async (lookupErr, rows) => {
            if (lookupErr) {
              console.error("Recipient lookup error:", lookupErr);

              return res.json({
                success: true,
                message: "Leave applied, but notification lookup failed.",
                leaveId,
                emailSent: false
              });
            }

            const employee = rows && rows[0];

            if (!employee) {
              return res.json({
                success: true,
                message: "Leave applied, but employee details were not found.",
                leaveId,
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
              }
            ];

            // Remove empty and duplicate email addresses.
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
                emailSent: false,
                sentTo: [],
                failedFor: []
              });
            }

            // Attempt notification to each unique recipient.
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

            const allSent = failedFor.length === 0;

            return res.json({
              success: true,
              message: allSent
                ? "Leave applied and all notification emails accepted by SMTP."
                : "Leave applied, but some notification emails failed.",
              leaveId,
              emailSent: allSent,
              sentTo,
              failedFor
            });
          }
        );
      }
    );
  });
});

// GET EMPLOYEE LEAVE HISTORY
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

// GET PENDING LEAVES FOR REPORTING MANAGER
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

// MANAGER APPROVE OR REJECT LEAVE
router.put("/status/:leaveId", (req, res) => {
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

  const checkSql = `
    SELECT
      l.id,
      l.employee_id,
      e.reporting_manager_id
    FROM leaves l
    INNER JOIN employees e
      ON l.employee_id = e.employee_id
    WHERE l.id = ?
      AND l.status = 'Pending'
  `;

  db.query(checkSql, [leaveId], (err, results) => {
    if (err) {
      console.error("Leave approval check error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending leave application not found"
      });
    }

    const leave = results[0];

    // Preserve existing direct-manager authorization.
    if (leave.reporting_manager_id !== managerId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to approve or reject this leave"
      });
    }

    const updateSql = `
      UPDATE leaves
      SET status = ?
      WHERE id = ?
        AND status = 'Pending'
    `;

    db.query(updateSql, [status, leaveId], (err, result) => {
      if (err) {
        console.error("Leave status update error:", err);

        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      if (result.affectedRows === 0) {
        return res.status(409).json({
          success: false,
          message: "Leave status was already changed. Refresh and try again."
        });
      }

      return res.json({
        success: true,
        message: `Leave ${status.toLowerCase()} successfully`,
        leaveId,
        status
      });
    });
  });
});

// GET ALL PENDING LEAVES
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

// GET LEAVE BALANCE FOR AN EMPLOYEE
// Allocation is unknown, so total and remaining stay null.
// Only approved leave days are counted as used.
router.get("/balance/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  const employeeSql = `
    SELECT employee_id
    FROM employees
    WHERE employee_id = ?
      AND status = 'Active'
  `;

  db.query(employeeSql, [employeeId], (err, employees) => {
    if (err) {
      console.error("Get leave balance error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (!employees || employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Active employee not found"
      });
    }

    const balanceSql = `
      SELECT
        leave_type,
        COALESCE(
          SUM(DATEDIFF(end_date, start_date) + 1),
          0
        ) AS used
      FROM leaves
      WHERE employee_id = ?
        AND status = 'Approved'
        AND leave_type IN ('SL', 'CL', 'EL')
      GROUP BY leave_type
    `;

    db.query(balanceSql, [employeeId], (balanceErr, rows) => {
      if (balanceErr) {
        console.error("Calculate leave balance error:", balanceErr);

        return res.status(500).json({
          success: false,
          message: "Unable to calculate leave balance"
        });
      }

      const usedByType = {
        SL: 0,
        CL: 0,
        EL: 0
      };

      rows.forEach(row => {
        usedByType[row.leave_type] = Number(row.used);
      });

      const leaveBalances = {};

      for (const type of ALLOWED_LEAVE_TYPES) {
        leaveBalances[type] = {
          total: null,
          used: usedByType[type],
          remaining: null
        };
      }

      return res.json({
        success: true,
        employeeId: employees[0].employee_id,
        leaveBalances,
        note: "Leave allocations have not been configured. Total and remaining will be available after the company confirms its leave policy."
      });
    });
  });
});

module.exports = router;
