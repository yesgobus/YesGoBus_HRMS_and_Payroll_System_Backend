
const express = require("express");
const db = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const router = express.Router();

// =====================================
// DATABASE HELPER
// =====================================

function query(sql, values = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, values, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

// =====================================
// HOSTINGER SMTP CONFIGURATION
// =====================================

const smtpPort = Number(process.env.SMTP_PORT || 587);

const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  requireTLS: smtpPort === 587,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  mailTransporter.verify((error) => {
    if (error) {
      console.error("SMTP connection failed:", error.message);
    } else {
      console.log("Hostinger SMTP connection successful!");
    }
  });
} else {
  console.warn("SMTP settings missing. Email OTP is unavailable.");
}

// =====================================
// HASH HELPER
// =====================================

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

// =====================================
// PASSWORD VERIFICATION
// =====================================

async function verifyPassword(inputPassword, storedPassword, employeeId) {
  if (!storedPassword) return false;

  const isBcryptHash = /^\$2[aby]\$\d{2}\$/.test(storedPassword);

  if (isBcryptHash) {
    return bcrypt.compare(inputPassword, storedPassword);
  }

  // Migrate existing plain-text password
  if (inputPassword === storedPassword) {
    const hashedPassword = await bcrypt.hash(inputPassword, 10);

    await query(
      "UPDATE employees SET password = ? WHERE employee_id = ?",
      [hashedPassword, employeeId]
    );

    return true;
  }

  return false;
}

// =====================================
// 1. EMPLOYEE LOGIN API WITH JWT
// =====================================

router.post("/login", async (req, res) => {
  try {
    console.log("========== LOGIN DEBUG ==========");
console.log("Request body:", req.body);
console.log("Employee ID:", req.body?.employeeId);
console.log("Employee ID (snake case):", req.body?.employee_id);
console.log("Password received:", !!req.body?.password);
console.log("=================================");
    // Supports both employeeId and employee_id
    const employeeId =
      req.body.employeeId || req.body.employee_id;

    const password = req.body.password;

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

    const employees = await query(
      `SELECT
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
       LIMIT 1`,
      [String(employeeId).trim()]
    );

    if (employees.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid employee ID or password"
      });
    }

    const employee = employees[0];

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

    const token = jwt.sign(
      {
        employeeId: employee.employee_id,
        role: employee.role
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    delete employee.password;

    // Employee can see only their own information
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

    const visibleEmployees = await query(
      hierarchySql,
      [employee.employee_id]
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      employee,
      role: employee.role,
      visibleEmployees
    });

  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to complete login"
    });
  }
});

// =====================================
// 2. FORGOT PASSWORD - SEND EMAIL OTP
// =====================================

router.post("/forgot-password", async (req, res) => {
  try {
    const { employeeId, method = "email" } = req.body;

    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: "Employee ID is required"
      });
    }

    if (method === "sms") {
      return res.status(501).json({
        success: false,
        message: "SMS OTP is not configured yet. Please choose official email."
      });
    }

    if (method !== "email") {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP delivery method"
      });
    }

    if (
      !process.env.SMTP_HOST ||
      !process.env.SMTP_USER ||
      !process.env.SMTP_PASS
    ) {
      return res.status(500).json({
        success: false,
        message: "Email service is not configured"
      });
    }

    const employees = await query(
      `SELECT employee_id, email
       FROM employees
       WHERE employee_id = ?
         AND status = 'Active'
       LIMIT 1`,
      [String(employeeId).trim()]
    );

    // Do not disclose whether an employee ID exists
    if (employees.length === 0 || !employees[0].email) {
      return res.status(200).json({
        success: true,
        message: "If the active employee account exists, an OTP will be sent to its registered email."
      });
    }

    const employee = employees[0];

    // Generate six-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashValue(otp);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

    await query(
      `UPDATE employees
       SET password_reset_otp_hash = ?,
           password_reset_otp_expires_at = ?,
           password_reset_otp_attempts = 0,
           password_reset_otp_method = 'email',
           password_reset_token_hash = NULL,
           password_reset_expires_at = NULL
       WHERE employee_id = ?
         AND status = 'Active'`,
      [otpHash, otpExpiry, employee.employee_id]
    );

    try {
      await mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: employee.email,
        subject: "YesGoBus HRMS - Password Reset OTP",
        text: `Your YesGoBus HRMS password reset OTP is ${otp}.

This OTP is valid for 5 minutes.
Do not share this OTP with anyone.

If you did not request a password reset, please ignore this email.`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto;">
            <h2>YesGoBus HRMS</h2>
            <p>You requested to reset your password.</p>
            <p>Your OTP is:</p>
            <h1 style="letter-spacing: 8px;">${otp}</h1>
            <p>This OTP is valid for <b>5 minutes</b>.</p>
            <p>Do not share this OTP with anyone.</p>
            <p>If you did not request this, please ignore this email.</p>
          </div>
        `
      });

    } catch (mailError) {
      console.error("OTP email sending failed:", mailError.message);

      await query(
        `UPDATE employees
         SET password_reset_otp_hash = NULL,
             password_reset_otp_expires_at = NULL,
             password_reset_otp_attempts = 0,
             password_reset_otp_method = NULL
         WHERE employee_id = ?`,
        [employee.employee_id]
      );

      return res.status(500).json({
        success: false,
        message: "Unable to send OTP email. Please try again later."
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully to your registered official email address."
    });

  } catch (error) {
    console.error("Forgot password error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to process password reset request"
    });
  }
});

// =====================================
// 3. VERIFY OTP AND GENERATE RESET TOKEN
// =====================================

router.post("/verify-otp", async (req, res) => {
  try {
    const { employeeId, otp } = req.body;

    if (!employeeId || !otp) {
      return res.status(400).json({
        success: false,
        message: "Employee ID and OTP are required"
      });
    }

    if (!/^\d{6}$/.test(String(otp))) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6-digit OTP"
      });
    }

    const employees = await query(
      `SELECT
        employee_id,
        password_reset_otp_hash,
        password_reset_otp_expires_at,
        password_reset_otp_attempts
       FROM employees
       WHERE employee_id = ?
         AND status = 'Active'
       LIMIT 1`,
      [String(employeeId).trim()]
    );

    if (employees.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP"
      });
    }

    const employee = employees[0];

    if (
      !employee.password_reset_otp_hash ||
      !employee.password_reset_otp_expires_at
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP"
      });
    }

    if (
      new Date(employee.password_reset_otp_expires_at).getTime() <= Date.now()
    ) {
      await query(
        `UPDATE employees
         SET password_reset_otp_hash = NULL,
             password_reset_otp_expires_at = NULL,
             password_reset_otp_attempts = 0,
             password_reset_otp_method = NULL
         WHERE employee_id = ?`,
        [employee.employee_id]
      );

      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new OTP."
      });
    }

    if (employee.password_reset_otp_attempts >= 5) {
      await query(
        `UPDATE employees
         SET password_reset_otp_hash = NULL,
             password_reset_otp_expires_at = NULL,
             password_reset_otp_attempts = 0,
             password_reset_otp_method = NULL
         WHERE employee_id = ?`,
        [employee.employee_id]
      );

      return res.status(429).json({
        success: false,
        message: "Too many incorrect attempts. Please request a new OTP."
      });
    }

    const submittedHash = hashValue(String(otp));
    const storedHash = employee.password_reset_otp_hash;

    const otpIsValid =
      submittedHash.length === storedHash.length &&
      crypto.timingSafeEqual(
        Buffer.from(submittedHash, "hex"),
        Buffer.from(storedHash, "hex")
      );

    if (!otpIsValid) {
      await query(
        `UPDATE employees
         SET password_reset_otp_attempts = password_reset_otp_attempts + 1
         WHERE employee_id = ?`,
        [employee.employee_id]
      );

      return res.status(400).json({
        success: false,
        message: "Incorrect OTP"
      });
    }

    // Generate secure random reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = hashValue(resetToken);
    const resetExpiry = new Date(Date.now() + 10 * 60 * 1000);

    // Save token before returning it
    const saveResult = await query(
      `UPDATE employees
       SET password_reset_otp_hash = NULL,
           password_reset_otp_expires_at = NULL,
           password_reset_otp_attempts = 0,
           password_reset_otp_method = NULL,
           password_reset_token_hash = ?,
           password_reset_expires_at = ?
       WHERE employee_id = ?
         AND status = 'Active'`,
      [resetTokenHash, resetExpiry, employee.employee_id]
    );

    if (saveResult.affectedRows !== 1) {
      return res.status(500).json({
        success: false,
        message: "Unable to create password reset session"
      });
    }

    const tokenCheck = await query(
      `SELECT password_reset_token_hash = ? AS token_matches
       FROM employees
       WHERE employee_id = ?`,
      [resetTokenHash, employee.employee_id]
    );

    if (
      tokenCheck.length === 0 ||
      Number(tokenCheck[0].token_matches) !== 1
    ) {
      console.error("Reset token storage verification failed");

      return res.status(500).json({
        success: false,
        message: "Unable to verify password reset session"
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      resetToken,
      resetTokenExpiresIn: "10 minutes"
    });

  } catch (error) {
    console.error("OTP verification error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify OTP"
    });
  }
});

// =====================================
// 4. RESET PASSWORD
// =====================================

router.post("/reset-password", async (req, res) => {
  try {
    const {
      employeeId,
      resetToken,
      newPassword,
      confirmPassword
    } = req.body;

    if (!employeeId || !resetToken || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Employee ID, reset token, new password and confirm password are required"
      });
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 8 characters"
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New password and confirm password do not match"
      });
    }

    const resetTokenHash = hashValue(String(resetToken));

    // Validate employee, token hash and expiry
    const employees = await query(
      `SELECT employee_id
       FROM employees
       WHERE employee_id = ?
         AND status = 'Active'
         AND password_reset_token_hash = ?
         AND password_reset_expires_at > NOW()
       LIMIT 1`,
      [String(employeeId).trim(), resetTokenHash]
    );

    if (employees.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired password reset session. Please start again."
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Consume token while changing password
    const result = await query(
      `UPDATE employees
       SET password = ?,
           password_reset_token_hash = NULL,
           password_reset_expires_at = NULL,
           password_reset_otp_hash = NULL,
           password_reset_otp_expires_at = NULL,
           password_reset_otp_attempts = 0,
           password_reset_otp_method = NULL
       WHERE employee_id = ?
         AND status = 'Active'
         AND password_reset_token_hash = ?
         AND password_reset_expires_at > NOW()`,
      [hashedPassword, String(employeeId).trim(), resetTokenHash]
    );

    if (result.affectedRows !== 1) {
      return res.status(400).json({
        success: false,
        message: "Reset session expired or already used. Please start again."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Password reset successfully. You can now log in with your new password."
    });

  } catch (error) {
    console.error("Reset password error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to reset password"
    });
  }
});

// =====================================
// EXPORT ROUTER
// =====================================

module.exports = router;
