const express = require("express");
const db = require("../db");

const router = express.Router();

router.post("/login", (req, res) => {
  const { employeeId, password } = req.body;

  if (!employeeId || !password) {
    return res.status(400).json({
      success: false,
      message: "Employee ID and password are required"
    });
  }

  // Get logged-in employee
  const sql = `
    SELECT
      id,
      employee_id,
      first_name,
      middle_name,
      last_name,
      name,
      email,
      department,
      designation,
      job_title,
      role,
      reporting_manager_id,
      status
    FROM employees
    WHERE employee_id = ?
      AND password = ?
      AND status = 'Active'
  `;

  db.query(sql, [employeeId, password], (err, results) => {
    if (err) {
      console.error("Database error:", err);

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

    // Employee → own data only
    if (employee.role === "Employee") {
      return res.json({
        success: true,
        message: "Login successful",
        employee: employee,
        role: employee.role,
        visibleEmployees: [employee]
      });
    }

    // Manager / HR / Main Head
    // Find everyone below this employee in the hierarchy
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
        e.first_name,
        e.middle_name,
        e.last_name,
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

        res.json({
          success: true,
          message: "Login successful",
          employee: employee,
          role: employee.role,
          visibleEmployees: visibleEmployees
        });
      }
    );
  });
});

module.exports = router;