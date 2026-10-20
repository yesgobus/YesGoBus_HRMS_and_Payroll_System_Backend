
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

module.exports = {
  sendLeaveNotification
};
