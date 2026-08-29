const express = require("express");
const db = require("../db");

const router = express.Router();

// =====================================================
// DASHBOARD
// =====================================================
router.get("/:employeeId", (req, res) => {
  const { employeeId } = req.params;

  // ---------------------------------------------------
  // 1. GET EMPLOYEE DETAILS
  // ---------------------------------------------------
  const employeeSql = `
    SELECT
      id,
      employee_id,
      name,
      email,
      department,
      designation,
      role,
      status
    FROM employees
    WHERE employee_id = ?
  `;

  db.query(employeeSql, [employeeId], (err, employees) => {
    if (err) {
      console.error("Dashboard employee error:", err);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    if (employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    const employee = employees[0];

    // ---------------------------------------------------
    // 2. TODAY'S ATTENDANCE
    // ---------------------------------------------------
    const attendanceSql = `
      SELECT
        id,
        attendance_date,
        check_in,
        check_out,
        status
      FROM attendance
      WHERE employee_id = ?
        AND attendance_date = CURDATE()
      LIMIT 1
    `;

    db.query(attendanceSql, [employeeId], (err, attendance) => {
      if (err) {
        console.error("Dashboard attendance error:", err);

        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      // ---------------------------------------------------
      // 3. LEAVE SUMMARY
      // ---------------------------------------------------
      const leaveSql = `
        SELECT
          COUNT(*) AS total_leaves,
          COALESCE(
            SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END),
            0
          ) AS pending_leaves,
          COALESCE(
            SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END),
            0
          ) AS approved_leaves,
          COALESCE(
            SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END),
            0
          ) AS rejected_leaves
        FROM leaves
        WHERE employee_id = ?
      `;

      db.query(leaveSql, [employeeId], (err, leaveSummary) => {
        if (err) {
          console.error("Dashboard leave error:", err);

          return res.status(500).json({
            success: false,
            message: "Database error"
          });
        }

        // ---------------------------------------------------
        // 4. RECENT LEAVES
        // ---------------------------------------------------
        const recentLeavesSql = `
          SELECT
            id,
            leave_type,
            start_date,
            end_date,
            reason,
            status,
            applied_at
          FROM leaves
          WHERE employee_id = ?
          ORDER BY applied_at DESC
          LIMIT 5
        `;

        db.query(
          recentLeavesSql,
          [employeeId],
          (err, recentLeaves) => {
            if (err) {
              console.error(
                "Dashboard recent leaves error:",
                err
              );

              return res.status(500).json({
                success: false,
                message: "Database error"
              });
            }

            // ---------------------------------------------------
            // 5. TEAM VISIBILITY BASED ON ROLE
            // ---------------------------------------------------

            const currentRole = employee.role;

            let teamSql;
            let teamParams = [];

            // ===================================================
            // HR AND MAIN HEAD
            // Can see all active employees except themselves
            // ===================================================
            if (
              currentRole === "HR" ||
              currentRole === "Main Head"
            ) {
              teamSql = `
                SELECT
                  e.employee_id,
                  e.name,
                  e.email,
                  e.department,
                  e.designation,
                  e.job_title,
                  e.role,
                  e.reporting_manager_id,
                  e.status,

                  a.attendance_date,
                  a.check_in,
                  a.check_out,
                  a.status AS attendance_status,

                  (
                    SELECT COUNT(*)
                    FROM leaves l
                    WHERE l.employee_id = e.employee_id
                      AND l.status = 'Pending'
                  ) AS pending_leaves

                FROM employees e

                LEFT JOIN attendance a
                  ON e.employee_id = a.employee_id
                  AND a.attendance_date = CURDATE()

                WHERE e.status = 'Active'
                  AND e.employee_id != ?

                ORDER BY e.id
              `;

              teamParams = [employeeId];
            }

            // ===================================================
            // MANAGER
            // Can see only direct reporting employees
            // ===================================================
            else if (currentRole === "Manager") {
              teamSql = `
                SELECT
                  e.employee_id,
                  e.name,
                  e.email,
                  e.department,
                  e.designation,
                  e.job_title,
                  e.role,
                  e.reporting_manager_id,
                  e.status,

                  a.attendance_date,
                  a.check_in,
                  a.check_out,
                  a.status AS attendance_status,

                  (
                    SELECT COUNT(*)
                    FROM leaves l
                    WHERE l.employee_id = e.employee_id
                      AND l.status = 'Pending'
                  ) AS pending_leaves

                FROM employees e

                LEFT JOIN attendance a
                  ON e.employee_id = a.employee_id
                  AND a.attendance_date = CURDATE()

                WHERE e.reporting_manager_id = ?
                  AND e.status = 'Active'

                ORDER BY e.id
              `;

              teamParams = [employeeId];
            }

            // ===================================================
            // NORMAL EMPLOYEE
            // Cannot see team
            // ===================================================
            else {
              teamSql = `
                SELECT
                  employee_id,
                  name,
                  email,
                  department,
                  designation,
                  job_title,
                  role,
                  reporting_manager_id,
                  status
                FROM employees
                WHERE 1 = 0
              `;

              teamParams = [];
            }

            // ---------------------------------------------------
            // 6. GET TEAM DATA
            // ---------------------------------------------------
            db.query(
              teamSql,
              teamParams,
              (teamErr, team) => {
                if (teamErr) {
                  console.error(
                    "Dashboard team error:",
                    teamErr
                  );

                  return res.status(500).json({
                    success: false,
                    message: "Database error"
                  });
                }

                // ---------------------------------------------------
                // 7. FINAL DASHBOARD RESPONSE
                // ---------------------------------------------------
                res.json({
                  success: true,

                  employee: employee,

                  todayAttendance:
                    attendance.length > 0
                      ? attendance[0]
                      : null,

                  leaveSummary: leaveSummary[0],

                  recentLeaves: recentLeaves,

                  teamSummary: {
                    count: team.length,
                    employees: team
                  }
                });
              }
            );
          }
        );
      });
    });
  });
});

module.exports = router;