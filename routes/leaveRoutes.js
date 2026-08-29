const express = require("express");
const db = require("../db");

const router = express.Router();

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
  // Only CL and EL are allowed
if (!["CL", "EL"].includes(leaveType)) {
  return res.status(400).json({
    success: false,
    message: "Invalid leave type. Only CL and EL are allowed"
  });
}

  // Check employee exists and is active
  const employeeSql = `
    SELECT employee_id
    FROM employees
    WHERE employee_id = ? AND status = 'Active'
  `;

  db.query(employeeSql, [employeeId], (err, employees) => {
    if (err) {
      console.error("Employee check error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found or inactive"
      });
    }

    // Insert leave application
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

        res.json({
          success: true,
          message: "Leave applied successfully",
          leaveId: result.insertId
        });
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

    res.json({
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

    res.json({
      success: true,
      managerId: managerId,
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

  // Check that the leave belongs to an employee
  // who reports to this manager
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

    // Make sure this manager is the employee's
    // actual reporting manager
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
    `;

    db.query(updateSql, [status, leaveId], (err, result) => {
      if (err) {
        console.error("Leave status update error:", err);

        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      res.json({
        success: true,
        message: `Leave ${status.toLowerCase()} successfully`,
        leaveId: leaveId,
        status: status
      });
    });
  });
});
// GET PENDING LEAVE REQUESTS FOR HR
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

    res.json({
      success: true,
      count: results.length,
      leaves: results
    });
  });
});
module.exports = router;