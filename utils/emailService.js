
const nodemailer = require("nodemailer");

function createEmailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP configuration is missing");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass
    }
  });
}

// Existing notification: send leave application to manager.
async function sendLeaveNotification({
  managerEmail,
  employeeName,
  employeeId,
  leaveType,
  startDate,
  endDate,
  reason,
  leaveId
}) {
  const transporter = createEmailTransporter();

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: managerEmail,
    subject: `Leave application from ${employeeName}`,
    text: [
      "Hello,",
      "",
      `${employeeName} (${employeeId}) has applied for leave.`,
      `Leave ID: ${leaveId}`,
      `Leave type: ${leaveType}`,
      `Start date: ${startDate}`,
      `End date: ${endDate}`,
      `Reason: ${reason || "Not provided"}`,
      "Status: Pending",
      "",
      "Please review this request in the YesGoBus HRMS."
    ].join("\n")
  });

  console.log("SMTP accepted:", info.accepted);
  console.log("SMTP rejected:", info.rejected);
  console.log("SMTP response:", info.response);
  console.log("SMTP message ID:", info.messageId);

  return info;
}

// Common function: notify employee about the manager's decision.
async function sendLeaveDecisionEmail({
  employeeEmail,
  employeeName,
  employeeId,
  leaveId,
  leaveType,
  startDate,
  endDate,
  reason,
  status
}) {
  if (!employeeEmail) {
    throw new Error("Employee email address is missing");
  }

  const transporter = createEmailTransporter();

  const approved = status === "Approved";

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: employeeEmail,
    subject: `Your leave request has been ${status.toLowerCase()}`,
    text: [
      `Hello ${employeeName || "Employee"},`,
      "",
      `Your leave request has been ${status.toLowerCase()}.`,
      "",
      `Leave ID: ${leaveId}`,
      `Employee ID: ${employeeId}`,
      `Leave type: ${leaveType}`,
      `Start date: ${startDate}`,
      `End date: ${endDate}`,
      `Status: ${status}`,
      `Original leave reason: ${reason || "Not provided"}`,
      "",
      approved
        ? "Your leave has been approved. Please check the YesGoBus HRMS for details."
        : "Your leave has been rejected. Please contact your manager if you need clarification.",
      "",
      "Regards,",
      "YesGoBus HRMS"
    ].join("\n")
  });

  console.log(`Leave ${status} email accepted:`, info.accepted);
  console.log("SMTP rejected:", info.rejected);
  console.log("SMTP response:", info.response);
  console.log("SMTP message ID:", info.messageId);

  return info;
}

async function sendLeaveApprovedEmail(details) {
  return sendLeaveDecisionEmail({
    ...details,
    status: "Approved"
  });
}

async function sendLeaveRejectedEmail(details) {
  return sendLeaveDecisionEmail({
    ...details,
    status: "Rejected"
  });
}

module.exports = {
  sendLeaveNotification,
  sendLeaveApprovedEmail,
  sendLeaveRejectedEmail
};
