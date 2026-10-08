const express = require("express");
const db = require("../db");

const router = express.Router();

/*
========================================
INDIA STANDARD TIME (IST)
========================================
UTC + 05:30

We use UTC_TIMESTAMP() and explicitly
convert it to IST so the API does not
depend on the MySQL/server timezone.
*/

const IST_DATE_SQL =
  "DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))";

const IST_TIME_SQL =
  "TIME(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))";


// ===============================
// CALCULATE TOTAL WORKING HOURS
// ===============================

function calculateWorkingHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) {
    return null;
  }

  const start = new Date(`1970-01-01T${checkIn}`);
  const end = new Date(`1970-01-01T${checkOut}`);

  let difference = end - start;

  // Handles overnight shifts
  if (difference < 0) {
    difference += 24 * 60 * 60 * 1000;
  }

  const totalSeconds = Math.floor(difference / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(seconds).padStart(2, "0")}`;
}


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

    // Check whether already checked in today (IST)
    const checkSql = `
      SELECT *
      FROM attendance
      WHERE employee_id = ?
        AND attendance_date = ${IST_DATE_SQL}
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

      // Create today's attendance using IST date and time
      const insertSql = `
        INSERT INTO attendance
        (employee_id, attendance_date, check_in, status)
        VALUES (
          ?,
          ${IST_DATE_SQL},
          ${IST_TIME_SQL},
          'Present'
        )
      `;

      db.query(insertSql, [employeeId], (err, result) => {
        if (err) {
          console.error("Check-in error:", err);

          return res.status(500).json({
            success: false,
            message: "Unable to check in"
          });
        }

        // Get the newly created attendance record
        const getAttendanceSql = `
          SELECT
            id,
            employee_id,
            attendance_date,
            check_in,
            check_out,
            status
          FROM attendance
          WHERE id = ?
        `;

        db.query(
          getAttendanceSql,
          [result.insertId],
          (attendanceErr, attendanceResults) => {
            if (attendanceErr) {
              console.error(
                "Attendance fetch error:",
                attendanceErr
              );

              return res.status(500).json({
                success: false,
                message:
                  "Check-in successful but unable to fetch attendance"
              });
            }

            const attendance = attendanceResults[0];

            res.json({
              success: true,
              message: "Check-in successful",
              attendance: {
                employeeId: attendance.employee_id,
                date: attendance.attendance_date,
                checkIn: attendance.check_in,
                checkOut: attendance.check_out,
                totalWorkingHours: null,
                status: attendance.status
              }
            });
          }
        );
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

  // Find today's attendance record using IST date
  const sql = `
    SELECT *
    FROM attendance
    WHERE employee_id = ?
      AND attendance_date = ${IST_DATE_SQL}
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

    // Save check-out time in IST
    const updateSql = `
      UPDATE attendance
      SET check_out = ${IST_TIME_SQL}
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

      // Get updated attendance record
      const getUpdatedSql = `
        SELECT
          id,
          employee_id,
          attendance_date,
          check_in,
          check_out,
          status
        FROM attendance
        WHERE id = ?
      `;

      db.query(
        getUpdatedSql,
        [attendance.id],
        (fetchErr, updatedResults) => {
          if (fetchErr) {
            console.error(
              "Updated attendance fetch error:",
              fetchErr
            );

            return res.status(500).json({
              success: false,
              message:
                "Check-out successful but unable to fetch attendance"
            });
          }

          const updatedAttendance = updatedResults[0];

          const totalWorkingHours = calculateWorkingHours(
            updatedAttendance.check_in,
            updatedAttendance.check_out
          );

          res.json({
            success: true,
            message: "Check-out successful",
            attendance: {
              employeeId: updatedAttendance.employee_id,
              date: updatedAttendance.attendance_date,
              checkIn: updatedAttendance.check_in,
              checkOut: updatedAttendance.check_out,
              totalWorkingHours: totalWorkingHours,
              status: updatedAttendance.status
            }
          });
        }
      );
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
      AND attendance_date = ${IST_DATE_SQL}
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

    const attendance = results[0];

    const totalWorkingHours = calculateWorkingHours(
      attendance.check_in,
      attendance.check_out
    );

    res.json({
      success: true,
      attendance: {
        employeeId: attendance.employee_id,
        date: attendance.attendance_date,
        checkIn: attendance.check_in,
        checkOut: attendance.check_out,
        totalWorkingHours: totalWorkingHours,
        status: attendance.status
      }
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

    const attendance = results.map((record) => ({
      employeeId: record.employee_id,
      date: record.attendance_date,
      checkIn: record.check_in,
      checkOut: record.check_out,
      totalWorkingHours: calculateWorkingHours(
        record.check_in,
        record.check_out
      ),
      status: record.status
    }));

    res.json({
      success: true,
      count: attendance.length,
      attendance: attendance
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

    const attendance = results.map((record) => ({
      employeeId: record.employee_id,
      name: record.name,
      department: record.department,
      designation: record.designation,
      date: record.attendance_date,
      checkIn: record.check_in,
      checkOut: record.check_out,
      totalWorkingHours: calculateWorkingHours(
        record.check_in,
        record.check_out
      ),
      status: record.status
    }));

    res.json({
      success: true,
      managerId: managerId,
      count: attendance.length,
      attendance: attendance
    });
  });
});


module.exports = router;