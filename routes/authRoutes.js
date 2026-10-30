
const express = require("express");
const db = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

/* =====================================
   PASSWORD VERIFICATION
===================================== */

async function verifyPassword(inputPassword, storedPassword, employeeId) {
  if (!storedPassword) {
    return false;
  }

  // Check whether password is already bcrypt hashed
  const isBcryptHash = /^\$2[aby]\$\d{2}\$/.test(storedPassword);

  if (isBcryptHash) {
    return await bcrypt.compare(inputPassword, storedPassword);
  }

  // Support and migrate existing plain-text passwords
  if (inputPassword === storedPassword) {
    const hashedPassword = await bcrypt.hash(inputPassword, 10);

    await new Promise((resolve, reject) => {
      db.query(
        "UPDATE employees SET password = ? WHERE employee_id = ?",
        [hashedPassword, employeeId],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    return true;
  }

  return false;
}

/* =====================================
   EMPLOYEE LOGIN API WITH JWT
===================================== */

router.post("/login", (req, res) => {
  const { employeeId, password } = req.body;

  if (!employeeId || !password) {
    return res.status(400).json({
      success: false,
      message: "Employee ID and password are required"
    });
  }

  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is missing");

    return res.status(500).json({
      success: false,
      message: "Authentication configuration error"
    });
  }

  const sql = `
    SELECT
      id,
      employee_id,
      name,
      email,
      department,
      designation,
      job_title,
      role,
      reporting_manager_id,
      status,
      password
    FROM employees
    WHERE employee_id = ?
      AND status = 'Active'
  `;

  db.query(sql, [employeeId], async (err, results) => {
    if (err) {
      console.error("Login database error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (results.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid employee ID or password"
      });
    }

    const employee = results[0];

    try {
      // Verify password
      const passwordValid = await verifyPassword(
        password,
        employee.password,
        employee.employee_id
      );

      if (!passwordValid) {
        return res.status(401).json({
          success: false,
          message: "Invalid employee ID or password"
        });
      }

      // Generate JWT token
      console.log(
        "LOGIN JWT_SECRET loaded:",
        !!process.env.JWT_SECRET
      );

      const token = jwt.sign(
        {
          employeeId: employee.employee_id,
          role: employee.role
        },
        process.env.JWT_SECRET,
        {
          expiresIn: "8h"
        }
      );

      // Temporary token verification
      const testDecoded = jwt.verify(
        token,
        process.env.JWT_SECRET
      );

      console.log(
        "LOGIN TOKEN SELF-VERIFICATION:",
        testDecoded.employeeId
      );

      // Never return password
      delete employee.password;

      // Employee can see only own information
      if (employee.role === "Employee") {
        return res.status(200).json({
          success: true,
          message: "Login successful",
          token,
          employee,
          role: employee.role,
          visibleEmployees: [employee]
        });
      }

      // Manager / HR / Main Head hierarchy
      const hierarchySql = `
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

      db.query(
        hierarchySql,
        [employee.employee_id],
        (hierarchyErr, visibleEmployees) => {
          if (hierarchyErr) {
            console.error("Hierarchy error:", hierarchyErr);

            return res.status(500).json({
              success: false,
              message: "Unable to load employee hierarchy"
            });
          }

          return res.status(200).json({
            success: true,
            message: "Login successful",
            token,
            employee,
            role: employee.role,
            visibleEmployees
          });
        }
      );

    } catch (error) {
      console.error("Login error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to complete login"
      });
    }
  });
});

module.exports = router;
