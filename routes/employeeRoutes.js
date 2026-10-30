const bcrypt = require("bcryptjs");
const authMiddleware = require("../middleware/authMiddleware");
const express = require("express");
const db = require("../db");

const router = express.Router();
// CHANGE PASSWORD API
router.put("/change-password", authMiddleware, async (req, res) => {

  console.log("CHANGE PASSWORD ROUTE HIT");

  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // Get employee ID from JWT token
    const employeeId = req.user.employeeId;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "All password fields are required"
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New password and confirm password do not match"
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 8 characters"
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password"
      });
    }

    const sql = `
      SELECT password, status
      FROM employees
      WHERE employee_id = ?
    `;

    db.query(sql, [employeeId], async (err, results) => {
      if (err) {
        console.error("Fetch password error:", err);
        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      if (results.length === 0 || results[0].status !== "Active") {
        return res.status(404).json({
          success: false,
          message: "Employee not found or inactive"
        });
      }

      try {
        const isValid = await bcrypt.compare(
          currentPassword,
          results[0].password
        );

        if (!isValid) {
          return res.status(401).json({
            success: false,
            message: "Current password is incorrect"
          });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        db.query(
          "UPDATE employees SET password = ? WHERE employee_id = ?",
          [hashedPassword, employeeId],
          (updateErr, updateResult) => {
            if (updateErr) {
              console.error("Update password error:", updateErr);
              return res.status(500).json({
                success: false,
                message: "Failed to update password"
              });
            }

            return res.status(200).json({
              success: true,
              message: "Password changed successfully"
            });
          }
        );

      } catch (error) {
        console.error("Password verification error:", error);
        return res.status(500).json({
          success: false,
          message: "Password processing failed"
        });
      }
    });

  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});

// GET all employees
router.get("/", (req, res) => {
  const sql = `
    SELECT
    employee_id,
      name,
      gender,
      contact_details,
      doj,
      job_title,
      email,
      department,
      designation,
      reporting_manager_id,
      status
    FROM employees
    ORDER BY id
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Get employees error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    res.json({
      success: true,
      count: results.length,
      employees: results
    });
  });
});

// GET employee details by employee ID
router.get("/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      employee_id AS employeeCode,
      name AS fullName,
      gender,
      dob,
      place,
      contact_details AS contactNumber,
      email,
      emergency_contact_number AS emergencyContactNumber,
      doj AS joiningDate,
      department,
      designation,
      job_title AS jobTitle,
      role,
      status AS accountStatus
    FROM employees
    WHERE employee_id = ?
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Get employee details error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    return res.json({
      success: true,
      employee: results[0]
    });
  });
});


// GET all employees visible to a user
router.get("/:employeeId/visible-employees", (req, res) => {
  const { employeeId } = req.params;

  // First get the logged-in employee
  const userSql = `
    SELECT
      employee_id,
      role,
      reporting_manager_id
    FROM employees
    WHERE employee_id = ?
      AND status = 'Active'
  `;

  db.query(userSql, [employeeId], (err, users) => {
    if (err) {
      console.error("Get user error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    const user = users[0];

    // Employee → own data only
    if (user.role === "Employee") {
      const sql = `
        SELECT
          employee_id,
          name,
          gender,
          contact_details,
          doj,
          job_title,
          email,
          department,
          designation,
          reporting_manager_id,
          status
        FROM employees
        WHERE employee_id = ?
          AND status = 'Active'
      `;

      return db.query(sql, [employeeId], (err, results) => {
        if (err) {
          console.error("Get visible employee error:", err);

          return res.status(500).json({
            success: false,
            message: "Database error"
          });
        }

        return res.json({
          success: true,
          role: user.role,
          count: results.length,
          employees: results
        });
      });
    }

    // Manager / HR / Main Head
    // Get everyone below this user in the reporting hierarchy
    const sql = `
      WITH RECURSIVE employee_hierarchy AS (
        SELECT employee_id
        FROM employees
        WHERE employee_id = ?

        UNION ALL

        SELECT e.employee_id
        FROM employees e
        INNER JOIN employee_hierarchy h
          ON e.reporting_manager_id = h.employee_id
        WHERE e.status = 'Active'
      )

      SELECT
        e.employee_id,
        e.name,
        e.gender,
        e.contact_details,
        e.doj,
        e.email,
        e.department,
        e.designation,
        e.job_title,
        e.role,
        e.reporting_manager_id,
        e.status
      FROM employees e
      INNER JOIN employee_hierarchy h
        ON e.employee_id = h.employee_id
      WHERE e.status = 'Active'
      ORDER BY e.id
    `;

    db.query(sql, [employeeId], (err, results) => {
      if (err) {
        console.error("Get hierarchy error:", err);

        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      res.json({
        success: true,
        role: user.role,
        count: results.length,
        employees: results
      });
    });
  });
});


// GET manager's team
router.get("/:employeeId/team", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      employee_id,
      name,
      gender,
      contact_details,
      doj,
      job_title,
      email,
      department,
      designation,
      reporting_manager_id,
      status
    FROM employees
    WHERE reporting_manager_id = ?
      AND status = 'Active'
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Get team error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    res.json({
      success: true,
      managerId: employeeId,
      count: results.length,
      employees: results
    });
  });
});


/* GET reporting manager details for an employee */
router.get("/:employeeId/manager", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      e.employee_id AS employeeId,
      e.name AS employeeName,
      e.reporting_manager_id AS managerId,
      m.name AS managerName,
      m.email AS managerEmail
    FROM employees e
    LEFT JOIN employees m
      ON e.reporting_manager_id = m.employee_id
    WHERE e.employee_id = ?
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Get manager details error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    const employee = results[0];

    if (!employee.managerId) {
      return res.status(404).json({
        success: false,
        message: "No reporting manager assigned"
      });
    }

    if (!employee.managerEmail) {
      return res.status(404).json({
        success: false,
        message: "Manager email not available"
      });
    }

    return res.json({
      success: true,
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      manager: {
        employeeId: employee.managerId,
        name: employee.managerName,
        email: employee.managerEmail
      }
    });
  });
});

module.exports = router;