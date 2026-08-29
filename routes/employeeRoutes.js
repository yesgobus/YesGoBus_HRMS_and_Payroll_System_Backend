const express = require("express");
const db = require("../db");

const router = express.Router();

// GET all employees
router.get("/", (req, res) => {
  const sql = `
    SELECT
      employee_id,
      first_name,
      middle_name,
      last_name,
      dob,
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


// GET employee by ID
router.get("/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  const sql = `
    SELECT
      employee_id,
      first_name,
      middle_name,
      last_name,
      dob,
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
  `;

  db.query(sql, [employeeId], (err, results) => {
    if (err) {
      console.error("Get employee error:", err);

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

    res.json({
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
    SELECT employee_id, role, reporting_manager_id
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
        SELECT *
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
      first_name,
      middle_name,
      last_name,
      dob,
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

module.exports = router;