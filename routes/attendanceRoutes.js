const express = require("express");
const db = require("../db");

const router = express.Router();

// ===============================
// CHECK-IN
// ===============================
router.post("/check-in", (req, res) => {
  const { employeeId } = req.body;

  if (!employeeId) {
    return res.status(400).json({
      success: false,
      message: "Employee ID is required"
    });
  }

  // Check employee exists and is active
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

    if (employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found or inactive"
      });
    }

    // Check whether already checked in today
    const checkSql = `
      SELECT *
      FROM attendance
      WHERE employee_id = ?
        AND attendance_date = CURDATE()
    `;

    db.query(checkSql, [employeeId], (err, results) => {
      if (err) {
        console.error("Attendance check error:", err);

        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      if (results.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Already checked in today"
        });
      }

      // Create today's attendance
      const insertSql = `
        INSERT INTO attendance
        (employee_id, attendance_date, check_in, status)
        VALUES (?, CURDATE(), CURTIME(), 'Present')
      `;

      db.query(insertSql, [employeeId], (err, result) => {
        if (err) {
          console.error("Check-in error:", err);

          return res.status(500).json({
            success: false,
            message: "Unable to check in"
          });
        }

        res.json({
          success: true,
          message: "Check-in successful",
          attendanceId: result.insertId
        });
      });
    });
  });
});


// ===============================
// CHECK-OUT
// ===============================
router.post("/check-out", (req, res) => {
  const { employeeId } = req.body;

  if (!employeeId) {
    return res.status(400).json({
      success: false,
      message: "Employee ID is required"
    });
  }

  const sql = `
    SELECT *
    FROM attendance
    WHERE employee_id = ?
      AND attendance_date = CURDATE()
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Check-out error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No attendance record found for today"
      });
    }

    const attendance = results[0];

    if (!attendance.check_in) {
      return res.status(400).json({
        success: false,
        message: "Employee has not checked in today"
      });
    }

    if (attendance.check_out) {
      return res.status(400).json({
        success: false,
        message: "Already checked out today"
      });
    }

    const updateSql = `
      UPDATE attendance
      SET check_out = CURTIME()
      WHERE id = ?
    `;

    db.query(updateSql, [attendance.id], (err) => {
      if (err) {
        console.error("Check-out update error:", err);

        return res.status(500).json({
          success: false,
          message: "Unable to check out"
        });
      }

      res.json({
        success: true,
        message: "Check-out successful",
        attendanceId: attendance.id
      });
    });
  });
});


// ===============================
// TODAY'S ATTENDANCE
// ===============================
router.get("/today/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      id,
      employee_id,
      attendance_date,
      check_in,
      check_out,
      status
    FROM attendance
    WHERE employee_id = ?
      AND attendance_date = CURDATE()
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Today's attendance error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (results.length === 0) {
      return res.json({
        success: true,
        message: "No attendance record for today",
        attendance: null
      });
    }

    res.json({
      success: true,
      attendance: results[0]
    });
  });
});


// ===============================
// EMPLOYEE ATTENDANCE HISTORY
// ===============================
router.get("/history/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      id,
      employee_id,
      attendance_date,
      check_in,
      check_out,
      status
    FROM attendance
    WHERE employee_id = ?
    ORDER BY attendance_date DESC
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Attendance history error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    res.json({
      success: true,
      count: results.length,
      attendance: results
    });
  });
});


// ===============================
// MANAGER'S TEAM ATTENDANCE
// ===============================
router.get("/manager/:managerId", (req, res) => {
  const { managerId } = req.params;

  const sql = `
    SELECT
      a.id,
      a.employee_id,
      e.name,
      e.department,
      e.designation,
      a.attendance_date,
      a.check_in,
      a.check_out,
      a.status
    FROM attendance a
    INNER JOIN employees e
      ON a.employee_id = e.employee_id
    WHERE e.reporting_manager_id = ?
    ORDER BY a.attendance_date DESC, a.check_in DESC
  `;

  db.query(sql, [managerId], (err, results) => {
    if (err) {
      console.error("Manager attendance error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    res.json({
      success: true,
      managerId: managerId,
      count: results.length,
      attendance: results
    });
  });
});


module.exports = router;
